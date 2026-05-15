# erepublik-agent

Browser-driving automation for eRepublik, built on **CloakBrowser** (stealth Chromium) and the **Claude Agent SDK**. The repo hosts **two cooperating workloads** that share the same browser profile, transport layer, and endpoint allow-list — but are otherwise independent:

| Workload | Driver | What it does | Entry points |
|---|---|---|---|
| **Daily agent** (LLM-orchestrated) | Claude Haiku 4.5 | Performs the safe-daily loop: `work`, `train`, buy 1 Q1 food, claim VIP, claim missions + AP chests + weekly challenge tiers. Long-running by default. | `npm start` / `npm run agent` |
| **Gold-farming pipeline** (operator-only) | Plain TypeScript | Discovers empty-division battles, plans a cheapest-travel route, deploys on **both** sides to collect True Patriot / Freedom Fighter / Mercenary medals. **Not exposed to the LLM.** | `npm run farmer`, `npm run farm-one`, `npm run farmable` |

The LLM only sees a fixed set of MCP tools registered in `src/agent/tools.ts`. The farming CLIs are deliberately separate — there is no MCP tool that fights, deploys, or travels, so Claude **cannot** spend energy on its own even if jailbroken.

> Full design lives in `docs/superpowers/specs/2026-05-14-erepublik-agent-design.md`.

---

## Setup

```bash
cp .env.example .env
# Fill in: ERP_LOGIN, ERP_PASSWORD, ANTHROPIC_API_KEY, ERP_MAX_FOOD_PRICE.
# Telegram, farming, and tuning vars are optional.

npm install
npm run bootstrap        # opens a visible browser, you log in once; profile persists
npm run healthcheck      # confirms the persisted session still authenticates
```

After `bootstrap`, the CloakBrowser profile lives in `sessions/profile/<ERP_ACCOUNT_SLUG>/` and is reused by every other script. Credentials are **only** read by `bootstrap.ts` — they are never touched again.

For a second account: set a different `ERP_ACCOUNT_SLUG`, re-run `bootstrap`, then point the agent / farmer at that slug.

---

## Daily agent (LLM loop)

```bash
npm run agent            # one cycle, then exit
npm start                # long-running: cycle every LOOP_INTERVAL_MS (default 10 min)
```

### What each cycle does

1. Computes the current **eRepublik day** (PST midnight epoch — not UTC). Loads `sessions/daily-state-{day}.json`. If the day has rolled over, the previous file is archived.
2. Reads `csrfToken`, `citizenId`, `countryId` from the live page (`SERVER_DATA` / `erepublik.citizen`).
3. Calls three read-only endpoints: daily missions, objective chests, weekly challenge.
4. **Reconciles** the API state into local memory — if the player did `work` manually (or another bot did it), the local flag is set to `source: 'external'` so the agent won't redo it.
5. **Short-circuits**: if every safe-daily action is done AND there is nothing left to claim, the cycle exits **without calling Claude**. This is the hot path — most ticks of a long-running loop never spend Anthropic tokens.
6. Otherwise invokes Claude with a fixed-shape system prompt listing the pending actions. Claude is restricted to the MCP tools below; `MAX_AGENT_ITERATIONS` (default 8) hard-caps the tool loop.
7. Saves state. If anything changed since the last cycle, sends a Telegram digest (silent if no token configured).

### MCP tools the LLM can call

| Tool | What it does |
|---|---|
| `getMissionState` | Read today's missions + which safe-daily ones are still pending. |
| `work` | Mission 100001. POST `/en/economy/work`. Once per day. |
| `train` | Mission 100003. Sweeps all free training grounds. Once per day. |
| `buyFood` | Mission 100011. Buys 1 unit of the cheapest Q1 food on the home marketplace. **Hard-rejects if price > `ERP_MAX_FOOD_PRICE`**, and `amount` is hard-coded to 1. |
| `vipClaim` | Daily VIP gift. Idempotent. |
| `collectMissionRewards` | Sweeps every completed mission and claims its reward. |
| `collectObjectiveRewards` | Sweeps unlocked AP chests (20/40/60/80/100). |
| `collectWeeklyChallengeRewards` | Claims any newly-unlocked weekly tier (with reset detection). |

> Everything outside this list is unreachable — see *Safety boundaries* below.

### Memory layout

```
sessions/
  profile/<slug>/                   # CloakBrowser profile (cookies, fingerprint)
  daily-state-{day}.json            # today's state (active)
  daily-state-{day-1}.archive.json  # archived after rollover
  weekly-state.json                 # last-claimed weekly reward id
```

`DailyState` (Zod schema in `src/memory/schema.ts`):

- `completedActions.{work|train|vipClaim|buyFood}` — each tagged `source: 'agent' | 'external'`
- `claimedMissionIds[]`, `claimedChestThresholds[]`
- `lastDigestHash` — used to suppress no-op Telegram pings

---

## Gold-farming pipeline (operator-only)

Three CLIs, none of them callable by the LLM. **All default to dry-run.** Add `--execute` to actually deploy.

### `npm run farmable` — read-only scout

Lists every active battle where:
- Your division has `wall.dom === 50` (caretaker / empty),
- The division has not ended (`division_end === false`),
- The first authoritative empty signal (`/en/military/battle-stats/...`) confirms zero damage in your division.

Use this to eyeball what's currently farmable from your residence region.

### `npm run farm-one -- --battle=<id>` — one battle, both sides

```bash
# Dry-run: prints the planned route + costs, never deploys.
npm run farm-one -- --battle=12345

# Fight one side only:
npm run farm-one -- --battle=12345 --side=invader --execute
npm run farm-one -- --battle=12345 --side=defender --execute

# Fight both sides:
npm run farm-one -- --battle=12345 --side=both --execute

# Skip the empty-division check (dangerous — use only for debugging known-good targets):
npm run farm-one -- --battle=12345 --execute --skip-empty-check
```

Sequence on `--execute`:
1. Navigate the open page to `/en/military/battlefield/{battleId}` (the browser-enforced `Referer` is what the deploy endpoint checks — not settable programmatically).
2. Cancel any stale deployment session.
3. For each requested side: `travelData` → cheapest region → `battlefieldTravel` → `fightDeploy-getInventory` → `fightDeploy-startDeploy` with Q-1 no-weapon, 33 energy/hit. On error: retry up to `MAX_HIT_ATTEMPTS` (5) and verify against `battle-console` whether the hit slipped through anyway.
4. Between sides: wait, verify the previous hit registered, then `cancelDeploy` to clear the "already fighting" lock before the next travel.

### `npm run farmer` — full pipeline across many battles

```bash
npm run farmer                       # dry-run, default cap of 5 battles
npm run farmer -- --execute          # actually deploy
```

Pipeline per pass:

1. **Discover**: `campaignsJson/list` → active battles → filter to my division + `wall.dom === 50`.
2. **Eligibility**: `campaignsJson/citizen` → keep only battles where I can deploy on **both** sides (native citizen, `isMercenary`, or `isFreedomFighter`).
3. **Filter**: drop battles younger than `ERP_FARM_MIN_BATTLE_MINUTES`, blocked countries, and any where both combatants are the same id.
4. **Route**: use a cluster-by-country router (`src/farm/routing.ts`). Plain English: *"is there a battle in the country I'm already standing in? Then fight that one first and minimize the next hop. Otherwise, bridge to the cheapest reachable cluster."* Per-hop ceiling is `ERP_FARM_MAX_TRAVEL_CC`.
5. **Verify empty**: `battle-stats/...` — `wall.dom === 50` alone is not enough.
6. **Fight both sides** (same as `farm-one`), advance routing state, log hops + total CC.

#### Stop conditions

| Condition | What happens |
|---|---|
| `farmedCount >= ERP_FARM_MAX_BATTLES` | Normal stop. |
| `fuelLeft < ERP_FARM_MIN_FUEL` | Stop — out of vehicle fuel. |
| `poolEnergy < ERP_FARM_TOTAL_ENERGY * 2` | Stop — not enough energy for another both-sides round. |
| `Forbidden` from any deploy endpoint | **Abort the whole run.** IP/account is flagged. Swap IP / wait — do not retry. |
| `EnergyExhaustedError` (≥ half of retries were "Not enough energy") | Abort the run, pool is dry. |
| No reachable battle within `ERP_FARM_MAX_TRAVEL_CC` per hop | Stop — log how many were left unreachable. |

End-of-run summary prints: battles farmed, attempts per side, last fuel, total hops, total travel CC, and the country sequence (e.g. `c40 → c40 → c11 → c11 → c33`).

### Debug helpers

| Command | Purpose |
|---|---|
| `npm run debug-deploy` | One-shot deploy probe with verbose request/response logging. Useful when a 403 needs picking apart. |
| `npm run debug-headers` | Dumps the headers the in-page `fetch` is actually sending. Useful for diffing against a working browser session. |

---

## All scripts

| Command | Purpose |
|---|---|
| `npm run bootstrap` | One-shot manual login (headed). Persists CloakBrowser profile. |
| `npm run healthcheck` | Verifies the persisted session still authenticates. |
| `npm run missions` | Prints today's missions and short-circuit status (read-only). |
| `npm run agent` | LLM daily loop, **one** cycle. |
| `npm start` | LLM daily loop, long-running. Sleeps `LOOP_INTERVAL_MS` between cycles. |
| `npm run farmable` | Lists candidate battles (empty division, wall.dom=50). |
| `npm run farm-one` | Single-battle farming. Dry-run unless `--execute`. |
| `npm run farmer` | Multi-battle farming with routing. Dry-run unless `--execute`. |
| `npm run debug-deploy` | Verbose one-shot deploy probe. |
| `npm run debug-headers` | Inspect in-page fetch headers. |
| `npm run typecheck` | `tsc --noEmit`. |

There is no test runner and no lint command in this project.

---

## Environment variables

### Core (always required)

| Var | Purpose |
|---|---|
| `ERP_LOGIN` / `ERP_PASSWORD` | eRepublik credentials. Only read by `bootstrap`. |
| `ERP_ACCOUNT_SLUG` | Profile directory name under `sessions/profile/<slug>/`. Default `main`. |
| `ERP_MAX_FOOD_PRICE` | Hard ceiling on Q1 food unit price for `buyFood`. Typical Q1 prices are 0.5–2.0. |
| `HEADED` | `true` to show the browser. Default `false`. |

### Daily agent

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key. |
| `CLAUDE_MODEL` | Default `claude-haiku-4-5`. |
| `MAX_AGENT_ITERATIONS` | Hard cap on tool calls per cycle. Default `8`. |
| `LOOP_INTERVAL_MS` | Sleep between cycles in long-running mode. Default `600000` (10 min). |
| `ERP_COUNTRY_ID` | Fallback only — `countryId` is normally auto-detected from `erepublik.citizen.citizenshipCountryId`. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Optional. Notifier degrades silently if unset. |

### Farming

| Var | Default | Purpose |
|---|---|---|
| `ERP_FARM_MAX_BATTLES` | `5` | Per-run cap. |
| `ERP_FARM_MAX_TRAVEL_CC` | `400` | Per-hop travel ceiling (in country currency). |
| `ERP_FARM_MIN_FUEL` | `10` | Stop when vehicle fuel drops below this. |
| `ERP_FARM_MIN_BATTLE_MINUTES` | `5` | Skip battles younger than this. |
| `ERP_FARM_WEAPON_QUALITY` | `-1` | `-1` = no-weapon (cheap). Q10 bazookas cost 11 energy/hit but are premium. |
| `ERP_FARM_TOTAL_ENERGY` | `33` | Energy spent per hit. |
| `ERP_FARM_MAX_ATTEMPTS` | `10` | Per-side deploy retries before giving up. |
| `ERP_FARM_RETRY_DELAY_MS` | `500` | Delay between retries. |
| `ERP_FARM_HANDOFF_SLEEP_MS` | `2000` | Wait between side A and side B so the first deploy settles. |
| `ERP_FARM_BLOCKED_COUNTRIES` | `''` | CSV of country IDs to never deploy on. |
| `ERP_FARM_WHITELIST_COUNTRIES` | `''` | CSV of country IDs to prefer (sorted first in the queue). |

---

## Safety boundaries

The two safety layers are independent — both have to be passed for any HTTP call to go out.

### 1. Endpoint allow-list (`src/transport/allowlist.ts`)

Every HTTP call goes through `apiCall()` → `assertAllowed(method, path)` → throws if `(method, path)` isn't in `PHASE_1_ALLOWLIST`. The current set covers:

- **Auth / profile read**: `/en/main`, `/en/login`, `/en/citizen/profile/...`, `/en/main/messages-paginated`
- **Mission / objective / weekly**: `daily-missions-data`, `objective-status`, `objective-claim-reward`, `mission-solve`, `weekly-challenge-data`, `weekly-challenge-collect-all`
- **Safe daily actions**: `economy/work`, `training-grounds-json`, `economy/train`, `marketplaceAjax`, `marketplaceActions`, `vip-claim`
- **Farming**: `campaignsJson/list`, `campaignsJson/citizen`, `battle-stats/...`, `travelData`, `battlefieldTravel`, `fightDeploy-{getInventory,startDeploy,cancelDeploy}`, `battle-console`

> Adding any new endpoint **requires editing `allowlist.ts`**. There is no other way in.

### 2. LLM tool surface (narrower than the allow-list)

The agent only sees the MCP tools listed under *Daily agent → MCP tools*. The **farming endpoints in the allow-list are reachable only from the operator-launched CLI scripts**, never from Claude. If you ever register a farming MCP tool, the agent gains the ability to spend energy in battles — that's an explicit design decision, not the current state.

### 3. Per-action guards

- `buyFromOffer` hard-rejects `amount !== 1`.
- `buyOneCheapestFood` is hard-coded to `industry=FOOD, quality=1` and refuses prices above `ERP_MAX_FOOD_PRICE`.
- `MAX_AGENT_ITERATIONS` caps how many tool calls Claude can make per cycle.
- No `click` tool is exposed to the LLM — Playwright clicks are reserved for the login flow in `bootstrap.ts`.

### 4. Forbidden = stop

A `Forbidden` response from any deploy endpoint means the IP/account is flagged. The farm runner throws `ForbiddenError` and aborts the entire run. Do not retry — swap IP or wait for the cooldown.

---

## Architecture (one screen)

```
agent/runner.ts                  long-running loop, day rollover, short-circuit, digest
  agent/cycle.ts                 reconcile(API → memory)
  agent/tools.ts                 buildTools(): wraps semantic actions as MCP tools
    tools/*.ts                   semantic operations (work, train, market, claim, …)
      transport/apiCall.ts       context.request.fetch + CSRF + allow-list check
        transport/allowlist.ts   the inviolable endpoint set
          browser/session.ts     CloakBrowser persistent context

farmRunner.ts / farmOne.ts       operator CLIs (not LLM-driven)
  farm/routing.ts                cluster-by-country router
  tools/battles.ts               campaign discovery + eligibility + empty check
  tools/farm.ts                  travel + inventory + deploy + verify
    transport/apiCall.ts         (same enforcement applies)
```

**Layering rule**: do not skip levels. Everything goes through `apiCall` so the allow-list always fires.

**Memory-write rule**: only `agent/runner.ts` and `agent/tools.ts` mutate `DailyState`/`WeeklyState`. `tools/*.ts` are pure — they return results and never persist.

---

## Conventions specific to this codebase

- **ESM + TypeScript via `tsx`**, no build step. Imports use `.js` suffix (`../tools/missions.js`) even though files are `.ts` — required by `moduleResolution: Bundler` + ESM.
- **Form bodies** are `application/x-www-form-urlencoded`. `apiCall()` automatically prepends `_token: csrf` and sets `X-Requested-With: XMLHttpRequest` on POSTs. Don't bypass it.
- **CSRF is per-page, not per-session.** Each cycle re-reads it from the live page.
- **Mission IDs**: 100001 = work, 100003 = train, 100011 = buy food. VIP claim is not exposed in `daily-missions-data` — its tool is the only writer for that flag.
- **The agent's system prompt is a fixed-shape recipe**, not a free-form description. Each cycle injects the current pending list. Sweeping rewrites tend to break the short-circuit profile.
- **`Referer` matters for deploys.** The farming CLIs `page.goto(/military/battlefield/{id})` before any deploy fetch because the browser-enforced `Referer` is what the deploy endpoints check.

---

## Stack

- Node.js 22+, TypeScript, ESM (no build step — `tsx` runs sources directly)
- [`cloakbrowser`](https://github.com/CloakHQ/CloakBrowser) — stealth Chromium with source-level fingerprint patches
- `@anthropic-ai/claude-agent-sdk` — agent runtime + in-process MCP server
- `playwright-core` — browser context API surface
- `zod` — env, memory, tool input validation

## Disclaimer

Personal automation tool. Use against your own account. Respect [eRepublik Terms of Service](https://www.erepublik.com/en/main/terms-of-service).
