# Electron native app — Windows desktop distribution

**Date:** 2026-05-18
**Status:** draft, awaiting user review
**Scope:** Packaging, runtime shell, and end-user UX for shipping the daily runner + farming pipeline + UI dashboard as a single native Windows desktop application. Replaces the `.bat` ZIP distribution defined in `2026-05-16-windows-distribution-design.md`. No changes to `src/farm/`, `src/tools/`, `src/transport/`, or the endpoint allow-list. The agent runtime (`src/agent/runner.ts`) gets two narrow, opt-in additions; otherwise untouched.

---

## 1. Goal

Reduce the install-and-run workflow from three sequential `.bat` double-clicks (`setup` → `bootstrap` → `start`) to **one install + one icon**. The bot becomes a real Windows app: tray icon, normal window, autostart-on-login (opt-in), built-in auto-update, no console windows for the user to mistake for "the bot is broken because I closed it".

Concretely, the user journey from "I have nothing" to "the bot is running" must be: download `erepublik-agent-Setup-X.Y.Z.exe` from a Telegram channel → double-click → step through a 3-screen welcome wizard → bot is running in the tray. Subsequent reboots auto-resume if the user enabled autostart; otherwise one icon click on the Start menu.

Secondary goals:

- Built-in **auto-update** via `electron-updater` against GitHub Releases. No more `update.bat`.
- **Identical** runtime semantics to the `.bat` distribution. Same daily cycle, same farm gate, same fuel pacing, same Telegram digests. The Electron shell adds zero behavior to the agent itself.
- **Migration path** for users on the `.bat` distribution: the wizard offers to import their existing `sessions/`, `config/`, and `chromium-cache/` so they don't re-login or re-download Chromium.

Non-goals (deferred to v2.x):

- Code signing certificate (Windows SmartScreen friendliness)
- macOS `.dmg` / Linux `AppImage`
- Multi-account UI inside one install (still single-account-per-install, as in `.bat` v1)
- Native settings editor inside Electron — settings live in the existing web dashboard
- Localization (UI stays English-only)

---

## 2. Audience and assumptions

Audience unchanged from the `.bat` spec: ~90% non-technical Windows 10/11 x64 users on personal machines. They:

- Know how to download a file from Telegram and double-click it.
- Are scared by anything that looks like a programming tool.
- May not have admin rights (locked-down work laptops).
- Have ~500 MB free disk space.

The remaining ~10% technical users continue to clone the repo and run `npm start` on macOS / Linux. The Electron shell is **opt-in for developers** — it has no advantage over `npm start` for someone already in a TS toolchain.

**English-only.** All wizard prompts, tray menu, error dialogs, README — English. Same constraint as the `.bat` distribution.

---

## 3. Deliverable: `erepublik-agent-Setup-X.Y.Z.exe`

Single NSIS installer per release. Approximate size: **~150-180 MB compressed**. The breakdown:

- Electron runtime (Chromium + Node) bundled in `app.asar` resources: ~120 MB
- Our compiled JS + production `node_modules` (including `cloakbrowser` package itself): ~30-40 MB
- Icons + onboarding wizard assets: ~1 MB

**Not bundled:** CloakBrowser's Chromium binary. As in the `.bat` distribution, this ~200 MB blob is downloaded on first bootstrap into `%APPDATA%\erepublik-agent\chromium-cache\`. Rationale identical to §3.3 of the `.bat` spec (smaller artifact, version pinned by `cloakbrowser` package).

### 3.1 NSIS installer behavior

- **Per-user install** by default (no admin rights required). Installs to `%LOCALAPPDATA%\Programs\erepublik-agent\`.
- Optionally per-machine if the user has admin rights and chooses it (installs to `Program Files`). Not the default — most of the audience can't elevate.
- Creates Start menu shortcut + optional desktop shortcut (checkbox in installer).
- Registers an uninstaller in "Add or Remove Programs". Uninstall removes program files but **leaves** `%APPDATA%\erepublik-agent\` (sessions, config, logs, Chromium cache) intact for a clean reinstall.
- Single-instance: launching the installer while the app is running prompts to close it first.

---

## 4. Architecture overview

```
┌──────────────────────────── Electron app ──────────────────────────────┐
│                                                                        │
│  ┌── main process ──┐                                                  │
│  │ • Tray icon      │      ┌────────── utilityProcess (child) ──────┐  │
│  │ • BrowserWindow  │◀IPC▶ │  src/agent/runner.ts                   │  │
│  │ • single-inst    │      │   ├─ daily cycle + farm gate           │  │
│  │ • autostart API  │      │   ├─ HTTP server on 127.0.0.1:$PORT    │  │
│  │ • electron-updat │      │   └─ writes sessions/, reads config/   │  │
│  │ • wizard window  │      └────────────────────────────────────────┘  │
│  └────────┬─────────┘                       ▲                          │
│           │ load URL                         │ spawn (only on bootstrap)│
│           ▼                                  │                         │
│  ┌── BrowserWindow ─────────┐                │                         │
│  │ http://127.0.0.1:$PORT   │                │                         │
│  │ (existing UI dashboard,  │                │                         │
│  │  zero changes)           │                │                         │
│  └──────────────────────────┘                │                         │
└──────────────────────────────────────────────┼─────────────────────────┘
                                               │
                                               ▼
                                     src/bootstrap.ts (headed)
                                     → CloakBrowser separate window
```

**Two key principles:**

1. **The agent is a child process, not a library.** Electron `main` spawns `dist/agent/runner.js` via `utilityProcess.fork()`. If the runner crashes, the shell survives and restarts it. Stop = kill the child. No shared module state between shell and agent.
2. **The dashboard is loaded over HTTP, not bundled into Electron's renderer.** The existing `src/ui/server.ts` keeps serving on `127.0.0.1:$PORT`; the Electron `BrowserWindow` simply navigates to that URL. Zero changes to `src/ui/`. As a side benefit, power users can still open `http://127.0.0.1:$PORT` in a real browser (Chrome dev tools, mobile-emulation, etc.) while the Electron window is open.

---

## 5. First-run onboarding wizard

Replaces `setup.bat` + `bootstrap.bat`. A dedicated `BrowserWindow` (separate HTML renderer at `electron/wizard/index.html`, **not** the dashboard) shown only when `%APPDATA%\erepublik-agent\config\settings.json` does not exist. Three screens, no skipping.

### 5.1 Step 1 — Account & tuning

A form with these fields, grouped:

**Account**
- eRepublik email (text)
- eRepublik password (password input)
- Account label (text, default `main`, becomes `ERP_ACCOUNT_SLUG`)

**Daily actions**
- Max Q1 food price (number, default 3.0)

**Gold farming**
- Max travel cost per battle hop, in CC (number, default 400)
- Minimum fuel barrels to keep in inventory (number, default 10)
- Blocked countries (chip-input with autocomplete from `data/countries.json`; same catalog and resolver as `resolveCountries.ts` in the `.bat` spec, just rendered as a JS picker instead of a CLI prompt)

**Auto return-home**
- Return home after N minutes abroad (number, default 15; 0 disables)
- Max return-home travel cost (number, default 500)

**Telegram (optional)**
- Bot token (text, blank to skip)
- Chat ID (text, blank to skip)

**Captcha (optional)**
- Provider (select: `none` / `2captcha`, default `none`)
- 2captcha API key (text, shown only when provider = `2captcha`)

**Advanced** (collapsed by default, click "Show advanced…" to reveal)
- Cycle interval in minutes (number, default 10)

On **Next**: validate inline (numeric ranges, country resolver), then write:
- `%APPDATA%\erepublik-agent\config\.env` — env vars in the same shape `dotenv` already reads.
- `%APPDATA%\erepublik-agent\config\settings.json` — `Settings` Zod object, seeded as the runner does on first init.

If the wizard is run a second time (via tray → "Reconfigure…"), prefill each field from the current config and the heading reads "Edit configuration" instead of "Welcome".

### 5.2 Step 2 — Sign in to eRepublik

A single big button: **"Open login window"**. On click, IPC fires `main → spawn bootstrap`, which runs the existing `src/bootstrap.ts` as a `child_process.spawn` with `HEADED=true`. CloakBrowser opens its own headed Chromium window (separate process, separate Chromium build — Electron does not embed CloakBrowser).

Wizard meanwhile reads bootstrap's `stdout`/`stderr` via piped streams and shows them in a `<pre>` panel for transparency:

```
[bootstrap] Launching CloakBrowser…
[bootstrap] Loading https://www.erepublik.com/en/login
[bootstrap] Waiting for authenticated session…
[bootstrap] Authenticated. Closing browser.
```

The wizard advances to step 3 when bootstrap exits with code 0. If exit code is non-zero (user closed the window, login failed, network error), wizard shows the captured error tail + a **Retry** button. The user can step back to step 1 to fix credentials.

Existing fix `985756d` (detect already-authenticated session via form wait) keeps the bootstrap from hanging when a profile already has a valid cookie — covers the case of step 2 being re-run after a session expiry.

### 5.3 Step 3 — Done

- Checkbox: **"Start automatically when Windows starts"** — default **OFF**. Toggling it calls `app.setLoginItemSettings({ openAtLogin: true })` immediately so the setting is live before the user even clicks Finish.
- Button: **Start bot** — closes the wizard window, opens the dashboard window, IPC tells main to spawn the runner. Status indicator in dashboard title bar updates to 🟢 Running as soon as the first cycle starts.

---

## 6. Tray + window UX

**Tray icon** appears immediately when the app starts (after the wizard, or on every normal launch). Single-instance lock prevents a second copy from launching.

### 6.1 Tray menu

```
─ Open dashboard           (default left-click)
─────
─ ⏸ Pause / ▶ Resume       (toggles settings.paused via IPC)
─ Open logs folder         (shell.openPath %APPDATA%\erepublik-agent\logs)
─ Reconfigure…             (re-shows the wizard)
─ Check for updates…
─────
─ ☐ Start with Windows     (live toggle)
─ Quit                     (graceful shutdown)
```

### 6.2 Window behavior

- Default `BrowserWindow` size 1280×800, resizable, normal Windows chrome.
- **Closing the window hides to tray, does NOT quit.** First time this happens, a Windows balloon tip says: "Bot is still running in tray. Right-click the icon to quit."
- Title bar shows a status indicator updated via IPC from the runner: 🟢 Running / ⏸ Paused / 🔴 Error.
- `Ctrl+R` (renderer reload) is bound to a no-op in production builds — the dashboard reloads itself when settings change; manual reload would just refetch from `127.0.0.1` and confuse a non-tech user. DevTools available via `Ctrl+Shift+I` in development builds only.

### 6.3 Quit semantics

User clicks tray → Quit. Sequence:

1. Main sends `{ type: 'shutdown' }` IPC to the runner utility-process.
2. Runner sets `stopping = true`, finishes the current cycle (max 10s for non-farm cycle, up to ~60s if a farm session is mid-flight), exits 0.
3. Main waits up to 12s for the child to exit. If still alive, sends SIGTERM. If still alive after another 3s, SIGKILL.
4. Main calls `app.quit()`. Tray icon disappears, app exits.

Force-quit (e.g., user kills via Task Manager) is handled gracefully too — the on-disk state is written incrementally during the cycle, so worst case is losing the *current* cycle's results, not corrupting prior state.

---

## 7. File layout

### 7.1 Installed files (read-only)

```
%LOCALAPPDATA%\Programs\erepublik-agent\        ← per-user install
├── erepublik-agent.exe                          ← Electron main binary
├── resources\
│   ├── app.asar                                 ← our TS code, compiled + packed
│   └── app.asar.unpacked\
│       └── node_modules\cloakbrowser\           ← unpacked because it spawns native subprocesses
├── locales\                                     ← Electron i18n (we use en-US only)
├── *.dll, *.pak, *.bin                          ← Electron runtime
└── Uninstall erepublik-agent.exe
```

### 7.2 User data (read-write, persists across upgrades and reinstalls)

```
%APPDATA%\erepublik-agent\                       ← Electron's app.getPath('userData')
├── chromium-cache\
│   └── chromium-<version>\                      ← CloakBrowser Chromium (~200 MB, first-bootstrap download)
├── sessions\
│   ├── profile\{slug}\                          ← CloakBrowser persistent context (cookies, fingerprint)
│   ├── daily-state-{day}.json
│   ├── weekly-state.json
│   └── weekly-fuel-state.json
├── config\
│   ├── .env                                     ← written by wizard
│   └── settings.json                            ← written by dashboard
└── logs\
    └── agent-{YYYY-MM-DD}.log                   ← daily rotation (existing ERP_FILE_LOGGING=true)
```

The runner reads `ERP_ROOT=%APPDATA%\erepublik-agent` from its environment (set by Electron main before spawning). `src/paths.ts` already supports this env override — **no change needed there**.

### 7.3 Why split installed vs userData

Standard Windows-app convention. Lets the uninstaller cleanly remove the binary without nuking the user's logged-in profile and 200 MB Chromium download. Reinstall is instant: user gets a fresh binary but resumes with existing session.

---

## 8. Process model & IPC

Electron `main` is the parent; the agent runs as a single long-lived child via `utilityProcess.fork()` (preferred over `child_process.fork` because it's the API Electron documents for "long-running Node child"). Two short-lived children spawned on demand: `bootstrap` (during wizard step 2 or "Reconfigure"), and `electron-updater`'s download/install helper (transient, not our concern to manage).

### 8.1 IPC contract

All messages between Electron main and the runner child are simple JSON objects on a single channel (`parentPort.postMessage` / `process.parentPort.on('message')`). The runner's `src/agent/runner.ts` is updated to detect `process.parentPort` and emit/receive these messages; in standalone mode (`npm start` from CLI), `parentPort` is undefined and the IPC layer is a no-op.

**runner → main:**

| Type | Payload | When |
|---|---|---|
| `ready` | `{ port: number }` | After the UI HTTP server has bound and is accepting connections. Main uses this to open the dashboard window with the right port. |
| `log` | `{ level: 'info' \| 'warn' \| 'error', text: string }` | Each `console.log`/`error` line is mirrored as an IPC message so the wizard can show bootstrap output and so the tray can flash a balloon on errors. |
| `state` | `{ status: 'idle' \| 'cycling' \| 'paused' \| 'error', reason?: string }` | After each cycle and on settings changes. Main updates window title indicator and tray tooltip. |
| `cycleResult` | `{ cycleNumber, farmedBattles, errors }` | Compact summary after each cycle. Reserved for future tray-balloon notifications; not used in v1. |

**main → runner:**

| Type | Payload | When |
|---|---|---|
| `shutdown` | `{}` | Quit, before SIGTERM fallback. |
| `pauseToggle` | `{ paused: boolean }` | Tray menu Pause/Resume — faster than going through `settings.json` watch. (Implementation note: still writes to `settings.json` so the dashboard stays in sync, but flips the in-memory flag immediately.) |

The IPC layer is intentionally tiny. Anything else the dashboard needs goes through the existing HTTP API on `127.0.0.1:$PORT` — that surface is already well-tested.

### 8.2 Crash recovery

If the runner exits unexpectedly (non-zero, not via `shutdown`):

1. Main logs the exit code and last 20 IPC log lines to `%APPDATA%\erepublik-agent\logs\electron-main.log`.
2. Main shows a tray balloon: "Bot crashed. Restarting in 1 second…"
3. Backoff retry: 1s, 5s, 30s. After 3 consecutive crashes, give up. Final balloon: "Bot stopped after repeated crashes. Click for logs."
4. Tray indicator stays 🔴 until the user clicks Resume (which re-tries the spawn) or Quit.

---

## 9. Auto-update channel

`electron-updater` configured with the `github` provider, pointing at the project's GitHub repo. CI publishes two artifacts per release:

- `erepublik-agent-Setup-X.Y.Z.exe` — the installer
- `latest.yml` — update manifest with version, file URL, SHA512

**Update flow at runtime:**

1. On app start, after a 30-second delay (don't block UX), main calls `autoUpdater.checkForUpdates()`.
2. If a newer version is published: tray balloon "Update available: vX.Y.Z. Restart to install." Manifest download proceeds in the background.
3. When the user clicks Quit (or "Restart to update" in the balloon), the installer launches, replaces program files, and re-opens the app.
4. The runner's `%APPDATA%\erepublik-agent\` is untouched. No re-login, no Chromium re-download.

Manual trigger: tray menu **Check for updates…** forces an immediate `checkForUpdates()` call. If no update is available, a "You are on the latest version (X.Y.Z)" dialog appears.

Failure handling: any error during check or download is logged silently. Auto-update is best-effort; the bot keeps running on the old version until the next attempt.

This entirely replaces the `.bat` `update.bat` script.

---

## 10. Codebase changes

The Electron shell is additive — almost all behavior already exists in `src/`. The narrow changes:

### 10.1 Graceful SIGTERM in `src/agent/runner.ts`

Today `SIGTERM` does `process.exit(143)` immediately (line 80-83); only `SIGINT` is graceful. For Electron `Quit` we need SIGTERM to also be graceful: set `stopping = true`, let the current cycle finish, exit 0. ~10 lines: extend the existing `process.on('SIGTERM', …)` to mirror the `SIGINT` handler, and have the latter call into a shared `requestStop()` helper.

### 10.2 IPC bridge in `src/agent/runner.ts`

New module `src/agent/electronBridge.ts`:

```ts
// Pure module. Returns no-op functions when not running as a utility-process child.
export function attachElectronBridge(): {
  emitReady: (port: number) => void;
  emitLog: (level: 'info'|'warn'|'error', text: string) => void;
  emitState: (status: string, reason?: string) => void;
  onShutdown: (cb: () => void) => void;
  onPauseToggle: (cb: (paused: boolean) => void) => void;
};
```

If `process.parentPort` is undefined (CLI mode), every emitter is a no-op and every `on*` registers nothing. The runner unconditionally calls these — no branching in the cycle logic. ~50 lines plus tests.

### 10.3 UI server emits ready

`src/ui/server.ts`'s `start()` already returns a port. Wire the runner's startup so that, after `start()` resolves, it calls `bridge.emitReady(port)`. ~3 lines.

### 10.4 Bootstrap exit code clarity

`src/bootstrap.ts` should exit 0 on success and non-zero on failure (timeout, login-window closed without auth, network error). Verify the existing implementation already does this; the `985756d` fix partially covers it. If gaps exist, fill them. ~5-10 lines.

### 10.5 New `electron/` directory (entirely new files)

```
electron/
├── main.ts                 ← Electron main entry: creates window, tray, spawns runner
├── preload.ts              ← contextBridge exposing { startBootstrap, getStatus, setAutostart, … } to wizard
├── tray.ts                 ← tray icon + menu + balloon helpers
├── updater.ts              ← electron-updater wiring + tray glue
├── runnerSupervisor.ts     ← spawn / IPC / crash-restart logic for the utility-process
├── importLegacy.ts         ← optional migration from a .bat install (see §12)
├── wizard/
│   ├── index.html
│   ├── wizard.js           ← form logic, country autocomplete, IPC calls
│   └── wizard.css
└── icons/
    ├── icon.ico            ← .exe + window icon
    └── tray.png            ← tray icon (16/32 px)
electron-builder.yml        ← packaging config
```

Total estimated new code in `electron/`: ~800-1200 LOC. None of it touches game logic.

### 10.6 What is **not** touched

- `src/farm/` — strategies, routing, fuel budget — all stay.
- `src/tools/` — work, train, market, claim, travel, captcha, deploy — all stay.
- `src/transport/` — allow-list, apiCall — **all stay**. No new endpoints.
- `src/ui/` — server, snapshot, settingsStore, historyStore, logsTail, sleepUntilWake — all stay.
- `src/erepublik/` — day, week — all stay.

---

## 11. Build & release pipeline

New GitHub Actions workflow `.github/workflows/release-electron.yml`, triggered on git tag push (`v*.*.*`). Replaces `release-windows.yml`.

**Job runs on `windows-latest` runner:**

1. Check out repo at the tag.
2. Set up Node 22 LTS via `actions/setup-node@v4`.
3. `npm ci` — install all deps.
4. `npm run build` — compile `src/` to `dist/` (existing).
5. `npm run build:electron` — `tsc` for `electron/` to `electron-dist/`.
6. `npx electron-builder --win nsis --x64 --publish always`
   - Builds and packages the NSIS installer.
   - `--publish always` uploads `erepublik-agent-Setup-X.Y.Z.exe` + `latest.yml` to the GitHub Release matching the tag.
7. Smoke test (optional): launch the installer in `/S` silent mode, run `--version`, uninstall.

`electron-builder.yml`:

```yaml
appId: live.yurii.erepublik-agent
productName: erepublik-agent
directories:
  output: release
files:
  - dist/**
  - electron-dist/**
  - data/**
  - package.json
  - node_modules/**
asarUnpack:
  - node_modules/cloakbrowser/**
win:
  target: nsis
  icon: electron/icons/icon.ico
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  shortcutName: erepublik-agent
publish:
  provider: github
  releaseType: release
```

Total CI time: ~7-10 minutes per release.

### 11.1 Versioning

`npm version patch|minor|major` → creates git tag → workflow fires → release published. Same as today.

### 11.2 Cross-build from macOS (dev)

For local iteration, `npx electron-builder --win` works on macOS. `wine` is optional; for unsigned NSIS builds it's not required. Useful for testing changes without pushing a tag.

---

## 12. Migration from the `.bat` distribution

Some existing users will be on the `.bat` ZIP install. The wizard handles them.

### 12.1 Detection

On first launch (no `%APPDATA%\erepublik-agent\config\settings.json`), the wizard's step 1 shows an extra small banner:

> Already running the old ZIP version? **Import existing setup →**

Clicking it opens a folder picker. If the user selects a directory containing `app/`, `sessions/`, `config/.env`, and `chromium-cache/` (heuristic: at least three of those exist), the importer:

1. Copies `sessions/` → `%APPDATA%\erepublik-agent\sessions\`
2. Copies `config/.env` and `config/settings.json` → `%APPDATA%\erepublik-agent\config\`
3. Copies `chromium-cache/` → `%APPDATA%\erepublik-agent\chromium-cache\` (~200 MB copy, shows progress bar)
4. Runs a one-shot **healthcheck** (`src/healthcheck.ts`, already exists in the repo) against the imported profile to confirm the session cookie is still valid.
   - **If healthcheck passes**: skips the wizard's "Sign in" step and jumps directly to step 3 (autostart toggle + Start bot).
   - **If healthcheck fails** (cookie expired, profile corrupted, network error): wizard proceeds normally to step 2 ("Sign in"); the user re-authenticates manually. The imported `sessions/profile/{slug}/` directory is preserved; CloakBrowser reuses any non-cookie state (cached fingerprint, localStorage) and the user only re-enters credentials.
5. Skips the Chromium download in any case (cache is populated).

### 12.2 Cleanup

The wizard does **not** delete the old ZIP folder. README and the Telegram migration post explicitly instruct the user to delete it manually once they verify the bot runs from the new install ("if you want the 250 MB back").

### 12.3 Documentation

Telegram channel post on release day:

> 🆕 v2.0 — erepublik-agent is now a real Windows app. Download Setup.exe, install, follow the 3-screen wizard. **Existing users:** the wizard offers to import your current setup so you don't re-login or re-download Chromium. Old ZIP folder can be deleted afterwards.

### 12.4 Deprecating `windows/*.bat`

- Move `windows/*.bat` and `windows/README.txt` → `legacy/windows-bat/` (kept in tree for ~6 months in case of regressions, then deletable).
- Delete `.github/workflows/release-windows.yml`.
- Update root `README.md` and `CLAUDE.md` to describe Electron as the primary distribution.

---

## 13. Error handling

| Failure | Handling |
|---|---|
| Runner child exits non-zero | Auto-restart with backoff 1s/5s/30s. After 3 fails, tray balloon "Bot stopped. Click for logs." Indicator 🔴 until Resume or Quit. |
| Runner hangs (no `ready` IPC within 60s) | Main kills it, treats as crash, applies backoff. |
| CloakBrowser Chromium download fails (first bootstrap) | Wizard step 2 shows error tail + Retry. Link to README troubleshooting (corporate proxy). |
| Login flow times out / user closes login window without auth | Wizard step 2 shows captured stderr + Retry. User can go back to step 1 to fix credentials. |
| Dashboard `BrowserWindow` fails to load `127.0.0.1:$PORT` | Retry-loop with 500 ms backoff for up to 30 s. After that, error page with "View logs" button. |
| `electron-updater` fails | Log silently, retry on next launch. No user-facing error. |
| Second instance launched | Single-instance lock activates the existing window and focuses it. The second process exits cleanly. |
| Captcha unsolved (existing runner behavior) | Runner throws, finishes cycle, Telegram alert. Electron catches the `log error` IPC and shows tray balloon "Captcha unsolved — see Telegram." |
| `Forbidden` from deploy endpoint (existing) | Runner stops the farm session, Telegram alert. Electron tray balloon "Account temporarily flagged. Logs: …" |
| User force-quits via Task Manager | OS sends SIGKILL. Worst case: current cycle's results lost. On-disk state from prior cycles untouched. Next launch resumes cleanly. |

---

## 14. Testing

- **Unit tests (vitest)** — unchanged. `fuelBudget`, `modeSelector`, `pickWeapon`, `pickBomb`, `damageFormula`, `resolveCountries`, plus the existing UI primitives.
- **New unit tests** — IPC bridge (`electronBridge.test.ts`): emitters are no-ops without `parentPort`, emit correctly with a mocked `parentPort`. Wizard form validation (`wizard.test.ts` with jsdom + vitest): required-field validation, country resolver integration, captcha-key conditional visibility.
- **Electron main** — not unit-tested. Smoke-tested manually.
- **End-to-end on Windows 11 VM** (~1 day before each public release):
  1. Fresh VM, no prior install.
  2. Run `Setup.exe`, walk through wizard (step 1 form → step 2 sign in → step 3 done).
  3. Verify Chromium downloads in step 2 with visible progress.
  4. Verify dashboard opens at 🟢 Running.
  5. Reboot VM. If autostart was enabled, bot resumes silently. If not, manual launch from Start menu.
  6. Tray operations: Pause → check `settings.paused` in JSON → Resume → verify cycle resumes.
  7. Trigger an update by publishing a v0.0.X+1 patch release; verify the balloon appears and Restart-to-update installs cleanly with state preserved.
  8. Migration from `.bat`: install the v1 `.bat` ZIP separately, run a cycle, then run the Electron installer and verify import.
- **CI** — `electron-builder --win` must succeed; artifacts produced; `latest.yml` valid.

---

## 15. Out of scope (deferred to v2.x)

- **v2.1**: Code signing certificate (OV or EV) for SmartScreen friendliness. Adds ~$70-500/year + USB token logistics.
- **v2.x**: macOS `.dmg`, Linux `AppImage`.
- **v2.x**: Multi-account UI inside one install (account switcher in tray, per-account profile selector).
- **v2.x**: Native settings UI inside Electron (currently we reuse the web dashboard).
- **v2.x**: In-app Telegram notification center (mirror Telegram alerts into Windows notification center).
- **v2.x**: Localization (Ukrainian UI).

---

## 16. Implementation phases

Roughly 7-10 working days, in order. Each phase is independently mergeable except phase 6 which depends on 1-5.

1. **Runner additions** (~0.5 day). SIGTERM graceful shutdown, IPC bridge module, `ready` emit. Tests. CLI flow unchanged.
2. **Bootstrap exit code audit** (~0.25 day). Verify and tighten failure exits in `src/bootstrap.ts`.
3. **Electron skeleton** (~1 day). `electron/main.ts`, `tray.ts`, `runnerSupervisor.ts`, `electron-builder.yml`. Verify `npx electron .` launches the existing dashboard against a local `npm start`.
4. **Wizard renderer** (~1.5 days). Three screens, form validation, country autocomplete, bootstrap stdout piping, IPC. Unit tests for form logic.
5. **Auto-updater** (~0.5 day). `electron-updater` + GitHub provider + tray glue.
6. **Importer** (~0.5 day). `.bat` install detection + folder copy with progress.
7. **CI workflow** (~0.5 day). `release-electron.yml`, draft-tag dry run to verify artifacts.
8. **End-to-end on Win 11 VM** (~1-2 days). Walk through the full user flow on a fresh VM, plus migration test.
9. **README + migration post** (~0.25 day). Update root `README.md`, write Telegram migration announcement template.

Each phase produces a checkable artifact; phases 1-2 are pure refactors that don't change developer workflow.

---

## 17. Open questions for review

None. All decisions in this spec are concrete. If something feels under-specified during implementation, prefer the option that minimizes user-facing friction.
