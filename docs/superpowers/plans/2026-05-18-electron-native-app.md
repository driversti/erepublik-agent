# Electron Native App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `.bat` ZIP Windows distribution with a single native Electron `.exe` installer that wraps the existing daily runner + farming pipeline + UI dashboard, with onboarding wizard, tray icon, and built-in auto-update.

**Architecture:** Electron `main` process owns a tray icon and a `BrowserWindow`. It spawns the unchanged `src/agent/runner.ts` as a `utilityProcess` child; the runner serves its existing localhost HTTP dashboard, which the `BrowserWindow` simply loads over `http://127.0.0.1:$PORT`. First-run experience is a 3-step HTML wizard window that collects config, spawns the existing `src/bootstrap.ts` for the headed CloakBrowser login, and triggers the runner. Auto-update via `electron-updater` against GitHub Releases. Source spec: `docs/superpowers/specs/2026-05-18-electron-native-app-design.md`.

**Tech Stack:** Node 22, TypeScript (ESM), Electron 31+, `electron-builder` (NSIS, win-x64), `electron-updater`, existing `cloakbrowser` / `playwright-core` / `zod`. Tests via `vitest` (already wired). No new runtime deps in the agent itself; Electron lives in `devDependencies` (it's the bundler's runtime).

---

## File Structure

**New files** (all under `electron/` — entirely new tree):

| File | Responsibility |
|---|---|
| `electron/main.ts` | Process entry. Single-instance lock, app lifecycle, first-run detection, opens wizard window or dashboard window. Sets `ERP_ROOT=app.getPath('userData')` before spawning the runner. |
| `electron/preload.ts` | `contextBridge` exposing `window.electronAPI.*` to the wizard renderer (IPC into main). |
| `electron/runnerSupervisor.ts` | Spawns `dist/agent/runner.js` via `utilityProcess.fork`. Owns IPC channel, listens for `ready`/`log`/`state`, sends `shutdown`/`pauseToggle`. Implements crash backoff (1s, 5s, 30s, give up after 3). |
| `electron/tray.ts` | Builds tray icon + context menu. Wires Pause / Resume / Open dashboard / Open logs / Reconfigure / Check for updates / Start with Windows / Quit. |
| `electron/updater.ts` | `electron-updater` setup (GitHub provider), tray-balloon glue, manual "Check for updates" handler. |
| `electron/importLegacy.ts` | Detects a `.bat` install in a folder picked by the user. Copies `sessions/`, `config/`, `chromium-cache/` to `userData`, runs healthcheck. |
| `electron/wizard/index.html` | Static HTML for the 3-step wizard (form fields, step navigation skeleton). |
| `electron/wizard/wizard.js` | Vanilla JS for the wizard: form state, validation, country autocomplete, IPC calls, step transitions. |
| `electron/wizard/wizard.css` | Minimal styling, matches dashboard aesthetic. |
| `electron/icons/icon.ico` | Windows `.exe` + window icon (256×256 `.ico`, multi-resolution). |
| `electron/icons/tray.png` | Tray icon (32×32 PNG). |
| `electron/tsconfig.json` | TS config for electron sources, outputs to `electron-dist/`. |
| `electron-builder.yml` | `electron-builder` packaging config (NSIS, asarUnpack cloakbrowser, GitHub publish). |
| `.github/workflows/release-electron.yml` | CI workflow building + publishing the installer on git tag push. |

**New tests:**
- `src/agent/electronBridge.test.ts` — unit tests for the IPC bridge module.
- `electron/wizard/wizard.test.ts` — unit tests for wizard form validation and country resolver glue (jsdom).
- `electron/importLegacy.test.ts` — unit tests for legacy-install detection + copy logic.

**Modified files** (narrow changes only):
- `src/agent/runner.ts` — graceful SIGTERM (~10 lines, replacing the immediate-exit handler at line 80-83). Wire `electronBridge` emit calls into existing log paths (~10 lines).
- `package.json` — add electron deps, new scripts (`build:electron`, `start:electron`, `dist:electron`).
- `README.md` — replace `.bat` install instructions with `.exe` install instructions, link to migration section.
- `CLAUDE.md` — update "Commands" section to mention Electron build, deprecate `.bat` distribution path.

**Files moved (no edits):**
- `windows/*.bat` and `windows/README.txt` → `legacy/windows-bat/` (kept for ~6 months in case of regressions; documented in README).
- `.github/workflows/release-windows.yml` → deleted.

---

## Task overview

23 tasks across 6 phases. Phases 1-2 are pure refactors (developer workflow unchanged). Phase 3 onward introduces Electron.

1. **Runner foundation** (Tasks 1-4): Graceful SIGTERM, IPC bridge, bootstrap audit.
2. **Electron skeleton** (Tasks 5-10): Tooling, main process, supervisor, tray, dashboard window.
3. **Wizard** (Tasks 11-16): HTML/JS, three-step flow, first-run detection.
4. **Auto-updater** (Task 17).
5. **Legacy importer** (Tasks 18-19).
6. **Build, release, cleanup** (Tasks 20-23).

---

# Phase 1 — Runner foundation

These tasks are independent of Electron and can land before any Electron code exists. Developer workflow (`npm start`, `npm run agent`) keeps working.

## Task 1: Graceful SIGTERM in the runner

**Files:**
- Create: `src/agent/stopController.ts`
- Create: `src/agent/stopController.test.ts`
- Modify: `src/agent/runner.ts` (replace lines ~80-83 and ~554-558)

The current `SIGTERM` handler at line 80-83 exits immediately. We need it graceful — same behavior as `SIGINT` (set `stopping = true`, finish current cycle, exit 0). To make this testable, extract a small `requestStop()` helper and unit-test it.

- [ ] **Step 1: Add a failing test for the stop helper.** Create `src/agent/stopController.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createStopController } from './stopController.js';

describe('stopController', () => {
  it('starts in running state', () => {
    const ctrl = createStopController();
    expect(ctrl.isStopping()).toBe(false);
  });

  it('flips to stopping on first request', () => {
    const ctrl = createStopController();
    ctrl.requestStop();
    expect(ctrl.isStopping()).toBe(true);
  });

  it('returns true from requestStop only on the first call', () => {
    const ctrl = createStopController();
    expect(ctrl.requestStop()).toBe(true);
    expect(ctrl.requestStop()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails.**

```bash
npx vitest run src/agent/stopController.test.ts
```

Expected: FAIL (cannot resolve `./stopController.js`).

- [ ] **Step 3: Implement the helper.** Create `src/agent/stopController.ts`:

```ts
export interface StopController {
  isStopping(): boolean;
  /** Returns true on the first call, false on every subsequent call. */
  requestStop(): boolean;
}

export function createStopController(): StopController {
  let stopping = false;
  return {
    isStopping: () => stopping,
    requestStop: () => {
      if (stopping) return false;
      stopping = true;
      return true;
    },
  };
}
```

- [ ] **Step 4: Run the test, confirm it passes.**

```bash
npx vitest run src/agent/stopController.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Wire `stopController` into `runner.ts`.** Open `src/agent/runner.ts`. Replace the existing `let stopping = false;` and both signal handlers with a unified version. Find lines `~80-83` and `~552-558`. Replace both blocks with:

At the top of the file (near imports), add:
```ts
import { createStopController } from './stopController.js';
```

Replace the early SIGTERM-only block (~lines 80-83):
```ts
process.on('SIGTERM', () => {
  cleanupPid();
  process.exit(143);
});
```
with — leave it deleted; the new unified handler below covers both signals.

Replace the later block (~lines 552-558) — find `let stopping = false;` and the `process.on('SIGINT', ...)` handler — with:
```ts
const stopCtrl = createStopController();
function handleStopSignal(name: string) {
  if (!stopCtrl.requestStop()) {
    // Second Ctrl-C / SIGTERM → hard-exit.
    process.exit(1);
  }
  console.log(`\n[runner] ${name} received — finishing current cycle then exiting`);
}
process.on('SIGINT', () => handleStopSignal('SIGINT'));
process.on('SIGTERM', () => handleStopSignal('SIGTERM'));
```

Then in the loop body, replace `let stopping = false;` initial declaration and references to bare `stopping` with `stopCtrl.isStopping()`. Search the file for `stopping` and update all callsites.

- [ ] **Step 6: Run full test suite + typecheck.**

```bash
npm run typecheck && npm test
```

Expected: all green.

- [ ] **Step 7: Commit.**

```bash
git add src/agent/stopController.ts src/agent/stopController.test.ts src/agent/runner.ts
git commit -m "$(cat <<'EOF'
refactor(runner): unify SIGINT/SIGTERM into graceful stop controller

Previous SIGTERM handler exited immediately, dropping mid-cycle work.
Extract a tiny stopController with explicit unit tests; wire both
SIGINT and SIGTERM through it so Electron's Quit (which sends SIGTERM
as a fallback after IPC shutdown) gets the same graceful behavior as
Ctrl-C in dev.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Electron IPC bridge module

**Files:**
- Create: `src/agent/electronBridge.ts`
- Create: `src/agent/electronBridge.test.ts`

A pure module that abstracts the Electron utility-process IPC. In CLI mode (no `parentPort`), every emitter is a no-op and every subscriber registers nothing. When `parentPort` is present, messages flow.

- [ ] **Step 1: Write the failing tests.** Create `src/agent/electronBridge.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachElectronBridge, type IpcMessage } from './electronBridge.js';

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  on: (event: string, cb: (msg: unknown) => void) => void;
  fire: (msg: IpcMessage) => void;
}

function makeFakePort(): FakePort {
  let listener: ((msg: unknown) => void) | undefined;
  return {
    postMessage: vi.fn(),
    on: (_event, cb) => {
      listener = cb;
    },
    fire: (msg) => listener?.(msg),
  };
}

describe('electronBridge', () => {
  describe('no-op mode (no parentPort)', () => {
    let bridge: ReturnType<typeof attachElectronBridge>;
    beforeEach(() => {
      bridge = attachElectronBridge(undefined);
    });

    it('emitters do nothing and do not throw', () => {
      expect(() => bridge.emitReady(7423)).not.toThrow();
      expect(() => bridge.emitLog('info', 'hello')).not.toThrow();
      expect(() => bridge.emitState('idle')).not.toThrow();
    });

    it('subscribers are never invoked', () => {
      const cb = vi.fn();
      bridge.onShutdown(cb);
      bridge.onPauseToggle(cb);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('connected mode (parentPort present)', () => {
    it('emitReady posts a ready message', () => {
      const port = makeFakePort();
      const bridge = attachElectronBridge(port as unknown as NodeJS.MessagePort);
      bridge.emitReady(7423);
      expect(port.postMessage).toHaveBeenCalledWith({ type: 'ready', port: 7423 });
    });

    it('emitLog posts log messages with level and text', () => {
      const port = makeFakePort();
      const bridge = attachElectronBridge(port as unknown as NodeJS.MessagePort);
      bridge.emitLog('warn', 'careful now');
      expect(port.postMessage).toHaveBeenCalledWith({ type: 'log', level: 'warn', text: 'careful now' });
    });

    it('emitState posts state with optional reason', () => {
      const port = makeFakePort();
      const bridge = attachElectronBridge(port as unknown as NodeJS.MessagePort);
      bridge.emitState('cycling');
      bridge.emitState('error', 'captcha unsolved');
      expect(port.postMessage).toHaveBeenNthCalledWith(1, { type: 'state', status: 'cycling' });
      expect(port.postMessage).toHaveBeenNthCalledWith(2, { type: 'state', status: 'error', reason: 'captcha unsolved' });
    });

    it('onShutdown invokes callback when shutdown arrives', () => {
      const port = makeFakePort();
      const bridge = attachElectronBridge(port as unknown as NodeJS.MessagePort);
      const cb = vi.fn();
      bridge.onShutdown(cb);
      port.fire({ type: 'shutdown' });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('onPauseToggle invokes callback with paused flag', () => {
      const port = makeFakePort();
      const bridge = attachElectronBridge(port as unknown as NodeJS.MessagePort);
      const cb = vi.fn();
      bridge.onPauseToggle(cb);
      port.fire({ type: 'pauseToggle', paused: true });
      expect(cb).toHaveBeenCalledWith(true);
    });

    it('ignores unknown message types silently', () => {
      const port = makeFakePort();
      const bridge = attachElectronBridge(port as unknown as NodeJS.MessagePort);
      const cb = vi.fn();
      bridge.onShutdown(cb);
      port.fire({ type: 'unknown' } as unknown as IpcMessage);
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run the tests, confirm they fail.**

```bash
npx vitest run src/agent/electronBridge.test.ts
```

Expected: FAIL (cannot resolve `./electronBridge.js`).

- [ ] **Step 3: Implement the module.** Create `src/agent/electronBridge.ts`:

```ts
export type IpcMessage =
  | { type: 'ready'; port: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'state'; status: 'idle' | 'cycling' | 'paused' | 'error'; reason?: string }
  | { type: 'shutdown' }
  | { type: 'pauseToggle'; paused: boolean };

export interface ElectronBridge {
  emitReady(port: number): void;
  emitLog(level: 'info' | 'warn' | 'error', text: string): void;
  emitState(status: 'idle' | 'cycling' | 'paused' | 'error', reason?: string): void;
  onShutdown(cb: () => void): void;
  onPauseToggle(cb: (paused: boolean) => void): void;
}

/**
 * Returns a bridge. In CLI mode `port` is undefined and every method
 * is a no-op. In Electron utility-process mode `port` is `process.parentPort`.
 */
export function attachElectronBridge(port: NodeJS.MessagePort | undefined): ElectronBridge {
  if (!port) {
    return {
      emitReady: () => {},
      emitLog: () => {},
      emitState: () => {},
      onShutdown: () => {},
      onPauseToggle: () => {},
    };
  }

  const shutdownCbs: Array<() => void> = [];
  const pauseCbs: Array<(paused: boolean) => void> = [];

  port.on('message', (raw: unknown) => {
    const msg = raw as IpcMessage;
    switch (msg?.type) {
      case 'shutdown':
        for (const cb of shutdownCbs) cb();
        break;
      case 'pauseToggle':
        for (const cb of pauseCbs) cb(msg.paused);
        break;
      default:
        // Ignore unknown types silently.
        break;
    }
  });

  const post = (msg: IpcMessage) => port.postMessage(msg);

  return {
    emitReady: (port) => post({ type: 'ready', port }),
    emitLog: (level, text) => post({ type: 'log', level, text }),
    emitState: (status, reason) =>
      reason === undefined
        ? post({ type: 'state', status })
        : post({ type: 'state', status, reason }),
    onShutdown: (cb) => shutdownCbs.push(cb),
    onPauseToggle: (cb) => pauseCbs.push(cb),
  };
}
```

- [ ] **Step 4: Run the tests, confirm they pass.**

```bash
npx vitest run src/agent/electronBridge.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit.**

```bash
git add src/agent/electronBridge.ts src/agent/electronBridge.test.ts
git commit -m "$(cat <<'EOF'
feat(runner): add electronBridge IPC module

Pure module that wraps process.parentPort message-passing between the
runner and an Electron main process. In CLI mode (parentPort=undefined)
every emitter is a no-op so npm start / npm run agent are unaffected.
Tests cover both modes and verify graceful handling of unknown message
types.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire electronBridge into the runner startup

**Files:**
- Modify: `src/agent/runner.ts` (add bridge attach, wire emitReady / emitState / emitLog into existing flow, hook onShutdown to the stop controller)

The bridge is a no-op without an Electron parent, so this change is invisible to the developer workflow.

- [ ] **Step 1: Add the import at the top of `src/agent/runner.ts`.** Near the other `./` imports:

```ts
import { attachElectronBridge } from './electronBridge.js';
```

- [ ] **Step 2: Initialize the bridge near the top of the file**, right after the dotenv config block:

```ts
const bridge = attachElectronBridge(process.parentPort as NodeJS.MessagePort | undefined);
bridge.onShutdown(() => handleStopSignal('IPC shutdown'));
bridge.onPauseToggle(async (paused) => {
  // Forward to settings.json so the dashboard stays in sync.
  // Lazy import to avoid moving Settings module load earlier in the file.
  const { loadSettings, saveSettings } = await import('../ui/settingsStore.js');
  const cur = await loadSettings();
  await saveSettings({ ...cur, paused });
});
```

Note: `handleStopSignal` was defined in Task 1.

- [ ] **Step 3: Emit ready after the UI server binds.** Find where the runner calls `startUiServer(...)` and stores the resulting port (`uiPort`). Right after the `await` resolves, add:

```ts
bridge.emitReady(uiPort);
```

If the variable name differs, use whatever name the runner uses for the bound port; if no port is captured today, capture it: `const uiHandle = await startUiServer(...); bridge.emitReady(uiHandle.port);`. The UI server's `start()` already returns a port (`src/ui/server.ts`).

- [ ] **Step 4: Emit state transitions.** In the cycle loop, emit `cycling` at the top of each iteration and `idle` at the bottom; on caught errors emit `error` with the error message. Concretely, find the `try { do { ... } while (...) } catch` block at the bottom of `runner.ts`. Wrap the cycle call:

```ts
bridge.emitState('cycling');
try {
  await runCycle(ctx, notifier, captchaCfg, uiSnapshot);
  bridge.emitState('idle');
} catch (err) {
  bridge.emitState('error', err instanceof Error ? err.message : String(err));
  // existing error handling…
}
```

(Keep the existing settings-paused check; if `settings.paused === true`, the runner already returns from `runCycle` early — we can emit `paused` once at the start of an early-return cycle if desired. For v1, `idle` after a no-op cycle is acceptable.)

- [ ] **Step 5: Mirror critical console messages to bridge.emitLog.** Wherever the runner logs an error to console (e.g., the catch blocks in the cycle loop), also call `bridge.emitLog('error', text)`. Use minimal taste — don't mirror every log; only:
  - cycle start: `bridge.emitLog('info', '[runner] cycle started')`
  - cycle error: `bridge.emitLog('error', text)`
  - captcha detected unsolved: piggyback on the existing `console.warn` calls

Grep for `console.error` and `console.warn` in `runner.ts`; add a `bridge.emitLog(...)` call alongside each.

- [ ] **Step 6: Typecheck + test.**

```bash
npm run typecheck && npm test
```

Expected: all green. (Tests don't exercise the bridge attachment because tests don't run runner.ts as a process, but typecheck must pass.)

- [ ] **Step 7: Smoke-test from CLI to make sure nothing regressed.**

```bash
npm run agent
```

Expected: identical behavior to before (one cycle runs, exits cleanly). The bridge attach must not affect CLI mode.

- [ ] **Step 8: Commit.**

```bash
git add src/agent/runner.ts
git commit -m "$(cat <<'EOF'
feat(runner): wire electronBridge into startup, cycle, and shutdown

Bridge is a no-op when running as a normal Node process; only emits
when spawned by Electron's utilityProcess.fork. Adds ready/state/log
emits at the natural points already present in the cycle loop, and
hooks the IPC shutdown into the same stop controller used by SIGINT.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Bootstrap exit-code audit

**Files:**
- Audit (read-only first): `src/bootstrap.ts`
- Possibly modify: `src/bootstrap.ts`

The wizard relies on `bootstrap.ts` exiting non-zero on failure. Today's implementation already does this — line `process.exit(0)` on already-authenticated success, `process.exit(1)` on missing `erpk` cookie. Unhandled exceptions naturally exit non-zero. Verify there are no silent-success paths.

- [ ] **Step 1: Read `src/bootstrap.ts` end-to-end.** Confirm:
  1. Success path explicitly calls `process.exit(0)` or falls off the end (Node exits 0 by default after top-level await completes).
  2. Every failure path either `throw`s an Error (Node exits 1 on unhandled rejection) or calls `process.exit(1)`.
  3. The login-form-not-found case (line `~38-44`) currently throws — good.
  4. The missing-`erpk` case (line `~63-67`) calls `process.exit(1)` — good.

- [ ] **Step 2: Add an explicit `process.exit(0)` after `await ctx.close()` at the end of the file** — defensive against future changes that might add hanging timers. Find:

```ts
console.log('[bootstrap] session persisted in profile dir; safe to close');

await ctx.close();
```

Add after:
```ts
process.exit(0);
```

- [ ] **Step 3: Add a 10-minute hard timeout for the whole script.** Right after the dotenv load and before `launchPersistentContext`, add:

```ts
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const hardTimeout = setTimeout(() => {
  console.error('[bootstrap] FAILED: hard timeout reached (10 min). User may have closed the window.');
  process.exit(2);
}, HARD_TIMEOUT_MS);
hardTimeout.unref();
```

Rationale: if the user opens the CloakBrowser window and walks away, the script hangs forever. The wizard would spin forever too. Exit 2 is a distinct code we can show as "you took too long".

- [ ] **Step 4: Smoke-test bootstrap.**

```bash
npm run bootstrap
```

Expected: succeeds against the existing profile (already authenticated, exits 0 within seconds). Verify with `echo $?`.

- [ ] **Step 5: Commit.**

```bash
git add src/bootstrap.ts
git commit -m "$(cat <<'EOF'
feat(bootstrap): add explicit exit 0 + 10-min hard timeout

Two small defensive touches for the Electron wizard, which polls
bootstrap's exit code: ensure exit 0 is reached even if a future
change adds a hanging timer, and bail out with exit 2 if the user
opens the CloakBrowser login window and never finishes within 10
minutes (otherwise the wizard would spin forever).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 2 — Electron skeleton

## Task 5: Install Electron tooling and add build config

**Files:**
- Modify: `package.json` (deps + scripts)
- Create: `electron/tsconfig.json`
- Modify: `.gitignore` (add `electron-dist/` and `release/`)

- [ ] **Step 1: Install electron, electron-builder, electron-updater.**

```bash
npm install --save-dev electron@^31 electron-builder@^25
npm install electron-updater@^6
```

Expected: clean install, no peer-dep warnings beyond the usual.

- [ ] **Step 2: Add scripts to `package.json`.** In the `scripts` block, alongside the existing `build`:

```json
"build:electron": "tsc -p electron/tsconfig.json",
"start:electron": "npm run build && npm run build:electron && electron electron-dist/main.js",
"dist:electron": "npm run build && npm run build:electron && electron-builder --win nsis --x64"
```

- [ ] **Step 3: Create `electron/tsconfig.json`.**

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "outDir": "../electron-dist",
    "rootDir": ".",
    "noEmit": false,
    "module": "ESNext",
    "moduleResolution": "Bundler"
  },
  "include": ["**/*.ts"],
  "exclude": ["**/*.test.ts"]
}
```

- [ ] **Step 4: Update `.gitignore`.** Append:

```
electron-dist/
release/
```

- [ ] **Step 5: Verify the empty build runs.** Create a stub `electron/main.ts`:

```ts
console.log('electron main stub');
```

Then:

```bash
npm run build:electron && ls electron-dist/
```

Expected: `main.js` present in `electron-dist/`.

- [ ] **Step 6: Remove the stub** (we'll write the real `main.ts` in Task 6):

```bash
rm electron/main.ts
```

- [ ] **Step 7: Commit.**

```bash
git add package.json package-lock.json electron/tsconfig.json .gitignore
git commit -m "$(cat <<'EOF'
chore(electron): add electron tooling + build scripts

Installs electron, electron-builder, electron-updater. Adds dedicated
tsconfig for the electron/ tree compiling to electron-dist/. Adds
npm scripts build:electron / start:electron / dist:electron and
gitignores the build output dirs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Electron main process skeleton

**Files:**
- Create: `electron/main.ts`
- Create: `electron/icons/tray.png` (placeholder — see step)
- Create: `electron/icons/icon.ico` (placeholder — see step)

Builds the minimum viable Electron app: single-instance lock, app lifecycle, a `BrowserWindow` that loads a placeholder URL, an `app.on('ready')` handler. No tray, no spawn yet — those come in Tasks 7-8.

- [ ] **Step 1: Generate placeholder icons.** Tray and app icons are required by `electron-builder` even in development. Generate a 32×32 PNG and a 256×256 ICO; for now any valid file works (real icons in Task 20).

```bash
mkdir -p electron/icons
# 32x32 transparent PNG — minimal valid PNG.
node -e "require('fs').writeFileSync('electron/icons/tray.png', Buffer.from('89504e470d0a1a0a0000000d49484452000000200000002008060000007309e9e6000000164944415478da63601805a300d600c4990300000a000041e0a9be0d0000000049454e44ae426082','hex'))"
# Minimal ICO with a single 16x16 frame (electron-builder requires a real .ico for the final build; for dev a 1px works).
node -e "const fs=require('fs');const ico=Buffer.concat([Buffer.from('00000100010010100000010020002804000016000000','hex'),Buffer.alloc(40+256*4)]);fs.writeFileSync('electron/icons/icon.ico',ico)"
```

(Task 20 replaces both with real production-quality icons.)

- [ ] **Step 2: Create `electron/main.ts`.**

```ts
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Single-instance lock — second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | undefined;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'erepublik-agent',
    icon: path.join(__dirname, '../electron/icons/icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL('data:text/html,<h1>erepublik-agent</h1><p>Skeleton OK.</p>');
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', (event: Electron.Event) => {
  // Don't quit when last window closes — the tray icon will keep the app alive
  // (added in Task 8). For now during skeleton testing, allow normal quit.
  // Comment in the next line once the tray exists:
  // event.preventDefault();
});
```

- [ ] **Step 3: Verify the app launches.** From the repo root:

```bash
npm run start:electron
```

Expected: a window appears titled "erepublik-agent" with the placeholder HTML. Close the window — the process exits cleanly.

- [ ] **Step 4: Commit.**

```bash
git add electron/main.ts electron/icons/
git commit -m "$(cat <<'EOF'
feat(electron): minimal main process skeleton

Single-instance lock, basic BrowserWindow, app lifecycle. Loads a
placeholder data: URL — real dashboard loading wired in later tasks
once the runner-supervisor exists. Placeholder icons committed; real
ones replaced in the packaging task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Runner supervisor (spawn + IPC + crash backoff)

**Files:**
- Create: `electron/runnerSupervisor.ts`

This module wraps `utilityProcess.fork()` against the compiled runner. Owns the IPC channel; exposes high-level events (`onReady`, `onLog`, `onState`) and methods (`start`, `stop`, `togglePause`).

- [ ] **Step 1: Create `electron/runnerSupervisor.ts`.**

```ts
import { app, utilityProcess, type UtilityProcess, type MessageBoxOptions } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type RunnerState =
  | { status: 'idle' | 'cycling' | 'paused' }
  | { status: 'error'; reason: string };

type IpcFromRunner =
  | { type: 'ready'; port: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'state'; status: 'idle' | 'cycling' | 'paused' | 'error'; reason?: string };

type IpcToRunner =
  | { type: 'shutdown' }
  | { type: 'pauseToggle'; paused: boolean };

const BACKOFF_DELAYS_MS = [1_000, 5_000, 30_000];

export interface RunnerSupervisor {
  start(): void;
  stop(): Promise<void>;
  togglePause(paused: boolean): void;
  onReady(cb: (port: number) => void): void;
  onLog(cb: (level: 'info' | 'warn' | 'error', text: string) => void): void;
  onState(cb: (state: RunnerState) => void): void;
  onPermanentFailure(cb: () => void): void;
  isRunning(): boolean;
  getLastKnownPort(): number | undefined;
}

export function createRunnerSupervisor(): RunnerSupervisor {
  const userDataDir = app.getPath('userData');
  mkdirSync(userDataDir, { recursive: true });

  // Locate the compiled runner. In dev (running from electron-dist/),
  // it's at ../dist/agent/runner.js. In a packaged app, both live under
  // resources/app.asar — same relative path.
  const runnerPath = path.resolve(__dirname, '../dist/agent/runner.js');

  let child: UtilityProcess | undefined;
  let lastPort: number | undefined;
  let crashCount = 0;
  let stopping = false;
  const readyCbs: Array<(port: number) => void> = [];
  const logCbs: Array<(level: 'info' | 'warn' | 'error', text: string) => void> = [];
  const stateCbs: Array<(state: RunnerState) => void> = [];
  const failureCbs: Array<() => void> = [];

  function spawn() {
    child = utilityProcess.fork(runnerPath, [], {
      env: {
        ...process.env,
        ERP_ROOT: userDataDir,
        ERP_FILE_LOGGING: 'true',
      },
      stdio: 'pipe',
      serviceName: 'erepublik-agent-runner',
    });

    child.on('message', (raw: unknown) => {
      const msg = raw as IpcFromRunner;
      switch (msg?.type) {
        case 'ready':
          lastPort = msg.port;
          crashCount = 0; // healthy startup resets the backoff
          for (const cb of readyCbs) cb(msg.port);
          break;
        case 'log':
          for (const cb of logCbs) cb(msg.level, msg.text);
          break;
        case 'state':
          {
            const state: RunnerState =
              msg.status === 'error'
                ? { status: 'error', reason: msg.reason ?? 'unknown' }
                : { status: msg.status };
            for (const cb of stateCbs) cb(state);
          }
          break;
      }
    });

    child.stdout?.on('data', (buf: Buffer) => {
      for (const cb of logCbs) cb('info', buf.toString().trimEnd());
    });
    child.stderr?.on('data', (buf: Buffer) => {
      for (const cb of logCbs) cb('error', buf.toString().trimEnd());
    });

    child.on('exit', (code) => {
      child = undefined;
      if (stopping || code === 0) return;
      crashCount += 1;
      const reason = `runner exited with code ${code}`;
      for (const cb of stateCbs) cb({ status: 'error', reason });
      if (crashCount > BACKOFF_DELAYS_MS.length) {
        for (const cb of failureCbs) cb();
        return;
      }
      const delay = BACKOFF_DELAYS_MS[crashCount - 1];
      for (const cb of logCbs) cb('warn', `[supervisor] restarting runner in ${delay}ms (attempt ${crashCount})`);
      setTimeout(() => {
        if (!stopping) spawn();
      }, delay);
    });
  }

  function send(msg: IpcToRunner) {
    child?.postMessage(msg);
  }

  return {
    start() {
      stopping = false;
      crashCount = 0;
      if (!child) spawn();
    },
    async stop() {
      stopping = true;
      if (!child) return;
      send({ type: 'shutdown' });
      // Wait up to 12s for clean exit, then SIGTERM, then SIGKILL.
      await new Promise<void>((resolve) => {
        const c = child;
        if (!c) return resolve();
        const cleanTimer = setTimeout(() => {
          c.kill('SIGTERM');
          setTimeout(() => {
            if (child) child.kill('SIGKILL');
            resolve();
          }, 3_000);
        }, 12_000);
        c.once('exit', () => {
          clearTimeout(cleanTimer);
          resolve();
        });
      });
    },
    togglePause(paused: boolean) {
      send({ type: 'pauseToggle', paused });
    },
    onReady: (cb) => void readyCbs.push(cb),
    onLog: (cb) => void logCbs.push(cb),
    onState: (cb) => void stateCbs.push(cb),
    onPermanentFailure: (cb) => void failureCbs.push(cb),
    isRunning: () => child !== undefined,
    getLastKnownPort: () => lastPort,
  };
}
```

- [ ] **Step 2: Verify it compiles.**

```bash
npm run build:electron
```

Expected: clean compile, `electron-dist/runnerSupervisor.js` exists.

- [ ] **Step 3: Commit.**

```bash
git add electron/runnerSupervisor.ts
git commit -m "$(cat <<'EOF'
feat(electron): add runner supervisor with IPC + crash backoff

utilityProcess.fork wrapper around dist/agent/runner.js. Owns the IPC
channel (ready/log/state in, shutdown/pauseToggle out), exposes
event-style callbacks, and handles graceful shutdown (12s wait →
SIGTERM → SIGKILL). Auto-restart with 1s/5s/30s backoff; gives up
after 3 consecutive crashes and signals permanent failure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Tray icon + menu

**Files:**
- Create: `electron/tray.ts`

Builds the tray icon and context menu. Wires Pause/Resume to the supervisor; Show dashboard / Open logs / Reconfigure / Quit to callbacks injected by main.

- [ ] **Step 1: Create `electron/tray.ts`.**

```ts
import { Tray, Menu, nativeImage, app, shell, type NativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TrayState {
  status: 'idle' | 'cycling' | 'paused' | 'error';
  paused: boolean;
  autostart: boolean;
}

export interface TrayCallbacks {
  onShowDashboard: () => void;
  onTogglePause: () => void;
  onOpenLogs: () => void;
  onReconfigure: () => void;
  onCheckForUpdates: () => void;
  onToggleAutostart: () => void;
  onQuit: () => void;
}

export interface TrayController {
  setState(state: Partial<TrayState>): void;
  showBalloon(title: string, body: string): void;
  destroy(): void;
}

function loadIcon(): NativeImage {
  const iconPath = path.resolve(__dirname, '../electron/icons/tray.png');
  return nativeImage.createFromPath(iconPath);
}

export function createTray(callbacks: TrayCallbacks): TrayController {
  const tray = new Tray(loadIcon());
  let state: TrayState = { status: 'idle', paused: false, autostart: false };

  function rebuild() {
    const statusLabel =
      state.status === 'cycling' ? '🟢 Running'
      : state.status === 'paused' ? '⏸ Paused'
      : state.status === 'error' ? '🔴 Error'
      : '🟢 Running';

    const menu = Menu.buildFromTemplate([
      { label: `erepublik-agent — ${statusLabel}`, enabled: false },
      { type: 'separator' },
      { label: 'Open dashboard', click: callbacks.onShowDashboard },
      { type: 'separator' },
      {
        label: state.paused ? '▶ Resume' : '⏸ Pause',
        click: callbacks.onTogglePause,
      },
      { label: 'Open logs folder', click: callbacks.onOpenLogs },
      { label: 'Reconfigure…', click: callbacks.onReconfigure },
      { label: 'Check for updates…', click: callbacks.onCheckForUpdates },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: state.autostart,
        click: callbacks.onToggleAutostart,
      },
      { label: 'Quit', click: callbacks.onQuit },
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip(`erepublik-agent — ${statusLabel}`);
  }

  tray.on('click', callbacks.onShowDashboard);
  rebuild();

  return {
    setState(patch) {
      state = { ...state, ...patch };
      rebuild();
    },
    showBalloon(title, body) {
      tray.displayBalloon({ title, content: body });
    },
    destroy() {
      tray.destroy();
    },
  };
}

export function openLogsFolder() {
  shell.openPath(path.join(app.getPath('userData'), 'logs'));
}
```

- [ ] **Step 2: Compile.**

```bash
npm run build:electron
```

Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git add electron/tray.ts
git commit -m "$(cat <<'EOF'
feat(electron): tray icon + context menu

Builds tray icon with status-aware label, pause/resume toggle,
Open dashboard / Open logs / Reconfigure / Check for updates / Start
with Windows / Quit. Callbacks injected by main.ts so this module
stays free of business logic.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Wire main.ts to supervisor + tray + dashboard window

**Files:**
- Modify: `electron/main.ts`

Replace the placeholder data-URL window with a real flow: spawn the runner, wait for `ready`, load the dashboard at the reported port, build the tray, hook the menu callbacks.

- [ ] **Step 1: Rewrite `electron/main.ts`** to integrate the supervisor and tray:

```ts
import { app, BrowserWindow, shell, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunnerSupervisor } from './runnerSupervisor.js';
import { createTray, openLogsFolder } from './tray.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let dashboardWindow: BrowserWindow | undefined;
let tray: ReturnType<typeof createTray> | undefined;
let isQuitting = false;
const supervisor = createRunnerSupervisor();

function createDashboardWindow(port: number) {
  if (dashboardWindow) {
    if (dashboardWindow.isMinimized()) dashboardWindow.restore();
    dashboardWindow.focus();
    return;
  }
  dashboardWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'erepublik-agent',
    icon: path.join(__dirname, '../electron/icons/icon.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // Tiny retry loop: window may open before HTTP server accepts connections.
  loadDashboardWithRetry(dashboardWindow, port);
  dashboardWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      dashboardWindow?.hide();
      tray?.showBalloon(
        'erepublik-agent',
        'Bot is still running in the system tray. Right-click the icon to quit.',
      );
    }
  });
}

async function loadDashboardWithRetry(win: BrowserWindow, port: number, attempt = 0) {
  const url = `http://127.0.0.1:${port}/`;
  try {
    await win.loadURL(url);
  } catch (err) {
    if (attempt >= 60) {
      // 30s total
      await dialog.showMessageBox(win, {
        type: 'error',
        message: `Failed to load dashboard at ${url}.`,
        detail: 'The bot may have crashed during startup. Open the logs folder for details.',
        buttons: ['OK'],
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
    return loadDashboardWithRetry(win, port, attempt + 1);
  }
}

app.on('second-instance', () => {
  if (dashboardWindow) {
    if (!dashboardWindow.isVisible()) dashboardWindow.show();
    if (dashboardWindow.isMinimized()) dashboardWindow.restore();
    dashboardWindow.focus();
  }
});

app.whenReady().then(() => {
  // Build tray first so the app stays alive even before the dashboard appears.
  tray = createTray({
    onShowDashboard: () => {
      const port = supervisor.getLastKnownPort();
      if (!port) {
        tray?.showBalloon('erepublik-agent', 'Bot is still starting…');
        return;
      }
      if (!dashboardWindow) createDashboardWindow(port);
      else {
        if (!dashboardWindow.isVisible()) dashboardWindow.show();
        dashboardWindow.focus();
      }
    },
    onTogglePause: () => {
      // Toggle state is implied; supervisor doesn't track paused itself,
      // so we ask main to flip based on current tray state. For v1 we
      // forward the inverse of the last-known paused flag.
      supervisor.togglePause(!isPaused);
      isPaused = !isPaused;
      tray?.setState({ paused: isPaused });
    },
    onOpenLogs: openLogsFolder,
    onReconfigure: () => {
      // Wired to wizard in Task 16.
      tray?.showBalloon('erepublik-agent', 'Reconfigure not yet wired in this build.');
    },
    onCheckForUpdates: () => {
      // Wired in Task 17.
      tray?.showBalloon('erepublik-agent', 'Update check not yet wired in this build.');
    },
    onToggleAutostart: () => {
      const cur = app.getLoginItemSettings().openAtLogin;
      app.setLoginItemSettings({ openAtLogin: !cur });
      tray?.setState({ autostart: !cur });
    },
    onQuit: async () => {
      isQuitting = true;
      await supervisor.stop();
      tray?.destroy();
      app.quit();
    },
  });
  tray.setState({
    autostart: app.getLoginItemSettings().openAtLogin,
  });

  let isPaused = false;
  supervisor.onReady((port) => {
    createDashboardWindow(port);
  });
  supervisor.onState((state) => {
    tray?.setState({ status: state.status });
  });
  supervisor.onLog((level, text) => {
    // Forward errors to balloon. Don't spam.
    if (level === 'error' && text.length > 0 && text.length < 200) {
      tray?.showBalloon('erepublik-agent', text);
    }
  });
  supervisor.onPermanentFailure(() => {
    tray?.showBalloon(
      'erepublik-agent',
      'Bot stopped after repeated crashes. Right-click → Open logs folder.',
    );
  });

  supervisor.start();
});

app.on('window-all-closed', (event: Electron.Event) => {
  event.preventDefault();
});
```

Note: the `isPaused` variable in the callbacks is captured via closure but defined inside `whenReady`. TS will complain about the order — move `let isPaused = false;` to before the `tray = createTray({...})` call. Adjust as needed.

- [ ] **Step 2: Build and run end-to-end.**

```bash
npm run start:electron
```

Expected: a tray icon appears in the Windows notification area (on macOS, in the menu bar). The runner starts, the dashboard window opens at `http://127.0.0.1:<port>/`, showing the existing dashboard UI. Right-click tray → Pause works. Right-click tray → Quit shuts everything down cleanly.

On macOS for local dev, the tray API works in the menu bar; the dashboard window opens. (Note: macOS isn't a release target but tests of the dev loop work there.)

- [ ] **Step 3: Commit.**

```bash
git add electron/main.ts
git commit -m "$(cat <<'EOF'
feat(electron): wire main to supervisor + tray + dashboard window

main owns: tray, runner-supervisor, dashboard BrowserWindow. On
'ready' from runner, opens BrowserWindow against http://127.0.0.1:port.
Hides-to-tray on window close, with balloon. Quit menu sends shutdown
IPC then SIGTERM/SIGKILL fallback via supervisor. Reconfigure and
update-check are stubs filled in by later tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: First-run detection (decide wizard vs dashboard)

**Files:**
- Modify: `electron/main.ts`
- Create: `electron/firstRun.ts`

When the app starts, decide:
- `${userData}/config/settings.json` exists AND `${userData}/sessions/profile/{slug}/` populated → go straight to dashboard.
- Otherwise → show wizard window first (wizard implemented in Task 11-15).

- [ ] **Step 1: Create `electron/firstRun.ts`.**

```ts
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface FirstRunStatus {
  needsWizard: boolean;
  reason: 'no-settings' | 'no-profile' | 'ok';
}

export function checkFirstRun(userDataDir: string): FirstRunStatus {
  const settingsPath = path.join(userDataDir, 'config', 'settings.json');
  if (!existsSync(settingsPath)) {
    return { needsWizard: true, reason: 'no-settings' };
  }
  const profilesRoot = path.join(userDataDir, 'sessions', 'profile');
  if (!existsSync(profilesRoot) || readdirSync(profilesRoot).length === 0) {
    return { needsWizard: true, reason: 'no-profile' };
  }
  return { needsWizard: false, reason: 'ok' };
}
```

- [ ] **Step 2: Hook into `electron/main.ts`.** Inside `app.whenReady().then(...)`, before `supervisor.start()`, check first-run status. If `needsWizard` — open the wizard window and defer `supervisor.start()` until the wizard signals completion. For now, since the wizard doesn't exist yet, just **log** the decision; we'll wire the wizard window in Task 16.

Insert near the top of `whenReady`:

```ts
import { checkFirstRun } from './firstRun.js';
// …
const firstRun = checkFirstRun(app.getPath('userData'));
console.log(`[main] first-run check: ${firstRun.reason} (needsWizard=${firstRun.needsWizard})`);
```

- [ ] **Step 3: Run, verify the log line appears.**

```bash
npm run start:electron
```

Expected: console prints `[main] first-run check: …`. With no `userData` config it should say `needsWizard=true`. Quit, verify clean shutdown.

- [ ] **Step 4: Commit.**

```bash
git add electron/firstRun.ts electron/main.ts
git commit -m "$(cat <<'EOF'
feat(electron): first-run detection helper

Decides wizard-vs-dashboard at startup by checking userData/config/
settings.json and userData/sessions/profile/. Wizard window itself
is wired in a later task; for now main just logs the decision so the
plumbing is testable independently.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 3 — Wizard

## Task 11: Wizard HTML skeleton + step navigation

**Files:**
- Create: `electron/wizard/index.html`
- Create: `electron/wizard/wizard.css`
- Create: `electron/wizard/wizard.js`

Three steps, navigation between them, no logic yet.

- [ ] **Step 1: Create `electron/wizard/wizard.css`.**

```css
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #1e1e2e; color: #cdd6f4; }
h1 { font-size: 22px; margin: 0 0 16px; }
.stepper { display: flex; gap: 8px; margin-bottom: 24px; }
.stepper .dot { width: 10px; height: 10px; border-radius: 50%; background: #45475a; }
.stepper .dot.active { background: #89b4fa; }
.stepper .dot.done { background: #a6e3a1; }
.step { display: none; }
.step.active { display: block; }
fieldset { border: 1px solid #45475a; border-radius: 6px; padding: 12px 16px; margin-bottom: 16px; }
legend { color: #94a3b8; padding: 0 4px; font-size: 13px; text-transform: uppercase; }
label { display: block; font-size: 13px; margin-bottom: 4px; color: #94a3b8; }
input[type="text"], input[type="number"], input[type="email"], input[type="password"], select { width: 100%; padding: 8px; background: #313244; color: #cdd6f4; border: 1px solid #45475a; border-radius: 4px; font-size: 14px; }
input:focus, select:focus { outline: none; border-color: #89b4fa; }
.row { display: flex; gap: 16px; margin-bottom: 12px; }
.row > div { flex: 1; }
.actions { display: flex; justify-content: space-between; margin-top: 24px; }
button { padding: 10px 24px; background: #89b4fa; color: #1e1e2e; border: none; border-radius: 4px; font-size: 14px; font-weight: 600; cursor: pointer; }
button:hover { background: #74a8f9; }
button.ghost { background: transparent; color: #cdd6f4; border: 1px solid #45475a; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.error { color: #f38ba8; font-size: 13px; margin-top: 4px; }
pre.log { background: #11111b; padding: 12px; border-radius: 6px; max-height: 300px; overflow-y: auto; font-family: "SF Mono", "Cascadia Code", monospace; font-size: 12px; }
.import-banner { background: #313244; padding: 12px 16px; border-radius: 6px; margin-bottom: 16px; font-size: 14px; }
.import-banner a { color: #89b4fa; cursor: pointer; }
```

- [ ] **Step 2: Create `electron/wizard/index.html`.**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>erepublik-agent setup</title>
  <link rel="stylesheet" href="wizard.css" />
</head>
<body>
  <div class="stepper">
    <div class="dot active" data-step="1"></div>
    <div class="dot" data-step="2"></div>
    <div class="dot" data-step="3"></div>
  </div>

  <!-- Step 1: Account & tuning -->
  <section class="step active" data-step="1">
    <h1>Welcome — configure your account</h1>

    <div class="import-banner" id="import-banner">
      Already running the old ZIP version?
      <a id="import-link">Import existing setup →</a>
    </div>

    <fieldset>
      <legend>Account</legend>
      <div class="row">
        <div>
          <label for="email">eRepublik email</label>
          <input id="email" type="email" required />
        </div>
        <div>
          <label for="password">Password</label>
          <input id="password" type="password" required />
        </div>
      </div>
      <label for="slug">Account label</label>
      <input id="slug" type="text" value="main" />
    </fieldset>

    <fieldset>
      <legend>Daily actions</legend>
      <label for="maxFoodPrice">Max Q1 food price</label>
      <input id="maxFoodPrice" type="number" step="0.1" value="3.0" />
    </fieldset>

    <fieldset>
      <legend>Gold farming</legend>
      <div class="row">
        <div>
          <label for="maxTravel">Max travel cost per battle (CC)</label>
          <input id="maxTravel" type="number" value="400" />
        </div>
        <div>
          <label for="minFuel">Min fuel barrels to keep</label>
          <input id="minFuel" type="number" value="10" />
        </div>
      </div>
      <label for="blockedCountries">Blocked countries</label>
      <input id="blockedCountries" type="text" placeholder="Poland, Romania, Argentina" />
      <div id="blockedCountries-error" class="error"></div>
    </fieldset>

    <fieldset>
      <legend>Auto return-home</legend>
      <div class="row">
        <div>
          <label for="returnAfter">Return home after (minutes; 0 disables)</label>
          <input id="returnAfter" type="number" value="15" />
        </div>
        <div>
          <label for="returnMax">Max return-home travel cost (CC)</label>
          <input id="returnMax" type="number" value="500" />
        </div>
      </div>
    </fieldset>

    <fieldset>
      <legend>Telegram notifications (optional)</legend>
      <div class="row">
        <div>
          <label for="tgToken">Bot token</label>
          <input id="tgToken" type="text" />
        </div>
        <div>
          <label for="tgChat">Chat ID</label>
          <input id="tgChat" type="text" />
        </div>
      </div>
    </fieldset>

    <fieldset>
      <legend>Captcha solver (optional)</legend>
      <label for="captchaProvider">Provider</label>
      <select id="captchaProvider">
        <option value="none">none</option>
        <option value="2captcha">2captcha</option>
      </select>
      <div id="captchaKeyWrap" style="display:none; margin-top:12px;">
        <label for="captchaKey">2captcha API key</label>
        <input id="captchaKey" type="text" />
      </div>
    </fieldset>

    <div class="actions">
      <span></span>
      <button id="step1-next">Next</button>
    </div>
  </section>

  <!-- Step 2: Sign in -->
  <section class="step" data-step="2">
    <h1>Sign in to eRepublik</h1>
    <p>A browser window will open. Sign in manually with your eRepublik account; solve any Cloudflare or captcha challenge. The window will close automatically once you're signed in.</p>
    <div class="actions">
      <button id="step2-open" class="ghost">Open login window</button>
    </div>
    <pre class="log" id="step2-log"></pre>
    <div class="actions">
      <button id="step2-back" class="ghost">Back</button>
      <button id="step2-retry" style="display:none;">Retry</button>
    </div>
  </section>

  <!-- Step 3: Done -->
  <section class="step" data-step="3">
    <h1>Almost ready</h1>
    <label style="display:flex; gap:8px; align-items:center;">
      <input type="checkbox" id="autostart" />
      Start automatically when Windows starts
    </label>
    <div class="actions">
      <button id="step3-start">Start bot</button>
    </div>
  </section>

  <script src="wizard.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create `electron/wizard/wizard.js`** with bare navigation:

```js
const state = { current: 1 };
function show(step) {
  state.current = step;
  for (const el of document.querySelectorAll('.step')) {
    el.classList.toggle('active', Number(el.dataset.step) === step);
  }
  for (const el of document.querySelectorAll('.stepper .dot')) {
    const n = Number(el.dataset.step);
    el.classList.toggle('active', n === step);
    el.classList.toggle('done', n < step);
  }
}

document.getElementById('captchaProvider').addEventListener('change', (e) => {
  document.getElementById('captchaKeyWrap').style.display = e.target.value === '2captcha' ? 'block' : 'none';
});

document.getElementById('step1-next').addEventListener('click', () => show(2));
document.getElementById('step2-back').addEventListener('click', () => show(1));
```

- [ ] **Step 4: Update `electron/tsconfig.json` to also copy wizard assets**. We need the build to copy HTML/CSS/JS into `electron-dist/wizard/`. Add a post-build script in `package.json`:

Replace the existing `"build:electron"`:
```json
"build:electron": "tsc -p electron/tsconfig.json && node -e \"require('fs').cpSync('electron/wizard','electron-dist/wizard',{recursive:true})\" && node -e \"require('fs').cpSync('electron/icons','electron-dist/icons',{recursive:true})\""
```

- [ ] **Step 5: Build and verify the files are copied.**

```bash
npm run build:electron && ls electron-dist/wizard/ electron-dist/icons/
```

Expected: `index.html`, `wizard.css`, `wizard.js`, `icon.ico`, `tray.png` all present.

- [ ] **Step 6: Commit.**

```bash
git add electron/wizard/ package.json
git commit -m "$(cat <<'EOF'
feat(wizard): static HTML/CSS/JS skeleton with 3-step navigation

Three sections, Catppuccin-mocha-ish color palette matching the
existing dashboard. Step navigation works (Next/Back) but forms are
not yet wired to validation or IPC — those land in the next tasks.
Build script copies the wizard/ tree alongside compiled main code.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Wizard form validation (TDD)

**Files:**
- Create: `electron/wizard/formValidation.ts`
- Create: `electron/wizard/formValidation.test.ts`

Pure validation logic, testable in isolation. Wizard.js calls it before transitioning to step 2.

- [ ] **Step 1: Write the failing test.** Create `electron/wizard/formValidation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateWizardForm, type WizardFormInput } from './formValidation.js';

const valid: WizardFormInput = {
  email: 'me@example.com',
  password: 'secret123',
  slug: 'main',
  maxFoodPrice: '3.0',
  maxTravel: '400',
  minFuel: '10',
  blockedCountries: '',
  returnAfter: '15',
  returnMax: '500',
  tgToken: '',
  tgChat: '',
  captchaProvider: 'none',
  captchaKey: '',
};

describe('validateWizardForm', () => {
  it('accepts a fully-valid input', () => {
    const result = validateWizardForm(valid);
    expect(result.ok).toBe(true);
  });

  it('rejects empty email', () => {
    const result = validateWizardForm({ ...valid, email: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.email).toMatch(/email/i);
  });

  it('rejects malformed email', () => {
    const result = validateWizardForm({ ...valid, email: 'not-an-email' });
    expect(result.ok).toBe(false);
  });

  it('rejects empty password', () => {
    const result = validateWizardForm({ ...valid, password: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.password).toBeTruthy();
  });

  it('rejects empty slug', () => {
    const result = validateWizardForm({ ...valid, slug: '   ' });
    expect(result.ok).toBe(false);
  });

  it('rejects non-numeric maxFoodPrice', () => {
    const result = validateWizardForm({ ...valid, maxFoodPrice: 'lots' });
    expect(result.ok).toBe(false);
  });

  it('rejects negative numeric fields', () => {
    const result = validateWizardForm({ ...valid, maxTravel: '-1' });
    expect(result.ok).toBe(false);
  });

  it('requires captchaKey when provider is 2captcha', () => {
    const result = validateWizardForm({ ...valid, captchaProvider: '2captcha', captchaKey: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.captchaKey).toBeTruthy();
  });

  it('accepts 2captcha provider with key present', () => {
    const result = validateWizardForm({ ...valid, captchaProvider: '2captcha', captchaKey: 'abc123' });
    expect(result.ok).toBe(true);
  });

  it('coerces numbers correctly on success', () => {
    const result = validateWizardForm(valid);
    if (result.ok) {
      expect(result.values.maxFoodPrice).toBe(3.0);
      expect(result.values.maxTravel).toBe(400);
      expect(result.values.minFuel).toBe(10);
    } else {
      throw new Error('expected ok=true');
    }
  });
});
```

- [ ] **Step 2: Add wizard's directory to vitest include.** Edit `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 3: Run the test, confirm it fails.**

```bash
npx vitest run electron/wizard/formValidation.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 4: Implement.** Create `electron/wizard/formValidation.ts`:

```ts
export interface WizardFormInput {
  email: string;
  password: string;
  slug: string;
  maxFoodPrice: string;
  maxTravel: string;
  minFuel: string;
  blockedCountries: string;
  returnAfter: string;
  returnMax: string;
  tgToken: string;
  tgChat: string;
  captchaProvider: string;
  captchaKey: string;
}

export interface WizardFormValues {
  email: string;
  password: string;
  slug: string;
  maxFoodPrice: number;
  maxTravel: number;
  minFuel: number;
  blockedCountries: string; // raw — country resolution happens elsewhere
  returnAfter: number;
  returnMax: number;
  tgToken: string;
  tgChat: string;
  captchaProvider: 'none' | '2captcha';
  captchaKey: string;
}

export type WizardFormErrors = Partial<Record<keyof WizardFormInput, string>>;

export type WizardFormResult =
  | { ok: true; values: WizardFormValues }
  | { ok: false; errors: WizardFormErrors };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function num(raw: string, label: string, opts: { min?: number; allowFloat?: boolean }): { value: number } | { error: string } {
  if (raw.trim() === '') return { error: `${label} is required` };
  const n = opts.allowFloat ? Number.parseFloat(raw) : Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return { error: `${label} must be a number` };
  if (opts.min !== undefined && n < opts.min) return { error: `${label} must be ≥ ${opts.min}` };
  return { value: n };
}

export function validateWizardForm(input: WizardFormInput): WizardFormResult {
  const errors: WizardFormErrors = {};

  if (!EMAIL_RE.test(input.email.trim())) errors.email = 'Enter a valid email';
  if (input.password.length === 0) errors.password = 'Password is required';
  if (input.slug.trim().length === 0) errors.slug = 'Account label is required';

  const maxFoodPrice = num(input.maxFoodPrice, 'Max Q1 food price', { min: 0, allowFloat: true });
  if ('error' in maxFoodPrice) errors.maxFoodPrice = maxFoodPrice.error;

  const maxTravel = num(input.maxTravel, 'Max travel CC', { min: 0 });
  if ('error' in maxTravel) errors.maxTravel = maxTravel.error;

  const minFuel = num(input.minFuel, 'Min fuel barrels', { min: 0 });
  if ('error' in minFuel) errors.minFuel = minFuel.error;

  const returnAfter = num(input.returnAfter, 'Return home after', { min: 0 });
  if ('error' in returnAfter) errors.returnAfter = returnAfter.error;

  const returnMax = num(input.returnMax, 'Max return-home CC', { min: 0 });
  if ('error' in returnMax) errors.returnMax = returnMax.error;

  if (input.captchaProvider !== 'none' && input.captchaProvider !== '2captcha') {
    errors.captchaProvider = 'Pick a provider';
  }
  if (input.captchaProvider === '2captcha' && input.captchaKey.trim().length === 0) {
    errors.captchaKey = '2captcha key is required when provider is 2captcha';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    values: {
      email: input.email.trim(),
      password: input.password,
      slug: input.slug.trim(),
      maxFoodPrice: (maxFoodPrice as { value: number }).value,
      maxTravel: (maxTravel as { value: number }).value,
      minFuel: (minFuel as { value: number }).value,
      blockedCountries: input.blockedCountries.trim(),
      returnAfter: (returnAfter as { value: number }).value,
      returnMax: (returnMax as { value: number }).value,
      tgToken: input.tgToken.trim(),
      tgChat: input.tgChat.trim(),
      captchaProvider: input.captchaProvider as 'none' | '2captcha',
      captchaKey: input.captchaKey.trim(),
    },
  };
}
```

- [ ] **Step 5: Run, confirm green.**

```bash
npx vitest run electron/wizard/formValidation.test.ts
```

Expected: all 10 tests passing.

- [ ] **Step 6: Wire into wizard.js.** The wizard JS runs in the browser, not Node — vanilla JS, no TS compilation needed for it (it's not run by tsc; it's served as a static file). To avoid duplicating the validation code, we compile it to JS via tsc and copy it. Update `tsconfig.json`'s electron build to also emit the wizard validation as a separate file.

Modify `electron/tsconfig.json`:
```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "outDir": "../electron-dist",
    "rootDir": ".",
    "noEmit": false,
    "module": "ESNext",
    "moduleResolution": "Bundler"
  },
  "include": ["**/*.ts"],
  "exclude": ["**/*.test.ts"]
}
```

Already includes `wizard/*.ts`. So `electron-dist/wizard/formValidation.js` will exist after build. The wizard.js can import it:

Update `electron/wizard/index.html`:
```html
<script type="module" src="wizard.js"></script>
```

Update `electron/wizard/wizard.js`:
```js
import { validateWizardForm } from './formValidation.js';

const state = { current: 1, values: null };
// …existing show() / step navigation…

document.getElementById('step1-next').addEventListener('click', () => {
  const input = {
    email: document.getElementById('email').value,
    password: document.getElementById('password').value,
    slug: document.getElementById('slug').value,
    maxFoodPrice: document.getElementById('maxFoodPrice').value,
    maxTravel: document.getElementById('maxTravel').value,
    minFuel: document.getElementById('minFuel').value,
    blockedCountries: document.getElementById('blockedCountries').value,
    returnAfter: document.getElementById('returnAfter').value,
    returnMax: document.getElementById('returnMax').value,
    tgToken: document.getElementById('tgToken').value,
    tgChat: document.getElementById('tgChat').value,
    captchaProvider: document.getElementById('captchaProvider').value,
    captchaKey: document.getElementById('captchaKey').value,
  };
  // Clear previous errors
  for (const el of document.querySelectorAll('.error')) el.textContent = '';
  const result = validateWizardForm(input);
  if (!result.ok) {
    for (const [field, msg] of Object.entries(result.errors)) {
      const el = document.getElementById(`${field}-error`);
      if (el) el.textContent = msg;
      else {
        // Append a sibling error if no dedicated container exists.
        const input = document.getElementById(field);
        if (input?.parentElement) {
          const div = document.createElement('div');
          div.className = 'error';
          div.id = `${field}-error`;
          div.textContent = msg;
          input.parentElement.appendChild(div);
        }
      }
    }
    return;
  }
  state.values = result.values;
  show(2);
});
```

- [ ] **Step 7: Rebuild.**

```bash
npm run build:electron
```

Expected: `electron-dist/wizard/formValidation.js` and `wizard.js` exist.

- [ ] **Step 8: Smoke test.**

```bash
npm run start:electron
```

(Wizard is not yet wired into main.ts — Task 16 will. For now you can manually load `electron-dist/wizard/index.html` in a browser to exercise the form.)

- [ ] **Step 9: Commit.**

```bash
git add electron/wizard/formValidation.ts electron/wizard/formValidation.test.ts electron/wizard/wizard.js vitest.config.ts
git commit -m "$(cat <<'EOF'
feat(wizard): form validation with full unit-test coverage

Pure module: takes the raw form input, returns parsed values or a
field-keyed error map. Handles email regex, required strings,
non-negative number coercion (int + float), and the captcha
provider/key conditional. Vitest config extended to also pick up
electron/**/*.test.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Country picker integration

**Files:**
- Create: `electron/wizard/countryPicker.ts`
- Create: `electron/wizard/countryPicker.test.ts`
- Modify: `electron/wizard/wizard.js` (wire picker UI)

Reuses `src/util/resolveCountries.ts` (created in the .bat spec implementation — verify it exists; if not, this task notes the gap). The picker autocompletes against `data/countries.json`.

- [ ] **Step 1: Verify `src/util/resolveCountries.ts` and `data/countries.json` exist.**

```bash
ls src/util/resolveCountries.ts data/countries.json
```

If both exist → continue with Step 2.
If either missing → **stop and create them per §5.6 / §6.4 of `2026-05-16-windows-distribution-design.md`** before continuing this task. (They were defined in that spec; the .bat distribution implementation should have produced them.)

- [ ] **Step 2: Write failing test.** Create `electron/wizard/countryPicker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { suggestCountries, parseChips } from './countryPicker.js';

const catalog = [
  { id: 1, name: 'Romania' },
  { id: 35, name: 'Poland' },
  { id: 27, name: 'Argentina' },
  { id: 9, name: 'Brazil' },
];

describe('suggestCountries', () => {
  it('returns prefix matches case-insensitively', () => {
    const out = suggestCountries('pol', catalog);
    expect(out).toEqual([{ id: 35, name: 'Poland' }]);
  });

  it('returns substring matches when no prefix match', () => {
    const out = suggestCountries('ent', catalog);
    expect(out).toEqual([{ id: 27, name: 'Argentina' }]);
  });

  it('returns empty for whitespace input', () => {
    expect(suggestCountries('   ', catalog)).toEqual([]);
  });

  it('limits to 8 results', () => {
    const big = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Country${i}` }));
    expect(suggestCountries('Country', big).length).toBe(8);
  });
});

describe('parseChips', () => {
  it('returns no chips for empty string', () => {
    expect(parseChips('', catalog)).toEqual({ chips: [], unknown: [] });
  });

  it('parses comma-separated names', () => {
    const out = parseChips('Poland, Romania', catalog);
    expect(out.chips).toEqual([
      { id: 35, name: 'Poland' },
      { id: 1, name: 'Romania' },
    ]);
    expect(out.unknown).toEqual([]);
  });

  it('reports unknown tokens', () => {
    const out = parseChips('Poland, Atlantis', catalog);
    expect(out.chips).toEqual([{ id: 35, name: 'Poland' }]);
    expect(out.unknown).toEqual(['Atlantis']);
  });

  it('accepts numeric IDs', () => {
    const out = parseChips('35, 1', catalog);
    expect(out.chips).toEqual([
      { id: 35, name: 'Poland' },
      { id: 1, name: 'Romania' },
    ]);
  });
});
```

- [ ] **Step 3: Run, confirm fails.**

```bash
npx vitest run electron/wizard/countryPicker.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement.** Create `electron/wizard/countryPicker.ts`:

```ts
export interface Country { id: number; name: string; }

const MAX_SUGGESTIONS = 8;

export function suggestCountries(query: string, catalog: Country[]): Country[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const prefix = catalog.filter((c) => c.name.toLowerCase().startsWith(q));
  if (prefix.length > 0) return prefix.slice(0, MAX_SUGGESTIONS);
  const substring = catalog.filter((c) => c.name.toLowerCase().includes(q));
  return substring.slice(0, MAX_SUGGESTIONS);
}

export interface ParseResult {
  chips: Country[];
  unknown: string[];
}

export function parseChips(input: string, catalog: Country[]): ParseResult {
  const chips: Country[] = [];
  const unknown: string[] = [];
  for (const raw of input.split(',')) {
    const t = raw.trim();
    if (!t) continue;
    const asNum = Number.parseInt(t, 10);
    if (!Number.isNaN(asNum) && String(asNum) === t) {
      const c = catalog.find((x) => x.id === asNum);
      if (c) chips.push(c);
      else unknown.push(t);
      continue;
    }
    const c = catalog.find((x) => x.name.toLowerCase() === t.toLowerCase());
    if (c) chips.push(c);
    else unknown.push(t);
  }
  return { chips, unknown };
}
```

- [ ] **Step 5: Run, confirm passes.**

```bash
npx vitest run electron/wizard/countryPicker.test.ts
```

Expected: green.

- [ ] **Step 6: Load the catalog in the wizard.** The catalog is at `${userData}/../data/countries.json` in dev (under repo root); in the packaged app it's at `resources/app.asar/data/countries.json`. The wizard renderer can't read the filesystem directly — IPC.

For v1, the simplest approach: embed `data/countries.json` as a static asset bundled into the wizard. Add a build step that copies it:

Modify the `build:electron` script in `package.json`:
```json
"build:electron": "tsc -p electron/tsconfig.json && node -e \"require('fs').cpSync('electron/wizard','electron-dist/wizard',{recursive:true})\" && node -e \"require('fs').cpSync('electron/icons','electron-dist/icons',{recursive:true})\" && node -e \"require('fs').cpSync('data/countries.json','electron-dist/wizard/countries.json')\""
```

- [ ] **Step 7: Wire the picker into wizard.js.** In `electron/wizard/wizard.js`, add at the top (after the existing import):

```js
import { suggestCountries, parseChips } from './countryPicker.js';

let countryCatalog = [];
fetch('countries.json').then(r => r.json()).then(j => { countryCatalog = j; });

const blockedInput = document.getElementById('blockedCountries');
const errEl = document.getElementById('blockedCountries-error');
const suggestBox = document.createElement('div');
suggestBox.style.cssText = 'position:absolute; background:#313244; border:1px solid #45475a; max-height:240px; overflow-y:auto; z-index:10;';
suggestBox.style.display = 'none';
blockedInput.parentElement.style.position = 'relative';
blockedInput.parentElement.appendChild(suggestBox);

blockedInput.addEventListener('input', () => {
  const trailing = blockedInput.value.split(',').pop().trim();
  const matches = suggestCountries(trailing, countryCatalog);
  if (matches.length === 0) { suggestBox.style.display = 'none'; return; }
  suggestBox.innerHTML = '';
  for (const c of matches) {
    const item = document.createElement('div');
    item.style.cssText = 'padding:6px 10px; cursor:pointer;';
    item.textContent = c.name;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const parts = blockedInput.value.split(',').map(s => s.trim()).filter(Boolean);
      parts.pop();
      parts.push(c.name);
      blockedInput.value = parts.join(', ') + ', ';
      suggestBox.style.display = 'none';
      blockedInput.focus();
    });
    suggestBox.appendChild(item);
  }
  suggestBox.style.display = 'block';
});
blockedInput.addEventListener('blur', () => setTimeout(() => suggestBox.style.display = 'none', 200));
blockedInput.addEventListener('change', () => {
  const { unknown } = parseChips(blockedInput.value, countryCatalog);
  errEl.textContent = unknown.length > 0 ? `Unknown country: ${unknown.join(', ')}` : '';
});
```

- [ ] **Step 8: Rebuild, smoke test.**

```bash
npm run build:electron
# Open electron-dist/wizard/index.html in a browser
```

Expected: typing in the blocked-countries field shows suggestions; selecting one appends to the field; typing an unknown country shows an error after blur.

- [ ] **Step 9: Commit.**

```bash
git add electron/wizard/countryPicker.ts electron/wizard/countryPicker.test.ts electron/wizard/wizard.js package.json
git commit -m "$(cat <<'EOF'
feat(wizard): country autocomplete picker with chip parsing

Reuses data/countries.json (74 entries) loaded as a static asset
bundled into wizard/. Suggestion list opens on input, prefix-match
first then substring fallback; parseChips reports unknown tokens
back to the user. Both helpers fully unit-tested.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Wizard step 2 — bootstrap trigger + stdout streaming

**Files:**
- Create: `electron/preload.ts`
- Modify: `electron/main.ts` (register IPC handlers)
- Modify: `electron/wizard/wizard.js` (call window.electronAPI.startBootstrap)

The wizard needs to ask main to spawn `dist/bootstrap.js` with the user's credentials. Main streams stdout/stderr back as IPC events; wizard appends them to the log panel.

- [ ] **Step 1: Create `electron/preload.ts`.**

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Step 1 commit: write .env and settings.json, return success/error.
  saveConfig: (values: unknown) => ipcRenderer.invoke('wizard:saveConfig', values),
  // Step 2: trigger bootstrap, stream stdout via wizard:bootstrapOutput events.
  startBootstrap: () => ipcRenderer.invoke('wizard:startBootstrap'),
  onBootstrapOutput: (cb: (data: { stream: 'stdout' | 'stderr' | 'exit'; text?: string; code?: number }) => void) => {
    const listener = (_: unknown, payload: any) => cb(payload);
    ipcRenderer.on('wizard:bootstrapOutput', listener);
    return () => ipcRenderer.removeListener('wizard:bootstrapOutput', listener);
  },
  // Step 3: enable autostart, signal we're done so main can open the dashboard.
  finish: (opts: { autostart: boolean }) => ipcRenderer.invoke('wizard:finish', opts),
  // Importer (Task 18-19):
  pickLegacyFolder: () => ipcRenderer.invoke('wizard:pickLegacyFolder'),
  importLegacy: (folder: string) => ipcRenderer.invoke('wizard:importLegacy', folder),
});
```

- [ ] **Step 2: Add IPC handlers in `electron/main.ts`.** Near the top, after imports:

```ts
import { ipcMain, dialog as electronDialog } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
```

Inside `app.whenReady()`, before the supervisor starts (or after — order doesn't matter):

```ts
ipcMain.handle('wizard:saveConfig', async (_, raw: any) => {
  const userData = app.getPath('userData');
  await fs.mkdir(path.join(userData, 'config'), { recursive: true });
  // Write .env
  const envLines = [
    `ERP_LOGIN=${raw.email}`,
    `ERP_PASSWORD=${raw.password}`,
    `ERP_ACCOUNT_SLUG=${raw.slug}`,
    `ERP_MAX_FOOD_PRICE=${raw.maxFoodPrice}`,
    `ERP_FARM_MAX_TRAVEL_CC=${raw.maxTravel}`,
    `ERP_FARM_MIN_FUEL=${raw.minFuel}`,
    `ERP_RETURN_HOME_AFTER_MINUTES=${raw.returnAfter}`,
    `ERP_RETURN_HOME_MAX_CC=${raw.returnMax}`,
    `TELEGRAM_BOT_TOKEN=${raw.tgToken}`,
    `TELEGRAM_CHAT_ID=${raw.tgChat}`,
    `ERP_CAPTCHA_PROVIDER=${raw.captchaProvider}`,
    `ERP_CAPTCHA_API_KEY=${raw.captchaKey}`,
    `HEADED=false`,
  ];
  await fs.writeFile(path.join(userData, 'config', '.env'), envLines.join('\n'));
  // We let the runner seed config/settings.json from .env on first start.
  // For blocked-countries we don't yet have a settings shape — defer to the runner's seeder.
  // The country resolution result is also stored in .env for the runner to use.
  return { ok: true };
});

ipcMain.handle('wizard:startBootstrap', async (event) => {
  const userData = app.getPath('userData');
  const bootstrapPath = path.resolve(__dirname, '../dist/bootstrap.js');
  return new Promise<{ ok: boolean; code?: number; reason?: string }>((resolve) => {
    const child = spawn(process.execPath, [bootstrapPath], {
      env: { ...process.env, ERP_ROOT: userData, HEADED: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (buf: Buffer) => {
      event.sender.send('wizard:bootstrapOutput', { stream: 'stdout', text: buf.toString() });
    });
    child.stderr.on('data', (buf: Buffer) => {
      event.sender.send('wizard:bootstrapOutput', { stream: 'stderr', text: buf.toString() });
    });
    child.on('exit', (code) => {
      event.sender.send('wizard:bootstrapOutput', { stream: 'exit', code: code ?? -1 });
      resolve({ ok: code === 0, code: code ?? -1, reason: code !== 0 ? `Bootstrap exited with code ${code}` : undefined });
    });
  });
});

ipcMain.handle('wizard:finish', async (_, opts: { autostart: boolean }) => {
  app.setLoginItemSettings({ openAtLogin: opts.autostart });
  // Main will be told to start the supervisor from the wizard-window-closed handler — see Task 16.
  return { ok: true };
});
```

(The `wizard:pickLegacyFolder` and `wizard:importLegacy` handlers are wired in Task 18-19.)

- [ ] **Step 3: Wire preload into wizard window.** This requires the wizard `BrowserWindow` to use the preload script — done in Task 16 when we create the wizard window. For now, add a sanity check to the existing dashboard `BrowserWindow` constructor to keep changes minimal — no harm in attaching the preload to both.

In `electron/main.ts`, replace the `webPreferences` block in `createDashboardWindow` with:

```ts
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  preload: path.resolve(__dirname, 'preload.js'),
},
```

- [ ] **Step 4: Wire step 2 in `electron/wizard/wizard.js`.**

```js
const step2Log = document.getElementById('step2-log');
const step2Open = document.getElementById('step2-open');
const step2Retry = document.getElementById('step2-retry');

function appendLog(text, kind = '') {
  const line = document.createElement('div');
  if (kind === 'stderr') line.style.color = '#f38ba8';
  line.textContent = text;
  step2Log.appendChild(line);
  step2Log.scrollTop = step2Log.scrollHeight;
}

const offBootstrap = window.electronAPI.onBootstrapOutput((data) => {
  if (data.stream === 'exit') {
    if (data.code === 0) {
      appendLog('[wizard] login successful — preparing next step…');
      setTimeout(() => show(3), 600);
    } else {
      appendLog(`[wizard] bootstrap exited with code ${data.code}`, 'stderr');
      step2Retry.style.display = 'inline-block';
    }
  } else {
    appendLog(data.text.trimEnd(), data.stream === 'stderr' ? 'stderr' : '');
  }
});

async function runBootstrap() {
  step2Log.innerHTML = '';
  step2Retry.style.display = 'none';
  step2Open.disabled = true;
  // First save the config so bootstrap can read it.
  const save = await window.electronAPI.saveConfig(state.values);
  if (!save.ok) {
    appendLog(`[wizard] failed to save config: ${save.error}`, 'stderr');
    step2Open.disabled = false;
    return;
  }
  await window.electronAPI.startBootstrap();
  step2Open.disabled = false;
}

step2Open.addEventListener('click', runBootstrap);
step2Retry.addEventListener('click', runBootstrap);
```

- [ ] **Step 5: Build and verify the bootstrap path compiles.**

```bash
npm run build && npm run build:electron
ls dist/bootstrap.js
```

Expected: `dist/bootstrap.js` exists.

- [ ] **Step 6: Commit.**

```bash
git add electron/preload.ts electron/main.ts electron/wizard/wizard.js
git commit -m "$(cat <<'EOF'
feat(wizard): IPC bridge + step 2 bootstrap trigger with live logs

Adds contextBridge preload exposing saveConfig, startBootstrap, and
the onBootstrapOutput event stream. Main handles saveConfig by
writing userData/config/.env, and startBootstrap by spawning
dist/bootstrap.js as a child process with HEADED=true, piping
stdout/stderr back to the renderer line-by-line. Wizard step 2 shows
the live log and a Retry button on non-zero exit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Wizard step 3 — autostart toggle + Start bot

**Files:**
- Modify: `electron/wizard/wizard.js`
- Modify: `electron/main.ts` (handler is already in place from Task 14; verify wizard-finish path opens dashboard)

- [ ] **Step 1: Wire step 3 in `electron/wizard/wizard.js`.**

```js
const step3Start = document.getElementById('step3-start');
const autostartChk = document.getElementById('autostart');

step3Start.addEventListener('click', async () => {
  step3Start.disabled = true;
  step3Start.textContent = 'Starting…';
  await window.electronAPI.finish({ autostart: autostartChk.checked });
  // Main will close this window and open the dashboard. Nothing else to do.
});
```

- [ ] **Step 2: In `electron/main.ts`'s `wizard:finish` handler**, close the wizard window and trigger the supervisor:

Replace the existing `wizard:finish` handler:
```ts
ipcMain.handle('wizard:finish', async (_, opts: { autostart: boolean }) => {
  app.setLoginItemSettings({ openAtLogin: opts.autostart });
  tray?.setState({ autostart: opts.autostart });
  if (wizardWindow) {
    wizardWindow.close();
    wizardWindow = undefined;
  }
  supervisor.start();
  return { ok: true };
});
```

(The `wizardWindow` variable is declared in Task 16; this code anticipates it.)

- [ ] **Step 3: Compile.**

```bash
npm run build:electron
```

Expected: clean. Note that until Task 16 introduces `wizardWindow`, TS may complain — if so, add `let wizardWindow: BrowserWindow | undefined;` at module scope ahead of this task.

- [ ] **Step 4: Commit.**

```bash
git add electron/wizard/wizard.js electron/main.ts
git commit -m "$(cat <<'EOF'
feat(wizard): step 3 autostart toggle + Start bot finalization

Step 3 sets app login-item setting and signals main to close the
wizard window and spawn the runner. Tray state mirrors the autostart
toggle so the menu checkbox stays accurate after first launch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: First-run wizard window in main.ts

**Files:**
- Modify: `electron/main.ts`

Open the wizard window on first run instead of starting the supervisor immediately. After the wizard signals `finish`, supervisor starts and dashboard opens normally.

- [ ] **Step 1: Add a `createWizardWindow` function and modify `whenReady`.** Replace the `app.whenReady().then(() => { ... })` block:

```ts
let wizardWindow: BrowserWindow | undefined;

function createWizardWindow() {
  wizardWindow = new BrowserWindow({
    width: 760,
    height: 700,
    title: 'erepublik-agent setup',
    icon: path.join(__dirname, '../electron/icons/icon.ico'),
    resizable: false,
    maximizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.resolve(__dirname, 'preload.js'),
    },
  });
  wizardWindow.loadFile(path.resolve(__dirname, 'wizard', 'index.html'));
  wizardWindow.on('closed', () => {
    wizardWindow = undefined;
  });
}

let isPaused = false;

app.whenReady().then(() => {
  // Build tray immediately so the user has a quit affordance.
  tray = createTray({
    onShowDashboard: () => {
      const port = supervisor.getLastKnownPort();
      if (!port) {
        tray?.showBalloon('erepublik-agent', 'Bot is still starting…');
        return;
      }
      if (!dashboardWindow) createDashboardWindow(port);
      else {
        if (!dashboardWindow.isVisible()) dashboardWindow.show();
        dashboardWindow.focus();
      }
    },
    onTogglePause: () => {
      supervisor.togglePause(!isPaused);
      isPaused = !isPaused;
      tray?.setState({ paused: isPaused });
    },
    onOpenLogs: openLogsFolder,
    onReconfigure: () => {
      if (!wizardWindow) createWizardWindow();
      else wizardWindow.focus();
    },
    onCheckForUpdates: () => {
      tray?.showBalloon('erepublik-agent', 'Update check not yet wired in this build.');
    },
    onToggleAutostart: () => {
      const cur = app.getLoginItemSettings().openAtLogin;
      app.setLoginItemSettings({ openAtLogin: !cur });
      tray?.setState({ autostart: !cur });
    },
    onQuit: async () => {
      isQuitting = true;
      await supervisor.stop();
      tray?.destroy();
      app.quit();
    },
  });
  tray.setState({ autostart: app.getLoginItemSettings().openAtLogin });

  supervisor.onReady((port) => {
    createDashboardWindow(port);
  });
  supervisor.onState((state) => tray?.setState({ status: state.status }));
  supervisor.onLog((level, text) => {
    if (level === 'error' && text.length > 0 && text.length < 200) {
      tray?.showBalloon('erepublik-agent', text);
    }
  });
  supervisor.onPermanentFailure(() => {
    tray?.showBalloon(
      'erepublik-agent',
      'Bot stopped after repeated crashes. Right-click → Open logs folder.',
    );
  });

  const firstRun = checkFirstRun(app.getPath('userData'));
  if (firstRun.needsWizard) {
    createWizardWindow();
    // Supervisor stays idle until wizard:finish triggers supervisor.start().
  } else {
    supervisor.start();
  }
});
```

- [ ] **Step 2: Run end-to-end on a fresh `userData` directory.** On macOS, delete the test userData:

```bash
rm -rf "$HOME/Library/Application Support/erepublik-agent"
npm run start:electron
```

Expected: wizard window opens. Fill the form (use real eRepublik credentials), click Next → step 2 → click "Open login window" (CloakBrowser opens) → log in manually → step 3 appears → Start bot → wizard closes, dashboard window opens, bot starts a cycle.

- [ ] **Step 3: Commit.**

```bash
git add electron/main.ts
git commit -m "$(cat <<'EOF'
feat(electron): first-run wizard window, dashboard after finish

Main now creates the tray immediately so the user has a quit
affordance even if the wizard is mid-flight, then either opens the
wizard window (first run) or starts the supervisor straight away.
Wizard:finish closes the window and starts the supervisor; supervisor
ready opens the dashboard.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 4 — Auto-updater

## Task 17: electron-updater integration

**Files:**
- Create: `electron/updater.ts`
- Modify: `electron/main.ts` (wire updater into tray + startup)

- [ ] **Step 1: Create `electron/updater.ts`.**

```ts
import { autoUpdater } from 'electron-updater';
import { dialog, app } from 'electron';
import log from 'node:console';

export interface UpdaterCallbacks {
  onUpdateAvailable: (version: string) => void;
  onUpdateNotAvailable: () => void;
  onError: (err: Error) => void;
}

export function configureUpdater(cb: UpdaterCallbacks) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    cb.onUpdateAvailable(info.version);
  });
  autoUpdater.on('update-not-available', () => {
    cb.onUpdateNotAvailable();
  });
  autoUpdater.on('error', (err) => {
    log.error('[updater]', err);
    cb.onError(err);
  });

  // Initial check after 30s delay (don't block startup UX).
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(cb.onError);
  }, 30_000);
}

export async function manualCheck(): Promise<{ status: 'available' | 'none' | 'error'; detail?: string }> {
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result?.updateInfo && result.updateInfo.version !== app.getVersion()) {
      return { status: 'available', detail: result.updateInfo.version };
    }
    return { status: 'none' };
  } catch (err) {
    return { status: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

export function showManualResultDialog(parentWindow: Electron.BrowserWindow | undefined, result: Awaited<ReturnType<typeof manualCheck>>) {
  if (result.status === 'available') {
    dialog.showMessageBox(parentWindow ?? null as any, {
      type: 'info',
      message: `Update available: v${result.detail}`,
      detail: 'Quit the app to install. The current install will continue running until you quit.',
      buttons: ['OK'],
    });
  } else if (result.status === 'none') {
    dialog.showMessageBox(parentWindow ?? null as any, {
      type: 'info',
      message: `You are on the latest version (v${app.getVersion()}).`,
      buttons: ['OK'],
    });
  } else {
    dialog.showMessageBox(parentWindow ?? null as any, {
      type: 'error',
      message: 'Update check failed',
      detail: result.detail ?? 'Unknown error',
      buttons: ['OK'],
    });
  }
}
```

- [ ] **Step 2: Wire into `electron/main.ts`.** Add at the top:

```ts
import { configureUpdater, manualCheck, showManualResultDialog } from './updater.js';
```

Inside `whenReady`, after the tray is built:

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

Replace the `onCheckForUpdates` callback in the tray construction:
```ts
onCheckForUpdates: async () => {
  const result = await manualCheck();
  showManualResultDialog(dashboardWindow, result);
},
```

- [ ] **Step 3: Smoke build.**

```bash
npm run build:electron
```

Expected: clean (electron-updater is a runtime dep, types come with the package).

- [ ] **Step 4: Commit.**

```bash
git add electron/updater.ts electron/main.ts
git commit -m "$(cat <<'EOF'
feat(electron): integrate electron-updater against GitHub Releases

Auto-check 30s after launch; balloon notification on available
updates; install-on-quit. Manual check via tray menu shows a
dialog with the version (or "you're current"). Errors are logged
silently — no user-facing noise.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 5 — Legacy importer

## Task 18: importLegacy module

**Files:**
- Create: `electron/importLegacy.ts`
- Create: `electron/importLegacy.test.ts`

Detect a `.bat` install (heuristic: directory contains `app/` + `sessions/` + at least one of `config/.env` or `chromium-cache/`). Copy into `userData`. Run `dist/healthcheck.js` to verify the imported session.

- [ ] **Step 1: Write tests.** Create `electron/importLegacy.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectLegacyInstall } from './importLegacy.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-test-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('detectLegacyInstall', () => {
  it('returns null for an empty directory', () => {
    expect(detectLegacyInstall(tmp)).toBeNull();
  });

  it('detects a directory with app/ + sessions/ + config/.env', () => {
    fs.mkdirSync(path.join(tmp, 'app'));
    fs.mkdirSync(path.join(tmp, 'sessions'));
    fs.mkdirSync(path.join(tmp, 'config'));
    fs.writeFileSync(path.join(tmp, 'config', '.env'), 'X=1');
    const out = detectLegacyInstall(tmp);
    expect(out).not.toBeNull();
    expect(out?.hasSessions).toBe(true);
    expect(out?.hasEnv).toBe(true);
    expect(out?.hasChromiumCache).toBe(false);
  });

  it('detects chromium-cache when present', () => {
    fs.mkdirSync(path.join(tmp, 'app'));
    fs.mkdirSync(path.join(tmp, 'sessions'));
    fs.mkdirSync(path.join(tmp, 'chromium-cache'));
    fs.writeFileSync(path.join(tmp, 'chromium-cache', 'placeholder'), '');
    const out = detectLegacyInstall(tmp);
    expect(out?.hasChromiumCache).toBe(true);
  });

  it('returns null when fewer than 2 marker dirs present', () => {
    fs.mkdirSync(path.join(tmp, 'app'));
    expect(detectLegacyInstall(tmp)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm fails.**

```bash
npx vitest run electron/importLegacy.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement.** Create `electron/importLegacy.ts`:

```ts
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface LegacyInstall {
  rootPath: string;
  hasApp: boolean;
  hasSessions: boolean;
  hasEnv: boolean;
  hasChromiumCache: boolean;
}

/**
 * Heuristic detection: a .bat install has at least 2 of these markers:
 *   - app/ subdir (compiled JS)
 *   - sessions/ subdir
 *   - config/.env file
 *   - chromium-cache/ subdir
 */
export function detectLegacyInstall(rootPath: string): LegacyInstall | null {
  if (!fs.existsSync(rootPath)) return null;
  const hasApp = fs.existsSync(path.join(rootPath, 'app'));
  const hasSessions = fs.existsSync(path.join(rootPath, 'sessions'));
  const hasEnv = fs.existsSync(path.join(rootPath, 'config', '.env'));
  const hasChromiumCache = fs.existsSync(path.join(rootPath, 'chromium-cache'));
  const markerCount = [hasApp, hasSessions, hasEnv, hasChromiumCache].filter(Boolean).length;
  if (markerCount < 2) return null;
  return { rootPath, hasApp, hasSessions, hasEnv, hasChromiumCache };
}

export interface ImportProgress {
  task: string;
  percent: number;
}

/**
 * Copy sessions/, config/, chromium-cache/ from a legacy install into userData.
 * Skips files that already exist in userData (non-destructive).
 */
export async function copyLegacyData(
  legacy: LegacyInstall,
  userDataDir: string,
  onProgress: (p: ImportProgress) => void,
): Promise<void> {
  const tasks: Array<{ src: string; dst: string; label: string }> = [];
  if (legacy.hasSessions) {
    tasks.push({ src: path.join(legacy.rootPath, 'sessions'), dst: path.join(userDataDir, 'sessions'), label: 'sessions' });
  }
  // config/.env first; config/settings.json if present.
  if (legacy.hasEnv) {
    tasks.push({ src: path.join(legacy.rootPath, 'config'), dst: path.join(userDataDir, 'config'), label: 'config' });
  }
  if (legacy.hasChromiumCache) {
    tasks.push({ src: path.join(legacy.rootPath, 'chromium-cache'), dst: path.join(userDataDir, 'chromium-cache'), label: 'chromium-cache (~200 MB)' });
  }
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    onProgress({ task: `Copying ${t.label}…`, percent: Math.floor((i / tasks.length) * 100) });
    await fsp.cp(t.src, t.dst, { recursive: true, force: false, errorOnExist: false });
  }
  onProgress({ task: 'Done', percent: 100 });
}

/**
 * Run a one-shot healthcheck against the imported profile.
 * Spawns dist/healthcheck.js with ERP_ROOT=userDataDir; exit 0 = ok, anything else = stale.
 */
export async function runImportedHealthcheck(userDataDir: string, healthcheckPath: string, execPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(execPath, [healthcheckPath], {
      env: { ...process.env, ERP_ROOT: userDataDir, HEADED: 'false' },
      stdio: 'ignore',
      windowsHide: true,
    });
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 60_000);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
}
```

- [ ] **Step 4: Run tests, confirm green.**

```bash
npx vitest run electron/importLegacy.test.ts
```

Expected: 4 tests passing.

- [ ] **Step 5: Commit.**

```bash
git add electron/importLegacy.ts electron/importLegacy.test.ts
git commit -m "$(cat <<'EOF'
feat(electron): legacy .bat install detection + copy helper

detectLegacyInstall heuristically identifies a .bat ZIP install
(≥2 of: app/, sessions/, config/.env, chromium-cache/). copyLegacyData
streams sessions/, config/, and chromium-cache/ into userData with a
non-destructive cp (force=false). runImportedHealthcheck spawns
dist/healthcheck.js against the imported profile with a 60s timeout —
its exit code decides whether the wizard skips the Sign in step.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Wire importer into wizard

**Files:**
- Modify: `electron/main.ts` (IPC handlers)
- Modify: `electron/wizard/wizard.js` (import banner click handler)

- [ ] **Step 1: Add IPC handlers in `electron/main.ts`.** Near the existing wizard IPC handlers:

```ts
import { detectLegacyInstall, copyLegacyData, runImportedHealthcheck } from './importLegacy.js';

ipcMain.handle('wizard:pickLegacyFolder', async () => {
  const win = wizardWindow ?? dashboardWindow;
  const result = await electronDialog.showOpenDialog(win as BrowserWindow, {
    title: 'Select your existing .bat install folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const folder = result.filePaths[0];
  const detected = detectLegacyInstall(folder);
  if (!detected) {
    return { ok: false, error: 'Selected folder does not look like a .bat install (missing markers).' };
  }
  return { ok: true, info: detected };
});

ipcMain.handle('wizard:importLegacy', async (event, folder: string) => {
  const detected = detectLegacyInstall(folder);
  if (!detected) return { ok: false, error: 'Selected folder is no longer a valid .bat install.' };
  const userData = app.getPath('userData');
  await copyLegacyData(detected, userData, (p) => {
    event.sender.send('wizard:importProgress', p);
  });
  // Run healthcheck against the imported session.
  const healthcheckPath = path.resolve(__dirname, '../dist/healthcheck.js');
  const ok = await runImportedHealthcheck(userData, healthcheckPath, process.execPath);
  return { ok: true, sessionValid: ok };
});
```

- [ ] **Step 2: Expose progress in preload.** Update `electron/preload.ts`:

```ts
onImportProgress: (cb: (p: { task: string; percent: number }) => void) => {
  const listener = (_: unknown, payload: any) => cb(payload);
  ipcRenderer.on('wizard:importProgress', listener);
  return () => ipcRenderer.removeListener('wizard:importProgress', listener);
},
```

- [ ] **Step 3: Wire the wizard import banner in `electron/wizard/wizard.js`.**

```js
document.getElementById('import-link').addEventListener('click', async () => {
  const picked = await window.electronAPI.pickLegacyFolder();
  if (!picked) return;
  if (!picked.ok) { alert(picked.error); return; }

  // Show a progress overlay.
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.7); display:flex; flex-direction:column; align-items:center; justify-content:center; color:#cdd6f4; z-index:100;';
  overlay.innerHTML = '<h2>Importing existing setup…</h2><div id="import-status">Starting…</div><progress id="import-bar" max="100" value="0" style="width:300px;"></progress>';
  document.body.appendChild(overlay);

  const offProgress = window.electronAPI.onImportProgress((p) => {
    document.getElementById('import-status').textContent = p.task;
    document.getElementById('import-bar').value = p.percent;
  });

  const result = await window.electronAPI.importLegacy(picked.info.rootPath);
  offProgress();
  overlay.remove();

  if (!result.ok) {
    alert(`Import failed: ${result.error}`);
    return;
  }

  if (result.sessionValid) {
    appendLog('[wizard] imported session is valid — skipping Sign in step.');
    show(3);
  } else {
    alert('Import successful, but your existing login has expired. You will need to sign in again.');
    show(2);
  }
});
```

Note: `appendLog` is defined in step 2's wizard.js — if not yet available in this scope, omit that line.

- [ ] **Step 4: Smoke test.** Manually create a fake legacy install folder and exercise the picker:

```bash
mkdir -p /tmp/fake-legacy/{app,sessions,config,chromium-cache}
echo "X=1" > /tmp/fake-legacy/config/.env
rm -rf "$HOME/Library/Application Support/erepublik-agent"
npm run build && npm run build:electron && npm run start:electron
# In wizard: click "Import existing setup →", pick /tmp/fake-legacy
# Verify progress bar appears, copy completes, healthcheck attempts to run (will fail because no real session).
```

- [ ] **Step 5: Commit.**

```bash
git add electron/main.ts electron/preload.ts electron/wizard/wizard.js
git commit -m "$(cat <<'EOF'
feat(wizard): import existing .bat setup with healthcheck-gated skip

Clicking the import banner opens a folder picker, validates it looks
like a .bat install, then copies sessions/, config/, and chromium-
cache/ into userData with a live progress overlay. After copy, runs
dist/healthcheck.js against the imported profile — on exit 0 the
wizard jumps directly to step 3 (autostart + Start), otherwise it
proceeds to step 2 (Sign in) so the user re-authenticates.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 6 — Build, release, cleanup

## Task 20: electron-builder config + real icons

**Files:**
- Create: `electron-builder.yml`
- Replace: `electron/icons/icon.ico` (real 256×256 multi-resolution)
- Replace: `electron/icons/tray.png` (real 32×32)

- [ ] **Step 1: Create real icons.** Generate a simple eRepublik-themed icon. Two approaches:
  - Use any icon generator (e.g., Figma export → ICO converter at `icoconvert.com`).
  - Or commission/generate one with whatever tool you prefer.

For now place the production icon files at `electron/icons/icon.ico` (256×256 multi-resolution) and `electron/icons/tray.png` (32×32). They replace the dev placeholders.

- [ ] **Step 2: Create `electron-builder.yml`.**

```yaml
appId: live.yurii.erepublik-agent
productName: erepublik-agent
copyright: Copyright © 2026 Yurii Chekhotskyi
directories:
  output: release
  buildResources: electron/icons
files:
  - dist/**
  - electron-dist/**
  - data/**
  - package.json
  - node_modules/**
asarUnpack:
  - node_modules/cloakbrowser/**
  - node_modules/playwright-core/**
win:
  target: nsis
  icon: electron/icons/icon.ico
  artifactName: erepublik-agent-Setup-${version}-${arch}.${ext}
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

- [ ] **Step 3: Add the `main` entry to package.json.** Electron needs to know where to start:

```json
"main": "electron-dist/main.js"
```

(Place it alongside the existing `"private": true` field.)

- [ ] **Step 4: Build a local installer.** From macOS:

```bash
npm run dist:electron
```

Expected: `release/erepublik-agent-Setup-X.Y.Z-x64.exe` produced (X.Y.Z from package.json). The build also produces `latest.yml`.

If the build complains about missing native modules — confirm `asarUnpack` block includes them. If `electron-builder` fails on macOS due to wine-needed for NSIS, install wine via Homebrew (`brew install --cask wine-stable`) or just rely on CI for production builds; the local cross-build is best-effort dev convenience.

- [ ] **Step 5: Commit.**

```bash
git add electron-builder.yml electron/icons/icon.ico electron/icons/tray.png package.json
git commit -m "$(cat <<'EOF'
feat(electron): packaging config + production icons

electron-builder.yml: NSIS per-user installer, asarUnpack for
cloakbrowser + playwright-core (they spawn native subprocesses
that can't run from inside .asar), GitHub provider for publishing.
Adds package.json main entry pointing to electron-dist/main.js.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 21: GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release-electron.yml`

- [ ] **Step 1: Create `.github/workflows/release-electron.yml`.**

```yaml
name: Release Electron installer

on:
  push:
    tags:
      - 'v*.*.*'

permissions:
  contents: write

jobs:
  build:
    runs-on: windows-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node 22
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install
        run: npm ci

      - name: Build
        run: |
          npm run build
          npm run build:electron

      - name: Run tests
        run: npm test

      - name: Build installer
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npx electron-builder --win nsis --x64 --publish always
```

- [ ] **Step 2: Verify workflow syntax with `act` or by pushing a test branch and using the Actions tab dry-run.** Optional — actual release happens on tag push.

- [ ] **Step 3: Commit.**

```bash
git add .github/workflows/release-electron.yml
git commit -m "$(cat <<'EOF'
ci: add Electron release workflow on tag push

Triggers on v*.*.* tag pushes. Runs on windows-latest, installs deps,
builds compiled JS + electron dist, runs tests, then invokes
electron-builder with --publish always so the installer and
latest.yml land on the matching GitHub Release automatically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 22: Move .bat distribution to legacy/

**Files:**
- Move: `windows/` → `legacy/windows-bat/`
- Delete: `.github/workflows/release-windows.yml`

- [ ] **Step 1: Move the windows directory.**

```bash
mkdir -p legacy
git mv windows legacy/windows-bat
```

- [ ] **Step 2: Verify nothing in the repo references the old path.**

```bash
grep -rn "windows/" --include="*.md" --include="*.json" --include="*.yml" --include="*.ts" .
```

Expected: only references inside the moved `legacy/windows-bat/` itself. If anything outside (e.g., README.md), fix in Task 23.

- [ ] **Step 3: Delete old release workflow.**

```bash
git rm .github/workflows/release-windows.yml
```

(If the file does not exist — skip; the .bat spec may have only been partially implemented in the repo's `.github/`. Verify before running.)

- [ ] **Step 4: Add `legacy/windows-bat/DEPRECATED.md`** for clarity:

```markdown
# Deprecated — .bat ZIP distribution

This directory contains the original .bat-based Windows distribution
(setup.bat / bootstrap.bat / start.bat / etc.). It was the primary
distribution channel until 2026-05-18 when it was replaced by the
Electron native app (see `docs/superpowers/specs/2026-05-18-electron-native-app-design.md`).

These files are kept for ~6 months in case the Electron distribution
needs a fallback for regressions. After that, this directory can be
deleted.
```

- [ ] **Step 5: Commit.**

```bash
git add legacy/ .github/workflows/release-windows.yml
git commit -m "$(cat <<'EOF'
chore: deprecate .bat distribution to legacy/

Move windows/*.bat and windows/README.txt to legacy/windows-bat/
and remove the GitHub Actions workflow that built the .bat ZIP.
The Electron .exe installer (release-electron.yml) is now the sole
release artifact. Legacy files kept ~6 months in case of regression.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 23: Update README and CLAUDE.md

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update root `README.md`.** Replace the install instructions section with:

```markdown
## Install (Windows)

1. Download `erepublik-agent-Setup-X.Y.Z-x64.exe` from the latest GitHub Release or Telegram channel.
2. Double-click the installer; choose any folder when prompted. No admin rights required.
3. The setup wizard opens. Fill in your eRepublik email/password and tuning options, sign in through the headed browser window that appears, then click "Start bot".
4. The app lives in your system tray. Left-click for the dashboard; right-click for Pause / Quit / Settings.

### Migrating from the old .bat distribution

The wizard's step 1 has a banner: "Already running the old ZIP version? Import existing setup →". Click it, point to your old folder, and your sessions/, config/, and chromium-cache/ are copied — no re-login, no Chromium re-download.

### Developer workflow

```bash
git clone …
cd erepublik-agent
npm install
npm run bootstrap   # one-shot manual login
npm run agent       # one daily cycle
npm start           # long-running with dashboard
```

(Developer workflow is unchanged. The Electron build is the *user* distribution; developers keep using tsx.)
```

- [ ] **Step 2: Update `CLAUDE.md`.** Find the `## Commands` section and add:

```markdown
## Electron distribution build

npm run build:electron   # compile electron/ → electron-dist/
npm run start:electron   # local dev: build + run electron app
npm run dist:electron    # produce a Windows installer (release/ dir)
```

Find any reference to the `.bat` distribution and either delete it or replace with a pointer to the spec. Specifically, scan for `windows/*.bat`, `setup.bat`, `bootstrap.bat`, etc. in CLAUDE.md and update.

- [ ] **Step 3: Verify the docs build / render correctly.** Open both files in a markdown previewer (or just `cat` them) and check that links work.

- [ ] **Step 4: Commit.**

```bash
git add README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: update README + CLAUDE.md for Electron distribution

Replace .bat install instructions with Setup.exe + wizard flow.
Add migration note for users coming from the old ZIP. Add three
new npm scripts to CLAUDE.md Commands section.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Manual verification (post-implementation)

Once all 23 tasks land, run the full end-to-end suite manually on a fresh Windows 11 VM:

1. Fresh VM, no prior install. Download `Setup.exe` from the GitHub Release of the test tag.
2. Click through SmartScreen warning ("More info" → "Run anyway").
3. Walk through wizard: fill all fields, click Next.
4. Step 2: click "Open login window" → CloakBrowser opens → log in with real eRepublik credentials → wizard log shows progress → step 3 appears within a few seconds of the cookie being set.
5. Step 3: toggle autostart on, click "Start bot". Wizard closes, dashboard appears with 🟢 Running indicator.
6. Verify the runner completes at least one cycle (~10 min default).
7. Tray operations: Pause → wait → check that `%APPDATA%\erepublik-agent\config\settings.json` shows `"paused": true`; Resume → verify cycle resumes.
8. Quit via tray → app exits cleanly.
9. Reboot the VM. The app should auto-start (because autostart was enabled in step 5) and appear in tray; dashboard window stays hidden.
10. Trigger an update by publishing v0.0.X+1 patch release; verify the balloon appears within 30s of next launch, and "Restart to update" installs cleanly with state preserved.
11. Migration test: install the legacy `.bat` ZIP separately on a different folder, configure and run it once, then run the Electron installer. Wizard step 1 → click Import → pick the legacy folder → progress overlay → wizard jumps to step 3 (session was valid).

---

# Self-review checklist (for the implementing engineer)

After all tasks complete, before declaring done:

- [ ] All 23 task commits land on the branch.
- [ ] `npm test` passes (existing + new tests).
- [ ] `npm run typecheck` passes.
- [ ] `npm run build:electron` produces `electron-dist/` with `main.js`, `wizard/index.html`, `icons/`.
- [ ] `npm run start:electron` opens a tray icon + a window successfully on macOS dev.
- [ ] `npm run dist:electron` produces a working `.exe` (or CI build succeeds).
- [ ] Wizard works through all 3 steps end-to-end on a fresh `userData` directory.
- [ ] Manual verification §11 import test passes.
- [ ] README + CLAUDE.md updated.
- [ ] No references to `windows/*.bat` outside `legacy/`.
