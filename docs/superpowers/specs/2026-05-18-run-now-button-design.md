# Run-now button — wake the runner on demand

**Status:** approved
**Author:** Claude + Yurii
**Date:** 2026-05-18

## Problem

The daily runner sleeps `LOOP_INTERVAL_MS` (default 10 minutes) between cycles. The only ways to force a cycle right now are:

- Restart the app.
- Toggle some setting in the UI as a side-effect (since `fs.watch` on `config/settings.json` already wakes `sleepUntilWake`).

There is no explicit "Run now" affordance, so users who just want *"run a cycle immediately"* have to either wait or invent a fake settings change. The infrastructure to wake the loop is already in place — we just need to expose it.

## Goals

1. **Explicit UI control** — a "Run now" button on the dashboard that requests the runner to start a new cycle as soon as possible.
2. **Reuse the existing wake mechanism** — no new IPC, no new file watcher, no AbortController plumbing. The button writes the current settings back to disk, which triggers the existing `fs.watch` on `config/settings.json` that `sleepUntilWake` is already listening to.
3. **Click is idempotent and safe** — clicking 10 times in a row mustn't queue 10 cycles or break the runner.

## Non-goals

- **Interrupting an in-flight cycle.** If the runner is currently executing `runCycle`, the click is best-effort: it may not register, because `fs.watch` only sees events after a watcher is created (i.e. after `sleepUntilWake` is called). The user will either get the next cycle immediately (if it landed during sleep), or have to click again after the current cycle finishes. This is documented in the UI tooltip.
- **AbortController-driven hard abort** of the current cycle. The architecture cost (thread an `AbortSignal` through `sleepUntilWake`, expose a callback from the UI server, share state between server and runner) is not worth it for the size of the race window.
- **A queue of pending wake requests.** YAGNI — one wake is enough; the runner is going to run a cycle and then sleep again.
- **Authentication / CSRF on the endpoint.** The UI server already binds to `127.0.0.1` only and has no auth on `PUT /api/settings`; the new endpoint follows the same trust model.

## Design

### Backend — `src/ui/server.ts`

Add a single new endpoint:

```
POST /api/run-now
```

Behavior:

1. Read current settings via `loadSettings()`.
2. Write them back unchanged via `saveSettings()` (atomic write — tmpfile + `renameSync`). The rename bumps the file's mtime/ctime, which `fs.watch` sees as a change event.
3. Respond `200` with `{ ok: true }`.
4. If `loadSettings()` or `saveSettings()` throws (corrupt JSON, EACCES, ENOSPC), respond `500` with `{ error: message }`.

The endpoint takes no request body. Content-Type is irrelevant for `POST /api/run-now` — it returns 200 even with no body, no Content-Type header. This is consistent with how a "tap-to-trigger" endpoint should feel; the existing `PUT /api/settings` strictness comes from needing to parse a JSON body, which doesn't apply here.

Method check: `POST` returns 200; any other method on `/api/run-now` returns `405 Method not allowed` (the existing behavior for unsupported methods on other paths already covers this — we add `/api/run-now` to the method-router before the catchall `if (method !== 'GET')` guard).

### Frontend — `src/ui/public/index.html` + `app.js`

Add a button to the existing "Farm strategy" section, near the Pause/Farm-enabled checkboxes (around `index.html:105-109`).

```html
<div class="mt-3 flex items-center gap-3">
  <button
    id="btn-run-now"
    class="px-3 py-1.5 rounded bg-blue-600 text-white text-sm font-medium
           hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed">
    Run now
  </button>
  <span id="run-now-hint" class="text-xs text-gray-500">
    Wakes the runner immediately if it's sleeping.
  </span>
</div>
```

`app.js` wires up the click handler:

```js
function bindRunNowButton() {
  const btn = document.getElementById('btn-run-now');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const hint = document.getElementById('run-now-hint');
    const prev = hint?.textContent;
    if (hint) hint.textContent = 'Requested — runner will wake on next sleep tick.';
    try {
      const r = await fetch('/api/run-now', { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 100)}`);
    } catch (err) {
      if (hint) hint.textContent = `Failed: ${err.message}`;
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        if (hint && prev) hint.textContent = prev;
      }, 3000);
    }
  });
}
```

The 3-second disable prevents double-click spam — and is also long enough that the user sees the "Requested" feedback before the button re-enables.

### Wiring it through

`bindRunNowButton()` is called once from the existing init block in `app.js` (alongside `bindControls()`).

### Edge cases

| Case | Behavior |
|---|---|
| Runner is mid-cycle when button clicked | `fs.watch` only sees changes *after* it's created. The click writes settings.json, but the next `sleepUntilWake` starts a fresh watcher and the past event is gone. Next cycle runs after the full sleep — unless user clicks again during the sleep. Documented in the hint. |
| Runner is paused (`settings.paused === true`) | `runCycle` short-circuits before doing anything. "Run now" still wakes the sleep, but the cycle returns immediately. The button text doesn't lie: it wakes the runner. The user knows they're paused. |
| Settings file corrupt | `loadSettings()` throws → 500 response → UI shows "Failed: …" in the hint. The runner is unaffected. |
| User mashes the button 10×/sec | The disabled state blocks duplicate fetches for 3s. Even without the guard, this would just be 10 no-op writes to settings.json. Harmless. |
| App is closing | Endpoint fails (server is gone). Hint shows "Failed: …". Not a real scenario worth defensive code. |

## Testing

### Backend (`src/ui/server.test.ts`)

Add a `describe('POST /api/run-now', ...)` block with four tests:

1. **POST `/api/run-now` returns 200 `{ ok: true }`** — verify the response body.
2. **POST `/api/run-now` writes settings.json** — capture the file's mtime before and after; assert it changed. Confirms `fs.watch` would have fired.
3. **POST `/api/run-now` does not mutate settings** — read settings before and after; assert deep-equal. This is the contract: the endpoint is purely a wake trigger.
4. **Non-POST methods on `/api/run-now` return 405** — quick smoke that we don't accidentally accept GET (which would make it cacheable / preloadable).

The existing server test setup (port=0, temp config dir, `getSnapshot` stub) is the pattern — follow it.

### Frontend

No new unit tests. The frontend logic is a fetch + a disabled-toggle; the existing UI test scope (`src/ui/*.test.ts`) doesn't cover DOM interaction, and we won't introduce that infrastructure for one button.

The manual verification step in the plan is: run `npm start`, click the button while the runner is asleep, observe `[runner] woken early — settings.json changed` in the log within 1 second.

## Out of scope

- AbortController-based hard abort of the current cycle.
- A "Run now" tray-menu equivalent in the Electron host (the dashboard is the canonical control surface).
- Persisting a "last run-now requested at" timestamp in the snapshot.
- Differentiating "user-triggered wake" from "settings actually changed" in the runner's log line. Both currently show `woken early — settings.json changed`; that's fine.
