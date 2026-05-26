# Electron update notifications + one-click restart — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `electron-updater` finishes downloading a new release, surface a sticky banner in the dashboard with a Restart now button, send a one-shot Telegram message, and keep `autoInstallOnAppQuit` as the fallback.

**Architecture:** Update state lives in `electron/main.ts`. `electron/updater.ts` gains an `onUpdateDownloaded` callback and a thin `quitAndInstall()` wrapper. Main pushes the event to the dashboard `BrowserWindow` over IPC and sends Telegram directly (no runner hop). Dashboard (`src/ui/public/index.html` + `app.js`) renders a sticky banner via `window.electronAPI` exposed in `electron/preload.cjs`. Restart-now click → graceful `supervisor.stop()` → `quitAndInstall()`.

**Tech Stack:** Electron 39, `electron-updater` 6, vitest with `vi.mock` + fake timers, Tailwind (CDN) in the dashboard HTML, IPC via `contextBridge` + `ipcRenderer`.

**Spec:** `docs/superpowers/specs/2026-05-26-electron-update-notifications-design.md`

---

## File map

- **Modify** `electron/updater.ts` — add `onUpdateDownloaded` to `UpdaterCallbacks`, subscribe to `update-downloaded`, export `quitAndInstall` wrapper.
- **Modify** `electron/updater.test.ts` — extend with two new cases (`onUpdateDownloaded` fires; `quitAndInstall` proxies).
- **Create** `electron/telegram.ts` — `sendUpdateNotification(version, userDataDir)` reads `.env`, posts to Telegram, silent on missing config or errors.
- **Create** `electron/telegram.test.ts` — 4 cases (missing file, missing keys, happy path, fetch rejection).
- **Modify** `electron/main.ts` — module-level `updateReady` state, wire `onUpdateDownloaded`, register `update:getStatus` and `update:restartNow` IPC handlers, import `quitAndInstall`.
- **Modify** `electron/preload.cjs` — expose `getUpdateStatus`, `restartNow`, `onUpdateReady`.
- **Modify** `src/ui/public/index.html` — sticky banner element as the first child of `<body>` (Tailwind classes to match the existing dashboard).
- **Modify** `src/ui/public/app.js` — `initUpdateBanner()` boot block; call on load.

---

### Task 1: Add `onUpdateDownloaded` callback to `electron/updater.ts`

**Files:**
- Modify: `electron/updater.ts:7-11, 23-32`
- Test: `electron/updater.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `electron/updater.test.ts` inside the existing `describe('configureUpdater', …)` block:

```ts
  it('routes update-downloaded to onUpdateDownloaded with the version', async () => {
    const onUpdateDownloaded = vi.fn();
    configureUpdater({
      onUpdateAvailable: vi.fn(),
      onUpdateNotAvailable: vi.fn(),
      onUpdateDownloaded,
      onError: vi.fn(),
    });

    // Find the 'update-downloaded' handler registered via autoUpdater.on(...)
    const downloadedCall = onSpy.mock.calls.find((c) => c[0] === 'update-downloaded');
    expect(downloadedCall, 'update-downloaded should be subscribed').toBeDefined();
    const handler = downloadedCall![1] as (info: { version: string }) => void;
    handler({ version: '1.2.3' });

    expect(onUpdateDownloaded).toHaveBeenCalledWith('1.2.3');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- electron/updater.test.ts`
Expected: FAIL — either TypeScript complains that `onUpdateDownloaded` is missing on `UpdaterCallbacks`, or the new case fails because `update-downloaded` was never registered with `autoUpdater.on`.

- [ ] **Step 3: Extend the `UpdaterCallbacks` interface**

In `electron/updater.ts`, replace the `UpdaterCallbacks` block (lines 7-11) with:

```ts
export interface UpdaterCallbacks {
  onUpdateAvailable: (version: string) => void;
  onUpdateNotAvailable: () => void;
  onUpdateDownloaded: (version: string) => void;
  onError: (err: Error) => void;
}
```

- [ ] **Step 4: Subscribe to the event inside `configureUpdater`**

In `electron/updater.ts`, immediately after the existing `autoUpdater.on('update-not-available', …)` listener (around line 26-28), insert:

```ts
  autoUpdater.on('update-downloaded', (info) => {
    cb.onUpdateDownloaded(info.version);
  });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- electron/updater.test.ts`
Expected: PASS — all 5 cases green (4 pre-existing + 1 new).

- [ ] **Step 6: Update the existing 4 test cases to satisfy the new required callback**

The pre-existing cases pass `{ onUpdateAvailable, onUpdateNotAvailable, onError }` — TypeScript will reject them now. In each of the 4 prior `configureUpdater({...})` calls inside `updater.test.ts`, add `onUpdateDownloaded: vi.fn(),` to the callback object.

Run again: `npm test -- electron/updater.test.ts`
Expected: PASS — all 5 cases green, no TS errors.

- [ ] **Step 7: Commit**

```bash
git add electron/updater.ts electron/updater.test.ts
git commit -m "feat(updater): add onUpdateDownloaded callback"
```

---

### Task 2: Export `quitAndInstall` wrapper from `electron/updater.ts`

**Files:**
- Modify: `electron/updater.ts` (append export)
- Test: `electron/updater.test.ts` (extend)

- [ ] **Step 1: Extend the electron-updater mock to include `quitAndInstall`**

In `electron/updater.test.ts`, replace the `vi.hoisted` block (lines 3-6) with:

```ts
const { checkForUpdates, onSpy, quitAndInstallSpy } = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  onSpy: vi.fn(),
  quitAndInstallSpy: vi.fn(),
}));
```

And the `vi.mock('electron-updater', …)` block (lines 8-17) with:

```ts
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      checkForUpdates,
      on: onSpy,
      quitAndInstall: quitAndInstallSpy,
    },
  },
}));
```

- [ ] **Step 2: Extend the static import and add `quitAndInstallSpy.mockReset()`**

Change the existing top-of-file import (line 24) from:

```ts
import { configureUpdater } from './updater.js';
```

to:

```ts
import { configureUpdater, quitAndInstall } from './updater.js';
```

Add this line inside the existing `beforeEach` (after `onSpy.mockReset();`):

```ts
    quitAndInstallSpy.mockReset();
```

- [ ] **Step 3: Write the failing test**

Append inside the existing `describe('configureUpdater', …)` block in `electron/updater.test.ts`:

```ts
  it('quitAndInstall() proxies to autoUpdater.quitAndInstall', () => {
    quitAndInstall();
    expect(quitAndInstallSpy).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- electron/updater.test.ts`
Expected: FAIL — `quitAndInstall is not a function` (export doesn't exist yet) or a TypeScript error on the import.

- [ ] **Step 5: Add the wrapper export to `electron/updater.ts`**

Append at the very bottom of `electron/updater.ts`:

```ts
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- electron/updater.test.ts`
Expected: PASS — 6 cases green.

- [ ] **Step 7: Commit**

```bash
git add electron/updater.ts electron/updater.test.ts
git commit -m "feat(updater): export quitAndInstall wrapper"
```

---

### Task 3: Create `electron/telegram.ts` with `sendUpdateNotification`

**Files:**
- Create: `electron/telegram.ts`
- Test: `electron/telegram.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `electron/telegram.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { sendUpdateNotification } from './telegram.js';

describe('sendUpdateNotification', () => {
  let tmpDir: string;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'erep-telegram-'));
    fetchSpy = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('silently returns when config/.env is missing', async () => {
    await expect(sendUpdateNotification('1.2.3', tmpDir)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('silently returns when telegram keys are missing or blank', async () => {
    await fs.mkdir(path.join(tmpDir, 'config'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'config', '.env'),
      'TELEGRAM_BOT_TOKEN=\nTELEGRAM_CHAT_ID=\nOTHER=value\n',
    );
    await expect(sendUpdateNotification('1.2.3', tmpDir)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to telegram with version + chat_id when both keys are set', async () => {
    await fs.mkdir(path.join(tmpDir, 'config'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'config', '.env'),
      'TELEGRAM_BOT_TOKEN=secret123\nTELEGRAM_CHAT_ID=999\n',
    );

    await sendUpdateNotification('1.2.3', tmpDir);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botsecret123/sendMessage');
    expect(init.method).toBe('POST');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('chat_id')).toBe('999');
    expect(body.get('text')).toContain('v1.2.3');
    expect(body.get('disable_web_page_preview')).toBe('true');
  });

  it('does not throw if fetch rejects', async () => {
    await fs.mkdir(path.join(tmpDir, 'config'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'config', '.env'),
      'TELEGRAM_BOT_TOKEN=secret123\nTELEGRAM_CHAT_ID=999\n',
    );
    fetchSpy.mockRejectedValueOnce(new Error('network down'));

    await expect(sendUpdateNotification('1.2.3', tmpDir)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- electron/telegram.test.ts`
Expected: FAIL — `Cannot find module './telegram.js'`.

- [ ] **Step 3: Implement `electron/telegram.ts`**

Create `electron/telegram.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';

interface TelegramConfig {
  token: string;
  chatId: string;
}

async function readTelegramConfig(userDataDir: string): Promise<TelegramConfig | null> {
  const envPath = path.join(userDataDir, 'config', '.env');
  let raw: string;
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    return null;
  }
  const map: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    map[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const token = map.TELEGRAM_BOT_TOKEN;
  const chatId = map.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  return { token, chatId };
}

export async function sendUpdateNotification(version: string, userDataDir: string): Promise<void> {
  const cfg = await readTelegramConfig(userDataDir);
  if (!cfg) return;
  const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;
  const body = new URLSearchParams({
    chat_id: cfg.chatId,
    text: `🆙 Update v${version} ready to install. Open the dashboard and click "Restart now".`,
    disable_web_page_preview: 'true',
  });
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    console.warn('[telegram] update notification failed:', err);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- electron/telegram.test.ts`
Expected: PASS — 4 cases green.

- [ ] **Step 5: Commit**

```bash
git add electron/telegram.ts electron/telegram.test.ts
git commit -m "feat(electron): add sendUpdateNotification helper"
```

---

### Task 4: Wire `onUpdateDownloaded` callback in `electron/main.ts`

**Files:**
- Modify: `electron/main.ts:9, 22-26, 113-125`

No new test (main.ts is wiring; verified via typecheck and manual smoke).

- [ ] **Step 1: Extend the updater import**

In `electron/main.ts:9`, change:

```ts
import { configureUpdater, manualCheck, showManualResultDialog } from './updater.js';
```

to:

```ts
import { configureUpdater, manualCheck, showManualResultDialog, quitAndInstall } from './updater.js';
import { sendUpdateNotification } from './telegram.js';
```

- [ ] **Step 2: Add the `updateReady` module-level state**

In `electron/main.ts`, immediately after `let isPaused = false;` (around line 25), insert:

```ts
let updateReady: { version: string } | null = null;
```

- [ ] **Step 3: Wire the new callback in `configureUpdater`**

In `electron/main.ts`, replace the existing `configureUpdater({...})` call (lines 117-125) with:

```ts
  const updaterHandle = configureUpdater({
    onUpdateAvailable: (v) => {
      tray?.showBalloon('erepublik-agent', `Update available: v${v}. Downloading…`);
    },
    onUpdateNotAvailable: () => {},
    onUpdateDownloaded: (v) => {
      updateReady = { version: v };
      dashboardWindow?.webContents.send('update:ready', { version: v });
      sendUpdateNotification(v, app.getPath('userData')).catch((err) =>
        console.warn('[updater] telegram send failed:', err),
      );
      tray?.showBalloon(
        'erepublik-agent',
        `Update v${v} downloaded. Open dashboard → Restart now.`,
      );
    },
    onError: (err) => {
      console.warn('[updater]', err.message);
    },
  });
```

Note: the `onUpdateAvailable` wording changed from "Quit to install" to "Downloading…" because the actionable cue is now the post-download `onUpdateDownloaded` balloon + dashboard banner.

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts
git commit -m "feat(electron): notify dashboard + telegram on update-downloaded"
```

---

### Task 5: Add IPC handlers for `update:getStatus` and `update:restartNow`

**Files:**
- Modify: `electron/main.ts` (inside `app.whenReady().then(...)`, near the existing `ipcMain.handle('wizard:*', …)` block)

- [ ] **Step 1: Add the two IPC handlers**

In `electron/main.ts`, right after the existing `ipcMain.handle('wizard:saveConfig', …)` registration (around line 189), insert:

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

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors. `updaterHandle` is in scope because it's declared earlier in the same `app.whenReady().then(...)` body.

- [ ] **Step 3: Commit**

```bash
git add electron/main.ts
git commit -m "feat(electron): add update:getStatus and update:restartNow IPC handlers"
```

---

### Task 6: Expose update API in `electron/preload.cjs`

**Files:**
- Modify: `electron/preload.cjs:8-28`

- [ ] **Step 1: Append the new methods to `electronAPI`**

In `electron/preload.cjs`, inside the `contextBridge.exposeInMainWorld('electronAPI', { ... })` object, append three new properties before the closing `}`:

```js
  getUpdateStatus: () => ipcRenderer.invoke('update:getStatus'),
  restartNow: () => ipcRenderer.invoke('update:restartNow'),
  onUpdateReady: (cb) => {
    const listener = (_, payload) => cb(payload);
    ipcRenderer.on('update:ready', listener);
    return () => ipcRenderer.removeListener('update:ready', listener);
  },
```

The final object should look like:

```js
contextBridge.exposeInMainWorld('electronAPI', {
  saveConfig: (values) => ipcRenderer.invoke('wizard:saveConfig', values),
  startBootstrap: () => ipcRenderer.invoke('wizard:startBootstrap'),
  onBootstrapOutput: (cb) => {
    const listener = (_, payload) => cb(payload);
    ipcRenderer.on('wizard:bootstrapOutput', listener);
    return () => ipcRenderer.removeListener('wizard:bootstrapOutput', listener);
  },
  finish: (opts) => ipcRenderer.invoke('wizard:finish', opts),
  pickLegacyFolder: () => ipcRenderer.invoke('wizard:pickLegacyFolder'),
  importLegacy: (folder) => ipcRenderer.invoke('wizard:importLegacy', folder),
  onImportProgress: (cb) => {
    const listener = (_, payload) => cb(payload);
    ipcRenderer.on('wizard:importProgress', listener);
    return () => ipcRenderer.removeListener('wizard:importProgress', listener);
  },
  getUpdateStatus: () => ipcRenderer.invoke('update:getStatus'),
  restartNow: () => ipcRenderer.invoke('update:restartNow'),
  onUpdateReady: (cb) => {
    const listener = (_, payload) => cb(payload);
    ipcRenderer.on('update:ready', listener);
    return () => ipcRenderer.removeListener('update:ready', listener);
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add electron/preload.cjs
git commit -m "feat(electron): expose update API on window.electronAPI"
```

---

### Task 7: Add sticky banner to `src/ui/public/index.html`

**Files:**
- Modify: `src/ui/public/index.html:9-15` (insert before `<header>`)

The existing dashboard uses Tailwind via CDN — match that convention.

- [ ] **Step 1: Insert banner markup**

In `src/ui/public/index.html`, replace the opening of `<body>` (line 9) and the immediately following `<header>` with:

```html
<body class="bg-gray-100 text-gray-900 font-sans">
  <div id="update-banner"
       class="hidden sticky top-0 z-50 bg-emerald-700 text-white px-4 py-2 flex items-center gap-3 shadow"
       role="status" aria-live="polite">
    <span>🆙 Update <strong id="update-version">vX.Y.Z</strong> ready</span>
    <button id="update-restart" type="button"
            class="bg-white text-emerald-700 font-semibold rounded px-3 py-1 hover:bg-emerald-100">
      Restart now
    </button>
    <button id="update-later" type="button"
            class="text-emerald-100 hover:text-white underline text-sm">
      Later
    </button>
  </div>
  <header class="bg-gray-900 text-white px-4 py-3 flex items-center gap-3">
```

Only the new `<div id="update-banner">…</div>` block is added; the existing `<header>` content stays unchanged after it. The banner is hidden by default via the `hidden` utility (Tailwind's `display: none`).

- [ ] **Step 2: Open the page in Electron to confirm layout still works**

Run: `HEADED=true npm run start:electron`

In the dashboard window, open DevTools console and run:

```js
document.getElementById('update-banner').classList.remove('hidden');
document.getElementById('update-version').textContent = 'v9.9.9';
```

Expected: green banner appears at the top, header sits beneath it, layout unbroken. Run `document.getElementById('update-banner').classList.add('hidden')` to verify it disappears cleanly. Close the app.

- [ ] **Step 3: Commit**

```bash
git add src/ui/public/index.html
git commit -m "feat(ui): add sticky update banner markup"
```

---

### Task 8: Wire banner behavior in `src/ui/public/app.js`

**Files:**
- Modify: `src/ui/public/app.js` (append `initUpdateBanner` block at the bottom)

- [ ] **Step 1: Append the banner bootstrap**

At the **end** of `src/ui/public/app.js`, append:

```js
function showUpdateBanner(version) {
  const versionEl = document.getElementById('update-version');
  const bannerEl = document.getElementById('update-banner');
  if (!versionEl || !bannerEl) return;
  versionEl.textContent = `v${version}`;
  bannerEl.classList.remove('hidden');
}

async function initUpdateBanner() {
  if (!window.electronAPI || !window.electronAPI.getUpdateStatus) {
    return; // running in a plain browser, not inside the Electron window
  }
  try {
    const status = await window.electronAPI.getUpdateStatus();
    if (status && status.version) showUpdateBanner(status.version);
  } catch (err) {
    console.warn('[update-banner] getUpdateStatus failed:', err);
  }
  window.electronAPI.onUpdateReady?.(({ version }) => showUpdateBanner(version));

  const restartBtn = document.getElementById('update-restart');
  if (restartBtn) {
    restartBtn.addEventListener('click', () => {
      window.electronAPI.restartNow();
    });
  }
  const laterBtn = document.getElementById('update-later');
  if (laterBtn) {
    laterBtn.addEventListener('click', () => {
      document.getElementById('update-banner')?.classList.add('hidden');
    });
  }
}

initUpdateBanner();
```

- [ ] **Step 2: Smoke-test in DevTools**

Run: `HEADED=true npm run start:electron`

In DevTools console run:

```js
await window.electronAPI.getUpdateStatus();  // expect: null
```

This confirms the IPC route works end-to-end (preload → main → handler → reply). Close the app.

- [ ] **Step 3: Commit**

```bash
git add src/ui/public/app.js
git commit -m "feat(ui): show update banner when electronAPI reports update ready"
```

---

### Task 9: Final verification

**Files:** none modified (gate task).

- [ ] **Step 1: Typecheck the whole tree**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the new `electron/telegram.test.ts` and the extended `electron/updater.test.ts` (6 cases).

- [ ] **Step 3: Build the Electron app to confirm packaging is still clean**

Run: `npm run build:electron`
Expected: `electron-dist/` populated, no compile errors. (No need to run `dist:electron` — the NSIS build is slow and isn't needed for verifying this change.)

- [ ] **Step 4: Document the manual smoke test**

The end-to-end check requires a real GitHub release pair, which only the user can drive. Write a short note to the user summarizing the manual steps:

> 1. Bump `package.json` version to a placeholder like `0.4.5+test` on a throwaway branch.
> 2. Build the installer (`npm run dist:electron`).
> 3. Install that version locally and let it run.
> 4. Publish a higher version (e.g. `0.4.6-test`) as a GitHub Release with the matching installer.
> 5. Within ~30 seconds of app start (or up to 24h on a long-running install) the new release should be detected, downloaded, and you should see:
>    - tray balloon "Update vX downloaded"
>    - a sticky green banner in the dashboard
>    - a Telegram message (if `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are configured)
> 6. Click Restart now → app should close gracefully (runner shutdown logs) → installer launches → app relaunches on new version → banner is gone.

No commit needed for this step.

---

## Out of scope (deferred)

- Banner in the dev-only dashboard variants (`dashboard-console.html`, `dashboard-minimal.html`, `dashboard-tabs.html`). The production dashboard is `index.html`.
- Configurable Telegram message template.
- Persisting "Later" dismissal across reloads.
- Migrating off `electron-updater`.
- Automated end-to-end test of the GitHub release → install flow.
