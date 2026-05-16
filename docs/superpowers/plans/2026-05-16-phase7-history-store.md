# Phase 7 — History Store + UI Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-cycle events (battles farmed, mode changes, daily-action completions) to a JSONL log under `sessions/history.jsonl`. Replace the stub `/api/history` endpoint with a real reader, and add a "Recent activity" card to the dashboard.

**Architecture:** A tiny `src/ui/historyStore.ts` module exposes `append(event)` (atomic-ish line append via `fs.appendFileSync`) and `tail(n)` (read last N lines). The runner calls `append` at three points: end of each cycle (one `cycle` event summarizing the cycle), after each farmed battle (`battle` event from the strategy result), and on mode change (lazy: compare current effectiveMode to last). `/api/history` reads the last 100 events. Frontend shows a simple list, no charts.

**Spec:** `docs/superpowers/specs/2026-05-16-flexible-farming-config-design.md` §6 Phase 7 row, §5.2 history card.

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/ui/historyStore.ts` | **create** | `append(event)` + `tail(n)`. Events tagged with ISO `at`. |
| `src/ui/historyStore.test.ts` | **create** | Vitest: append+tail roundtrip, tail truncation, malformed-line tolerance. |
| `src/ui/server.ts` | modify | Replace the `/api/history` stub `{events:[]}` with `{events: tail(limit)}`. |
| `src/agent/runner.ts` | modify | Emit `cycle` event at end of each cycle (paused/error/success), `battle` events from `result.wins`, `mode` event when effectiveMode changes between cycles. |
| `src/ui/public/index.html` | modify | Add a "Recent activity" card. |
| `src/ui/public/app.js` | modify | Render the last 20 history events with relative timestamps. |

---

## Task 1: `historyStore` module + tests

**Files:**
- Create: `src/ui/historyStore.ts`
- Create: `src/ui/historyStore.test.ts`

TDD pair.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendHistory, tailHistory, type HistoryEvent } from './historyStore.js';

describe('historyStore', () => {
  let tmpRoot: string;
  let originalRoot: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'erp-history-'));
    originalRoot = process.env.ERP_ROOT;
    process.env.ERP_ROOT = tmpRoot;
    mkdirSync(join(tmpRoot, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.ERP_ROOT;
    else process.env.ERP_ROOT = originalRoot;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('tail returns empty when no file', () => {
    expect(tailHistory(50)).toEqual([]);
  });

  it('append + tail roundtrip preserves event order', () => {
    appendHistory({ type: 'cycle', reason: 'short-circuit' });
    appendHistory({ type: 'cycle', reason: 'farmed' });
    const events = tailHistory(50);
    expect(events).toHaveLength(2);
    expect(events[0].reason).toBe('short-circuit');
    expect(events[1].reason).toBe('farmed');
  });

  it('tail caps at N (returns most recent)', () => {
    for (let i = 0; i < 100; i++) appendHistory({ type: 'cycle', reason: `c${i}` });
    const events = tailHistory(10);
    expect(events).toHaveLength(10);
    expect(events[0].reason).toBe('c90');
    expect(events[9].reason).toBe('c99');
  });

  it('stamps each event with an ISO timestamp', () => {
    appendHistory({ type: 'cycle', reason: 'x' });
    const events = tailHistory(1);
    expect(events[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('skips malformed JSON lines silently', () => {
    appendHistory({ type: 'cycle', reason: 'ok' });
    const path = join(tmpRoot, 'sessions', 'history.jsonl');
    writeFileSync(path, '{"type":"cycle","reason":"ok","at":"2026-01-01T00:00:00.000Z"}\nnot valid json\n{"type":"cycle","reason":"ok2","at":"2026-01-02T00:00:00.000Z"}\n');
    const events = tailHistory(50);
    expect(events.length).toBe(2);
    expect(events.map((e) => e.reason)).toEqual(['ok', 'ok2']);
  });

  it('append is durable across re-loads', () => {
    appendHistory({ type: 'mode', from: 'standard', to: 'd4tw' });
    const reread = tailHistory(50);
    expect(reread[0]).toMatchObject({ type: 'mode', from: 'standard', to: 'd4tw' });
  });
});
```

- [ ] **Step 2: Run RED.**

- [ ] **Step 3: Implement `src/ui/historyStore.ts`**

```ts
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sessionsDir } from '../paths.js';

export type HistoryEvent =
  | { type: 'cycle'; reason: string; at?: string }
  | { type: 'battle'; battleId: number; regionName: string; mode: string; at?: string }
  | { type: 'mode'; from: string; to: string; at?: string }
  | { type: 'pause'; paused: boolean; at?: string }
  | { type: 'error'; message: string; at?: string };

function filePath(): string {
  return join(sessionsDir(), 'history.jsonl');
}

export function appendHistory(event: HistoryEvent): void {
  const stamped: HistoryEvent = { ...event, at: event.at ?? new Date().toISOString() };
  appendFileSync(filePath(), JSON.stringify(stamped) + '\n', 'utf8');
}

const MAX_TAIL_BYTES = 256 * 1024;

export function tailHistory(n: number): HistoryEvent[] {
  const path = filePath();
  if (!existsSync(path)) return [];
  const stats = statSync(path);
  const start = Math.max(0, stats.size - MAX_TAIL_BYTES);
  // Byte-slice before decoding for emoji-safety (same lesson as logsTail).
  const raw = readFileSync(path);
  const tail = start === 0 ? raw : raw.subarray(start);
  const lines = tail.toString('utf8').split('\n');
  const safe = start === 0 ? lines : lines.slice(1); // drop possibly truncated first line
  const parsed: HistoryEvent[] = [];
  for (const line of safe) {
    if (line.trim() === '') continue;
    try {
      parsed.push(JSON.parse(line) as HistoryEvent);
    } catch {
      /* skip malformed line */
    }
  }
  return parsed.slice(-n);
}
```

- [ ] **Step 4: GREEN. 6 tests pass.**

- [ ] **Step 5: Full suite — 75 total.**

- [ ] **Step 6: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/ui/historyStore.ts src/ui/historyStore.test.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(ui): historyStore append/tail with byte-safe UTF-8 slicing"
```

---

## Task 2: Wire runner emissions + /api/history reader

**Files:**
- Modify: `src/agent/runner.ts`
- Modify: `src/ui/server.ts`

### Step 1: Replace `/api/history` stub in `server.ts`

Find the existing handler:

```ts
  if (path === '/api/history') return sendJson(res, 200, { events: [] });
```

Replace with:

```ts
  if (path === '/api/history') {
    const lines = parseLinesParam(url);
    return sendJson(res, 200, { events: tailHistory(lines) });
  }
```

Add the import:

```ts
import { tailHistory } from './historyStore.js';
```

### Step 2: Emit events from `runner.ts`

Add the import:

```ts
import { appendHistory } from '../ui/historyStore.js';
```

Add a `let lastMode: string | null = null;` at module scope (outside `runCycle`).

Inside `runCycle`, AFTER the effectiveMode computation (around the existing `const mode = effectiveMode(...)` line), add:

```ts
        if (lastMode !== null && lastMode !== mode) {
          appendHistory({ type: 'mode', from: lastMode, to: mode });
        }
        lastMode = mode;
```

After the `getStrategy(mode).run(...)` call returns its `result`, emit one battle event per win:

```ts
        for (const w of result.wins) {
          appendHistory({ type: 'battle', battleId: w.battleId, regionName: w.regionName, mode });
        }
```

In the paused short-circuit (the early return block), add BEFORE the return:

```ts
    appendHistory({ type: 'cycle', reason: 'paused' });
```

At the end of `runCycle` (after the snapshot update / before the function returns normally), add:

```ts
  appendHistory({
    type: 'cycle',
    reason: shortCircuit ? 'short-circuit' : (lastDecisionReason ?? 'completed'),
  });
```

NOTE: `shortCircuit` is the variable computed inside `runCycle` from the safe-daily check. If it's not in scope at the end of the function, use `lastDecisionReason ?? 'completed'` as the reason for all non-paused cycles. Implementer decides based on actual code structure.

In the outer catch (where the cycle exception is logged), add:

```ts
      appendHistory({ type: 'error', message });
```

### Step 3: Typecheck + tests

`npm run typecheck && npm test --silent`. 75 pass (existing tests; history events tested in T1).

### Step 4: Smoke

```bash
cd /Users/driversti/Projects/erepublik/erepublik-agent
rm -f config/settings.json sessions/history.jsonl
ERP_ACCOUNT_SLUG=baryga2026 npm run agent > /tmp/p7-runner.log 2>&1 &
PID=$!
sleep 10
echo "--- /api/history ---"
curl -s 'http://localhost:3737/api/history?lines=20' | python3 -m json.tool | head -25
echo "--- history.jsonl ---"
cat sessions/history.jsonl 2>/dev/null
kill -INT $PID 2>/dev/null
wait $PID 2>/dev/null
```

Expected: at least one `cycle` event appears in both the file and the /api/history response.

### Step 5: Commit

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/agent/runner.ts src/ui/server.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(runner): emit cycle/battle/mode/error events to history.jsonl"
```

---

## Task 3: Frontend history card

**Files:**
- Modify: `src/ui/public/index.html`
- Modify: `src/ui/public/app.js`

### Step 1: Add card to `index.html`

Find the existing "Live logs" section. INSERT a new section BEFORE it:

```html
    <section class="bg-white rounded shadow p-4 md:col-span-2">
      <h2 class="font-semibold mb-2">Recent activity (last 20)</h2>
      <ul id="history-list" class="text-sm space-y-1 max-h-48 overflow-y-auto"></ul>
    </section>
```

### Step 2: Render in `app.js`

Inside the existing `refresh()` function, after `Promise.all([...])` returns, add:

```js
    const hist = await fetchJson('/api/history?lines=20');
    const events = (hist.events ?? []).slice().reverse(); // newest first
    document.getElementById('history-list').innerHTML = events
      .map((e) => {
        const ts = e.at ? new Date(e.at).toLocaleTimeString() : '—';
        let summary;
        if (e.type === 'cycle') summary = `cycle: ${e.reason}`;
        else if (e.type === 'battle') summary = `🎯 battle ${e.battleId} (${e.regionName}) [${e.mode}]`;
        else if (e.type === 'mode') summary = `mode: ${e.from} → ${e.to}`;
        else if (e.type === 'pause') summary = `pause: ${e.paused ? 'on' : 'off'}`;
        else if (e.type === 'error') summary = `❌ ${e.message}`;
        else summary = JSON.stringify(e);
        return `<li><span class="text-gray-400 mr-2">${ts}</span>${summary}</li>`;
      })
      .join('') || '<li class="text-gray-400">(no events yet)</li>';
```

### Step 3: Manual eyeball

Run the agent for a couple cycles. Open `http://localhost:3737`. Verify the activity card shows cycle events with timestamps.

### Step 4: Commit

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/ui/public/
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(ui): Recent activity card showing last 20 history events"
```

---

## Task 4: Smoke test

**Files:** none.

- [ ] **Step 1: Clean state**

```bash
rm -f /Users/driversti/Projects/erepublik/erepublik-agent/config/settings.json
rm -f /Users/driversti/Projects/erepublik/erepublik-agent/sessions/history.jsonl
```

- [ ] **Step 2: Run a couple cycles**

```bash
cd /Users/driversti/Projects/erepublik/erepublik-agent
ERP_ACCOUNT_SLUG=baryga2026 npm run agent > /tmp/p7-smoke.log 2>&1 &
PID=$!
sleep 12
echo "--- history.jsonl events ---"
cat sessions/history.jsonl
echo ""
echo "--- /api/history ---"
curl -s 'http://localhost:3737/api/history?lines=5' | python3 -m json.tool
```

Expected: at least one `cycle` event, JSONL valid.

- [ ] **Step 3: Trigger mode change via PUT and verify mode event**

```bash
curl -s -X PUT http://localhost:3737/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"paused":false,"farmEnabled":true,"modeOverride":"maverickD3","maverickManual":null,"d4tw":{"targetDamageAttacker":130000000,"targetDamageDefender":220000000,"maxBattlesPerSession":1,"weaponPriority":[7,6,5,4,3,2,1]},"emptyDiv":{"maxBattlesPerSession":3,"nativeWeaponPriority":[7,6,5,4,3,2,1],"foreignWeaponPolicy":"bomb-then-bazooka"},"travel":{"maxTravelCC":100,"returnHomeAfterMinutes":15,"returnHomeMaxCC":500},"detected":{"division":null,"hasMaverick":null,"citizenId":null,"countryId":null,"lastUpdated":null}}' \
  > /dev/null
sleep 12
echo "--- after mode change ---"
tail -5 sessions/history.jsonl
```

Expected: a `{"type":"mode","from":"standard","to":"maverickD3",...}` entry appears.

- [ ] **Step 4: Shutdown + cleanup**

```bash
kill -INT $PID 2>/dev/null
wait $PID 2>/dev/null
rm -f config/settings.json sessions/history.jsonl
```

- [ ] **Step 5: Full vitest** — 75 pass.

- [ ] **Step 6: No commit.**

---

## Self-Review Notes

- `appendFileSync` is not atomic across processes, but the runner is single-process so concurrent writes aren't a concern. If we ever spawn multiple agents that write the same file, we'll need a lock (out of scope for v1).
- `MAX_TAIL_BYTES = 256 KB` is the same cap as `logsTail` — keeps `/api/history` cheap.
- Mode events use a module-scope `lastMode` because the runner is one process; if the runner restarts it'll fire a synthetic `mode` event on the first cycle (lastMode starts null, after first cycle becomes the current mode — no event). Acceptable.
- The schema is loose (`HistoryEvent` is a discriminated union but `at` is optional in the source type; `appendHistory` fills it). Tests verify the timestamp is auto-stamped.
- This is the last phase. After merge, the full 7-phase implementation is done.
