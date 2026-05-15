# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Two cooperating workloads live here, sharing the same CloakBrowser profile, transport, and allow-list. **Both are fully deterministic — no LLM is on the hot path.**

1. **Daily runner** (`src/agent/`, `npm run agent` / `npm start`) — Phase 1 safe-daily loop: work, train, buy 1 cheapest Q1 food, VIP claim, claim missions/objective chests/weekly-challenge tiers. `runCycle()` reads memory, derives `pending`, calls each action once in a fixed order, then runs the three idempotent sweep functions.
2. **Gold-farming pipeline** (`src/farmRunner.ts`, `src/farmOne.ts`, `src/showFarmableBattles.ts`) — operator-launched CLI scripts that travel + deploy on both sides of empty-division battles to collect True Patriot / Freedom Fighter / Mercenary medals.

> Historical note: until 2026-05-15 the daily runner was orchestrated by Claude Haiku via the Claude Agent SDK + an in-process MCP server. The model was only executing a fixed recipe with no real reasoning, so the LLM layer was removed in favor of a direct sequential call. The original design spec at `docs/superpowers/specs/2026-05-14-erepublik-agent-design.md` still describes the LLM-driven architecture.

## Commands

```bash
npm run bootstrap        # one-shot manual login (headed by default), persists CloakBrowser profile
npm run healthcheck      # verifies the persisted session still authenticates
npm run missions         # prints today's missions and short-circuit status
npm run agent            # daily loop, one cycle (= `start -- --once`)
npm start                # daily loop, long-running, sleeps LOOP_INTERVAL_MS between cycles

# Gold-farming pipeline. Dry-run by default; add `-- --execute` to fight.
npm run farmable         # lists candidate battles (empty division, wall.dom=50) for this account
npm run farmer           # full pipeline: discover → filter → both-side deploy on each candidate
npm run farm-one -- --battle=<id> [--execute] [--side=invader|defender|both] [--skip-empty-check]

# Debug helpers
npm run debug-deploy     # one-shot deploy probe with verbose request/response logging
npm run debug-headers    # dumps headers the in-page fetch is sending (useful when eRepublik returns 403)
npm run typecheck        # tsc --noEmit
```

No test runner is wired up (despite the spec referencing vitest). There is no lint command.

A new account always starts with `bootstrap` to populate `sessions/profile/{ERP_ACCOUNT_SLUG}/`. Subsequent runs reuse that profile via `openSession` and never touch `ERP_LOGIN`/`ERP_PASSWORD`.

## Architecture

### Cycle flow (`src/agent/runner.ts` → `runCycle`)

1. Compute `eRepublikDay()` (PST midnight epoch from `src/erepublik/day.ts`, **not** UTC). `loadOrInit` archives any stale `daily-state-*.json` and creates a fresh file when the day rolls.
2. `extractCitizenContext` reads CSRF + `countryId` + `citizenId` from the live page's `SERVER_DATA` / `erepublik.citizen` globals. `countryId` is auto-detected; `ERP_COUNTRY_ID` env is a fallback only.
3. Read API state: `getMissionState`, `getObjectiveStatus`, `getWeeklyChallenge`. `reconcile()` marks safe-daily actions as `source: 'external'` when the API says they're done but local memory disagrees (player did it manually or another bot).
4. **Short-circuit**: if `allSafeDailyDone(state) && no unclaimed missions/objectives/weekly tiers` → return immediately. This is the hot path: most ticks of the loop do nothing but the read calls in steps 1-3.
5. Otherwise: derive `pending = pendingActions(state)`, then call `runAction(action, ...)` once for each pending item in the fixed order `work → train → vipClaim → buyFood`. Each successful action immediately writes its flag onto `state.completedActions`. After actions, call the three idempotent sweeps (`collectMissionRewards`, `collectObjectiveRewards`, `collectWeeklyChallenge`) — they return empty results when nothing is claimable.
6. Persist `DailyState` + `WeeklyState`. If the state hash changed, send a Telegram digest and store the new hash.

### Layering — do not skip levels

```
agent/runner.ts                  loop, day rollover, short-circuit decision, action sequence, sweeps, digest
  agent/cycle.ts                 reconcile(API → memory)
  tools/*.ts                     semantic operations (work, train, market, claim, …)
    transport/apiCall.ts         context.request.fetch + CSRF + allow-list assertion
      transport/allowlist.ts     the inviolable endpoint set
        browser/session.ts       CloakBrowser persistent context
```

Every HTTP call goes through `apiCall()`, which calls `assertAllowed()` and throws on anything outside `PHASE_1_ALLOWLIST`. **Adding any new endpoint requires editing `src/transport/allowlist.ts` — there is no other way in.**

### Memory model

- `sessions/daily-state-{day}.json` — `DailyState` (Zod schema in `src/memory/schema.ts`). Tracks `completedActions` (work/train/buyFood/vipClaim, each with `at` + `source: 'agent' | 'external'`), `claimedMissionIds[]`, `claimedChestThresholds[]`, `lastDigestHash`. On day rollover, previous file becomes `daily-state-{prevDay}.archive.json`.
- `sessions/weekly-state.json` — `WeeklyState` with `lastClaimedRewardId`. Resets are detected when `weeklyStatus.maxCompleted < lastClaimedRewardId` (cleared automatically).
- **`runCycle` is the only writer.** Tools return results; `runAction()` and the post-sweep blocks in `runCycle` mutate `state` / `weekly` after each successful call. Don't write to memory from inside `tools/*.ts`.

### Gold-farming pipeline (`src/farmRunner.ts`, `src/farmOne.ts`)

Separate from the agent runner. Each pass:

1. `listFarmableBattles` (`/military/campaignsJson/list`) → all active battles where the player's division has `wall.dom === 50` and `division_end === false`.
2. `getCitizenEligibility` (`/military/campaignsJson/citizen`) → filter to battles where we can deploy on **both** sides (native citizen, `isMercenary`, or `isFreedomFighter` in RWs).
3. `isBattleDivisionEmpty` (`/military/battle-stats/{battleId}/{div}/{battleZoneId}`) → confirm zero damage in our division (the only authoritative empty signal — `wall.dom === 50` alone is not enough).
4. `findCheapestTravelRegion` (`/main/travelData`) → cheapest region on each side. Skip if either side exceeds `ERP_FARM_MAX_TRAVEL_CC`.
5. For each side: `battlefieldTravel` → `getDeployInventory` → `deployWeapon` (Q-1 no-weapon, 33 energy/hit) with retry-and-verify against `battle-console`. Between sides: sleep, `verifyHitRegistered`, `cancelDeploy` (to clear the "already fighting" lock before defender's travel).

Stop conditions inside `farmer`: `--max-battles` reached, `fuelLeft < ERP_FARM_MIN_FUEL`, `poolEnergy < TOTAL_ENERGY*2`, a `Forbidden` response (IP/account flagged — abort immediately), or `EnergyExhaustedError`.

Important field-name quirks captured by `tools/farm.ts`:
- `battlefieldTravel` form expects `inRegionId` (not `toRegionId`) — that's the campaign-side endpoint's spelling.
- `deployWeapon` requires at least one `energySources[N]` entry; we send `quality:1, amount:0` to signal "draw from pool, don't burn food".
- Default skin per division if no active vehicle: `{1:14, 2:15, 3:16, 4:17, 11:18}` (`skinForDivision`).

### Safety boundaries

- **Endpoint allow-list** (`src/transport/allowlist.ts`) — every HTTP call must match `(method, path)` in `PHASE_1_ALLOWLIST` or `apiCall` throws. The set currently covers: auth/profile read, missions/objectives/weekly read+claim, marketplaceAjax/Actions, work, training-grounds-json + train, vip-claim, and the farming endpoints (`campaignsJson/list|citizen`, `battle-stats/`, `travelData`, `battlefieldTravel`, `fightDeploy-{getInventory,startDeploy,cancelDeploy}`, `battle-console`).
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

When extending the **daily runner**: add the endpoint to `allowlist.ts`, add the implementation in `tools/*.ts` (pure function, no memory writes), then wire it into `runner.ts` — either as a new `runAction` branch (with memory mutation on success) or as a new sweep call. When extending the **farming pipeline**: only `allowlist.ts` + `tools/farm.ts` / `tools/battles.ts` need changes.

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
