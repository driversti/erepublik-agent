# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Three cooperating surfaces live here, sharing the same CloakBrowser profile, transport, and allow-list. **All are fully deterministic — no LLM is on the hot path.**

1. **Daily runner** (`src/agent/`, `npm run agent` / `npm start`) — long-running loop that on every cycle runs (a) the safe-daily sweep (work, train, buy 1 cheapest Q1 food, VIP claim, claim missions/objective chests/weekly-challenge tiers) **and** (b) an integrated farm gate that decides whether to run a farming session this cycle based on the weekly fuel budget, cooldowns, energy/fuel availability, and the per-account `farmEnabled` switch.
2. **Standalone farming CLIs** (`src/farmRunner.ts`, `src/farmOne.ts`, `src/showFarmableBattles.ts`) — operator-launched scripts for one-off / targeted runs (specific battle, dry-run inventory, debugging). They share the strategy implementations under `src/farm/strategies/` but bypass the gate and persistent fuel pacing.
3. **UI dashboard** (`src/ui/`, served at `http://localhost:$PORT` when the daily runner is up) — read-only snapshot + writeable `config/settings.json`. Writes are picked up live: the runner sleeps with `sleepUntilWake` (`fs.watch` on `settings.json`) so toggling pause/farm/strategy in the UI wakes the loop immediately.

> Historical note: until 2026-05-15 the daily runner was orchestrated by Claude Haiku via the Claude Agent SDK + an in-process MCP server. The model was only executing a fixed recipe with no real reasoning, so the LLM layer was removed in favor of a direct sequential call. The original design spec at `docs/superpowers/specs/2026-05-14-erepublik-agent-design.md` still describes the LLM-driven architecture.

## Commands

```bash
npm run bootstrap        # one-shot manual login (headed by default), persists CloakBrowser profile
npm run healthcheck      # verifies the persisted session still authenticates
npm run missions         # prints today's missions and short-circuit status
npm run agent            # daily loop, one cycle (= `start -- --once`)
npm start                # daily loop, long-running; integrated farm gate + UI dashboard;
                         #   sleeps LOOP_INTERVAL_MS between cycles (or wakes early on settings.json change)

# Standalone farming CLIs. Dry-run by default; add `-- --execute` to fight.
npm run farmable         # lists candidate battles (empty division, wall.dom=50) for this account
npm run farmer           # full pipeline: discover → filter → both-side deploy on each candidate
npm run farm-one -- --battle=<id> [--execute] [--side=invader|defender|both] [--skip-empty-check]

# Tests / typecheck (vitest)
npm test                 # vitest run (one-shot)
npm run test:watch       # vitest --watch
npm run typecheck        # tsc --noEmit

# Debug helpers
npm run debug-deploy     # one-shot deploy probe with verbose request/response logging
npm run debug-headers    # dumps headers the in-page fetch is sending (useful when eRepublik returns 403)
```

Tests use vitest — co-located `*.test.ts` files cover `fuelBudget`, `modeSelector`, `pickWeapon`, `pickBomb`, `damageFormula`, `resolveCountries`, and the UI primitives (`settingsStore`, `historyStore`, `logsTail`, `sleepUntilWake`, `server`). No lint command is wired up.

A new account always starts with `bootstrap` to populate `sessions/profile/{ERP_ACCOUNT_SLUG}/`. Subsequent runs reuse that profile via `openSession` and never touch `ERP_LOGIN`/`ERP_PASSWORD`.

## Architecture

### Cycle flow (`src/agent/runner.ts` → `runCycle`)

1. Compute `eRepublikDay()` + `eRepublikWeek()` (PST anchors from `src/erepublik/{day,week}.ts`, **not** UTC). `loadOrInit` archives any stale `daily-state-*.json` and creates a fresh file when the day rolls; `loadFuel` does the same for `weekly-fuel-state.json` on Tuesday 00:00 PST week rollover.
2. `loadSettings()` reads `config/settings.json` (Zod-parsed; first run is seeded from `.env`). If `settings.paused === true` → log + return **before** any page interaction.
3. `extractCitizenContext({ refresh: true })` navigates to `/en/military/campaigns`, then reads CSRF, `countryId`, `citizenId`, `division`, energy/pool, `fuelLeft`, `currentRegionId`, `residenceRegionId`, `hasMaverick`, etc., from `SERVER_DATA` / `erepublik.citizen` globals. `countryId` is auto-detected; `ERP_COUNTRY_ID` env is a fallback only. `handleCaptchaIfPresent()` runs right after — if a captcha is detected and unsolved, `runCycle` throws and the runner sleeps until the next interval.
4. **Update `awaySince` timer** by comparing `currentRegionId` to `residenceRegionId` (the auto return-home trigger fires later, in the idle branch).
5. Read API state: `getMissionState`, `getObjectiveStatus`, `getWeeklyChallenge`. `reconcile()` marks safe-daily actions as `source: 'external'` when the API says they're done but local memory disagrees (player did it manually or another bot).
6. **Short-circuit safe-daily**: if `allSafeDailyDone(state) && no unclaimed missions/objectives/weekly tiers` → skip the action sequence + sweeps. Otherwise: derive `pending = pendingActions(state)`, call `runAction(action, ...)` once for each pending item in the fixed order `work → train → vipClaim → buyFood` (each successful action immediately writes its flag onto `state.completedActions`), then run the three idempotent sweeps (`collectMissionRewards`, `collectObjectiveRewards`, `collectWeeklyChallenge`).
7. **Farm gate** (only if `settings.farmEnabled`): call `decideFarming({ weekly: fuel, poolEnergy, fuelInInventory, maxBattlesPerSession })`. If `shouldFarm === true`, resolve the active strategy via `effectiveMode(settings, detected)` (Standard / D4TW / MaverickD3, see below), then `getStrategy(mode).run(ctx, info, opts)`. On completion: bump `fuel.spent`, `fuel.hitsLanded`, `fuel.lastFarmedAt`, and `rollNextEligibleAt()` for the cooldown jitter. If `shouldFarm === false`, we may instead `travelHome()` (when `state.awaySince` is older than `ERP_RETURN_HOME_AFTER_MINUTES`) — only in the idle branch to avoid wasting a round-trip we'd immediately undo.
8. Persist `DailyState` + `WeeklyState` + `WeeklyFuelState` (`finally` block — runs even if a step threw). Refresh the `UiSnapshot` for the dashboard, then `appendHistory({ type: 'cycle', reason })`. If the snapshot hash changed, send a Telegram digest and store the new hash.
9. `sleepUntilWake(LOOP_INTERVAL_MS, settings.json)` — wakes on timeout **or** on `settings.json` change (so UI toggles take effect immediately).

### Layering — do not skip levels

```
agent/runner.ts                  loop, day/week rollover, paused gate, short-circuit, action sequence, farm gate, sweeps, UI snapshot, digest
  agent/cycle.ts                 reconcile(API → memory)
  agent/fuelBudget.ts            decideFarming() pacing + rollNextEligibleAt() cooldown jitter
  agent/modeSelector.ts          effectiveMode(): settings.modeOverride > maverickManual+division > autoMode
  farm/strategies/{standard,d4tw,maverickD3}.ts   per-mode farm session implementations
  farm/routing.ts                side ordering / next-pick for the empty-div pipeline
  ui/{server,snapshot,settingsStore,historyStore,sleepUntilWake}.ts   dashboard + live settings + wake-on-change
  tools/*.ts                     semantic operations (work, train, market, claim, travel, captcha, farm, battles, …)
    transport/apiCall.ts         context.request.fetch + CSRF + allow-list assertion
      transport/allowlist.ts     the inviolable endpoint set
        browser/session.ts       CloakBrowser persistent context
```

Every HTTP call goes through `apiCall()`, which calls `assertAllowed()` and throws on anything outside `PHASE_1_ALLOWLIST`. **Adding any new endpoint requires editing `src/transport/allowlist.ts` — there is no other way in.**

### Memory model

On-disk state lives under `sessions/` (path resolved by `src/paths.ts`; root anchor is `process.cwd()` or `$ERP_ROOT`):

- `sessions/daily-state-{day}.json` — `DailyState` (Zod schema in `src/memory/schema.ts`). Tracks `completedActions` (work/train/buyFood/vipClaim, each with `at` + `source: 'agent' | 'external'`), `claimedMissionIds[]`, `claimedChestThresholds[]`, `awaySince` (ISO timestamp of when we first observed the citizen abroad — drives the return-home trigger), `lastDigestHash`. On day rollover, previous file becomes `daily-state-{prevDay}.archive.json`.
- `sessions/weekly-state.json` — `WeeklyState` with `lastClaimedRewardId` (weekly-challenge progress). Resets are detected when `weeklyStatus.maxCompleted < lastClaimedRewardId` (cleared automatically).
- `sessions/weekly-fuel-state.json` — `WeeklyFuelState` (Tuesday-anchored eRepublik week). Tracks `week`, `spent` (fuel barrels consumed this week, cap 70), `hitsLanded`, `lastFarmedAt`, `nextEligibleAt` (cooldown jitter target), `cyclesSkipped`. Week rollover archives to `weekly-fuel-{prevWeek}.archive.json`.
- `config/settings.json` — `Settings` (Zod schema in `src/ui/settingsStore.ts`). UI-editable + first-run seeded from `.env`. Carries `paused`, `farmEnabled`, `modeOverride`, `maverickManual`, per-mode tuning (`d4tw.*`, `emptyDiv.*`), `travel.*`, `farmSession.cooldown{Min,Max}Minutes`, and a `detected` block the runner stamps with the latest auto-observed division / Maverick / IDs. Atomic writes via tmpfile + rename.
- **`runCycle` is the only writer of session memory.** Tools return results; `runAction()` and the farm-gate / sweep blocks in `runCycle` mutate `state` / `weekly` / `fuel` after each successful call. Don't write to memory from inside `tools/*.ts` or `farm/strategies/*.ts`.

### Integrated farm gate (`src/agent/fuelBudget.ts`, `src/farm/strategies/`)

The daily runner's farm gate is what actually drives day-to-day medal farming on a long-running install — the standalone CLIs (below) are operator-only escape hatches.

**Decision** (`decideFarming` in `src/agent/fuelBudget.ts` — pure, unit-tested):

1. **Hard stops** in order: `WEEKLY_BUDGET=70` exhausted → no. No fuel barrels in inventory → no. `poolEnergy < ENERGY_PER_BATTLE` (66, Standard-strategy-specific — see the NOTE in `fuelBudget.ts` for D4TW/Maverick deviations) → no.
2. **Cooldown jitter** — `weekly.nextEligibleAt` is set after every session to `now + uniform(SESSION_COOLDOWN_{MIN,MAX}_MIN)` (default 30–90 min, overridable via `settings.farmSession.cooldown{Min,Max}Minutes` or `ERP_SESSION_COOLDOWN_{MIN,MAX}_MIN` on first run). Returns "cooldown: Xm until next eligible" until elapsed.
3. **Pacing brake** — `weekFraction` is the fraction of the Tuesday-anchored eRepublik week elapsed (0.0 → 1.0, from `src/erepublik/week.ts`). `target = floor(70 * weekFraction)`, `ahead = spent - target`. If `ahead >= PACE_OVERSHOOT_TOLERANCE (5)` → no, "letting it equalize". This is how the bot stays on rhythm instead of dumping all 70 barrels Monday night.
4. **Session size** = `min(sessionCap, energyBudget, fuelBudget, paceBudget)` where `sessionCap = settings.emptyDiv.maxBattlesPerSession` (default 3, seedable from `ERP_EMPTY_DIV_MAX_BATTLES_PER_SESSION`), `paceBudget = max(1, target - spent + 2)`. If 0 → no.

**Strategy resolution** (`effectiveMode` in `src/agent/modeSelector.ts`):

- `settings.modeOverride` wins if set (operator force-pick).
- Otherwise: `autoMode(division, hasMaverick)` — `d ≤ 3` → `standard`, `d === 4 && maverick` → `maverickD3`, `d === 4` → `d4tw`, else → `standard`. `maverickManual` overrides the detected Maverick flag.
- `getStrategy(id).run(ctx, info, opts)` runs the picked strategy. All strategies share the same `FarmStrategy` interface in `src/farm/strategies/types.ts` and return `{ wins, skipped, stopReason, fuelLeftAtEnd }`.

**Empty-div pipeline** (used by `standard` and `maverickD3` strategies, also by the standalone CLIs). Per battle:

1. `listFarmableBattles` (`/military/campaignsJson/list`) → all active battles where the player's division has `wall.dom === 50` and `division_end === false`. D4TW uses `listMyCountryActiveBattles` instead (different criteria).
2. `getCitizenEligibility` (`/military/campaignsJson/citizen`) → filter to battles where we can deploy on **both** sides (native citizen, `isMercenary`, or `isFreedomFighter` in RWs).
3. `isBattleDivisionEmpty` (`/military/battle-stats/{battleId}/{div}/{battleZoneId}`) → confirm zero damage in our division (the only authoritative empty signal — `wall.dom === 50` alone is not enough).
4. `findCheapestTravelRegion` (`/main/travelData`) → cheapest region on each side. Skip if either side exceeds `settings.travel.maxTravelCC` (`ERP_FARM_MAX_TRAVEL_CC` on first run).
5. For each side: `battlefieldTravel` → `getDeployInventory` → `deployWeapon` (Q-1 no-weapon, 33 energy/hit for Standard; bomb for Maverick) with retry-and-verify against `battle-console`. Between sides: sleep, `verifyHitRegistered`, `cancelDeploy` (to clear the "already fighting" lock before defender's travel).

Stop conditions for a session: `maxBattles` reached, `fuelLeft < ERP_FARM_MIN_FUEL`, `poolEnergy < TOTAL_ENERGY*2`, a `Forbidden` response (IP/account flagged — abort immediately, `ForbiddenError`), or `EnergyExhaustedError`.

**Per-battle Telegram notification** — every battle attempt emits exactly one message via `cfg.notify` (the runner-supplied `TelegramNotifier`). On success (both sides verified for empty-div, single deploy for D4TW): `💥 [#id Region](url) — 🇽🇽 vs 🇽🇽 · Dn`. On failure (partial battle, deploy refused, travel blocked, missing energy/ammo): `⚠️ [#id Region](url) — 🇽🇽 vs 🇽🇽 · Dn` + reason. Formatters live in `src/util/battleNotification.ts`; flag emojis come from `src/util/countryFlag.ts` (countryId → ISO-2 → regional-indicator codepoints). The URL is a division-specific deep-link `/en/military/battlefield/{battleId}/{battleZoneId}` — the trailing `battleZoneId` lands the operator on the exact division the agent hit (necessary for Maverick, which fights in D3 from a D4 native account; eRepublik's default URL would open the citizen's native division). The pattern is confirmed against ePlus' `divisionSwitcher` userscript. `disable_web_page_preview: true` is already set on the notifier, so the link doesn't expand to a card. Session-level stops (`ForbiddenError`, `EnergyExhaustedError`) intentionally skip per-battle notification — they surface in the runner's digest instead.

Important field-name quirks captured by `tools/farm.ts`:
- `battlefieldTravel` form expects `inRegionId` (not `toRegionId`) — that's the campaign-side endpoint's spelling.
- `deployWeapon` requires at least one `energySources[N]` entry; for the no-weapon path we send `quality:1, amount:0` to signal "draw from pool, don't burn food".
- Default skin per division if no active vehicle: `{1:14, 2:15, 3:16, 4:17, 11:18}` (`skinForDivision`).

### Standalone farming CLIs (`src/farmRunner.ts`, `src/farmOne.ts`, `src/showFarmableBattles.ts`)

These bypass the gate, the cooldown, and the persistent `WeeklyFuelState` writes — they're for operator one-shots and debugging.

- `npm run farmable` → dry-run discovery (steps 1-3 above), prints candidate battles. No side effects.
- `npm run farmer` → end-to-end pipeline of the **empty-div** path, capped by `ERP_FARM_MAX_BATTLES` (default 5).
- `npm run farm-one -- --battle=<id>` → target one specific battle; `--side=invader|defender|both`, `--skip-empty-check`, `--execute`.

Stop conditions and field-name quirks are the same as the integrated path (they share `src/farm/strategies/standard.ts`).

### Safety boundaries

- **Endpoint allow-list** (`src/transport/allowlist.ts`) — every HTTP call must match `(method, path)` in `PHASE_1_ALLOWLIST` or `apiCall` throws. The set currently covers: auth/profile read (`/main`, `/login`, `/citizen/profile/`, `/main/citizen-profile-json-personal/`, `/economy/inventory-json`, `/main/messages-paginated`), missions/objectives/weekly read+claim, marketplaceAjax/Actions, work, training-grounds-json + train, vip-claim, the residence-travel endpoint (`/main/travel`), and the farming endpoints (`campaignsJson/list|citizen`, `battle-stats/`, `travelData`, `battlefieldTravel`, `fightDeploy-{getInventory,startDeploy,cancelDeploy}`, `battle-console`).
- **Per-action guards** — `buyFromOffer` hard-rejects `amount !== 1`; `buyOneCheapestFood` is hardcoded to `industry=FOOD, quality=1` and refuses to buy above `ERP_MAX_FOOD_PRICE`.
- **Once-per-cycle gating** — `runAction()` is only invoked for items in `pendingActions(state)`. A successful action flips the flag in memory immediately, so the same call can never fire twice within a single eRepublik day.
- **Playwright clicks** are reserved for the login flow in `bootstrap.ts` and the captcha solver in `tools/captcha.ts`. Everything else is `fetch` through the authenticated browser context.

### Captcha handling (`src/tools/captcha.ts`)

eRepublik throws a session-unlock captcha (image-coordinate challenge) when it suspects bot activity. The handler mirrors the ePlus userscript flow (`ePlus/client/src/plugins/premium/captchaSolver.ts`):

1. **Detect** — `runCycle` calls `handleCaptchaIfPresent()` right after `extractCitizenContext()`. It checks the current page DOM for `#startSessionVerify` (the verify button) or `#captchaImage`.
2. **Reveal** — `page.evaluate(() => #startSessionVerify.click())` to surface the image; then `page.waitForFunction` until `#captchaImage.src` starts with `data:image`.
3. **Solve** — provider `2captcha` POSTs the base64 to `api.2captcha.com/createTask` as a `CoordinatesTask`, polls `getTaskResult` every 5s (≤2 min), and gets back `[{x, y}, …]`.
4. **Submit** — for each coordinate, dispatch a synthetic `MouseEvent('click', { clientX: rect.left + x, clientY: rect.top + y })` on the image (the captcha JS derives `offsetX/Y` from these). Then click `#sessionUnlockSubmit`.
5. **Verify + retry** — wait ~2.5s, re-check for `#startSessionVerify`. If still present, click `#refreshIcon` and retry up to `ERP_CAPTCHA_MAX_ATTEMPTS`.

If detected but unsolved (provider=`none`, no API key, or all attempts failed), `runCycle` throws and the runner sleeps to the next interval. Telegram alerts fire on detect / success / failure.

Configuration (env vars): `ERP_CAPTCHA_PROVIDER` (`none` default | `2captcha`), `ERP_CAPTCHA_API_KEY`, `ERP_CAPTCHA_MAX_ATTEMPTS` (default 3). The captcha submission goes through eRepublik's in-page JS (not our `apiCall`), so no `allowlist.ts` entry is required.

### Auto return-home (`src/tools/travel.ts`)

After a farm session the citizen is stranded in some foreign region, losing the residence energy bonus. The agent mirrors ePlus' `returnHome` plugin: track time-since-leaving in `DailyState.awaySince`, travel back once the threshold expires.

1. **Observe** — `extractCitizenContext` reads `erepublik.citizen.regionLocationId` / `countryLocationId` (same fields ePlus uses) into `ctxInfo.currentRegionId`. At the start of every cycle `runCycle` compares `currentRegionId` to `residenceRegionId`: clears `awaySince` when home, sets it to `now` when first observed abroad.
2. **Defer past the farm gate** — the return trip only fires in the `!decision.shouldFarm` branch (idle cycles). If the gate says "farm" we'd be moving again anyway, so the round-trip would be wasted.
3. **Pre-check cost** — `travelHome` first calls `/main/travelData` and reads `regions[residenceRegionId].cost`. Travel home is **NOT free** — it scales with distance just like any other trip. If cost > `ERP_RETURN_HOME_MAX_CC`, the trip is skipped and Telegram is alerted.
4. **Execute** — POST `/en/main/travel` with `check=moveAction&travelMethod=preferCurrency&inRegionId=…&toCountryId=…`. On success, `awaySince` is cleared and the digest reflects the new state.

Configuration (env vars seed `settings.travel` on first run): `ERP_RETURN_HOME_AFTER_MINUTES` (default 15, matches ePlus; 0 disables), `ERP_RETURN_HOME_MAX_CC` (default 500). After first run, edit `settings.travel.returnHomeAfterMinutes` / `returnHomeMaxCC` in `config/settings.json` (or via the UI) — `.env` is no longer consulted. The endpoint `/en/main/travel` is in `allowlist.ts`.

### UI dashboard (`src/ui/`)

`startUiServer({ getSnapshot })` runs an in-process HTTP server alongside the daily runner. The URL is logged at startup (`http://localhost:$PORT`). It serves:

- `src/ui/public/` — static HTML/JS dashboard reading the live snapshot.
- `GET /api/snapshot` — returns the current `UiSnapshot` (citizen + dailyActions + weeklyFuel + settings + lastError + lastFarmReason).
- `PUT /api/settings` — atomic write to `config/settings.json` (Zod-validated). The runner's `sleepUntilWake` watches that file and breaks out of its sleep on any change, so toggling `paused` / `farmEnabled` / `modeOverride` / per-mode tuning is reflected in the **next** cycle (no restart needed).
- `GET /api/history` / `GET /api/logs` — recent `HistoryEvent[]` (cycles, battle wins, mode changes, errors) and tailed log lines.

`paused: true` short-circuits `runCycle` **before** `extractCitizenContext` runs, so the page is never refreshed while paused — that minimizes both flag-risk and CSRF churn. Trade-off documented inline in `runner.ts`: a captcha appearing during a paused window won't be detected until unpause.

`HEADED=true` opens the CloakBrowser window so you can watch the runner click around — useful for first-run captcha resolution or visually debugging the integrated farm gate.

### Extending the agent

- **Adding a new daily action** (work-like, runs once per game day): add the endpoint to `allowlist.ts`, write a pure tool function in `tools/*.ts` (no memory writes), then add a branch in `runAction()` and an entry to `pendingActions(state)` / the `completedActions` schema. The runner is the only writer.
- **Adding a new sweep** (claim-like, idempotent every cycle): same allowlist + tool, then call from the sweep block in `runCycle` after the action loop. Persist via `state.claimed*` arrays.
- **Adding a new farming strategy**: implement the `FarmStrategy` interface in `src/farm/strategies/types.ts`, register it in `src/farm/strategies/index.ts`, extend `StrategyId` in `settingsStore.ts` + `modeSelector.ts` (auto-mode rules), and wire any new endpoints through `allowlist.ts`. The integrated farm gate picks it up automatically once registered.
- **Tweaking the integrated farm gate**: `decideFarming` is pure — change pacing logic in `src/agent/fuelBudget.ts` and update the co-located vitest file. Cooldown defaults come from `SESSION_COOLDOWN_{MIN,MAX}_MIN` constants; per-account overrides flow through `settings.farmSession.cooldown{Min,Max}Minutes`.
- **Adding a UI setting**: extend `Settings` in `src/ui/settingsStore.ts` (Zod schema + `buildInitial` for env-var seeding), surface in `src/ui/public/index.html` + `app.js`, then read `settings.X` in `runner.ts`.

## Conventions specific to this codebase

- **ESM + TypeScript via `tsx`**, no build step. Source imports use `.js` suffixes (`../tools/missions.js`) even though files are `.ts` — required by `moduleResolution: Bundler` + ESM.
- **eRepublik form bodies** are `application/x-www-form-urlencoded` with `_token: csrf` prepended automatically by `apiCall`. POSTs need `X-Requested-With: XMLHttpRequest` (also set by `apiCall`). Don't bypass `apiCall`.
- **CSRF is per-page, not per-session.** `extractCitizenContext` re-reads it from the page each cycle — fine because cycles are minutes apart and CloakBrowser keeps the same tab.
- **Mission IDs to remember**: 100001 = work, 100003 = train, 100011 = buy food. Mapped in `agent/cycle.ts:SAFE_DAILY_MAP`. VIP claim is **not** in `daily-missions-data`, so `reconcile()` is a no-op for it — the `vipClaim` action is the only writer of that flag.
- **Battlefield deploys need a real page navigation first** — `farmOne.ts` / `farmRunner.ts` call `page.goto(/military/battlefield/{battleId})` before any deploy fetch, because the browser-enforced `Referer` is what the deploy endpoints check. You cannot set it programmatically from `apiCall`.
- **`Forbidden` from a deploy endpoint = stop, don't retry.** It means the IP/account is flagged. The farm runner throws `ForbiddenError` and aborts the whole run; preserve that behavior in any new fighting code.
- **Telegram notifier degrades silently** if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are unset — `send()` and `sendError()` are no-ops. Safe to leave blank for local dev.

## Knowledge Base

When implementing a new action or debugging an API response shape, check `~/KnowledgeBase/Erepublik/API_MILITARY.md` and the rest of `~/KnowledgeBase/Erepublik/` first — that's the authoritative endpoint reference for the monorepo.
