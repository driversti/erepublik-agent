# Phase 4 — Editable UI (PUT + Forms + Sleep Interrupt) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `config/settings.json` editable from the dashboard. User clicks Pause → file is updated atomically → runner notices within a couple of seconds (not 10 minutes) and skips the next cycle. Same for Farm-enabled, mode override, D4-TW target damage, weapon priority, and travel caps.

**Architecture:** `src/ui/server.ts` gains a `PUT /api/settings` handler that parses the request body (JSON, ≤64 KB), runs it through the same Zod schema, calls `saveSettings`, and returns the persisted value. Frontend (`public/app.js`) grows form controls bound to `/api/settings`; on change it debounces a PUT and re-reads. Runner gains a sleep-interrupt: `fs.watch(config/settings.json)` fires → the sleep `Promise` resolves early so the next cycle picks up the new state. This gives the operator near-instant pause without restarting the bot.

**Tech Stack:** Node 22 native `http`/`fs.watch`, Zod (already in use), vanilla JS. Same conventions as Phase 3.

**Spec:** `docs/superpowers/specs/2026-05-16-flexible-farming-config-design.md` §5.1 (`PUT /api/settings`), §6 Phase 4 row.

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/ui/server.ts` | modify | Add `PUT /api/settings` handler. Parse body, validate via `Settings.parse()`, call `saveSettings`, return 200 with new state. Reject non-JSON (415), oversize (413), bad shape (400). |
| `src/ui/server.test.ts` | modify | New tests for PUT: happy path, missing body, malformed JSON, schema validation error, oversize body, GET still works. |
| `src/ui/public/index.html` | modify | Replace the read-only `<pre id="settings-json">` block with form controls: 2 top-level toggles (Pause, Farm enabled) + mode dropdown + D4-TW target fields. Keep the JSON dump as a collapsible "Raw" view for power users. |
| `src/ui/public/app.js` | modify | Bind form controls to `/api/settings`. On change, debounce 300 ms then PUT. Show a small "saving…" / "saved ✓" / "error" badge. |
| `src/agent/runner.ts` | modify | Replace plain `await sleep(ms)` between cycles with `await sleepUntilWake(ms, settingsPath)`. The latter sets up a `setTimeout` AND an `fs.watch` listener; whichever fires first resolves. Cycle then re-reads settings normally. |
| `src/ui/sleepUntilWake.ts` | **create** | The interruptible-sleep helper extracted into its own module (small, pure, easy to unit-test). |
| `src/ui/sleepUntilWake.test.ts` | **create** | Two tests: timer fires when no file change; file change wakes us early. |

The sleep-interrupt lives in `src/ui/` even though it's used by the runner because it's part of the "settings-driven UX" surface — keeping the path-knowledge near `settingsStore.ts`.

---

## Task 1: `PUT /api/settings` handler + tests

**Files:**
- Modify: `src/ui/server.ts`
- Modify: `src/ui/server.test.ts`

TDD pair: add failing PUT tests, then implement.

- [ ] **Step 1: Add PUT tests to `src/ui/server.test.ts`**

Inside the existing outer `describe('UI server', () => { ... })`, AFTER the existing tests but BEFORE the closing brace, append:

```ts
  describe('PUT /api/settings', () => {
    it('persists a valid payload and returns the parsed result', async () => {
      const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
      try {
        // Seed defaults via GET so the file exists.
        await fetch(`http://127.0.0.1:${handle.port}/api/settings`);

        const payload = {
          paused: true,
          farmEnabled: false,
          modeOverride: null,
          maverickManual: null,
          d4tw: {
            targetDamageAttacker: 150_000_000,
            targetDamageDefender: 250_000_000,
            maxBattlesPerSession: 2,
            weaponPriority: [7, 6, 5],
          },
          emptyDiv: {
            maxBattlesPerSession: 3,
            nativeWeaponPriority: [7, 6, 5, 4, 3, 2, 1],
            foreignWeaponPolicy: 'bomb-then-bazooka' as const,
          },
          travel: {
            maxTravelCC: 100,
            returnHomeAfterMinutes: 15,
            returnHomeMaxCC: 500,
          },
          detected: {
            division: null,
            hasMaverick: null,
            citizenId: null,
            countryId: null,
            lastUpdated: null,
          },
        };
        const put = await fetch(`http://127.0.0.1:${handle.port}/api/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        expect(put.status).toBe(200);
        const echoed = await put.json();
        expect(echoed.paused).toBe(true);
        expect(echoed.d4tw.targetDamageAttacker).toBe(150_000_000);

        // Subsequent GET should reflect the change.
        const get = await fetch(`http://127.0.0.1:${handle.port}/api/settings`);
        const reread = await get.json();
        expect(reread.paused).toBe(true);
        expect(reread.d4tw.maxBattlesPerSession).toBe(2);
      } finally {
        await handle.close();
      }
    });

    it('rejects payload that fails schema validation with 400', async () => {
      const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
      try {
        const res = await fetch(`http://127.0.0.1:${handle.port}/api/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused: 'not a boolean' }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBeDefined();
      } finally {
        await handle.close();
      }
    });

    it('rejects non-JSON content-type with 415', async () => {
      const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
      try {
        const res = await fetch(`http://127.0.0.1:${handle.port}/api/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: 'plain text',
        });
        expect(res.status).toBe(415);
      } finally {
        await handle.close();
      }
    });

    it('rejects malformed JSON with 400', async () => {
      const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
      try {
        const res = await fetch(`http://127.0.0.1:${handle.port}/api/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: '{ not valid json',
        });
        expect(res.status).toBe(400);
      } finally {
        await handle.close();
      }
    });

    it('rejects oversize body (>64 KB) with 413', async () => {
      const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
      try {
        const big = 'x'.repeat(70 * 1024);
        const res = await fetch(`http://127.0.0.1:${handle.port}/api/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ junk: big }),
        });
        expect(res.status).toBe(413);
      } finally {
        await handle.close();
      }
    });
  });
```

- [ ] **Step 2: Run tests, expect RED**

`npm test --silent -- server` — 5 new tests should fail (PUT returns 405 currently).

- [ ] **Step 3: Implement PUT handler in `src/ui/server.ts`**

First, change the `handle()` function to allow PUT on `/api/settings`. Currently the method-check returns 405 for non-GET. Replace:

```ts
  if (method !== 'GET') {
    res.writeHead(405).end('Method not allowed');
    return;
  }

  // Strip query string for path-matching.
  const path = url.split('?')[0];
```

with:

```ts
  // Strip query string for path-matching.
  const path = url.split('?')[0];

  if (method === 'PUT' && path === '/api/settings') {
    return handlePutSettings(req, res);
  }
  if (method !== 'GET') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
```

Then add the `handlePutSettings` function ABOVE the `handle()` function:

```ts
import { saveSettings, Settings } from './settingsStore.js';

const MAX_BODY_BYTES = 64 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const ct = (req.headers['content-type'] ?? '').split(';')[0].trim();
  if (ct !== 'application/json') {
    throw Object.assign(new Error('Content-Type must be application/json'), { httpStatus: 415 });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw Object.assign(new Error('Request body exceeds 64 KB'), { httpStatus: 413 });
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw Object.assign(new Error('Malformed JSON: ' + (err as Error).message), { httpStatus: 400 });
  }
}

async function handlePutSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const raw = await readJsonBody(req);
    const validated = Settings.parse(raw);
    saveSettings(validated);
    sendJson(res, 200, validated);
  } catch (err) {
    const status = (err as { httpStatus?: number }).httpStatus ?? 400;
    sendJson(res, status, { error: (err as Error).message });
  }
}
```

The existing `loadSettings` import line needs to grow to include `saveSettings` and `Settings`. The current import is `import { loadSettings } from './settingsStore.js';` — change to `import { loadSettings, saveSettings, Settings } from './settingsStore.js';`.

- [ ] **Step 4: Run tests, expect GREEN**

`npm test --silent -- server` — all 11 server tests pass (6 GET + 5 PUT).

- [ ] **Step 5: Full suite + typecheck**

`npm run typecheck && npm test --silent` — 38 tests pass (33 + 5 new).

- [ ] **Step 6: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/ui/server.ts src/ui/server.test.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(ui): PUT /api/settings with Zod validation and 64 KB body cap"
```

---

## Task 2: Interruptible sleep helper

**Files:**
- Create: `src/ui/sleepUntilWake.ts`
- Create: `src/ui/sleepUntilWake.test.ts`

A tiny utility used by the runner between cycles. Resolves on whichever happens first: timer OR `fs.watch` event on the watched file.

- [ ] **Step 1: Write the failing test**

Create `src/ui/sleepUntilWake.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sleepUntilWake } from './sleepUntilWake.js';

describe('sleepUntilWake', () => {
  let tmpRoot: string;
  let watchPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'erp-sleep-'));
    watchPath = join(tmpRoot, 'settings.json');
    writeFileSync(watchPath, '{}');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('resolves after the timeout when no file change', async () => {
    const t0 = Date.now();
    const reason = await sleepUntilWake(150, watchPath);
    const elapsed = Date.now() - t0;
    expect(reason).toBe('timeout');
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(500);
  });

  it('resolves early when the watched file changes', async () => {
    const t0 = Date.now();
    // Schedule a write 60ms in.
    setTimeout(() => writeFileSync(watchPath, '{"paused":true}'), 60);
    const reason = await sleepUntilWake(2000, watchPath);
    const elapsed = Date.now() - t0;
    expect(reason).toBe('file-changed');
    expect(elapsed).toBeLessThan(500);
  });

  it('does not throw if the watch path does not exist (resolves on timeout)', async () => {
    const missing = join(tmpRoot, 'never-existed.json');
    expect(existsSync(missing)).toBe(false);
    const reason = await sleepUntilWake(150, missing);
    expect(reason).toBe('timeout');
  });
});
```

- [ ] **Step 2: Run tests, expect RED** (import fails)

`npm test --silent -- sleepUntilWake`.

- [ ] **Step 3: Implement `src/ui/sleepUntilWake.ts`**

```ts
import { watch as fsWatch, type FSWatcher } from 'node:fs';

export type WakeReason = 'timeout' | 'file-changed';

/**
 * Sleep for `ms` milliseconds OR until the file at `path` changes — whichever
 * fires first. Returns the reason. If `path` doesn't exist or fs.watch is
 * unavailable, this degrades to a plain timeout.
 */
export function sleepUntilWake(ms: number, path: string): Promise<WakeReason> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    let watcher: FSWatcher | null = null;
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
      }
    };

    const settle = (reason: WakeReason) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(reason);
    };

    timer = setTimeout(() => settle('timeout'), ms);

    try {
      watcher = fsWatch(path, () => settle('file-changed'));
      // If the file is removed/renamed, fs.watch emits an error on some
      // platforms — degrade silently to timeout-only.
      watcher.on('error', () => {
        if (watcher) {
          try {
            watcher.close();
          } catch {
            /* ignore */
          }
        }
        watcher = null;
      });
    } catch {
      // fs.watch throws synchronously on missing path on some platforms.
      // Degrade to timeout-only.
    }
  });
}
```

- [ ] **Step 4: Run tests, expect GREEN**

`npm test --silent -- sleepUntilWake` — 3/3 pass.

- [ ] **Step 5: Full suite**

`npm run typecheck && npm test --silent` — 41 tests pass.

- [ ] **Step 6: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/ui/sleepUntilWake.ts src/ui/sleepUntilWake.test.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(ui): sleepUntilWake — fs.watch-interruptible sleep helper"
```

---

## Task 3: Wire `sleepUntilWake` into the runner loop

**Files:**
- Modify: `src/agent/runner.ts`

Currently the loop ends with `await sleep(env.LOOP_INTERVAL_MS)`. Replace with the interruptible variant pointing at `config/settings.json`.

- [ ] **Step 1: Add the import**

In `src/agent/runner.ts`, near the other ui imports, add:

```ts
import { sleepUntilWake } from '../ui/sleepUntilWake.js';
import { join } from 'node:path';  // (if not already imported — check first)
import { configDir } from '../paths.js';  // (if not already imported)
```

Most of these are likely already imported. Inspect first.

- [ ] **Step 2: Replace the `sleep(...)` call**

Find the existing line (inside the `do { ... } while (!stopping)` loop near the end of the file):

```ts
    console.log(`[runner] sleeping ${env.LOOP_INTERVAL_MS / 1000}s`);
    await sleep(env.LOOP_INTERVAL_MS);
```

Replace with:

```ts
    console.log(`[runner] sleeping ${env.LOOP_INTERVAL_MS / 1000}s (wake on settings change)`);
    const reason = await sleepUntilWake(env.LOOP_INTERVAL_MS, join(configDir(), 'settings.json'));
    if (reason === 'file-changed') console.log('[runner] woken early — settings.json changed');
```

The existing local `sleep` function in runner.ts (a 1-line helper) is no longer used after this — remove it if it's only referenced here. Check with grep.

- [ ] **Step 3: Typecheck + tests**

`npm run typecheck && npm test --silent` — 41 pass.

- [ ] **Step 4: Manual smoke**

```bash
cd /Users/driversti/Projects/erepublik/erepublik-agent
rm -f config/settings.json
ERP_ACCOUNT_SLUG=baryga2026 npm run agent > /tmp/p4-sleep.log 2>&1 &
RUNNER_PID=$!
sleep 6
# Wait for the runner to reach the sleep line, then touch settings.
tail -f /tmp/p4-sleep.log &
TAIL_PID=$!
sleep 5
echo '{"paused":true,"farmEnabled":true,"modeOverride":null,"maverickManual":null,"d4tw":{"targetDamageAttacker":130000000,"targetDamageDefender":220000000,"maxBattlesPerSession":1,"weaponPriority":[7,6,5,4,3,2,1]},"emptyDiv":{"maxBattlesPerSession":3,"nativeWeaponPriority":[7,6,5,4,3,2,1],"foreignWeaponPolicy":"bomb-then-bazooka"},"travel":{"maxTravelCC":100,"returnHomeAfterMinutes":15,"returnHomeMaxCC":500},"detected":{"division":null,"hasMaverick":null,"citizenId":null,"countryId":null,"lastUpdated":null}}' > config/settings.json
sleep 5
kill $TAIL_PID 2>/dev/null
kill -INT $RUNNER_PID 2>/dev/null
wait $RUNNER_PID 2>/dev/null
rm -f config/settings.json
```

Expected log lines:
- `[runner] sleeping 600s (wake on settings change)`
- (after touching the file) `[runner] woken early — settings.json changed`
- (next cycle log) `[cycle] paused — skipping ...`
- `[runner] stopped`

If the smoke shows the runner did NOT wake early, fs.watch isn't firing on this filesystem — report DONE_WITH_CONCERNS and leave the change in place (the cycle still picks up settings on its NEXT scheduled wake-up, so behavior is correct, just not instant).

- [ ] **Step 5: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/agent/runner.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(runner): wake early when config/settings.json changes"
```

---

## Task 4: Frontend — top-level toggles bound to PUT

**Files:**
- Modify: `src/ui/public/index.html`
- Modify: `src/ui/public/app.js`

Replace the read-only settings block with interactive Pause / Farm-enabled toggles + a "saving…" indicator. Keep the JSON dump as a collapsible details element for power users.

- [ ] **Step 1: Replace the settings section in `index.html`**

Find the existing section:

```html
    <section class="bg-white rounded shadow p-4 md:col-span-2">
      <h2 class="font-semibold mb-2">Settings (read-only in this phase)</h2>
      <pre id="settings-json" class="text-xs bg-gray-50 p-3 rounded overflow-x-auto">loading…</pre>
    </section>
```

Replace with:

```html
    <section class="bg-white rounded shadow p-4 md:col-span-2">
      <div class="flex items-center justify-between mb-3">
        <h2 class="font-semibold">Settings</h2>
        <span id="save-indicator" class="text-xs text-gray-400">—</span>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label class="flex items-center gap-2 cursor-pointer">
          <input id="toggle-paused" type="checkbox" class="h-4 w-4">
          <span>Pause bot (skips entire cycle)</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input id="toggle-farmEnabled" type="checkbox" class="h-4 w-4">
          <span>Farm enabled (skip farm gate when off)</span>
        </label>
      </div>
      <details class="mt-4">
        <summary class="text-xs text-gray-500 cursor-pointer">Raw JSON</summary>
        <pre id="settings-json" class="text-xs bg-gray-50 p-3 rounded overflow-x-auto mt-2">loading…</pre>
      </details>
    </section>
```

- [ ] **Step 2: Add JS bindings in `app.js`**

Append (or integrate near the existing `refresh()` definition) the following:

```js
let lastSettings = null;
let saveDebounceTimer = null;

function setSaveIndicator(text, color) {
  const el = document.getElementById('save-indicator');
  if (!el) return;
  el.textContent = text;
  el.className = `text-xs ${color}`;
}

async function putSettings(next) {
  setSaveIndicator('saving…', 'text-gray-500');
  try {
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 100)}`);
    lastSettings = await r.json();
    setSaveIndicator('saved ✓', 'text-emerald-600');
    setTimeout(() => setSaveIndicator('—', 'text-gray-400'), 1500);
  } catch (err) {
    setSaveIndicator(`error: ${err.message}`, 'text-red-600');
  }
}

function scheduleSave(mutator) {
  if (!lastSettings) return;
  const next = JSON.parse(JSON.stringify(lastSettings));
  mutator(next);
  lastSettings = next;
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => putSettings(next), 300);
}

function bindControls() {
  const paused = document.getElementById('toggle-paused');
  const farm = document.getElementById('toggle-farmEnabled');
  if (paused) paused.addEventListener('change', (e) => scheduleSave((s) => (s.paused = e.target.checked)));
  if (farm) farm.addEventListener('change', (e) => scheduleSave((s) => (s.farmEnabled = e.target.checked)));
}

function renderSettingsForm(s) {
  lastSettings = s;
  const paused = document.getElementById('toggle-paused');
  const farm = document.getElementById('toggle-farmEnabled');
  if (paused && document.activeElement !== paused) paused.checked = !!s.paused;
  if (farm && document.activeElement !== farm) farm.checked = !!s.farmEnabled;
}

bindControls();
```

Then INSIDE the existing `refresh()` function, after `document.getElementById('settings-json').textContent = JSON.stringify(settings, null, 2);`, add:

```js
    renderSettingsForm(settings);
```

The `document.activeElement` guard prevents the poll from clobbering a checkbox the user is actively interacting with mid-PUT.

- [ ] **Step 3: Manual eyeball test**

Run the agent: `ERP_ACCOUNT_SLUG=baryga2026 npm run agent` in one terminal. Open `http://localhost:3737` in your browser. Verify:
- Both checkboxes load with the current state from `/api/settings`.
- Toggling "Pause bot" updates the badge to "saving…" → "saved ✓" within ~300 ms.
- Reload the page — the toggle persists.
- Untoggle, save, reload — also persists.
- After a couple seconds the agent log shows `[runner] woken early — settings.json changed`.
- Inspect `config/settings.json` to confirm the values match.

Kill the agent with Ctrl-C. Reset state:

```bash
rm config/settings.json
```

- [ ] **Step 4: Typecheck + tests**

`npm run typecheck && npm test --silent` — 41 pass (no source-code changes affect tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/ui/public/
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(ui): Pause + Farm-enabled toggles editable from dashboard"
```

---

## Task 5: Frontend — mode dropdown + D4-TW config fields

**Files:**
- Modify: `src/ui/public/index.html`
- Modify: `src/ui/public/app.js`

Add a Strategy section with a mode dropdown (`auto` + the three strategies) and four number inputs for D4-TW targets and session cap. Weapon priority is shown read-only (changing it via UI in v1 is overkill — JSON-edit if needed).

- [ ] **Step 1: Add a Strategy section to `index.html`**

Before the existing `<section>` that contains "Today's actions" (or anywhere logical in the grid), insert a new section:

```html
    <section class="bg-white rounded shadow p-4 md:col-span-2">
      <h2 class="font-semibold mb-3">Farm strategy</h2>
      <div class="flex flex-wrap items-center gap-3 mb-3">
        <label class="flex items-center gap-2">
          <span class="text-sm">Mode:</span>
          <select id="mode-override" class="border rounded px-2 py-1 text-sm">
            <option value="">Auto</option>
            <option value="standard">Standard (D1-D3 empty-div)</option>
            <option value="d4tw">D4-TW (native, hit to target)</option>
            <option value="maverickD3">Maverick-D3 (D3 empty-div)</option>
          </select>
        </label>
        <label class="flex items-center gap-2">
          <span class="text-sm">Maverick override:</span>
          <select id="maverick-manual" class="border rounded px-2 py-1 text-sm">
            <option value="">Auto-detect</option>
            <option value="true">YES</option>
            <option value="false">NO</option>
          </select>
        </label>
      </div>
      <div class="bg-gray-50 rounded p-3 text-sm">
        <div class="font-medium mb-2">D4-TW settings</div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label class="flex flex-col">
            <span class="text-xs text-gray-500">Target damage (attacker)</span>
            <input id="d4tw-attacker" type="number" min="1" class="border rounded px-2 py-1">
          </label>
          <label class="flex flex-col">
            <span class="text-xs text-gray-500">Target damage (defender)</span>
            <input id="d4tw-defender" type="number" min="1" class="border rounded px-2 py-1">
          </label>
          <label class="flex flex-col">
            <span class="text-xs text-gray-500">Max battles per session</span>
            <input id="d4tw-maxBattles" type="number" min="1" max="10" class="border rounded px-2 py-1">
          </label>
          <div class="flex flex-col text-xs text-gray-500">
            <span>Weapon priority (edit JSON to change)</span>
            <code id="d4tw-weapons" class="bg-white border rounded px-2 py-1">—</code>
          </div>
        </div>
        <p class="text-xs text-amber-800 bg-amber-50 rounded p-2 mt-2">
          ⓘ "Max battles per session" caps how many TW battles the bot fights per cycle (~10 min).
          For TW each battle is one big deploy of 1500–3000 energy — usually only one fits per full pool.
        </p>
      </div>
    </section>
```

- [ ] **Step 2: Extend `bindControls()` and `renderSettingsForm()` in `app.js`**

Inside `bindControls()`, after the existing two listeners, add:

```js
  const mode = document.getElementById('mode-override');
  if (mode) mode.addEventListener('change', (e) => scheduleSave((s) => (s.modeOverride = e.target.value || null)));
  const maverick = document.getElementById('maverick-manual');
  if (maverick)
    maverick.addEventListener('change', (e) => {
      const v = e.target.value;
      scheduleSave((s) => (s.maverickManual = v === '' ? null : v === 'true'));
    });
  const att = document.getElementById('d4tw-attacker');
  if (att) att.addEventListener('change', (e) => scheduleSave((s) => (s.d4tw.targetDamageAttacker = Number(e.target.value))));
  const def = document.getElementById('d4tw-defender');
  if (def) def.addEventListener('change', (e) => scheduleSave((s) => (s.d4tw.targetDamageDefender = Number(e.target.value))));
  const maxB = document.getElementById('d4tw-maxBattles');
  if (maxB) maxB.addEventListener('change', (e) => scheduleSave((s) => (s.d4tw.maxBattlesPerSession = Number(e.target.value))));
```

Inside `renderSettingsForm(s)`, after the existing two `if (paused && ...)` lines, add:

```js
  const mode = document.getElementById('mode-override');
  if (mode && document.activeElement !== mode) mode.value = s.modeOverride ?? '';
  const maverick = document.getElementById('maverick-manual');
  if (maverick && document.activeElement !== maverick) {
    maverick.value = s.maverickManual === null ? '' : String(s.maverickManual);
  }
  const att = document.getElementById('d4tw-attacker');
  if (att && document.activeElement !== att) att.value = String(s.d4tw.targetDamageAttacker);
  const def = document.getElementById('d4tw-defender');
  if (def && document.activeElement !== def) def.value = String(s.d4tw.targetDamageDefender);
  const maxB = document.getElementById('d4tw-maxBattles');
  if (maxB && document.activeElement !== maxB) maxB.value = String(s.d4tw.maxBattlesPerSession);
  const weapons = document.getElementById('d4tw-weapons');
  if (weapons) weapons.textContent = JSON.stringify(s.d4tw.weaponPriority);
```

- [ ] **Step 3: Manual eyeball**

Run agent + browser as in Task 4 Step 3. Verify:
- Mode dropdown shows "Auto" by default; changing to "D4-TW" persists.
- Maverick override shows "Auto-detect"; setting to "YES" persists.
- All three number inputs accept changes and persist.
- Reload — all values stick.
- After typing a new number, the badge fires "saving…" → "saved ✓" within ~300ms.
- Inspect `config/settings.json` to confirm the values match.

Reset: `rm config/settings.json`.

- [ ] **Step 4: Typecheck + tests**

`npm run typecheck && npm test --silent` — 41 pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/ui/public/
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(ui): mode dropdown + D4-TW target/cap fields editable from dashboard"
```

---

## Task 6: Smoke test

**Files:** none — verification only.

End-to-end check that all four toggles work, sleep-interrupt fires, and there's no regression.

- [ ] **Step 1: Clean state**

```bash
rm -f /Users/driversti/Projects/erepublik/erepublik-agent/config/settings.json
```

- [ ] **Step 2: Start agent in background**

```bash
cd /Users/driversti/Projects/erepublik/erepublik-agent
ERP_ACCOUNT_SLUG=baryga2026 npm run agent > /tmp/p4-smoke.log 2>&1 &
RUNNER_PID=$!
sleep 8
```

- [ ] **Step 3: PUT a paused state and confirm sleep-interrupt fires**

```bash
curl -s -X PUT http://localhost:3737/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"paused":true,"farmEnabled":true,"modeOverride":null,"maverickManual":null,"d4tw":{"targetDamageAttacker":130000000,"targetDamageDefender":220000000,"maxBattlesPerSession":1,"weaponPriority":[7,6,5,4,3,2,1]},"emptyDiv":{"maxBattlesPerSession":3,"nativeWeaponPriority":[7,6,5,4,3,2,1],"foreignWeaponPolicy":"bomb-then-bazooka"},"travel":{"maxTravelCC":100,"returnHomeAfterMinutes":15,"returnHomeMaxCC":500},"detected":{"division":null,"hasMaverick":null,"citizenId":null,"countryId":null,"lastUpdated":null}}' \
  | python3 -m json.tool | head -5
sleep 6
echo "--- recent log lines ---"
tail -20 /tmp/p4-smoke.log
```

Expected:
- PUT returns JSON with `paused: true`.
- Within ~5 seconds the log shows `[runner] woken early — settings.json changed`.
- Next cycle log shows `[cycle] paused — skipping ...`.

- [ ] **Step 4: PUT an unpaused state and verify normal cycle resumes**

```bash
curl -s -X PUT http://localhost:3737/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"paused":false,"farmEnabled":false,"modeOverride":null,"maverickManual":null,"d4tw":{"targetDamageAttacker":130000000,"targetDamageDefender":220000000,"maxBattlesPerSession":1,"weaponPriority":[7,6,5,4,3,2,1]},"emptyDiv":{"maxBattlesPerSession":3,"nativeWeaponPriority":[7,6,5,4,3,2,1],"foreignWeaponPolicy":"bomb-then-bazooka"},"travel":{"maxTravelCC":100,"returnHomeAfterMinutes":15,"returnHomeMaxCC":500},"detected":{"division":null,"hasMaverick":null,"citizenId":null,"countryId":null,"lastUpdated":null}}' \
  > /dev/null
sleep 6
echo "--- recent log lines ---"
tail -25 /tmp/p4-smoke.log
```

Expected:
- New cycle runs with `[cycle] farm: ⏭ disabled via settings.farmEnabled (week=...)`.
- Daily actions and sweeps run normally.

- [ ] **Step 5: Validation rejections via curl**

```bash
echo "--- malformed JSON (expect 400) ---"
curl -s -o /dev/null -w 'status=%{http_code}\n' -X PUT http://localhost:3737/api/settings \
  -H 'Content-Type: application/json' -d '{ not valid'
echo "--- wrong content-type (expect 415) ---"
curl -s -o /dev/null -w 'status=%{http_code}\n' -X PUT http://localhost:3737/api/settings \
  -H 'Content-Type: text/plain' -d 'hello'
echo "--- bad schema (expect 400) ---"
curl -s -o /dev/null -w 'status=%{http_code}\n' -X PUT http://localhost:3737/api/settings \
  -H 'Content-Type: application/json' -d '{"paused":"yes please"}'
```

- [ ] **Step 6: Shutdown**

```bash
kill -INT $RUNNER_PID 2>/dev/null
wait $RUNNER_PID 2>/dev/null
rm -f /Users/driversti/Projects/erepublik/erepublik-agent/config/settings.json
```

- [ ] **Step 7: Full vitest**

```bash
npm test --silent
```

Expected: 41 tests pass.

- [ ] **Step 8: No commit**

Verification only.

---

## Self-Review Notes (for the implementer)

- `fs.watch` semantics differ across platforms. On macOS / Linux it's reliable for individual files. On some Windows configurations (network shares, antivirus exclusion paths) it may not fire. The graceful fallback in `sleepUntilWake` (timer always set, watch is optional) keeps behavior correct in the worst case — pause is just less responsive (up to one `LOOP_INTERVAL_MS` of latency).
- The PUT body is parsed via `for await (const chunk of req)`. Memory cap at 64 KB is enforced — large requests are short-circuited before they exhaust RAM.
- The frontend's `document.activeElement` guard prevents the 3-second poll from clobbering the input the user is currently typing in. It's not perfect (focus moves before submit) but covers the common case.
- Weapon priority is editable via the Raw JSON view only. Users with arrays of integers as a strategy preference are inherently more technical than the default audience; the v1 form keeps the surface small.
- Phase 5 (D4-TW strategy) will populate `settings.detected.*` from page reads. The UI shows them as part of the Raw JSON; no input form is needed since they're auto-managed.
- Phase 6 (Maverick auto-detect) is the source of `settings.detected.hasMaverick`. The manual override dropdown in Task 5 covers the case where auto-detect is wrong.
