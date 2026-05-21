# Buy Gold — Daily-runner integration

**Status**: design pending review
**Date**: 2026-05-21
**Author**: Yurii Chekhotskyi
**Related code**: `src/agent/runner.ts`, `src/agent/actions.ts`, `src/memory/schema.ts`, `src/transport/allowlist.ts`, `src/transport/apiCall.ts`, `src/ui/*`
**Reference**: ePlus userscript plugin `ePlus/client/src/plugins/free/buyGold.ts` (the behavior we mirror)

## Goal

Add a deterministic `buyGold` daily action that buys N gold (`1..10`, configurable; default 10) from the monetary market once per eRepublik game day. Toggle and amount are operator-editable via `config/settings.json` and the dashboard, like every other UI-driven setting. The feature ships **off by default** — operators must opt in.

## Background

The monetary market (`/en/economy/exchange-market`) is sorted by rate ascending, so the first row is always the best deal. eRepublik enforces a hard per-day cap of 10 gold purchased per citizen; attempting more returns an `error: true` JSON response containing `"maximum limit"`. The action is a textbook safe-daily: one HTTP round trip, idempotent across the day once we record success, no flag-risk beyond what's already in play for `buyFood`.

ePlus's `buyGoldPlugin` already does this from the userscript side: fetch the market HTML, parse `.exchange_offers tr` for the first row whose `.ex_amount strong span` ≥ N, extract the `purchase_{offerId}` button id, then POST `offerId, amount, buyAction:1, _token` to `/en/economy/exchange/purchase/`. We reuse that exact contract — the page is what it is, no need to reinvent the parser.

## Requirements

**R1** — One purchase per eRepublik game day (PST). Success flips `state.completedActions.buyGold`; the daily file rolls over at 00:00 PST and resets the flag.

**R2** — Amount is configurable `0..10` (inclusive). `amount = 0` combined with `enabled = true` is a defensive no-op that never issues an HTTP call. `amount ∈ 1..10` is the active range.

**R3** — Enable/disable toggle independent of amount, so an operator can flip the feature off without losing the configured amount.

**R4** — Selection rule: the first row whose `amount ≥ settings.buyGold.amount`. Because the market is rate-sorted ascending, the first sufficient row is always the cheapest. No additional rate ceiling — the user explicitly opted out of one (gold rates are stable enough that a price spike is unrealistic).

**R5** — Server-side "maximum limit reached" (i.e. the player already bought 10 manually today) marks `completedActions.buyGold = { source: 'external', ... }`. Mirrors `reconcile()` philosophy across other safe-dailies: if the API confirms the daily action is done — by us or by the player — we stop probing.

**R6** — Other hard errors (HTTP non-200, parse failures, `error:true` with an unrecognized message) do **not** flip the flag, log to console, and emit one Telegram alert per occurrence. The runner retries next cycle.

**R7** — Ordering in the safe-daily action loop: after `buyFood`, before the farm gate. Cycle order becomes:

```
work → train → workOvertime → vipClaim → buyFood → buyGold → (sweeps) → farm gate
```

`buyGold` last because (a) it has no downstream dependencies, (b) failure must not block the energy-sensitive farm gate.

**R8** — Allow-list extension: every HTTP call goes through the allow-list. We add exactly two entries.

**R9** — UI: a "Buy Gold" panel in the existing settings page with `Enabled` checkbox and `Amount` numeric input (`min=0, max=10`). Snapshot exposes `dailyActions.buyGold` so the operator sees whether today's purchase has fired.

**R10** — Disabled feature is invisible to the cycle: when `settings.buyGold.enabled === false` **or** `settings.buyGold.amount === 0`, `buyGold` is pre-filtered out of `pendingActions` so it never enters the action loop, never logs, and the short-circuit predicate treats it as done. Toggling enabled on (and amount ≥ 1) **after** the day's first cycle attempts the purchase on the next cycle.

## Architecture

### Layering

```
agent/runner.ts        — pre-filters pending by settings, mutates state on success
  agent/actions.ts     — new branch `runAction('buyGold', …)`
    tools/buyGold.ts   — fetch market HTML, parse first sufficient offer, POST purchase
      transport/apiCall.ts          — JSON POST (existing)
      transport/apiCallHtml.ts NEW  — HTML GET sibling helper (see §HTML helper)
        transport/allowlist.ts      — +2 entries
```

### HTML helper

`apiCall` is JSON-only — it throws on non-JSON responses. The monetary market is an HTML page, so we add a thin sibling helper:

```ts
// src/transport/apiCallHtml.ts
export interface ApiCallHtmlResult { status: number; html: string }
export async function apiCallHtml(
  ctx: BrowserContext,
  input: { method: 'GET'; path: string; timeoutMs?: number },
): Promise<ApiCallHtmlResult>
```

- Calls `assertAllowed` exactly like `apiCall`.
- Reuses `getOrCreateErepublikPage` (the same long-lived page that carries the full browser fingerprint).
- Uses the same `withTimeout` wrapper and `ForbiddenError` semantics — 403 still throws, so a Cloudflare interstitial during a flag still aborts cleanly.
- Returns `text` instead of `JSON.parse`.

Rationale for a sibling helper rather than an `expect: 'html'` knob on `apiCall`: keeps the JSON-only contract explicit; no caller of `apiCall` accidentally gets HTML back as `T`. Two HTML pages in the entire codebase today (this one, and potentially future exchange/marketplace scrapes) doesn't justify polymorphism in `apiCall`.

### Tool — `src/tools/buyGold.ts` (new)

```ts
export interface GoldOffer { offerId: number; amount: number }

export function parseFirstSufficientOffer(html: string, minAmount: number): GoldOffer | null

export interface BuyGoldResult {
  success: boolean;
  /** Server confirmed via "maximum limit": daily cap already hit. Runner records source:'external'. */
  alreadyDone?: boolean;
  offerId?: number;
  amount?: number;
  reason?: string;
  status?: number;
}

export async function buyOneGoldFromMarket(
  ctx: BrowserContext,
  csrf: string,
  amount: number,
): Promise<BuyGoldResult>
```

`parseFirstSufficientOffer` is pure: takes the page HTML and minimum amount, returns the first row whose `.ex_amount strong span` parses to ≥ minAmount, with the `offerId` extracted from `button[id^="purchase_"]`. Returns `null` when nothing qualifies (or the page shape is unrecognized — same outcome from the caller's perspective).

`buyOneGoldFromMarket` composes the two HTTP calls:
1. `apiCallHtml(ctx, { method:'GET', path:'/en/economy/exchange-market' })` → HTML.
2. `parseFirstSufficientOffer(html, amount)`. Null → `{ success:false, reason:'no_offer_with_amount_>= N' }`.
3. `apiCall<PurchaseResp>(ctx, { method:'POST', path:'/en/economy/exchange/purchase/', csrf, form:{ offerId, amount, buyAction:1 } })`.
4. Map the response:
   - `body.error === false` (or missing) + status 200 → `{ success:true, offerId, amount }`.
   - `body.error === true && /maximum limit/i.test(body.message)` → `{ success:true, alreadyDone:true, offerId, amount }`.
   - Otherwise → `{ success:false, status, reason: body.message ?? 'unknown' }`.

No memory writes from inside the tool. Runner owns mutation.

### Runner & action wiring

**`src/memory/schema.ts`**
```ts
const BuyGoldRecord = ActionRecord.extend({
  offerId: z.number().int().optional(),
  amount: z.number().int().min(1).max(10).optional(),
});
// completedActions gains:
buyGold: BuyGoldRecord.optional(),
```

Add `'buyGold'` to `ACTIVE_SAFE_DAILY_KEYS`. `pendingActions(state)` keeps its current signature — it returns *all* active-and-incomplete keys. **The runner**, not the schema, filters by `settings.buyGold.enabled`:

```ts
// in runCycle, after loadSettings()
const buyGoldActive = settings.buyGold.enabled && settings.buyGold.amount > 0;
const pending = pendingActions(state).filter((k) => k !== 'buyGold' || buyGoldActive);
```

Same filter applied where `shortCircuit` reads `allSafeDailyDone(state)` — when `buyGold` is inactive (disabled or amount=0), treat it as done for the short-circuit check. Cleanest expression: a small helper `effectivePending(state, settings)` re-used by both sites.

**`src/agent/actions.ts`** — new branch in `runAction`:

```ts
if (action === 'buyGold') {
  const r = await buyOneGoldFromMarket(ctx, csrf, opts.buyGoldAmount);
  if (r.success && opts.buyGoldAmount > 0) {
    state.completedActions.buyGold = {
      at,
      source: r.alreadyDone ? 'external' : 'agent',
      offerId: r.offerId,
      amount: r.amount,
    };
  }
  if (!r.success) {
    await opts.notify(`⚠️ buy gold failed — ${r.reason ?? 'unknown'}`);
  }
  // r.alreadyDone === true is a benign info path (player bought manually) — no notify.
  const tag = r.success
    ? r.alreadyDone ? '⏭ already done (daily cap)' : `✅ ${r.amount}g via offer ${r.offerId}`
    : `❌ ${r.reason}`;
  console.log(`[cycle] buyGold: ${tag}`);
  return;
}
```

`RunActionOptions` gains `buyGoldAmount: number`. The runner's pre-filter already excludes `buyGold` from `pending` when `amount === 0`, so `runAction` never sees a zero amount — the branch can assume `buyGoldAmount ≥ 1`.

**`src/agent/runner.ts`**
- Inside the action loop, add `await tryAction('buyGold');` after `tryAction('buyFood')`.
- Pass `buyGoldAmount: settings.buyGold.amount` into `runActionOpts`.
- Use `effectivePending` (see above) when computing `pending` and `shortCircuit`.

### Settings

**`src/ui/settingsStore.ts`**

```ts
const BuyGoldSettings = z.object({
  enabled: z.boolean().default(false),
  amount: z.number().int().min(0).max(10).default(10),
});
// Settings gains:
buyGold: BuyGoldSettings.default(() => ({ enabled: false, amount: 10 })),
```

`buildInitial()` reads optional env seeds:
- `ERP_BUY_GOLD_ENABLED` (bool) → `enabled`
- `ERP_BUY_GOLD_AMOUNT` (int 0..10) → `amount`

Both are seed-only; the runner reads from `settings.json` at runtime.

### Allow-list

`src/transport/allowlist.ts`:
```ts
{ method: 'GET', path: '/en/economy/exchange-market' },
{ method: 'POST', path: '/en/economy/exchange/purchase/' },
```

The POST path ends in `/` so the prefix-match rule in `isAllowed` catches it regardless of any future query suffix (matches the existing pattern for `/en/citizen/profile/`).

### UI

**`src/ui/snapshot.ts`** — `dailyActions.buyGold: boolean` added. Rendered in `app.js` only when `settings.buyGold.enabled` is true (don't clutter the dashboard with a row that's permanently off).

**`src/ui/public/index.html`** — new panel after Overtime, before Farm session cooldown:

```html
<div class="bg-gray-50 rounded p-3 text-sm mt-4">
  <div class="font-medium mb-2">Buy Gold</div>
  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
    <label class="flex items-center gap-2 cursor-pointer">
      <input id="bg-enabled" type="checkbox" class="h-4 w-4">
      <span>Enabled</span>
    </label>
    <label class="flex flex-col">
      <span class="text-xs text-gray-500">Amount (0–10)</span>
      <input id="bg-amount" type="number" min="0" max="10" class="border rounded px-2 py-1">
    </label>
  </div>
  <p class="text-xs text-gray-600 mt-2">
    ⓘ Buys the configured amount of gold from the monetary market once per game day (PST). eRepublik caps gold purchases at 10/day.
  </p>
</div>
```

**`src/ui/public/app.js`** — bind change events with `scheduleSave`, mirroring the Overtime panel. Read-back in the render pass. Numeric input clamps via `Math.max(0, Math.min(10, parseInt(v, 10) || 0))` before save.

### Digest

`src/agent/digests.ts` — add a `🪙 buy gold` line, included **only when `settings.buyGold.enabled`** (same logic as the dashboard row — never show a permanently-off row). Marker `✅` when `state.completedActions.buyGold != null`, `⏳` otherwise.

## Behavioral matrix

| Scenario | Cycle outcome |
|---|---|
| `enabled=false` | Pre-filtered. No call, no log, no flag. |
| `enabled=true, amount=0` | Silent no-op — the runner pre-filter treats `amount=0` like `enabled=false`. Misconfiguration is visible in the UI; no log spam, no Telegram alert. |
| `enabled=true, amount=N (1..10)`, no offers ≥ N | `reason:'no_offer_with_amount_>=_N'`. No flag. Telegram alert. Retry next cycle. |
| Purchase succeeds | Flag = `source:'agent'`, offerId, amount. |
| Purchase fails with "maximum limit" | Flag = `source:'external'`. No alert (expected when player bought manually). |
| Purchase fails other | No flag. Telegram alert. Retry next cycle. |
| Already flagged for the day | Pre-filtered by `pendingActions`. Idempotent. |
| HTTP 403 | `ForbiddenError` propagates from `apiCallHtml`/`apiCall`. Runner's existing error handler logs + Telegram alerts. No flag. |
| Day rollover | Daily file archives, fresh state, flag absent → retry next cycle. |

## Testing

Co-located vitest files:

- **`src/tools/buyGold.test.ts`** (pure parser)
  - Picks the first row with `amount ≥ minAmount`.
  - Returns null when nothing qualifies.
  - Returns null on malformed HTML (no rows, no `.exchange_offers`).
  - Extracts numeric `offerId` from `purchase_{n}` button id.
  - Handles fractional amounts (`247.22 ≥ 10` → match).
- **`src/agent/actions.test.ts`** (extended)
  - `runAction('buyGold', …)` success → flag with `source:'agent'`, offerId, amount.
  - `alreadyDone:true` → `source:'external'`.
  - Failure → no flag, `notify` called once with the reason.
  - Runner pre-filter excludes `buyGold` from `pending` when `enabled=false` OR `amount=0` (so `runAction` is never reached with `buyGoldAmount=0`).
- **`src/ui/settingsStore.test.ts`** (extended)
  - Defaults: `{ enabled: false, amount: 10 }`.
  - Env seeding: `ERP_BUY_GOLD_ENABLED`, `ERP_BUY_GOLD_AMOUNT`.
  - Schema rejects `amount < 0` and `amount > 10`.

Manual smoke: with `enabled=true, amount=10`, observe one successful cycle log line + one Telegram digest entry; second cycle short-circuits because the flag is set. Day rollover (or manual archive of the daily file) re-runs cleanly.

## KB note

If `~/KnowledgeBase/Erepublik/` lacks an exchange-market entry, add one:
- Endpoints: `GET /en/economy/exchange-market` (HTML), `POST /en/economy/exchange/purchase/` (JSON).
- POST body: `offerId, amount, buyAction:1, _token`.
- Cap: 10 gold per citizen per PST day.
- Response shape: `{ error?: boolean, message?: string, currency?: number, gold?: number }`.
- Selectors: `.exchange_offers tr`, `.ex_amount strong span`, `button[id^="purchase_"]`.

## Out of scope

- Multi-purchase splitting (e.g. buy 10g across multiple offers if no single offer has ≥ 10g). Not worth the complexity; rare to see the cheapest offer hold < 10g for long.
- Rate ceiling / max-price guard. Explicitly declined by the user — gold rates are stable enough that the protection isn't worth the configuration surface.
- Reading the existing daily mission for gold (none exists in the safe-daily set).
- Background polling separate from the cycle. The daily runner cycles every `LOOP_INTERVAL_MS` (default 10 min) — well inside the day. No reason to break out.
