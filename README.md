# erepublik-agent

LLM-orchestrated agent that autonomously runs the daily eRepublik loop through a real browser (CloakBrowser stealth Chromium).

**Status:** Phase 1 skeleton. Performs `work` and `train` daily actions; short-circuits idle cycles via local memory; uses Claude Haiku 4.5 for reasoning.

## Architecture

```
runner ─┬─ eRepublikDay + memory load/rollover
        ├─ CloakBrowser persistent context (cookies/fingerprint per account)
        ├─ Reconcile: sync API mission state into memory (no LLM)
        ├─ Short-circuit: if all safe-daily flags set → exit, no LLM call
        └─ Else: Claude Agent SDK + MCP tools
              ├─ getMissionState  (read)
              ├─ work             (POST /en/economy/work)
              └─ train            (GET grounds → POST /en/economy/train)
```

Transport layer (`src/transport/apiCall.ts`) makes JSON calls inside the authenticated browser context via `context.request`. An endpoint **allow-list** in the transport rejects anything outside the Phase-1 set, regardless of what the LLM tries.

See `docs/superpowers/specs/2026-05-14-erepublik-agent-design.md` for the full design, roadmap, and safety boundaries.

## Quick start

```bash
cp .env.example .env
# edit .env: ERP_LOGIN, ERP_PASSWORD, ANTHROPIC_API_KEY

npm install
npm run bootstrap   # one-shot manual login (headed) — persists session
npm run agent       # run one cycle
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run bootstrap` | First-time login, opens a visible browser, persists profile |
| `npm run healthcheck` | Verifies the persisted session still authenticates |
| `npm run missions` | Prints today's missions and short-circuit status |
| `npm run agent` | Runs one full cycle (reconcile → maybe call LLM → maybe act) |
| `npm run typecheck` | TypeScript check |

## Environment

| Var | Purpose |
|---|---|
| `ERP_LOGIN` / `ERP_PASSWORD` | eRepublik credentials |
| `ERP_ACCOUNT_SLUG` | Profile directory under `sessions/profile/<slug>/` |
| `ANTHROPIC_API_KEY` | Claude API key |
| `CLAUDE_MODEL` | Default `claude-haiku-4-5` |
| `MAX_AGENT_ITERATIONS` | Hard cap on tool calls per cycle |
| `HEADED` | `true` to show the browser window |

## Phase 1 scope

✅ `work` (mission 100001)
✅ `train` (mission 100003) — multi-ground free training
⏳ `buyProducts` (mission 100011) — pending
⏳ `vipClaim` — pending
⏳ Mission/objective claim, Telegram digest, loop runner — pending

**Out of scope at every phase:** gold/premium spend, fighting, boosters, travel, currency exchange, anything outside the safety allow-list.

## Stack

- Node.js 22+, TypeScript, ESM
- [`cloakbrowser`](https://github.com/CloakHQ/CloakBrowser) — stealth Chromium with source-level fingerprint patches
- `@anthropic-ai/claude-agent-sdk` — agent runtime + in-process MCP server for tools
- `zod` — schema validation for env, memory, tool inputs

## Disclaimer

Personal automation tool. Use against your own account. Respect [eRepublik Terms of Service](https://www.erepublik.com/en/main/terms-of-service).
