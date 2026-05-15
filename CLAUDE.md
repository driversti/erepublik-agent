# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

LLM-orchestrated agent that runs the eRepublik daily loop through a CloakBrowser stealth Chromium. Phase 1: safe, free, once-per-day actions only (work, train, buy 1 cheapest Q1 food, VIP claim, claim missions/objective chests/weekly-challenge tiers). The full design spec lives at `docs/superpowers/specs/2026-05-14-erepublik-agent-design.md` — read it before substantial changes; it defines phase boundaries, safety guarantees, and the architecture this code implements.

## Commands

```bash
npm run bootstrap   # one-shot manual login (headed by default), persists CloakBrowser profile
npm run healthcheck # verifies the persisted session still authenticates
npm run missions    # prints today's missions and short-circuit status
npm run agent       # runs one full cycle (= `start -- --once`)
npm start           # long-running loop, sleeps LOOP_INTERVAL_MS between cycles
npm run typecheck   # tsc --noEmit
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

### Phase 1 safety boundaries (inviolable)

- **Endpoint allow-list** — only the 16 paths in `allowlist.ts` (auth check, missions/objectives/weekly read+claim, marketplaceAjax/Actions, work, training-grounds-json + train, vip-claim). Anything else → transport throws before sending.
- **Per-action guards** — `buyFromOffer` hard-rejects `amount !== 1`; `buyOneCheapestFood` is hardcoded to `industry=FOOD, quality=1` and refuses to buy above `ERP_MAX_FOOD_PRICE`.
- **No agent-callable tools** for: gold/premium spend, fighting/deploy, boosters, travel, currency exchange, manufacture, auto-hiring. There is no `click` tool exposed to the LLM (Playwright clicks are reserved for the login flow in `bootstrap.ts`).
- **Iteration cap** — `MAX_AGENT_ITERATIONS` (default 8) hard-stops the agent loop per cycle.

When extending: add the endpoint to `allowlist.ts`, add the implementation in `tools/*.ts`, register it in `agent/tools.ts`. Keep the LLM-facing tool description in `agent/tools.ts` precise — it's the agent's only contract with the action.

## Conventions specific to this codebase

- **ESM + TypeScript via `tsx`**, no build step. Source imports use `.js` suffixes (`../tools/missions.js`) even though files are `.ts` — required by `moduleResolution: Bundler` + ESM.
- **eRepublik form bodies** are `application/x-www-form-urlencoded` with `_token: csrf` prepended automatically by `apiCall`. POSTs need `X-Requested-With: XMLHttpRequest` (also set by `apiCall`). Don't bypass `apiCall`.
- **CSRF is per-page, not per-session.** `extractCitizenContext` re-reads it from the page each cycle — fine because cycles are minutes apart and CloakBrowser keeps the same tab.
- **Mission IDs to remember**: 100001 = work, 100003 = train, 100011 = buy food. Mapped in `agent/cycle.ts:SAFE_DAILY_MAP`. VIP claim is **not** in `daily-missions-data`, so `reconcile()` is a no-op for it — the `vipClaim` tool itself is the only writer.
- **The agent's system prompt is intentionally a fixed-shape recipe**, not a free-form description (see `systemPrompt()` in `runner.ts`). Each cycle re-derives `pending` from memory and injects it; the model is told exactly which tools to call and in what order. Treat the prompt as part of the contract — sweeping rewrites tend to break the cost/short-circuit profile.
- **Telegram notifier degrades silently** if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are unset — `send()` and `sendError()` are no-ops. Safe to leave blank for local dev.

## Knowledge Base

When implementing a new action or debugging an API response shape, check `~/KnowledgeBase/Erepublik/API_MILITARY.md` and the rest of `~/KnowledgeBase/Erepublik/` first — that's the authoritative endpoint reference for the monorepo.
