# Run-now Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a UI button that wakes the daily runner immediately when it's sleeping between cycles, by re-saving `config/settings.json` unchanged through a new `POST /api/run-now` endpoint.

**Architecture:** Reuse the existing `fs.watch`-on-`config/settings.json` wake path that `sleepUntilWake` already listens to. The new endpoint calls `saveSettings(loadSettings())` — atomic tmpfile + rename bumps the file's mtime, `fs.watch` fires, the runner's sleep returns early. No new IPC, no AbortController plumbing, no extra watchers.

**Tech Stack:** TypeScript (ESM), Node `http`, Zod schema in `settingsStore.ts`, vanilla JS on the dashboard, Vitest for backend tests.

**Spec:** [`docs/superpowers/specs/2026-05-18-run-now-button-design.md`](../specs/2026-05-18-run-now-button-design.md)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/ui/server.ts` | Modify | Add `POST /api/run-now` handler that re-saves current settings, plus `405` for non-POST on that path. |
| `src/ui/server.test.ts` | Modify | Add a `describe('POST /api/run-now', ...)` block with four tests (200 ok, mtime bumped, settings unchanged, non-POST → 405). |
| `src/ui/public/index.html` | Modify | Add `<button id="btn-run-now">` + hint `<span>` after the paused/farmEnabled grid in the Settings section (the section with `<h2>Settings</h2>` near line 100; **not** the Farm strategy section despite the spec's wording). |
| `src/ui/public/app.js` | Modify | Add `bindRunNowButton()` function, call it once at module scope alongside the existing `bindControls()` invocation. |

No new files, no shared types added, no schema changes.

---

## Task 1: Backend — failing tests for POST `/api/run-now`

**Files:**
- Modify: `src/ui/server.test.ts`

- [ ] **Step 1: Append a new `describe` block at the end of the outer `describe('UI server', () => { ... })` body, just before its closing brace**

The existing file ends with the `describe('PUT /api/settings', ...)` block. Add the new block as a sibling. Insert this entire block immediately before the final `});` that closes `describe('UI server', ...)`:

```ts
  describe('POST /api/run-now', () => {
    it('returns 200 { ok: true }', async () => {
      const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
      try {
        // Seed defaults so settings.json exists.
        await fetch(`http://127.0.0.1:${handle.port}/api/settings`);
        const res = await fetch(`http://127.0.0.1:${handle.port}/api/run-now`, { method: 'POST' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ ok: true });
      } finally {
        await handle.close();
      }
    });

    it('rewrites settings.json so fs.watch would fire (mtime bumped)', async () => {
      const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
      try {
        await fetch(`http://127.0.0.1:${handle.port}/api/settings`);
        const file = join(tmpRoot, 'config', 'settings.json');
        const mtimeBefore = statSync(file).mtimeMs;
        // 10 ms is enough for filesystem mtime resolution on macOS/Linux APFS/ext4.
        await new Promise((r) => setTimeout(r, 15));
        const res = await fetch(`http://127.0.0.1:${handle.port}/api/run-now`, { method: 'POST' });
        expect(res.status).toBe(200);
        const mtimeAfter = statSync(file).mtimeMs;
        expect(mtimeAfter).toBeGreaterThan(mtimeBefore);
      } finally {
        await handle.close();
      }
    });

    it('does not mutate the persisted settings', async () => {
      const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
      try {
        const before = await (await fetch(`http://127.0.0.1:${handle.port}/api/settings`)).json();
        await fetch(`http://127.0.0.1:${handle.port}/api/run-now`, { method: 'POST' });
        const after = await (await fetch(`http://127.0.0.1:${handle.port}/api/settings`)).json();
        expect(after).toEqual(before);
      } finally {
        await handle.close();
      }
    });

    it('rejects non-POST methods with 405', async () => {
      const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
      try {
        const res = await fetch(`http://127.0.0.1:${handle.port}/api/run-now`);
        expect(res.status).toBe(405);
      } finally {
        await handle.close();
      }
    });
  });
```

- [ ] **Step 2: Add `statSync` to the existing `node:fs` import at the top of the file**

The current import is:
```ts
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
```

Change it to:
```ts
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
```

- [ ] **Step 3: Run the new tests and confirm they fail**

Run: `npm test -- src/ui/server.test.ts`

Expected: at least 3 of the 4 new tests fail. The 405 test may or may not fail on its own (depends on whether the server's default branch returns 404 or 405 for unknown paths) — that's fine; the suite as a whole must be red.

- [ ] **Step 4: Commit the failing tests**

```bash
git add src/ui/server.test.ts
git commit -m "test(ui): failing tests for POST /api/run-now"
```

---

## Task 2: Backend — implement `POST /api/run-now`

**Files:**
- Modify: `src/ui/server.ts`

- [ ] **Step 1: Add a `handleRunNow` function above the `handle` function**

Insert immediately after `handlePutSettings` (currently lines 94-104):

```ts
function handleRunNow(_req: IncomingMessage, res: ServerResponse): void {
  try {
    // Reuse the existing fs.watch-on-settings.json wake path: atomic write
    // bumps mtime so sleepUntilWake (in the runner) breaks out of its sleep.
    saveSettings(loadSettings());
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message });
  }
}
```

- [ ] **Step 2: Wire the new endpoint into the method router**

In the `handle` function (currently lines 106-143), find this block:

```ts
  if (method === 'PUT' && path === '/api/settings') {
    return void handlePutSettings(req, res);
  }
  if (method !== 'GET') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
```

Replace it with:

```ts
  if (method === 'PUT' && path === '/api/settings') {
    return void handlePutSettings(req, res);
  }
  if (method === 'POST' && path === '/api/run-now') {
    return handleRunNow(req, res);
  }
  if (path === '/api/run-now') {
    // POST is the only verb; GET / PUT / DELETE etc. → 405.
    res.writeHead(405).end('Method not allowed');
    return;
  }
  if (method !== 'GET') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
```

The dedicated `/api/run-now` method guard above the generic `method !== 'GET'` check ensures that a GET on `/api/run-now` returns 405 (not 404 — we want method-not-allowed semantics, not path-not-found).

- [ ] **Step 3: Run the server tests and confirm all pass**

Run: `npm test -- src/ui/server.test.ts`

Expected: all tests pass (the existing UI server tests and the four new `POST /api/run-now` tests).

- [ ] **Step 4: Run the full test suite to confirm no regressions**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/ui/server.ts
git commit -m "feat(ui): POST /api/run-now triggers fs.watch via settings re-save"
```

---

## Task 3: Frontend — add the button and hint to the dashboard

**Files:**
- Modify: `src/ui/public/index.html`
- Modify: `src/ui/public/app.js`

- [ ] **Step 1: Add the button + hint to `index.html`**

Find the existing checkbox grid in the Settings section (around line 103-112):

```html
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
```

Insert the following block **immediately after** the closing `</div>` of that grid (i.e. after line 112, before the `<div class="bg-gray-50 rounded p-3 text-sm mt-4">` of the cooldown subsection):

```html
      <div class="mt-3 flex items-center gap-3">
        <button
          id="btn-run-now"
          type="button"
          class="px-3 py-1.5 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed">
          Run now
        </button>
        <span id="run-now-hint" class="text-xs text-gray-500">
          Wakes the runner immediately if it's sleeping.
        </span>
      </div>
```

`type="button"` is important — without it, the `<button>` defaults to `type="submit"`, which would do nothing harmful here (no form) but is a footgun if a form is added later.

- [ ] **Step 2: Add `bindRunNowButton()` to `app.js`**

In `src/ui/public/app.js`, append a new function after the existing `bindControls()` function (which currently ends at line 205). Insert this immediately after the closing `}` of `bindControls`:

```js
function bindRunNowButton() {
  const btn = document.getElementById('btn-run-now');
  if (!btn) return;
  const hint = document.getElementById('run-now-hint');
  const defaultHint = hint?.textContent ?? '';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    if (hint) hint.textContent = 'Requested — runner will wake on next sleep tick.';
    try {
      const r = await fetch('/api/run-now', { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 100)}`);
    } catch (err) {
      if (hint) hint.textContent = `Failed: ${err.message}`;
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        if (hint) hint.textContent = defaultHint;
      }, 3000);
    }
  });
}
```

- [ ] **Step 3: Call `bindRunNowButton()` at module init**

In `src/ui/public/app.js`, find the line at the bottom of the file:

```js
bindControls();
```

Replace it with:

```js
bindControls();
bindRunNowButton();
```

- [ ] **Step 4: Manual smoke test — confirm the button wakes the runner**

Start the runner in one terminal:

```bash
npm start
```

Wait for the line `[runner] sleeping 600s (wake on settings change)` to appear in the log. Open `http://localhost:3737/` (or whichever port the runner picked) in a browser. Click the **Run now** button.

Expected: within 1 second, the runner log prints `[runner] woken early — settings.json changed`, and a new cycle starts. The button disables for 3 seconds, the hint text changes to *"Requested — runner will wake on next sleep tick."* during that window, then reverts.

If the runner is in the middle of a cycle when you click, nothing visible happens — that's the documented race-window limitation. Click again once the current cycle finishes and the runner enters sleep.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `npm test`

Expected: all tests pass. Frontend changes have no unit tests; the manual smoke step covers them.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0. (No new TS files; the JS frontend files aren't type-checked.)

- [ ] **Step 7: Commit**

```bash
git add src/ui/public/index.html src/ui/public/app.js
git commit -m "feat(ui): Run now button wakes the runner on demand"
```

---

## Task 4: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: all tests pass, including the four new ones in the `POST /api/run-now` describe block.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 3: Confirm `git log` shows three new commits on the feature branch**

Run: `git log --oneline main..HEAD`

Expected output (most-recent first):

```
<sha> feat(ui): Run now button wakes the runner on demand
<sha> feat(ui): POST /api/run-now triggers fs.watch via settings re-save
<sha> test(ui): failing tests for POST /api/run-now
```

Plus the earlier spec commit (`docs: spec for run-now button`).

---

## Notes for the executor

- **Do NOT add new wake mechanisms** (AbortController, EventEmitter between server and runner, sentinel files). The spec explicitly rejects all of these — the settings-re-save approach is the chosen path because it reuses the existing `fs.watch` infrastructure.
- **Do NOT change the `Settings` Zod schema.** The endpoint reads-then-writes the existing schema as-is.
- **Do NOT add new tests for the frontend.** The codebase has no DOM-testing infrastructure (no jsdom, no playwright for the dashboard), and one button doesn't justify introducing it.
- **Do NOT change the runner.** This feature is purely a UI + server change. The runner already wakes on `settings.json` change; we're just adding a new way to trigger that change.
- **Do NOT change `sleepUntilWake.ts`.** Same reason as above.
- **HTML insertion point is the Settings section** (the section whose `<h2>` is "Settings", around line 100). The spec's prose said "Farm strategy section" — that was a wording error in the spec; the line numbers it referenced (`index.html:105-109`) are correct and live in the Settings section.
- The new endpoint takes **no request body** and **no Content-Type**. Don't add body-parsing — it would just create a class of 415 errors for an endpoint that doesn't need them.
