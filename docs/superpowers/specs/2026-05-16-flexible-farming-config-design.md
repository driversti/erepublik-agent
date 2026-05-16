# Flexible farming config — strategies, web UI, on/off toggles

**Date:** 2026-05-16
**Status:** draft, awaiting user review
**Scope:** `src/agent/`, `src/farm/`, `src/tools/`, new `src/ui/`, `config/settings.json`, Windows distribution `.bat` files. Adds a local web UI for non-technical Windows users, abstracts the current single farming strategy into three pluggable strategies (Standard, D4-TW, Maverick-D3), and adds bot-wide Pause + Farm on/off toggles.

---

## 1. Goal

Today the bot has exactly one farming behavior: discover empty-division battles in the player's native division, deploy on both sides with Q-1 no-weapon. This works for D1–D3 accounts. D4 accounts need different behavior:

- **D4 native + no Maverick Pack:** can only fight in their own (D4) division. To farm gold from medals they participate in **Training Wars** — agreed ping-pong battles where two countries take turns winning. The player fights on **their own country's side**, only when that side is empty (no one else contributing), and deploys enough damage to win the round (~130M attacker, ~220M defender — battles are calibrated so the side that should win actually overcomes the resistance).
- **D4 native + Maverick Pack:** Maverick lets them descend to D1–D3 (most valuable D3) and farm there as if they were a low-div player.

The user also wants the bot to be controllable by **non-technical players on Windows** without editing config files or restarting the process. That requires a small UI.

This spec defines:

1. A **strategy abstraction** so the existing farming logic and the two new modes share an interface and a runner that already understands fuel budget, routing, captcha, and stop conditions.
2. A **mode selector** that auto-picks the strategy from `division + hasMaverick` with a manual UI override.
3. A **local web UI** served by the runner process, exposing live status, on/off toggles, and per-mode settings via a single-page HTML.
4. A **settings store** (`config/settings.json`) separated from secrets (`.env`).

Non-goals (deferred):

- Multi-account support in one UI — one install per account, as today
- Pause-until-date scheduler
- LLM in the decision loop — explicitly out per `[[feedback_deterministic_first]]` and the 2026-05-15 historical removal
- Scheduling (time windows like "farm 19:00–23:00")
- Native tray app / Electron
- Remote access (`0.0.0.0` bind, HTTP auth)
- D11 / air-mode strategy

---

## 2. Three farming strategies

### 2.1 Standard (existing, D1–D3 native)

Already implemented in `src/farm/session.ts` + `src/farm/routing.ts`. Behavior preserved:

- Discovery: `listFarmableBattles` returns battles where the player's division has `wall.dom === 50` and `division_end === false`.
- Eligibility: native citizen / mercenary / freedom-fighter via `getCitizenEligibility`.
- Empty check: `isBattleDivisionEmpty` for both sides — zero damage in our division.
- Deploy: both sides.

⚠️ **Behavioral change for existing users:** today Standard deploys with bare hands at 33 energy per deploy (3 hits × ~11 energy, capped at the per-deploy minimum). Per user decision 2026-05-16, this spec changes the default to "try Q7 → Q6 → … → Q1 → bare hands" (see §2.5). The per-deploy energy cost stays ~30 either way (both bare hands and Q-weapons have the same per-deploy minimum), but with a Q-weapon each in-game hit deals more damage (per [[Military_Formulas]]) — useful when winning Battle Hero ties against unexpected co-fighters in the same empty division. Trade-off: each deploy now consumes weapon ammo. Users who prefer the current bare-hands-only behavior can set `emptyDiv.nativeWeaponPriority: []` in `settings.json` — empty list short-circuits to bare hands.

### 2.2 D4-TW (new, D4 native, no Maverick)

The player fights **one side only** — their citizenship country's side — in active battles involving their country, when that side is empty in their (D4) division.

**Discovery filter:** D4-TW does **not** reuse `listFarmableBattles` filtering as-is. The current helper restricts to `wall.dom === 50` (empty-domination signal); TW battles are usually not at 50/50, so we need a separate discovery path:

- New `listMyCountryActiveBattles(countryId)` calls the same `/military/campaignsJson/list` endpoint, then filters to battles where `battle.invaderId === myCountryId` OR `battle.defenderId === myCountryId` AND `division_end === false`. No `wall.dom` filter — we accept battles at any dominance.

**No travel required.** Fighting for your own country only needs you to be in **any region** of that country — the battle's specific region is irrelevant. So:

- If `ctx.currentCountryId === myCountryId` (we're somewhere at home): eligible to deploy on any of our country's battles. **Zero travel** between battles, regardless of which native region the battle is in.
- If `ctx.currentCountryId !== myCountryId` (we're abroad after farming): skip D4-TW this cycle. The `travelHome` path will return us; next cycle we're eligible.

This is different from Standard / Maverick-D3 which require physically traveling to each battle's region (since those involve foreign or empty-div battles). For D4-TW, the existing `findCheapestTravelRegion` / `ERP_FARM_MAX_TRAVEL_CC` plumbing is unused — discovery → empty-side check → deploy → next battle, no `battlefieldTravel` between them.

**Empty-side check (new):** `isSideEmpty(battleId, division=4, side='invader'|'defender')` — `battle-stats` already returns per-side per-division stats; the existing `isBattleDivisionEmpty` checks both sides, we add a single-side variant. The "my side" is whichever side matches `myCountryId`.

**Energy math primer.** The game's deploy form does NOT click hit-by-hit — one POST to `fightDeploy-startDeploy` runs N in-game hits where `N = energy / 10`. Each in-game hit deals `damagePerHit` damage **regardless of whether it kills the enemy** (2–5 hits typically kill one). The game requires a minimum energy per deploy (11 for special weapons like bazookas, 30 for normal weapons / bare hands). Bombs are inventory-only — no energy cost, one bomb per deploy.

**Deploy loop:**

1. Determine `damagePerHit` from `damagePerHit(strength, rankValue, firepower)` (see §2.4).
2. `target = side === 'invader' ? settings.d4tw.targetDamageAttacker : settings.d4tw.targetDamageDefender`.
3. `hitsNeeded = ceil(target / damagePerHit)` — total in-game hits to reach the damage target.
4. `energyToSpend = hitsNeeded * 10`, clamped to the per-deploy minimum (30 for normal weapons / bare hands; 11 for bazookas if `hitsNeeded === 1`).
5. Check pre-conditions: `poolEnergy >= energyToSpend` AND inventory has enough of the chosen weapon's ammo (`ammoNeeded = hitsNeeded` for ground weapons; 1 for bazooka).
6. If pre-conditions fail: **skip the battle, alert via Telegram** (`"D4-TW: skipped {battleId} — need {energyToSpend}e + {ammoNeeded} ammo, have {poolEnergy}e / {ammoOnHand} ammo"`), do not partially deploy.
7. Otherwise: one POST to `deployWeapon` with `energy: energyToSpend` and the chosen weapon. The existing retry/verify loop in `tools/farm.ts` already handles transient errors.
8. After battle: re-check empty-side; if another player joined mid-fight, alert (`"D4-TW: side contested mid-fight at {battleId}"`) and continue — we already paid the cost.

**Session cap:** `settings.d4tw.maxBattlesPerSession` (default 3, user-configurable). Tooltip in UI explains: "How many TW battles per cycle (~10 min). Higher = drain energy faster, hit all targets sooner. Default 3 is balanced."

**Travel:** None within D4-TW — see the "No travel required" note above. Deploying on a native-country battle works from any region of that country.

### 2.3 Maverick-D3 (new, D4 native with Maverick)

Same shape as Standard, but the division is forced to 3 instead of the player's native division.

**Discovery filter:**

- Same shape as Standard but the division parameter is **3**. `listFarmableBattles` today is implicitly parameterized by the player's own division — we extract a `division` argument and let the strategy supply it (`4` for D4-TW/Standard, `3` for Maverick-D3). Filter: `wall.dom === 50 && division_end === false` evaluated for division 3.
- Eligibility check uses Maverick perk path (TBD during impl — `getCitizenEligibility` likely already returns whether D3 is accessible to a D4+Maverick player; verify in Phase 6).

**Empty check:** `isBattleDivisionEmpty(battleId, division=3)`.

**Deploy:** Both sides (same as Standard).

**Weapon policy:** Foreign-division — `settings.emptyDiv.foreignWeaponPolicy` (default `"bomb-then-bazooka"`). Big Bomb (5M damage) preferred, fallback to Small Bomb, then bazookas, final fallback bare hands. See §2.5.

### 2.4 Damage formula

Per [[Military_Formulas]] (KB):

```
D = 10 × (1 + S/400) × (1 + R/5) × (1 + FP/100)
```

Field paths **confirmed 2026-05-16** by inspecting `GET /en/main/citizen-profile-json-personal/{citizenId}`:

| Variable | JSON path | Sample |
|----------|-----------|--------|
| `S` (strength) | `military.militaryData.strength` | `423037.469` |
| `R` (rank value) | `military.militaryData.rankNumber` | `89` |
| `FP` (firepower) | static per weapon quality: Q1=20, Q2=40, Q3=60, Q4=80, Q5=100, Q6=120, Q7=200, bare=0 | — |

Other useful fields from same endpoint:

- `military.militaryData.divisionData.smallBombDamage` — current division's small-bomb damage (sample: 1,500,000 for D4)
- `military.militaryData.divisionData.bazookaBoosterDamage` — bazooka damage in current division
- `military.militaryData.ground.*` mirrors top-level — for ground weapons specifically (use this; `aircraft.*` is for air-mode which is out of scope)

Implementation: `damagePerHit(s, r, fp): number` — pure function in `src/tools/damageFormula.ts`. Excludes natural-enemy, boosters, terrain (we don't auto-use boosters per user decision; the user's stated 130M/220M targets already include a safety margin for TW resistance).

### 2.5 Weapon priority lists

Per the user's rule "best weapon if available, else bare hands". Source: `GET /en/economy/inventory-json` — returns an array of category objects (`mainStorage`, `boosters`, `activeEnhancements`, `inProduction`, `assembly`). All weapons live in `mainStorage.items[]`. **Confirmed 2026-05-16:**

| Item | `type` | `industryId` | `quality` | Energy per deploy | Damage per deploy | Ammo per deploy |
|------|--------|--------------|-----------|-------------------|-------------------|-----------------|
| Bare hands | n/a | n/a | n/a | ≥30 (3+ hits × 10) | `hits × damagePerHit(s, r, 0)` | 0 |
| Q1–Q7 ground weapon | `"groundWeapon"` | 2 | 1..7 (e.g. "Ammunition Q7") | ≥30 | `hits × damagePerHit(s, r, FP)` | `hits` (one round per in-game hit) |
| Small Bomb | `"groundBomb"` | 100 | 21 | 0 | `divisionData.smallBombDamage` (D4 sample: 1.5M) | 1 |
| Big Bomb | `"groundBomb"` | 100 | 22 | 0 | 5,000,000 | 1 |
| Bazooka | TBD (Phase 6) | TBD | TBD | 11 (1 hit × 10, clamped to min) | `divisionData.bazookaBoosterDamage` (one-shot kill) | 1 |
| Q1 raw materials (ignore) | `"raw"` | 12 | — | — | — | — |

Each item has `amount`. A weapon is "available" iff `amount > 0` (or for bare hands, always).

- **Native division** (Standard, D4-TW): `weaponPriority = [7, 6, 5, 4, 3, 2, 1]` — try each `groundWeapon` quality in order; fall back to bare hands if none available.
- **Foreign division** (Maverick-D3): `foreignWeaponPolicy ∈ {"bomb-then-bazooka", "no-weapon"}`. `bomb-then-bazooka` tries Big Bomb → Small Bomb → bazookas (type TBD) → bare hands. `no-weapon` matches current Standard-mode behavior (bare hands, draws from energy pool).

For Maverick-D3 with bombs the deploy is **trivially cheap**: 1 bomb per side (2 bombs per battle) registers damage and earns the Battle Hero medal in the empty division. Per-battle energy cost approaches zero — only the per-cycle context refresh costs anything. This is why the user prefers bombs in foreign div: max medals per fuel.

`pickWeapon(inventory, priorityList, mode): { type, quality, energyPerDeploy, ammoPerDeploy } | null` lives in `src/tools/farm.ts`.

---

## 3. Mode selection

### 3.1 Auto rules

```typescript
function autoMode(division: number | null, hasMaverick: boolean): Mode {
  if (division == null) return 'standard'; // before first detection
  if (division <= 3) return 'standard';
  if (division === 4 && hasMaverick) return 'maverickD3';
  if (division === 4) return 'd4tw';
  return 'standard'; // D11 fallback; separate spec later
}

function effectiveMode(settings: Settings): Mode {
  return settings.modeOverride ?? autoMode(
    settings.detected.division,
    settings.maverickManual ?? settings.detected.hasMaverick ?? false,
  );
}
```

`detected.division` and `detected.hasMaverick` are written by the runner each cycle from the live page. `modeOverride` and `maverickManual` come from the UI. Manual override on Maverick takes precedence over auto-detect (if user toggled it on, they know better than the API probe).

### 3.2 Maverick detection

**Confirmed 2026-05-16:** Maverick Pack maps to `division_switch_pack` in the API. The same `citizen-profile-json-personal` endpoint that supplies strength/rank also exposes active packs:

```typescript
const profile = await apiCall(ctx, 'GET', `/en/main/citizen-profile-json-personal/${citizenId}`);
const hasMaverick = 'division_switch_pack' in (profile.activePacks ?? {});
```

`activePacks` is a dict whose keys name the active packs (sample observed: `{ power_pack: {...}, division_switch_pack: {...} }`). `activePacksAmount` is the count.

One endpoint covers all of §2.4 (damage formula inputs) **and** Maverick detection, so we make a single read per cycle. Result cached on `detected.hasMaverick`; if `maverickManual !== null`, it overrides.

UI shows: "Maverick auto-detected: **YES** / **NO**" with an "Override" link to flip `maverickManual` manually.

---

### 3.3 Per-strategy energy cost (impacts fuel gate)

`decideFarming` in `src/agent/fuelBudget.ts` currently hard-codes `ENERGY_PER_BATTLE = 66` (two 33e deploys per battle, Standard mode). With strategies the per-battle energy diverges and the gate must use the active strategy's value:

| Strategy | Energy per battle (typical) | Notes |
|----------|-----------------------------|-------|
| Standard (bare hands or Q-weapon) | ~60–80 | 2 sides × 30–40 per deploy |
| Maverick-D3 with bombs | ~0 | Bombs are pure inventory; only context refresh costs anything |
| Maverick-D3 with `no-weapon` | ~60–80 | Same as Standard |
| D4-TW | `ceil(targetDamage / damagePerHit) * 10` (single side, single deploy) | Strongly account-dependent. Sample: target 130M, S=423k, R=89, Q7 → ~2200e per battle |

Each strategy exposes `estimateEnergyPerBattle(ctx, settings): number`. `decideFarming` calls the active strategy's estimate before deciding session size. For D4-TW, a single battle may consume more energy than the entire weekly pool of a low-strength account — the gate will correctly skip until enough energy regenerates.

The weekly fuel budget (70 barrels) is preserved as-is for Standard. For D4-TW we additionally track **deploys per week** in `WeeklyFuelState` (new optional field) since fuel-barrel consumption pattern differs (Q-weapon ammo + bombs come from inventory, not from fuel barrels — fuel barrels are only consumed when the no-weapon path runs). Detailed accounting is a Phase 5 task.

---

## 4. Settings store

### 4.1 `config/settings.json` schema (Zod)

```json
{
  "paused": false,
  "farmEnabled": true,
  "modeOverride": null,
  "maverickManual": null,
  "d4tw": {
    "targetDamageAttacker": 130000000,
    "targetDamageDefender": 220000000,
    "maxBattlesPerSession": 3,
    "weaponPriority": [7, 6, 5, 4, 3, 2, 1]
  },
  "emptyDiv": {
    "maxBattlesPerSession": 3,
    "nativeWeaponPriority": [7, 6, 5, 4, 3, 2, 1],
    "foreignWeaponPolicy": "bomb-then-bazooka"
  },
  "travel": {
    "maxTravelCC": 100,
    "returnHomeAfterMinutes": 15,
    "returnHomeMaxCC": 500
  },
  "detected": {
    "division": null,
    "hasMaverick": null,
    "citizenId": null,
    "countryId": null,
    "lastUpdated": null
  }
}
```

- `paused: true` — runner skips the entire cycle except CSRF refresh; logs `[cycle] paused`. Telegram digest still fires on hash change.
- `farmEnabled: false` — runner runs daily actions but skips the farm gate entirely.
- `detected.*` — written by runner, read by UI. Never written from UI.

### 4.2 Atomic writes

`settingsStore.ts` uses write-temp-file-then-rename to avoid torn reads when the UI saves mid-cycle. Reads use `fs.readFileSync` (small file, no need for async).

### 4.3 Secrets stay in `.env`

`.env` continues to hold `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ERP_CAPTCHA_API_KEY`, login/password. The UI **never** reads or writes `.env`. Behavioral toggles (`ERP_RETURN_HOME_AFTER_MINUTES`, `ERP_FARM_MAX_TRAVEL_CC`, etc.) migrate to `settings.json`; `.env` values become last-resort defaults if `settings.json` is missing.

### 4.4 Migration on first run

On startup, if `config/settings.json` does not exist, the runner creates it by copying values from `.env` (or defaults). On subsequent runs, `settings.json` wins; `.env` values are ignored for keys present in `settings.json`.

---

## 5. Web UI

### 5.1 Server

`src/ui/server.ts` — Node native `http.createServer`, bound to `127.0.0.1` on `ERP_UI_PORT` (default 3737; if busy, try 3738..3747 then fail with a clear log line).

Endpoints (JSON unless noted):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Static `index.html` |
| GET | `/app.js`, `/styles.css` | Static assets |
| GET | `/api/status` | Live snapshot: ctx (energy/fuel/division/location), last cycle ts, last cycle reason, effectiveMode, weekly fuel pace |
| GET | `/api/settings` | Current `settings.json` |
| PUT | `/api/settings` | Validates payload against Zod schema, atomic-writes, returns new state |
| GET | `/api/history?limit=N` | Last N events from `sessions/history.jsonl` |
| GET | `/api/logs?lines=N` | Tail of `logs/agent-YYYY-MM-DD.log` |

No WebSocket — UI polls `/api/status` every 3 s (cheap; reads in-memory snapshot maintained by runner).

### 5.2 Frontend

Single `index.html` + `app.js` + `styles.css`. Vanilla JS, Tailwind via CDN, no build step (consistent with project's `tsx`-only philosophy).

Layout (single page):

- **Top bar:** account slug, `● RUNNING / ⏸ PAUSED` pill, two toggles (`Pause bot`, `Farm enabled`).
- **Live status card:** mode (with auto-source explainer), division, country, location (home/abroad), last cycle, energy bar, fuel bar.
- **Today card:** checklist of daily actions (work/train/food/VIP/missions/weekly tier) — read from `daily-state-{day}.json`.
- **Strategy card:** mode dropdown (`Auto (X)`, `Standard`, `D4-TW`, `Maverick-D3`), Maverick override link, per-mode settings pane (targets, weapon priority, max battles per session, with inline tooltips).
- **History card:** week-to-date counters (battles farmed, medals, est. gold, fuel pace).
- **Live logs:** collapsible, tail of today's log file.

### 5.3 Launch and access

`start.bat` runs the runner; runner opens `http://localhost:3737` in the default browser automatically. New `panel.bat` only opens the URL (for the case where the user closed the tab).

If `panel.bat` runs while the runner is stopped, the browser shows "connection refused" — acceptable per "monolithic" architectural choice. README mentions: "If the page won't load, run `start.bat` first."

### 5.4 Security

Bound to `127.0.0.1` only. No password. Only processes on the same machine can reach it. Matches user's choice; documented in README.

---

## 6. Implementation phases

Each phase is a standalone PR. Phases 1–4 ship the foundation (refactor + UI shell); 5–7 ship the new strategies and history.

| Phase | Scope | Risk |
|-------|-------|------|
| 1 | Strategy abstraction (refactor `farm/session.ts` into `strategies/standard.ts` + dispatcher). No behavior change. | Low — pure restructuring |
| 2 | `settingsStore.ts` + Pause/Farm toggles. Runner reads `paused`/`farmEnabled` per cycle. Migration from `.env`. | Low — additive |
| 3 | Read-only UI: HTTP server + static HTML, GET endpoints only, auto-open browser, `panel.bat` | Low — read-only |
| 4 | Editable UI: `PUT /api/settings` + frontend forms + `fs.watch` reload | Medium — write path; need atomic writes and Zod gate |
| 5 | D4-TW strategy: `damageFormula.ts`, `isSideEmpty`, `pickWeapon`, `strategies/d4tw.ts`, extend `extractCitizenContext` with `strength` + `rankValue` | Medium — new battle behavior; verify on a real TW |
| 6 | Maverick-D3 strategy + `maverick.ts` auto-detect with manual override | Medium — Maverick detection is the unknown |
| 7 | History store (`sessions/history.jsonl`) + history card in UI | Low — append-only events |

### 6.1 Allow-list additions

Confirmed additions:

- `GET /en/main/citizen-profile-json-personal/{citizenId}` (Phase 5) — supplies strength, rankNumber, and `activePacks.division_switch_pack` (Maverick check). One call covers damage formula + Maverick detection.
- `GET /en/economy/inventory-json` (Phase 5/6) — weapon inventory with bombs (Big Bomb Q22 = 5M dmg), bazookas, and Q1–Q7 ground weapons.

No new endpoints for D4-TW deploys themselves — `battle-stats`, `battlefieldTravel`, `deployWeapon`, `battle-console` already cover it.

---

## 7. Open questions (resolve during implementation)

| # | Question | Resolution path |
|---|----------|-----------------|
| 1 | ~~Strength/rank field paths~~ | **RESOLVED 2026-05-16:** `military.militaryData.strength`, `military.militaryData.rankNumber`. |
| 2 | ~~Maverick detection source~~ | **RESOLVED 2026-05-16:** `activePacks.division_switch_pack` in same endpoint. |
| 3 | Bazooka `type` field in `inventory-json` | Inspect on an account that owns bazookas during Phase 6; sample inventory had Big/Small Bomb (`type: "groundBomb"`) but no bazookas. |
| 4 | Mid-fight contested-side handling | Default: check only at start; if contested mid-fight, alert via Telegram and continue. Revisit if alerts get noisy. |
| 5 | UI port-collision behavior | Try 3737..3747 sequentially, log final port. No env var override in v1. |
| 6 | Whitelist countries for D4-TW | Out of v1; can be added in `settings.d4tw.blockedCountries: number[]` later. |

---

## 8. Validation

No automated end-to-end runner exists (project convention). Per phase:

- **Phases 1, 2, 4:** `npm run typecheck` + manual `npm run agent -- --once` smoke run.
- **Phase 3:** open `http://localhost:3737`, verify status card populates, logs tail.
- **Phase 4:** toggle Pause in UI; observe next cycle logs `[cycle] paused`.
- **Phase 5:** run `npm run agent -- --once` on a D4 account during an active native TW. Verify:
  - `isSideEmpty` returns correctly (compare with `battle-stats` raw response).
  - `damagePerHit` matches a manual formula calc for known S/R.
  - Deploy fires only if `hitsNeeded * energyPerHit <= poolEnergy`.
  - Skip-and-alert fires when underspending.
- **Phase 6:** test with one D4+Maverick and one D4-only account; verify auto-detect outcome and that override flips behavior.
- **Phase 7:** trigger a battle, check history.jsonl gets an event; UI history card updates after refresh.

Unit tests (vitest is already wired):

- `damageFormula.damagePerHit` — reference values from KB table (Recruit Q5 = 24, Sergeant Q7 = 112.50, etc.)
- `modeSelector.autoMode` — full truth table
- `pickWeapon` — priority-list selection + fallback
- `settingsStore.load` — schema parse + migration from `.env`

---

## 9. Acceptance criteria

This spec is "done" when:

- [ ] All three strategies are selectable via UI dropdown and via auto-detect, mode shown in dashboard matches the dispatcher's choice
- [ ] `Pause bot` toggle in UI makes the next cycle log `[cycle] paused` and skip all actions
- [ ] `Farm enabled: false` toggle makes the next cycle run daily actions but skip the farm gate
- [ ] D4-TW on a live native-country battle deploys hits only when the player's side is empty, hits stop at or just over the configured target damage, and skip-with-alert fires when the pre-check fails
- [ ] Maverick-D3 farms in D3 only when auto-detect (or manual override) says Maverick is owned, otherwise mode auto-falls back to D4-TW
- [ ] Settings changes in UI persist across runner restarts and survive `npm run agent -- --once`
- [ ] Browser opens automatically on `start.bat` (Windows), `panel.bat` reopens UI without restarting bot
- [ ] All endpoints used by new strategies are in `PHASE_1_ALLOWLIST`

---

## 10. Out of scope (explicit YAGNI)

| Item | Why deferred |
|------|--------------|
| Multi-account UI | One install per account today; user explicitly chose this. |
| Pause-until-date | User chose simple on/off; can add `pausedUntil: ISOString` field later. |
| LLM in decision loop | User explicitly chose deterministic per [[feedback_deterministic_first]]. |
| Time-window scheduling ("farm 19:00–23:00") | Not requested. Telegram alerts + manual toggle suffice. |
| Native tray app (Electron/Tauri) | Heavier ZIP, per-OS builds. Browser-based UI works on all OSes. |
| `0.0.0.0` bind + HTTP auth (mobile access) | Local-only is sufficient for v1. |
| D11 / air-mode strategy | Different game mechanics (fuel/level 70+); separate spec. |
| Multi-TW priority queue beyond `maxBattlesPerSession` | Session cap + weekly fuel budget already act as natural priority. |
| Per-battle damage-tracking from `battle-stats` post-start | Empty-side gate happens before deploy; if contested mid-fight we already committed energy. |
