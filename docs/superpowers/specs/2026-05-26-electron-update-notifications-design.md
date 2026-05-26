# Visible update notifications + one-click restart

**Status:** approved
**Author:** Claude + Yurii
**Date:** 2026-05-26

## Problem

The auto-update plumbing is already in place (`electron/updater.ts`, the 24h poll spec'd in [2026-05-18-daily-update-check-design.md](./2026-05-18-daily-update-check-design.md), `electron-builder.yml` GitHub publishing). Today's flow when a new release lands:

1. `autoUpdater` polls GitHub (30s after start, then every 24h).
2. `update-available` → tray balloon `"Update available: vX. Quit to install."`.
3. `electron-updater` silently downloads the installer in the background (`autoDownload: true`).
4. Nothing further happens until the user clicks Quit in the tray. Only then does `autoInstallOnAppQuit: true` actually apply the update.

The agent is a long-running tray daemon — the user almost never clicks Quit. In practice a downloaded update can sit unused for days or weeks. The tray balloon is also easy to miss (single ephemeral toast, no persistent UI).

## Goals

1. **Persistent visible cue when an update is downloaded and ready** — sticky banner at the top of the dashboard so it can't be missed.
2. **One-click restart from the dashboard** — `Restart now` button calls `autoUpdater.quitAndInstall()` after a graceful runner shutdown.
3. **Telegram ping when the update is ready to install** — single message, no spam at earlier stages.
4. **Banner state survives dashboard reload** — opening the dashboard later still shows the banner if an update is pending.

## Non-goals

- Auto-restart without user click. Cycle interruption risk is non-zero; the user explicitly wants to control the moment.
- Cycle-aware delayed restart ("finish current farm session, then restart"). Out of scope; rejected during brainstorming.
- Confirmation dialog before restart. The button itself is the confirmation.
- Quiet-window scheduling (e.g. install at 04:00 local). Out of scope; rejected during brainstorming.
- New release publishing pipeline. `electron-builder.yml` already declares `publish: provider: github`; we assume `release.sh` produces the artifacts `electron-updater` expects. If the GitHub release format turns out to be wrong, that's a separate fix from this work.
- Changes to `src/agent/runner.ts` or any runner-side Telegram code (`src/util/telegram.ts`). The update concern lives entirely in the Electron host.

## Design

### Architecture

```
[GitHub Release]                  
       │ (HTTPS poll @ 30s + every 24h)
       ▼                          
[electron-updater in main.ts]
       │ 'update-downloaded' event
       ├──► state: updateReady = { version }
       ├──► webContents.send('update:ready', {version})  ──► dashboard banner
       └──► HTTPS POST → Telegram API                    ──► chat

[Dashboard banner click "Restart now"]
       │ IPC: 'update:restartNow'
       ▼
[main.ts handler]
       ├─ supervisor.stop()  (graceful runner shutdown)
       └─ autoUpdater.quitAndInstall()
```

**Single source of truth:** the update state (`updateReady = { version } | null`) lives in `electron/main.ts`. The dashboard is a pure renderer — it asks main for state on load and listens for push events while open.

**Telegram is sent directly from the Electron host**, not from the runner. The Electron main process already manages `userData/config/.env` (see `wizard:saveConfig` in `main.ts`), so it can read `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` from there. Routing the notification through the runner would require an IPC hop and a runner-side handler for an event that has nothing to do with farming.

### Components

#### 1. `electron/updater.ts` — extend with `update-downloaded`

Add a new callback to `UpdaterCallbacks` and subscribe to the event:

```ts
export interface UpdaterCallbacks {
  onUpdateAvailable: (version: string) => void;
  onUpdateNotAvailable: () => void;
  onUpdateDownloaded: (version: string) => void;   // NEW
  onError: (err: Error) => void;
}

// inside configureUpdater():
autoUpdater.on('update-downloaded', (info) => {
  cb.onUpdateDownloaded(info.version);
});
```

`autoInstallOnAppQuit: true` stays — it's our fallback if the user clicks Quit (tray menu) instead of Restart now.

#### 2. `electron/telegram.ts` (new file, ~30 lines)

```ts
export async function sendUpdateNotification(version: string, userDataDir: string): Promise<void>;
```

- Reads `${userDataDir}/config/.env`, extracts `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
- If either is missing or empty → silent return (mirrors the runner's `src/util/telegram.ts` behavior).
- `POST https://api.telegram.org/bot{token}/sendMessage` with form body:
  - `chat_id` = parsed chat id
  - `text` = `🆙 Update v${version} ready to install. Open the dashboard and click "Restart now".`
  - `disable_web_page_preview` = `true`
- Wraps fetch in `try/catch` — any error is `console.warn`'d, never thrown (this is a best-effort side channel).

#### 3. `electron/main.ts` — wire the new event + IPC

Module-level state:

```ts
let updateReady: { version: string } | null = null;
```

Inside `configureUpdater({...})` callback object, add:

```ts
onUpdateDownloaded: (v) => {
  updateReady = { version: v };
  dashboardWindow?.webContents.send('update:ready', { version: v });
  sendUpdateNotification(v, app.getPath('userData')).catch((err) =>
    console.warn('[updater] telegram send failed:', err),
  );
  tray?.showBalloon('erepublik-agent', `Update v${v} downloaded. Open dashboard → Restart now.`);
},
```

The existing `onUpdateAvailable` tray balloon stays as-is — `update-available` fires before download completes, so it's still a useful early hint. Wording can be updated for clarity but is not a goal of this work.

`autoUpdater` is currently imported only inside `electron/updater.ts`. To keep that boundary, add a wrapper there:

```ts
// in electron/updater.ts
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}
```

Then in `main.ts`, extend the existing import: `import { configureUpdater, manualCheck, showManualResultDialog, quitAndInstall } from './updater.js';`.

IPC handlers (registered in `app.whenReady().then(...)`, alongside the existing `wizard:*` handlers):

```ts
ipcMain.handle('update:getStatus', () => updateReady);

ipcMain.handle('update:restartNow', async () => {
  isQuitting = true;
  updaterHandle.dispose();
  await supervisor.stop();
  tray?.destroy();
  quitAndInstall();
});
```

`update:restartNow` mirrors the existing `onQuit` handler (`main.ts:160-165`) but ends with `quitAndInstall()` instead of `app.quit()`. We need the same graceful runner shutdown — without it, the child process would be hard-killed mid-cycle.

No IPC handler is needed for "Later" — it's a client-side hide.

#### 4. `electron/preload.cjs` — expose `electronAPI` additions

Append to the `contextBridge.exposeInMainWorld('electronAPI', { ... })` object:

```js
getUpdateStatus: () => ipcRenderer.invoke('update:getStatus'),
restartNow: () => ipcRenderer.invoke('update:restartNow'),
onUpdateReady: (cb) => {
  const listener = (_, payload) => cb(payload);
  ipcRenderer.on('update:ready', listener);
  return () => ipcRenderer.removeListener('update:ready', listener);
},
```

Same shape as existing handlers (`onBootstrapOutput`, `onImportProgress`).

#### 5. `src/ui/public/index.html` — banner markup

Insert as the **first child of `<body>`** (so it sits above all dashboard content and the existing layout still flows naturally underneath):

```html
<div id="update-banner" class="update-banner hidden" role="status" aria-live="polite">
  <span>🆙 Update <strong id="update-version">vX.Y.Z</strong> ready</span>
  <button id="update-restart" type="button">Restart now</button>
  <button id="update-later" type="button">Later</button>
</div>
```

CSS (added to the existing inline `<style>` block in `index.html`):

```css
.update-banner {
  position: sticky;
  top: 0;
  z-index: 1000;
  background: #2d6a4f;
  color: white;
  padding: 8px 16px;
  display: flex;
  gap: 12px;
  align-items: center;
}
.update-banner.hidden { display: none; }
.update-banner button {
  background: white;
  color: #2d6a4f;
  border: none;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 600;
}
.update-banner button:hover { background: #e0e0e0; }
```

The dashboard ships three alternate HTML variants (`dashboard-console.html`, `dashboard-minimal.html`, `dashboard-tabs.html`). **Scope:** banner is added to `index.html` only — the variants are dev/experiment files, not the production dashboard.

#### 6. `src/ui/public/app.js` — banner behavior

Add a small bootstrap block (after existing snapshot/history wiring):

```js
async function initUpdateBanner() {
  if (!window.electronAPI?.getUpdateStatus) return;   // browser-direct mode, not Electron
  const status = await window.electronAPI.getUpdateStatus();
  if (status) showBanner(status.version);
  window.electronAPI.onUpdateReady(({ version }) => showBanner(version));

  document.getElementById('update-restart').addEventListener('click', () => {
    window.electronAPI.restartNow();
  });
  document.getElementById('update-later').addEventListener('click', () => {
    document.getElementById('update-banner').classList.add('hidden');
  });
}

function showBanner(version) {
  document.getElementById('update-version').textContent = `v${version}`;
  document.getElementById('update-banner').classList.remove('hidden');
}

initUpdateBanner();
```

The `window.electronAPI?.getUpdateStatus` guard is important — `src/ui/public/` is also reachable by opening `http://localhost:$PORT/` in a plain browser (no preload, no `electronAPI`). The banner simply stays hidden in that mode.

### Data flow on update arrival

1. `electron-updater` finishes downloading the installer in background.
2. `update-downloaded` event fires in main.
3. `main.ts`:
   - sets `updateReady = { version }`
   - pushes `update:ready` to `dashboardWindow.webContents` (no-op if window doesn't exist yet)
   - sends Telegram message (best-effort)
   - tray balloon "downloaded, Restart now" (additional, secondary channel)
4. Dashboard (if open): receives push event → `showBanner(version)`.
5. Dashboard (if closed and later opened): `app.js` calls `getUpdateStatus()` → returns `{version}` → `showBanner(version)`.
6. User clicks **Restart now** → IPC → `supervisor.stop()` → `autoUpdater.quitAndInstall()` → installer launches → app closes → installer relaunches the app on the new version.
7. User clicks **Later** → banner hidden via DOM only. Reopening the dashboard or refreshing the BrowserWindow brings it back (state in main is still `{version}`).

### Edge cases

| Case | Behavior |
|---|---|
| Dashboard not yet created when `update-downloaded` fires | `dashboardWindow?.webContents.send(...)` is a no-op. State held in main. Banner appears when user opens dashboard (via `getUpdateStatus`). |
| Telegram unconfigured | `sendUpdateNotification` silently returns. |
| Telegram API call fails (network, 4xx) | Caught in `main.ts` `.catch`, `console.warn`'d. No impact on banner or restart flow. |
| User clicks Later, then closes/reopens dashboard | Banner reappears (state still in main). This is by design — "Later" is a session-level hide, not a permanent dismiss. |
| Same update version downloads twice (e.g. main process restarts) | `updateReady = { version: v }` is idempotent; banner re-shows. Telegram message will be sent again. Acceptable — restarts of the Electron host are rare. |
| User clicks Restart now while a farm cycle is mid-deploy | `supervisor.stop()` sends SIGTERM/equivalent to the runner child; in-flight HTTP requests may be cut off. On next launch, the agent reconciles via `runCycle`'s API reads (`getMissionState`, `getObjectiveStatus`, `getWeeklyChallenge`, `extractCitizenContext`). State writes happen in the `finally` block of `runCycle`, so most local memory is intact. **Acceptable risk** — explicitly chosen during brainstorming. |
| User clicks Quit (tray) instead of Restart now | Existing `autoInstallOnAppQuit: true` still applies the update. No regression. |
| Dashboard opened in a regular browser (not Electron BrowserWindow) | No `window.electronAPI` → banner stays hidden. Tray balloon and Telegram still inform the user. |

## Testing

### `electron/updater.test.ts` (extend existing)

Add cases:

5. **`update-downloaded` invokes `onUpdateDownloaded`** — register the callback, fire the event with `{version: '1.2.3'}`, assert callback called with `'1.2.3'`.
6. **`quitAndInstall` wrapper calls underlying API** — call exported `quitAndInstall()`, assert mocked `autoUpdater.quitAndInstall` was invoked.

### `electron/telegram.test.ts` (new)

1. **No token in .env → silent skip** — write a `.env` without telegram keys, call `sendUpdateNotification('1.2.3', tmpDir)`, assert `fetch` was never called and the function resolved without throwing.
2. **Both keys present → HTTPS POST with correct shape** — write `.env` with token + chat id, mock `fetch`, assert URL is `https://api.telegram.org/bot{token}/sendMessage`, body contains `chat_id`, `text` includes `v1.2.3`, `disable_web_page_preview=true`.
3. **fetch rejection → does not throw** — mock `fetch` to reject, assert `sendUpdateNotification` resolves without throwing.
4. **Missing `.env` file → silent skip** — point at a tmp dir without `config/.env`, assert no throw, no fetch.

### Manual smoke test (after merge)

1. Bump version locally to `0.4.6-test`, publish a fake GitHub release with the matching installer.
2. Run the v0.4.5 installed app, wait for the 30s startup check.
3. Verify: tray balloon `update-available` → tray balloon `downloaded` → dashboard banner appears → Telegram message received.
4. Click Restart now → app closes → installer runs → app relaunches as 0.4.6-test → banner is gone.

## Out of scope

- Migrating off `electron-updater`.
- Banner variants in `dashboard-console.html` / `dashboard-minimal.html` / `dashboard-tabs.html` (dev files, not production).
- Telemetry on update install success rate.
- Configurable Telegram message template.
- Per-account / per-user opt-out of Telegram update notifications.
- Auto-dismiss banner after the install timestamp (the banner naturally goes away on the next launch since `updateReady` is in-memory in main).

These are valid follow-ups but none of them block closing the visibility gap.
