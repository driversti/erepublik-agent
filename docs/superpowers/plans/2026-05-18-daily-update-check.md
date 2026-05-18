# Daily Auto-Update Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the long-running Electron tray daemon poll GitHub Releases every 24 hours so users learn about new versions without restarting or clicking the manual check.

**Architecture:** Add a `setInterval`-driven recurring `autoUpdater.checkForUpdates()` on top of the existing 30-second startup check. Return a `dispose()` handle from `configureUpdater` so `main.ts` can cancel the timer on quit. Cover the new behavior with a vitest that uses fake timers and mocks `electron-updater` + `electron` at the module boundary.

**Tech Stack:** TypeScript (ESM), Electron 39, `electron-updater` 6.8, Vitest 4 (fake timers + `vi.mock`).

**Spec:** [`docs/superpowers/specs/2026-05-18-daily-update-check-design.md`](../specs/2026-05-18-daily-update-check-design.md)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `electron/updater.ts` | Modify | Add `DAILY_CHECK_INTERVAL_MS` constant, schedule recurring check, return `UpdaterHandle` from `configureUpdater`. |
| `electron/main.ts` | Modify | Capture `UpdaterHandle`, call `dispose()` inside the existing `onQuit` callback before `app.quit()`. |
| `electron/updater.test.ts` | Create | Vitest using fake timers + `vi.mock('electron-updater')` + `vi.mock('electron')` covering startup-check, 24h interval firing repeatedly, error swallowing, and `dispose()` cancellation. |

No other files change. The wizard, tray, supervisor, and packaging config are untouched.

---

## Task 1: Write the failing tests for the updater

**Files:**
- Create: `electron/updater.test.ts`

- [ ] **Step 1: Write `electron/updater.test.ts` with four failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const checkForUpdates = vi.fn();
const onSpy = vi.fn();

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      checkForUpdates,
      on: onSpy,
    },
  },
}));

vi.mock('electron', () => ({
  dialog: { showMessageBox: vi.fn() },
  app: { getVersion: () => '0.2.0' },
}));

import { configureUpdater } from './updater.js';

describe('configureUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    checkForUpdates.mockReset();
    checkForUpdates.mockResolvedValue(undefined);
    onSpy.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the startup check ~30s after configure', async () => {
    configureUpdater({
      onUpdateAvailable: vi.fn(),
      onUpdateNotAvailable: vi.fn(),
      onError: vi.fn(),
    });

    expect(checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('fires a recurring check every 24h after the startup check', async () => {
    configureUpdater({
      onUpdateAvailable: vi.fn(),
      onUpdateNotAvailable: vi.fn(),
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(checkForUpdates).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it('routes check failures to onError without throwing', async () => {
    const onError = vi.fn();
    checkForUpdates.mockRejectedValue(new Error('network down'));

    configureUpdater({
      onUpdateAvailable: vi.fn(),
      onUpdateNotAvailable: vi.fn(),
      onError,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('dispose() cancels both the startup timer and the daily interval', async () => {
    const handle = configureUpdater({
      onUpdateAvailable: vi.fn(),
      onUpdateNotAvailable: vi.fn(),
      onError: vi.fn(),
    });

    handle.dispose();
    await vi.advanceTimersByTimeAsync(30_000 + 48 * 60 * 60 * 1000);
    expect(checkForUpdates).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the new test file and confirm it fails**

Run: `npm test -- electron/updater.test.ts`

Expected: All 4 tests fail. The recurring-check, `dispose()`, and error-routing tests fail because the current `configureUpdater` has no interval and no return value (the dispose call site will TS-error or runtime-error). The startup test may pass on its own — that's fine, we only require the suite as a whole to be red.

- [ ] **Step 3: Commit the failing tests**

```bash
git add electron/updater.test.ts
git commit -m "test(electron): failing tests for daily update check"
```

---

## Task 2: Implement the daily check + dispose handle

**Files:**
- Modify: `electron/updater.ts`

- [ ] **Step 1: Add the constant, recurring interval, and `UpdaterHandle` return type**

Replace the body of `configureUpdater` in `electron/updater.ts:13-32` with the version below. Keep every other export (`ManualCheckResult`, `manualCheck`, `showManualResultDialog`, `UpdaterCallbacks`) exactly as it is.

```ts
const DAILY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdaterHandle {
  dispose(): void;
}

export function configureUpdater(cb: UpdaterCallbacks): UpdaterHandle {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    cb.onUpdateAvailable(info.version);
  });
  autoUpdater.on('update-not-available', () => {
    cb.onUpdateNotAvailable();
  });
  autoUpdater.on('error', (err) => {
    console.error('[updater]', err);
    cb.onError(err);
  });

  // Initial check after 30s delay (don't block startup UX).
  const startupTimer = setTimeout(() => {
    autoUpdater.checkForUpdates().catch(cb.onError);
  }, 30_000);

  // Recurring background check so the long-running tray daemon learns about
  // releases without a restart. 24h drift across Windows sleep is acceptable.
  const dailyTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch(cb.onError);
  }, DAILY_CHECK_INTERVAL_MS);

  return {
    dispose() {
      clearTimeout(startupTimer);
      clearInterval(dailyTimer);
    },
  };
}
```

- [ ] **Step 2: Run the updater test file and confirm all 4 tests pass**

Run: `npm test -- electron/updater.test.ts`

Expected: 4 passed.

- [ ] **Step 3: Run the full test suite to confirm no regressions**

Run: `npm test`

Expected: All tests pass (existing `firstRun.test.ts`, `importLegacy.test.ts`, every `src/**/*.test.ts`, and the new updater tests).

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: Exit 0, no diagnostics. (Type-check covers `main.ts` too — but since `main.ts` still discards the return value of `configureUpdater`, this passes because `UpdaterHandle` is just assignable to a discarded value.)

- [ ] **Step 5: Commit**

```bash
git add electron/updater.ts
git commit -m "feat(updater): poll for releases every 24h, expose dispose handle"
```

---

## Task 3: Wire the dispose handle into `main.ts`

**Files:**
- Modify: `electron/main.ts:157-165` (the `configureUpdater({...})` call) and `electron/main.ts:146-152` (the `onQuit` callback).

- [ ] **Step 1: Capture the handle when configuring the updater**

In `electron/main.ts`, find this block (around line 157):

```ts
  configureUpdater({
    onUpdateAvailable: (v) => {
      tray?.showBalloon('erepublik-agent', `Update available: v${v}. Quit to install.`);
    },
    onUpdateNotAvailable: () => {},
    onError: (err) => {
      console.warn('[updater]', err.message);
    },
  });
```

Replace it with:

```ts
  const updaterHandle = configureUpdater({
    onUpdateAvailable: (v) => {
      tray?.showBalloon('erepublik-agent', `Update available: v${v}. Quit to install.`);
    },
    onUpdateNotAvailable: () => {},
    onError: (err) => {
      console.warn('[updater]', err.message);
    },
  });
```

- [ ] **Step 2: Dispose the handle inside `onQuit`**

In `electron/main.ts`, find the `onQuit` callback inside the `createTray({ ... })` call (around line 146):

```ts
    onQuit: async () => {
      isQuitting = true;
      await supervisor.stop();
      tray?.destroy();
      app.quit();
    },
```

Replace it with:

```ts
    onQuit: async () => {
      isQuitting = true;
      updaterHandle.dispose();
      await supervisor.stop();
      tray?.destroy();
      app.quit();
    },
```

Note: `updaterHandle` is declared *after* `createTray({...})` in the source order, but the `onQuit` callback only fires when the user clicks Quit — long after both `createTray` and `configureUpdater` have run synchronously inside the same `app.whenReady().then(...)` block. The closure captures the binding by reference, so this is safe.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: Exit 0, no diagnostics.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 5: Build the Electron app to confirm it still compiles**

Run: `npm run build:electron`

Expected: Exit 0. `electron-dist/main.js` and `electron-dist/updater.js` are regenerated.

- [ ] **Step 6: Commit**

```bash
git add electron/main.ts
git commit -m "feat(electron): dispose updater timers on quit"
```

---

## Task 4: Manual smoke verification (optional, operator-driven)

This is not required for the PR to be considered done — the unit tests cover the behavior. But if you want to eyeball it on macOS dev before shipping a Windows installer:

- [ ] **Step 1: Run the Electron app locally**

Run: `npm run start:electron`

Expected: The tray icon appears. Wait ~30 seconds. In the Electron main-process console (the terminal you launched from), you should see one of:
- `[updater] update-not-available` events logged by `electron-updater` (if no newer release exists), or
- `[updater] <error>` if GitHub is unreachable / the dev build doesn't have a valid `latest.yml`.

Either is fine — the goal is to confirm no crash and that the startup check still fires. The 24h interval cannot be observed in a dev session without changing the constant.

- [ ] **Step 2: Quit via tray → Quit**

Expected: App exits cleanly with no `WARNING: Possible EventEmitter leak` or unhandled-rejection messages from the disposed timers.

---

## Task 5: Final verification

- [ ] **Step 1: Run the full test suite one more time**

Run: `npm test`

Expected: All tests pass, including the 4 new ones in `electron/updater.test.ts`.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: Exit 0.

- [ ] **Step 3: Confirm git status is clean**

Run: `git status`

Expected: `nothing to commit, working tree clean` on `main` (or your feature branch), with three new commits from this plan:
- `test(electron): failing tests for daily update check`
- `feat(updater): poll for releases every 24h, expose dispose handle`
- `feat(electron): dispose updater timers on quit`

---

## Notes for the executor

- **Don't move the constant `DAILY_CHECK_INTERVAL_MS` into an env var or `Settings`.** The spec explicitly rules out user-tunable cadence (YAGNI).
- **Don't touch `manualCheck` or `showManualResultDialog`.** They already work — the tray menu's "Check for updates…" item is out of scope.
- **Don't add new tray UI** (no "Last checked at" indicator, no badge). The spec lists these as non-goals.
- **`vi.mock` calls must appear before `import { configureUpdater } from './updater.js'`** in the test file. Vitest hoists `vi.mock` automatically, but keeping them at the top of the file matches the convention used elsewhere in `src/**/*.test.ts`.
- If `npm test` complains about ESM/CJS interop for `electron-updater`, double-check the mock returns `{ default: { autoUpdater: {...} } }` — the production code uses `import electronUpdater from 'electron-updater'; const { autoUpdater } = electronUpdater;`, which requires the default-export shape.
