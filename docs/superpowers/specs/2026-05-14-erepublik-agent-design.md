## erepublik-agent — Design Spec (MVP)

**Created:** 2026-05-14
**Status:** Draft for review
**Owner:** Yurii Chekhotskyi (`driversti`)
**Current target:** Phase 1 — Safe Daily Actions via CloakBrowser
**Supersedes:** `e-agent` (HTTP-only prototype) — not migrated, only API knowledge and safety principles carried over

---

## 1. Goal

Build a long-running, LLM-orchestrated agent that autonomously runs the daily eRepublik loop through a real browser (CloakBrowser stealth Chromium). Compared to `e-agent`, this project:

1. Replaces the plain-`fetch` transport with a persistent CloakBrowser context so Cloudflare and bot-detection systems see a real browser at all times.
2. Treats the browser as a first-class capability — agent tools can call game APIs through the authenticated browser context **and** fall back to DOM parsing, real clicks, or screenshots when JSON is not enough.
3. Is shaped from day one for a clean path to multi-account in a later phase (one CloakBrowser profile per account).

### 1.1 Phase 1 scope — Safe Daily Actions

A long-running process that, every 10 minutes (configurable), inspects the player's daily state and performs only the **safest, free, once-per-day** actions, remembering what it already did today so it never repeats:

| Action | Trigger | Daily Mission |
|---|---|---|
| **Work** | Has an employer; otherwise notify and skip | 100001 |
| **Train** | Always once per day | 100003 |
| **Buy 1 unit of cheapest food** on the marketplace | Once per day | 100011 |
| **Claim daily VIP gift** (`/en/main/vip-claim`) | Once per day | — |
| **Claim any completed Daily Mission** | When `progress.completed === true` | various |
| **Claim any unlocked Daily Objective chest** | When AP crosses 20 / 40 / 60 / 80 / 100 | — |
| **Telegram digest** | When state has changed since previous cycle | — |
| **Telegram alert "find me a job"** | When the player is unemployed | — |

Memory of "already done today" is keyed by **eRepublik day** (resets at 00:00 PST). On day rollover, the previous file is archived and a fresh state is created.

### 1.2 Explicitly excluded from Phase 1

- Activating boosters of any kind.
- Any kind of fighting / deployment / special weapons.
- Travel.
- Currency exchange.
- Manufacture / Assign Employees.
- Buying anything beyond a single unit of the cheapest food.
- Auto-hiring (notify only — user picks employer).
- Any gold or premium-currency spend.

### 1.3 Later phases

- **Phase 2 — Combat opt-ins**: Activate Booster, Fight with Weapons, Spend Energy in safe battles, Spend Fuel across 3 battles. Still no gold spend.
- **Phase 3 — Daily Order**: parse the MU's Daily Order and route 250+ energy to it (Mission 100007).
- **Phase 4 — Hero farm**: BH/SH/CH battle selection and gold farming on remaining energy.
- **Phase 5 — Weekly Challenge**: prestige planning.
- **Phase 6 — Multi-account**: one CloakBrowser profile per account, parallel agents with shared scheduler.

**Out of scope at every phase:** gold/premium spend, anything outside the safety allow-list, breaking eRepublik ToS in ways beyond "the user runs personal automation on their account".

---

## 2. Non-goals

- Not a high-frequency bot. The 10-minute cycle is for dev feedback; most cycles short-circuit on memory.
- Not a vision-first agent. Screenshots are a guarded fallback, not the default. Vision is feature-flagged off in Phase 1.
- Not a replacement for `ePlus` / `auto-redeploy` userscripts. Those run in the user's browser; this runs server-side and complements them.
- No web dashboard, no mobile app — **Telegram is the only UI**.
- Not designed to evade game admins reviewing accounts manually; CloakBrowser is for client-side detection (Cloudflare/fingerprint), not for hiding the existence of automation.

---

## 3. High-level architecture

### 3.1 Phase 1 architecture

```
┌────────────────────────────────────────────────────────┐
│ Loop runner (long-running Node process, 10 min ticks)  │
│  • on tick: load memory → run agent → save memory      │
│  • on day rollover (00:00 PST): rotate memory file     │
│  • restart-on-crash via local supervisor (Phase 1)     │
└──────────────────────┬─────────────────────────────────┘
                       │
                       ▼
┌────────────────────────────────────────────────────────┐
│ Daily Memory  (sessions/daily-state-{eRepDay}.json)    │
│  • completedActions: {work, train, buyFood, vipClaim}  │
│  • claimedMissionIds: number[]                         │
│  • claimedChestThresholds: number[]                    │
│  • notifiedNoJobToday: boolean                         │
│  • lastDigestHash: string | null                       │
└──────────────────────┬─────────────────────────────────┘
                       │ injected as context
                       ▼
┌────────────────────────────────────────────────────────┐
│ Claude Agent (claude-sonnet-4-6, @anthropic-ai/        │
│ claude-agent-sdk)                                      │
│ system prompt: "ти — agent of safe daily actions;      │
│   never touch boosters/fight/travel; respect memory."  │
│                                                        │
│ Tools (semantic — LLM-facing, Phase 1):                │
│   Read     getMissionState, getObjectiveStatus,        │
│            getEmploymentStatus, getMarketCheapestFood  │
│   Act      work, train, buyProduct(offerId, q=1),      │
│            claimVipGift, claimMission(id),             │
│            claimObjective(threshold)                   │
│   Report   reportToTelegram(text, level?)              │
└──────────────────────┬─────────────────────────────────┘
                       │ dispatches to internal transports
                       ▼
┌────────────────────────────────────────────────────────┐
│ Transport layer (NOT exposed to LLM)                   │
│   apiCall(method, path, payload)   — context.request   │
│   parseDom(url, cheerioParser)     — HTML scrape       │
│   click(selector, options)         — Playwright action │
│   screenshot(area?)                — vision fallback   │
└──────────────────────┬─────────────────────────────────┘
                       ▼
┌────────────────────────────────────────────────────────┐
│ CloakBrowser session                                   │
│  • single persistent BrowserContext per account        │
│  • profile dir: sessions/profile/{account-slug}/       │
│  • realistic Chrome headers, source-level fingerprint  │
│  • CSRF token cached, refreshed on 401 / login redir.  │
│  • Endpoint allow-list enforced inside apiCall         │
└────────────────────────────────────────────────────────┘
```

Each cycle: runner loads memory and current `eRepublikDay`, ensures the browser context is live (re-login if needed), then invokes the agent with the memory snapshot in its prompt. Semantic tools dispatch through the transport layer; transports own the browser, the allow-list, CSRF, and retries. The runner records tool outcomes back into memory.

Daily reset: when the runner detects the eRepublik day has changed (00:00 PST), it archives `daily-state-{prevDay}.json` and starts a fresh memory file. The agent therefore naturally re-attempts the daily actions on the new day.

### 3.2 Phase 2+ architecture

Phase 1 components stay. The agent gains additional **action** and **claim** tools (booster, fight, special weapons), the allow-list expands, and a battle-selector subagent is added at Phase 4. Phase 6 introduces account scheduler and per-account context isolation; no restructure required.

---

## 4. Components

### 4.1 CloakBrowser session manager

Single persistent `BrowserContext` per account. Loaded at process start, kept alive across cycles.

- **Profile**: `userDataDir` rooted at `sessions/profile/{account-slug}/`. Cookies, localStorage, IndexedDB survive across restarts.
- **Headless vs headed**: headless by default. `HEADED=true` for debugging. If login flow detects a captcha or interactive challenge, the runner alerts via Telegram and pauses for manual headed-mode resolution (see §13).
- **Auth check**: at start of each cycle, lightweight authenticated GET to `/en/main/messages-paginated`. On 401 / redirect to `/login` → run login flow.
- **Login flow**: navigate to `/en/login`, fill email + password via real Playwright interaction (not `evaluate`) so anti-bot scripts see human-like input timing (CloakBrowser's `humanize: true` option). Wait for redirect to `/en`. Persist cookies (done automatically by the profile dir).
- **CSRF**: extracted from page DOM (`<meta name="csrf-token">` or `SERVER_DATA.csrfToken`) and cached in-memory. Refreshed on any tool that lands on a fresh page.

Why CloakBrowser: gives a real Chromium binary with C++ fingerprint patches in source, so Cloudflare / FingerprintJS / BrowserScan don't flag the process. Doubles as the only place the project needs to handle JS-based challenges.

### 4.2 Transport layer (internal, not exposed to LLM)

The transport layer is the only code that knows about HTTP, DOM, or Playwright. Semantic tools call into it.

- **`apiCall(method, path, payload)`** — fetches inside the authenticated context via `context.request.fetch()`. Adds CSRF + `X-Requested-With: XMLHttpRequest`. Enforces the endpoint allow-list. On 401 / login redirect, triggers re-login then retries once.
- **`parseDom(url, parser)`** — navigates a page if not current, returns `parser(cheerio.load(html))`. Used for HTML-only data (employment, profile).
- **`click(selector, options)`** — Playwright click with humanized timing. Reserved for flows where API calls don't work (login, multi-step JS modals).
- **`screenshot(area?)`** — Phase 1: not invokable by agent (feature-flag off). Phase 1.5+: exposed for vision fallback.

### 4.3 Agent runtime

Built on `@anthropic-ai/claude-agent-sdk`. Single agent in Phase 1 (no subagents). System prompt encodes:

- Job: complete only the **safe daily actions** listed in §1.1 and stop. Never touch the explicitly-excluded actions in §1.2.
- Memory is authoritative: if `completedActions.work === true`, do not work again even if API would let you.
- Decision rules:
  - Each cycle, mandatory reads: `getMissionState`, `getObjectiveStatus`, `getEmploymentStatus`.
  - For each safe action whose memory flag is unset: perform it, then claim its mission if completed, then update memory.
  - If unemployed: call `reportToTelegram` once per day with a "find me a job" alert, set `notifiedNoJobToday`, skip work.
  - When AP crosses a chest threshold not in `claimedChestThresholds`, call `claimObjective`.
  - End the cycle silently unless the snapshot hash changed (then emit digest).
- Tools are defined as small TypeScript functions with Zod input/output schemas.

### 4.4 Daily memory

JSON file at `sessions/daily-state-{eRepDay}.json`, Zod-validated:

```ts
{
  eRepublikDay: number,
  completedActions: {
    work?:     { at: string, missionClaimedAt?: string },
    train?:    { at: string, missionClaimedAt?: string },
    buyFood?:  { at: string, offerId: number, missionClaimedAt?: string },
    vipClaim?: { at: string, awarded?: number },
  },
  claimedMissionIds: number[],
  claimedChestThresholds: number[],
  notifiedNoJobToday: boolean,
  lastDigestHash: string | null,
}
```

- **Lifecycle**: loaded at the start of each cycle, mutated by the runner after each successful tool call (runner is the only writer — agent describes what it did and the runner records it), persisted at the end of the cycle.
- **Day rollover**: at the start of each cycle the runner computes `eRepublikDay = floor((nowPST - 2007-11-21) / 1d)`. If different from the file's day, the previous file is renamed to `daily-state-{prevDay}.archive.json` and a fresh state is initialised.
- **Why memory exists even though the API also reports completion**: avoids unnecessary HTTP calls and unnecessary LLM tokens reasoning about already-handled actions. API is the source of truth; memory is the fast-path cache.

### 4.5 Telegram notifier

Reuses the existing eRepublik Telegram bot token if available (see `euberbot` patterns). Message types in Phase 1:

- **State digest** — sent when the snapshot hash changed.
- **"Find me a job" alert** — at most once per eRepublik day.
- **Error notice** — one-line message on a failed cycle.
- **Verbose log** (off by default) — one message per tool call.

### 4.6 Runner

For Phase 1 the runner is a single long-running Node process:

- `npm run start` — boots, runs immediate cycle, then sleeps `LOOP_INTERVAL_MS` (default 600_000 = 10 min) between cycles.
- `npm run start -- --once` — single cycle then exit (useful for CI and ad-hoc checks).
- `npm run start -- --dry-run` — read tools enabled, all writing tools disabled at the transport layer.
- `npm run start -- --headed` — opens visible CloakBrowser for debugging.
- On uncaught error: log, Telegram-notify, sleep, continue. Process never exits on a single bad cycle.

---

## 5. Project structure

```
erepublik-agent/
├── src/
│   ├── agent/
│   │   ├── runner.ts             # CLI entry, loop, day rollover
│   │   ├── prompt.ts             # system prompt template
│   │   └── tools/                # one file per semantic tool
│   │       ├── missions.ts       # getMissionState, claimMission
│   │       ├── objectives.ts     # getObjectiveStatus, claimObjective
│   │       ├── employment.ts     # getEmploymentStatus
│   │       ├── market.ts         # getMarketCheapestFood, buyProduct
│   │       ├── work.ts           # work
│   │       ├── train.ts          # train
│   │       ├── vip.ts            # claimVipGift
│   │       └── report.ts         # reportToTelegram
│   ├── browser/
│   │   ├── session.ts            # CloakBrowser bootstrap, profile dir
│   │   ├── auth.ts               # login flow, CSRF extraction
│   │   └── lifecycle.ts          # health check, re-login on 401
│   ├── transport/
│   │   ├── apiCall.ts            # context.request + allow-list + retry
│   │   ├── parseDom.ts           # cheerio wrapper
│   │   ├── click.ts              # humanized Playwright click
│   │   ├── screenshot.ts         # vision fallback (flag-gated)
│   │   └── allowlist.ts          # the inviolable endpoint set
│   ├── memory/
│   │   ├── dailyState.ts         # load / save / rollover
│   │   └── schema.ts             # Zod schema
│   ├── erepublik/
│   │   ├── day.ts                # eRepublikDay calculation
│   │   └── types.ts              # API response types
│   ├── telegram/
│   │   └── notifier.ts
│   └── config.ts                 # env loader (zod-validated)
├── sessions/                     # gitignored: profile/, daily-state-*.json
├── tests/
│   ├── unit/                     # parsers, allow-list, memory, day calc
│   └── integration/              # mocked browser-context happy paths
├── docs/superpowers/specs/       # this file lives here
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .env.example
└── README.md
```

No Docker in Phase 1. Node 22, `npm run start`, local supervision only.

---

## 6. Data flow — one cycle

1. **Bootstrap** (once at process start): load env, validate config, create CloakBrowser context from `sessions/profile/{slug}/`, create Telegram notifier.
2. **Tick**:
   1. Compute `currentERepublikDay`. If different from loaded memory's day → archive previous, start fresh.
   2. Health check: `apiCall('GET', '/en/main/messages-paginated')`. If 401 or login redirect → run login flow, retry once.
   3. Build system prompt by merging rule template with today's memory snapshot.
   4. `agentSdk.run({ systemPrompt, tools, maxIterations })`.
   5. Agent issues read tools (`getMissionState`, `getObjectiveStatus`, `getEmploymentStatus`).
   6. For each safe action with memory flag unset:
      - Agent calls action tool (`work`, `train`, `buyProduct`, `claimVipGift`).
      - Runner observes result and updates memory.
      - If the action's mission becomes claimable, agent calls `claimMission(missionId)`; runner records `missionClaimedAt`.
   7. Agent re-reads `getObjectiveStatus`. For each chest threshold reached but not in `claimedChestThresholds`, agent calls `claimObjective(threshold)`.
   8. If unemployed and `notifiedNoJobToday === false`, agent calls `reportToTelegram` job alert; runner sets the flag.
   9. Runner hashes post-cycle state. If hash differs from `lastDigestHash`, agent emits digest; runner records new hash.
   10. Memory persisted.
3. **Sleep** `LOOP_INTERVAL_MS`, repeat.

On any cycle error: log, send one-line Telegram error notice, sleep, continue. Memory left in last consistent state.

---

## 7. Tools catalog

### 7.1 Semantic tools (LLM-facing, Phase 1)

| Tool | Input | Returns | Transport used |
|---|---|---|---|
| `getMissionState` | — | `{missions: [{id, progress, completed, claimable}]}` | `apiCall POST /en/main/daily-missions-data` |
| `getObjectiveStatus` | — | `{ap, thresholds: [{at, claimed}]}` | `apiCall POST /en/main/objective-status` |
| `getEmploymentStatus` | — | `{employerId?, employerName?, jobOffer?}` | `parseDom /en/citizen/profile/{id}` |
| `getMarketCheapestFood` | `{country?}` | `{offerId, price, quality, quantity}` | `apiCall POST /en/economy/marketplace` |
| `work` | — | `{success, energy?, salary?}` | `apiCall POST /en/economy/work` |
| `train` | — | `{success, strength?}` | `apiCall POST /en/military/training-train` |
| `buyProduct` | `{offerId, quantity: 1}` | `{success, totalCost}` | `apiCall POST /en/economy/marketplaceBuy` (guarded q=1, FOOD only) |
| `claimVipGift` | — | `{success, awarded?}` | `apiCall POST /en/main/vip-claim` |
| `claimMission` | `{missionId}` | `{success, reward?}` | `apiCall POST /en/main/mission-solve` |
| `claimObjective` | `{threshold}` | `{success, reward?}` | `apiCall POST /en/main/objective-claim-reward` |
| `reportToTelegram` | `{text, level: 'info'|'warn'|'error'}` | `{messageId}` | direct Telegram Bot API |

### 7.2 Internal transports (NOT exposed to LLM)

| Transport | Purpose | Notes |
|---|---|---|
| `apiCall` | JSON API call inside browser context | Default for 90%+ of actions; cheapest tokens |
| `parseDom` | Scrape HTML when no JSON endpoint exists | Cheerio inside the page; structured selectors |
| `click` | Real Playwright interaction | Login flow only in Phase 1 |
| `screenshot` | Capture image for vision | **Flag-gated, off in Phase 1** |

Why this split: the LLM reasons about game semantics (`work`, `claimMission`), not transports. A tool author can change the underlying transport (e.g., switch from `apiCall` to a `click`+`parseDom` combo if eRepublik breaks the endpoint) without touching the agent prompt.

---

## 8. Configuration

All via environment variables, Zod-validated at startup:

| Var | Purpose | Example |
|---|---|---|
| `ERP_LOGIN` | eRepublik account email | `user@example.com` |
| `ERP_PASSWORD` | eRepublik account password | `***` |
| `ERP_ACCOUNT_SLUG` | Profile directory name | `main` |
| `ANTHROPIC_API_KEY` | Claude API key | `sk-ant-...` |
| `CLAUDE_MODEL` | Model id | `claude-sonnet-4-6` |
| `TELEGRAM_BOT_TOKEN` | Bot token | `123:abc...` |
| `TELEGRAM_CHAT_ID` | Destination chat | `-100...` |
| `LOOP_INTERVAL_MS` | Sleep between cycles | `600000` |
| `MAX_AGENT_ITERATIONS` | Hard cap on tool calls per cycle | `12` |
| `DRY_RUN` | Disable writing transports | `false` |
| `HEADED` | Show browser window | `false` |
| `ENABLE_VISION_FALLBACK` | Expose `screenshot` tool to agent | `false` |
| `VERBOSE_TELEGRAM` | Log every tool call to Telegram | `false` |
| `PROXY_URL` | Optional HTTP/SOCKS proxy for CloakBrowser | unset |

`.env` for local. Phase 2+ Docker uses injected secrets.

---

## 9. Safety boundaries

Layered, smallest blast radius first:

1. **Endpoint allow-list in transport layer** — only the Phase 1 paths permitted; everything else (gold shop, premium, present, fight-deploy, travel, exchange, manufacture) rejected at `apiCall` regardless of what the agent attempts. This is the inviolable boundary.

   Phase 1 allow-list (paths only):
   ```
   GET   /en/main                              (login form, CSRF)
   POST  /en/login
   GET   /en/main/messages-paginated           (lightweight auth check)
   POST  /en/main/daily-missions-data
   POST  /en/main/objective-status
   GET   /en/citizen/profile/<id>              (employment status)
   POST  /en/economy/marketplace               (market read for offers)
   POST  /en/economy/marketplaceBuy            (single-unit food only — guarded)
   POST  /en/economy/work
   POST  /en/military/training-train
   POST  /en/main/vip-claim
   POST  /en/main/mission-solve
   POST  /en/main/objective-claim-reward
   ```
   Exact paths confirmed against `~/KnowledgeBase/Erepublik/API` during implementation.

2. **Tool surface** — only safe semantic tools exposed. There is no `activateBooster`, `spendEnergy`, or `travel` tool in Phase 1.

3. **Per-action guards** in `buyProduct`: `quantity === 1` and product type `FOOD`; rejects anything else even if the agent supplies it.

4. **Per-cycle budgets** — `MAX_AGENT_ITERATIONS` (default 12) hard-stops runaway loops.

5. **Dry-run mode** — disables all writing transports while keeping reads, so a planned cycle can be inspected without side effects.

6. **Idempotency on claims** — claiming an already-claimed mission/chest must be a no-op for the runner, not an error. Daily memory provides the primary guard; the API is the secondary safety net.

7. **Memory authority** — agent treats memory as authoritative. Even if the API would let it work twice today (it won't), the agent must not, because memory says it already did.

8. **Vision lock-down in Phase 1** — `screenshot` is not registered as a tool unless `ENABLE_VISION_FALLBACK=true`. Default off.

9. **`click` is restricted to auth** in Phase 1 — only the login flow uses it. The agent cannot ask the transport layer to click arbitrary selectors (the `click` transport is called by `auth.ts`, not by any LLM-facing tool).

If a tool fails, the agent receives the error and can decide to abandon the action. It cannot bypass the allow-list.

---

## 10. Observability

### 10.1 Phase 1 Telegram digest (sent only when state hash changed)

```
erepublik-agent @ 2026-05-14 09:11 CET (eRepublik day 6665)
Done today: ✅ Work  ✅ Train  ✅ Buy 1 food  ✅ VIP claim
Missions claimed: 100001, 100003, 100011  (+ VIP)
Chests claimed: 20 AP
AP: 12 → 25
Errors: 0
```

Unemployed (at most once per eRepublik day):
```
⚠️ erepublik-agent: no employer detected. Please hire me, then I'll work tomorrow.
```

Error: `erepublik-agent error @ 09:11 CET: <reason>`.

### 10.2 Always

- **Structured JSON logs** to stdout, one line per tool call: `{ts, tool, input, output, latencyMs, error?}`.
- **Verbose mode** mirrors tool calls to Telegram during debugging.
- **Browser console** captured to stdout when `HEADED=true` for debugging anti-bot challenges.

No metrics backend — overkill at every phase.

---

## 11. Testing strategy

- **Unit tests** for: CSRF parser, header builder, allow-list, prompt assembly, response parsers, eRepublikDay calculation, daily-state load/save/rollover, single-unit-food guard, FOOD-only guard.
- **Integration tests** with a mocked Playwright `BrowserContext`: full happy path (work + train + buy food + VIP claim + mission claim + chest claim + digest), login expiry mid-cycle, claimable mission auto-claim, allow-list rejection, day rollover archives previous file, idempotent re-run.
- **No live e2e tests in CI** — they would burn the real account. A manual `--dry-run` against the live API is the integration check.

---

## 12. Deployment

### 12.1 Phase 1 — local

Local on the dev machine via `npm run start`. No Docker. No cron — the process is itself the loop. Stop with Ctrl+C; restart manually if it dies. Iteration speed first.

### 12.2 Phase 2+ — Dockerised on `192.168.10.18`

Mirrors `euberbot`:

- Multi-arch Docker image pushed to `registry.yurii.live/erepublik-agent`.
- `docker-compose.yml` with `restart: unless-stopped`, env from `.env`, mounted `sessions/` volume (so the CloakBrowser profile and daily state survive container restarts).
- Headless CloakBrowser; no Xvfb needed for the default flow. Image size dominated by Chromium binary (~250MB compressed).
- `release.sh` builds, pushes, and SSHes to `192.168.10.18` to pull and restart.

---

## 13. Open questions / risks

- **CloakBrowser `context.request.fetch()` parity** — the package wraps Playwright; confirm `context.request` works as in vanilla Playwright (it should). If not, fall back to `page.evaluate(() => fetch(...))` from a kept-alive tab. Verify in Phase 0 bootstrap, before tool implementation.
- **Login captcha** — first login may show hCaptcha. Phase 1 plan: when login flow detects captcha, switch to `HEADED=true`, Telegram-alert the user, pause until manual solve. Optional 2captcha integration deferred to a later phase.
- **Anthropic API spend** — 144 cycles/day × ~2–4k tokens/cycle on Sonnet 4.6 lands around $0.50–$1.50/day at the loose end. `MAX_AGENT_ITERATIONS = 12` + memory short-circuit keeps the bound tight. Observe in the first week and tune.
- **Marketplace cheapest-food edge cases** — if no Q1 food at a sane price, skip Buy Products for the day rather than buying expensive food. Memory flag stays unset; agent retries next cycle.
- **Train endpoint variants** — multiple training facilities; "train once" maps to the cheapest available. Confirm exact endpoint + payload during implementation against KB API docs.
- **Employment detection** — player profile page is HTML. `parseDom` parser must be robust to minor layout changes. Snapshot HTML during Phase 0 to lock the selectors.
- **eRepublik admin attention** — server-side automation has higher risk than userscripts. User accepts this risk. CloakBrowser reduces *detection* risk but not *policy* risk.
- **Profile-dir corruption** — if Chromium crashes mid-write, `userDataDir` can lock. Mitigation: graceful shutdown on SIGTERM, exponential backoff on profile-lock errors at startup.

---

## 14. Iteration roadmap

- **Phase 0 — Bootstrap** *(prerequisite)*: install CloakBrowser, verify `context.request.fetch` works, complete a manual login, snapshot HTML for the employment parser. Single throwaway script; no agent yet.
- **Phase 1 — Safe Daily Actions** *(current target)*: as scoped above.
- **Phase 2 — Combat opt-ins**: `activateBooster`, `fightDeploy` in safe battles, `spendEnergy`, `spendFuel`. Allow-list expands.
- **Phase 3 — Daily Order**: parse MU Daily Order, route 250+ energy to it.
- **Phase 4 — Hero farm**: battle-selector subagent over `campaignsJson/list`.
- **Phase 5 — Weekly Challenge**: prestige optimisation.
- **Phase 6 — Multi-account**: one CloakBrowser profile per account, account scheduler, parallel runners with shared rate limiter.

The Phase 1 architecture is intentionally shaped so each later phase is additive — new tools, expanded allow-list, optional subagent at Phase 4. No rewrite.

---

## 15. Acceptance criteria

### 15.1 Phase 0

- [ ] `npm run bootstrap` launches CloakBrowser, performs a manual login (`HEADED=true`), and persists a working profile in `sessions/profile/{slug}/`.
- [ ] A throwaway script calls `context.request.fetch('/en/main/daily-missions-data', ...)` and gets a 200 JSON response.
- [ ] An employment-parser sample is captured: HTML snapshot saved, parser tested against it.

### 15.2 Phase 1

Phase 1 is "done" when, on a fresh eRepublik day:

- [ ] `npm run start` boots locally, restores the CloakBrowser session, and runs an immediate cycle.
- [ ] First cycle: agent does Work, Train, buys 1 unit of cheapest food, claims VIP gift, claims missions 100001 / 100003 / 100011 and the 20 AP chest, and posts a digest to Telegram.
- [ ] Daily state file `sessions/daily-state-{day}.json` reflects the four `completedActions` flags set, the three `claimedMissionIds`, and `[20]` in `claimedChestThresholds`.
- [ ] Second cycle (next tick, same day): agent observes memory, performs no further actions, and **does not** post a duplicate digest.
- [ ] On day rollover: previous file renamed to `daily-state-{prevDay}.archive.json`, fresh file created, agent re-attempts the four daily actions.
- [ ] Unemployed scenario (manually break the user's job): agent posts the "find me a job" alert exactly once per day, sets `notifiedNoJobToday = true`, does not attempt to work.
- [ ] Auth survives session expiry: delete cookies in the profile, run, expect login then success.
- [ ] Allow-list test (unit): a request to a non-allowed path (e.g. `/military/fight-deploy`, or `marketplaceBuy` with quantity > 1) is rejected by the transport layer.
- [ ] On forced HTTP error (e.g. unplugged network), the loop logs and Telegrams a one-line error and continues running.
- [ ] Loop has run continuously for 48+ hours on the dev machine without manual intervention, surviving at least one day rollover.
- [ ] **CloakBrowser-specific**: a manual `curl` against FingerprintJS / BrowserScan demo pages from inside the same profile returns a "not bot" verdict, confirming the stealth layer is intact.

### 15.3 Phase 2 (later)

- [ ] `npm run start -- --once --dry-run` against the live account prints a sensible plan without side effects.
- [ ] Live cycle additionally activates one booster and spends some energy in a safe battle within `MAX_ENERGY_PER_RUN`.
- [ ] Allow-list rejects a deliberate `spendGold`-equivalent attempt (unit test).
- [ ] Docker image runs on `192.168.10.18` for at least seven consecutive days without manual intervention.
