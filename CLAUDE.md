# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Two cooperating workloads live here, sharing the same CloakBrowser profile, transport, and allow-list:

1. **LLM-orchestrated daily agent** (`src/agent/`, `npm run agent` / `npm start`) — Phase 1 safe-daily loop only: work, train, buy 1 cheapest Q1 food, VIP claim, claim missions/objective chests/weekly-challenge tiers. The Claude model can only call MCP tools registered in `agent/tools.ts`.
2. **Gold-farming pipeline** (`src/farmRunner.ts`, `src/farmOne.ts`, `src/showFarmableBattles.ts`) — operator-launched CLI scripts that travel + deploy on both sides of empty-division battles to collect True Patriot / Freedom Fighter / Mercenary medals. **Not exposed to the LLM** — there is no MCP tool that fights, deploys, or travels.

The full design spec for the agent lives at `docs/superpowers/specs/2026-05-14-erepublik-agent-design.md` — read it before substantial changes; it defines phase boundaries, safety guarantees, and the architecture this code implements.

## Commands

```bash
npm run bootstrap        # one-shot manual login (headed by default), persists CloakBrowser profile
npm run healthcheck      # verifies the persisted session still authenticates
npm run missions         # prints today's missions and short-circuit status
npm run agent            # LLM daily loop, one cycle (= `start -- --once`)
npm start                # LLM daily loop, long-running, sleeps LOOP_INTERVAL_MS between cycles

# Gold-farming pipeline (operator-only, NOT LLM-driven). Dry-run by default; add `-- --execute` to fight.
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
4. **Short-circuit**: if `allSafeDailyDone(state) && no unclaimed missions/objectives/weekly tiers` → skip the LLM entirely. This is the hot path: most ticks of the loop never spend Anthropic tokens.
5. Otherwise invoke Claude (`claude-haiku-4-5` by default) via `@anthropic-ai/claude-agent-sdk` `query()` with an in-process MCP server (`createSdkMcpServer`) exposing the tools built by `buildTools()`. `permissionMode: 'bypassPermissions'`, `allowedTools: ['mcp__erepublik-agent-tools__*']`.
6. Persist `DailyState` + `WeeklyState`. If the state hash changed, send a Telegram digest and store the new hash.

### Layering — do not skip levels

```
agent/runner.ts                  loop, day rollover, short-circuit decision, digest
  agent/cycle.ts                 reconcile(API → memory)
  agent/tools.ts                 buildTools(): wraps tools/* into MCP tools for the SDK
    tools/*.ts                   semantic operations (work, train, market, claim, …)
      transport/apiCall.ts       context.request.fetch + CSRF + allow-list assertion
        transport/allowlist.ts   the inviolable endpoint set
          browser/session.ts     CloakBrowser persistent context
```

The LLM only sees the MCP tools registered in `agent/tools.ts`. It cannot construct arbitrary HTTP calls — every request goes through `apiCall()`, which calls `assertAllowed()` and throws on anything outside `PHASE_1_ALLOWLIST`. **Adding any new endpoint requires editing `src/transport/allowlist.ts` — there is no other way in.**

### Memory model

- `sessions/daily-state-{day}.json` — `DailyState` (Zod schema in `src/memory/schema.ts`). Tracks `completedActions` (work/train/buyFood/vipClaim, each with `at` + `source: 'agent' | 'external'`), `claimedMissionIds[]`, `claimedChestThresholds[]`, `lastDigestHash`. On day rollover, previous file becomes `daily-state-{prevDay}.archive.json`.
- `sessions/weekly-state.json` — `WeeklyState` with `lastClaimedRewardId`. Resets are detected when `weeklyStatus.maxCompleted < lastClaimedRewardId` (cleared automatically).
- **Runner is the only writer.** Tools return results; `agent/tools.ts` (and the post-tool blocks in `runCycle`) mutate `deps.state` / `deps.weekly` after each successful call. Don't write to memory from inside `tools/*.ts`.

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
- **LLM tool surface is narrower than the allow-list.** The agent only sees the MCP tools registered in `agent/tools.ts` (`getMissionState`, `work`, `train`, `buyFood`, `vipClaim`, `collectMissionRewards`, `collectWeeklyChallengeRewards`, `collectObjectiveRewards`). **The farming endpoints in the allow-list are reachable only by the operator-launched CLI scripts, not by Claude.** If you add a farming MCP tool, the agent gains the ability to fight — that is an explicit design decision, not the current state.
- **Per-action guards** — `buyFromOffer` hard-rejects `amount !== 1`; `buyOneCheapestFood` is hardcoded to `industry=FOOD, quality=1` and refuses to buy above `ERP_MAX_FOOD_PRICE`.
- **Iteration cap** — `MAX_AGENT_ITERATIONS` (default 8) hard-stops the LLM tool loop per cycle.
- **No `click` tool exposed to the LLM.** Playwright clicks are reserved for the login flow in `bootstrap.ts`.

When extending the **agent**: add the endpoint to `allowlist.ts`, add the implementation in `tools/*.ts`, register it in `agent/tools.ts` with a precise description (the agent's only contract with the action), and remember to wire memory writes in `agent/tools.ts` or the post-tool blocks in `runCycle` — never inside `tools/*.ts`. When extending the **farming pipeline**: only `allowlist.ts` + `tools/farm.ts` / `tools/battles.ts` need changes; do **not** register farming tools in `agent/tools.ts`.

## Conventions specific to this codebase

- **ESM + TypeScript via `tsx`**, no build step. Source imports use `.js` suffixes (`../tools/missions.js`) even though files are `.ts` — required by `moduleResolution: Bundler` + ESM.
- **eRepublik form bodies** are `application/x-www-form-urlencoded` with `_token: csrf` prepended automatically by `apiCall`. POSTs need `X-Requested-With: XMLHttpRequest` (also set by `apiCall`). Don't bypass `apiCall`.
- **CSRF is per-page, not per-session.** `extractCitizenContext` re-reads it from the page each cycle — fine because cycles are minutes apart and CloakBrowser keeps the same tab.
- **Mission IDs to remember**: 100001 = work, 100003 = train, 100011 = buy food. Mapped in `agent/cycle.ts:SAFE_DAILY_MAP`. VIP claim is **not** in `daily-missions-data`, so `reconcile()` is a no-op for it — the `vipClaim` tool itself is the only writer.
- **The agent's system prompt is intentionally a fixed-shape recipe**, not a free-form description (see `systemPrompt()` in `runner.ts`). Each cycle re-derives `pending` from memory and injects it; the model is told exactly which tools to call and in what order. Treat the prompt as part of the contract — sweeping rewrites tend to break the cost/short-circuit profile.
- **Battlefield deploys need a real page navigation first** — `farmOne.ts` / `farmRunner.ts` call `page.goto(/military/battlefield/{battleId})` before any deploy fetch, because the browser-enforced `Referer` is what the deploy endpoints check. You cannot set it programmatically from `apiCall`.
- **`Forbidden` from a deploy endpoint = stop, don't retry.** It means the IP/account is flagged. The farm runner throws `ForbiddenError` and aborts the whole run; preserve that behavior in any new fighting code.
- **Telegram notifier degrades silently** if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are unset — `send()` and `sendError()` are no-ops. Safe to leave blank for local dev.

## Knowledge Base

When implementing a new action or debugging an API response shape, check `~/KnowledgeBase/Erepublik/API_MILITARY.md` and the rest of `~/KnowledgeBase/Erepublik/` first — that's the authoritative endpoint reference for the monorepo.
