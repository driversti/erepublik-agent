# Daily auto-update check

**Status:** approved
**Author:** Claude + Yurii
**Date:** 2026-05-18

## Problem

The Electron app is a long-running tray daemon — installs are expected to stay up for days or weeks. The current updater (`electron/updater.ts`) only checks for new releases **once**, 30 seconds after startup. If a new version is published while the app is running, the user will not learn about it until they either:

- restart the app (rare for a tray daemon), or
- manually click *"Check for updates…"* in the tray menu (requires the user to think to do this).

Result: users drift behind on releases and miss bug fixes.

## Goals

1. **Daily background check** — without restart, the app polls GitHub Releases ~once every 24 hours and surfaces an update via the existing tray balloon flow.
2. **Manual check still works** — already implemented; no regression.
3. **Clean shutdown** — the recurring timer must be cleared when the app quits, so we don't leak handles or fire callbacks against a torn-down tray.

## Non-goals

- Custom polling cadence per user. The interval is a code constant.
- Cron-style scheduling (*"check every day at 09:00 local"*). Drift of a few hours is fine for a release-notification feature.
- New UX surfaces (no "Last checked at" indicator, no dashboard panel). The existing tray balloon + manual menu item are sufficient.

## Design

### Single file changed: `electron/updater.ts`

Add a 24-hour recurring check on top of the existing 30-second startup check, and let the caller dispose of it on quit.

```ts
const DAILY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdaterHandle {
  dispose(): void;
}

export function configureUpdater(cb: UpdaterCallbacks): UpdaterHandle {
  // …existing autoUpdater config + event wiring unchanged…

  const startupTimer = setTimeout(() => {
    autoUpdater.checkForUpdates().catch(cb.onError);
  }, 30_000);

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

### Call-site change: `electron/main.ts`

- Capture the returned handle: `const updaterHandle = configureUpdater({ … });`
- Call `updaterHandle.dispose()` in the existing `onQuit` callback, right before `app.quit()`.

That's it. No other files change.

### Why `setInterval`, not recursive `setTimeout`

- Behavior is equivalent for a 24h interval (drift across sleep is irrelevant at this cadence).
- `setInterval` gives us a single handle to clear; recursive `setTimeout` would need a mutable reference + a "cancelled" flag. The simpler shape wins.

### Why a code constant, not an env var or setting

- YAGNI. There's no scenario where one user needs "check every 6 hours" and another needs "weekly". 24h is the right answer for a notification-only feature.
- Avoids growing the wizard/settings surface for a knob nobody will turn.

### Edge cases

| Case | Behavior |
|---|---|
| Windows sleep / hibernate | `setInterval` is paused while the OS is suspended. On resume the timer may fire late — acceptable; this is a notification, not a deadline. |
| No network | `electron-updater` rejects → `cb.onError` logs a warning. Next tick in 24h. No retry loop. |
| Update already downloaded, another release lands | `electron-updater` handles this internally and re-emits `update-available` for the newer version. Our code is idempotent — `onUpdateAvailable` just calls `tray.showBalloon` again. |
| App paused (farming pause) | Updater keeps running. Pause is about the runner, not the Electron host. |
| Quit during in-flight check | `clearInterval` doesn't cancel a fetch already in flight, but the promise's `.catch` swallows the error during teardown. No-op. |

## Testing

Add a vitest co-located alongside `updater.ts` (new file `electron/updater.test.ts`):

1. **Startup check fires once** — fake timers, advance 30s, assert `autoUpdater.checkForUpdates` was called once.
2. **Daily check fires every 24h** — advance another 24h, assert second call; advance another 24h, assert third call.
3. **`dispose()` stops the interval** — call dispose, advance 48h, assert no further calls.
4. **Errors are swallowed via `cb.onError`** — mock `checkForUpdates` to reject, advance time, assert `onError` invoked, no unhandled rejection.

`autoUpdater` is mocked at the `electron-updater` module boundary via `vi.mock('electron-updater', …)` returning an object with a stub `checkForUpdates`, `autoDownload`, `autoInstallOnAppQuit`, and `on()`. The `electron` module is mocked too (we never call into real Electron from a unit test); existing electron tests (`electron/firstRun.test.ts`, `electron/importLegacy.test.ts`) cover pure filesystem logic and don't need module mocks, so this test introduces the pattern.

## Out of scope

- Telemetry on update-check success rate.
- Showing "Last checked: Xh ago" anywhere.
- Letting the user disable daily checks.
- Migrating off `electron-updater`.

These are all valid follow-ups, but none of them are needed to close the gap that motivates this work.
