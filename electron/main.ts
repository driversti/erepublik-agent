import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRunnerSupervisor } from './runnerSupervisor.js';
import { createTray, openLogsFolder } from './tray.js';
import { checkFirstRun } from './firstRun.js';
import { configureUpdater, manualCheck, showManualResultDialog } from './updater.js';
import { detectLegacyInstall, copyLegacyData, runImportedHealthcheck } from './importLegacy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let dashboardWindow: BrowserWindow | undefined;
let wizardWindow: BrowserWindow | undefined;
let tray: ReturnType<typeof createTray> | undefined;
let isQuitting = false;
let isPaused = false;
const supervisor = createRunnerSupervisor();

function createWizardWindow() {
  wizardWindow = new BrowserWindow({
    width: 760,
    height: 700,
    title: 'erepublik-agent setup',
    icon: path.join(__dirname, 'icons', 'icon.ico'),
    resizable: false,
    maximizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.resolve(__dirname, 'preload.cjs'),
    },
  });
  wizardWindow.loadFile(path.resolve(__dirname, 'wizard', 'index.html'));
  // During beta, auto-open DevTools so testers can see console errors and
  // share screenshots. Removed before v1.0.
  if (app.getVersion().includes('beta') || process.env.ERP_DEBUG === '1') {
    wizardWindow.webContents.openDevTools({ mode: 'detach' });
  }
  wizardWindow.on('closed', () => {
    wizardWindow = undefined;
  });
}

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
    icon: path.join(__dirname, 'icons', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.resolve(__dirname, 'preload.cjs'),
    },
  });
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
  dashboardWindow.on('closed', () => {
    dashboardWindow = undefined;
  });
}

async function loadDashboardWithRetry(win: BrowserWindow, port: number, attempt = 0): Promise<void> {
  const url = `http://127.0.0.1:${port}/`;
  try {
    await win.loadURL(url);
  } catch (_err) {
    if (attempt >= 60) {
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
      isPaused = !isPaused;
      supervisor.togglePause(isPaused);
      tray?.setState({ paused: isPaused });
    },
    onOpenLogs: openLogsFolder,
    onReconfigure: () => {
      if (!wizardWindow) createWizardWindow();
      else wizardWindow.focus();
    },
    onCheckForUpdates: async () => {
      const result = await manualCheck();
      showManualResultDialog(dashboardWindow, result);
    },
    onToggleAutostart: () => {
      const cur = app.getLoginItemSettings().openAtLogin;
      app.setLoginItemSettings({ openAtLogin: !cur });
      tray?.setState({ autostart: !cur });
    },
    onQuit: async () => {
      isQuitting = true;
      updaterHandle.dispose();
      await supervisor.stop();
      tray?.destroy();
      app.quit();
    },
  });
  tray.setState({
    autostart: app.getLoginItemSettings().openAtLogin,
  });

  const updaterHandle = configureUpdater({
    onUpdateAvailable: (v) => {
      tray?.showBalloon('erepublik-agent', `Update available: v${v}. Quit to install.`);
    },
    onUpdateNotAvailable: () => {},
    onError: (err) => {
      console.warn('[updater]', err.message);
    },
  });

  supervisor.onReady((port) => {
    createDashboardWindow(port);
  });
  supervisor.onState((state) => {
    tray?.setState({ status: state.status });
  });
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

  ipcMain.handle('wizard:saveConfig', async (_, raw: any) => {
    const userData = app.getPath('userData');
    await fs.mkdir(path.join(userData, 'config'), { recursive: true });
    // Resolve blockedCountries names to numeric IDs for the runner.
    let blockedCountryIds = '';
    if (raw.blockedCountries && raw.blockedCountries.trim().length > 0) {
      try {
        const catalogPath = path.resolve(__dirname, '..', 'data', 'countries.json');
        const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as Array<{ id: number; name: string }>;
        const tokens = raw.blockedCountries.split(',').map((s: string) => s.trim()).filter(Boolean);
        const ids: number[] = [];
        for (const t of tokens) {
          const asNum = Number.parseInt(t, 10);
          if (!Number.isNaN(asNum) && String(asNum) === t) {
            ids.push(asNum);
            continue;
          }
          const c = catalog.find((x) => x.name.toLowerCase() === t.toLowerCase());
          if (c) ids.push(c.id);
          // Silently skip unknown — wizard's validator already warns the user.
        }
        blockedCountryIds = ids.join(',');
      } catch (err) {
        console.warn('[wizard:saveConfig] failed to resolve blockedCountries:', err);
      }
    }
    const envLines = [
      `ERP_LOGIN=${raw.email}`,
      `ERP_PASSWORD=${raw.password}`,
      `ERP_ACCOUNT_SLUG=${raw.slug}`,
      `ERP_MAX_FOOD_PRICE=${raw.maxFoodPrice}`,
      `ERP_FARM_MAX_TRAVEL_CC=${raw.maxTravel}`,
      `ERP_FARM_MIN_FUEL=${raw.minFuel}`,
      `ERP_FARM_BLOCKED_COUNTRIES=${blockedCountryIds}`,
      `ERP_RETURN_HOME_AFTER_MINUTES=${raw.returnAfter}`,
      `ERP_RETURN_HOME_MAX_CC=${raw.returnMax}`,
      `TELEGRAM_BOT_TOKEN=${raw.tgToken}`,
      `TELEGRAM_CHAT_ID=${raw.tgChat}`,
      `ERP_CAPTCHA_PROVIDER=${raw.captchaProvider}`,
      `ERP_CAPTCHA_API_KEY=${raw.captchaKey}`,
      `HEADED=false`,
    ];
    await fs.writeFile(path.join(userData, 'config', '.env'), envLines.join('\n'));
    return { ok: true };
  });

  ipcMain.handle('wizard:startBootstrap', async (event) => {
    const userData = app.getPath('userData');
    const bootstrapPath = path.resolve(__dirname, '../dist/bootstrap.js');
    // Immediate feedback so the user sees something before any subprocess output:
    event.sender.send('wizard:bootstrapOutput', {
      stream: 'stdout',
      text: `[wizard] launching login process… (script=${bootstrapPath})`,
    });
    // First-run downloads ~200 MB CloakBrowser Chromium; warn the user up front.
    event.sender.send('wizard:bootstrapOutput', {
      stream: 'stdout',
      text: '[wizard] first run downloads ~200 MB CloakBrowser Chromium — this can take 3-5 minutes',
    });
    return new Promise<{ ok: boolean; code?: number; reason?: string }>((resolve) => {
      // ELECTRON_RUN_AS_NODE=1 makes process.execPath (the .exe) behave as plain
      // Node when launched as a child — otherwise it would try to start another
      // copy of the Electron app instead of running our script.
      const child = spawn(process.execPath, [bootstrapPath], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ERP_ROOT: userData,
          HEADED: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.on('error', (err) => {
        event.sender.send('wizard:bootstrapOutput', { stream: 'stderr', text: `[wizard] spawn error: ${err.message}` });
      });
      child.stdout?.on('data', (buf: Buffer) => {
        event.sender.send('wizard:bootstrapOutput', { stream: 'stdout', text: buf.toString() });
      });
      child.stderr?.on('data', (buf: Buffer) => {
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
    tray?.setState({ autostart: opts.autostart });
    if (wizardWindow) {
      wizardWindow.close();
      wizardWindow = undefined;
    }
    supervisor.start();
    return { ok: true };
  });

  ipcMain.handle('wizard:pickLegacyFolder', async () => {
    // Use a top-level dialog (no parent) so it can't get hidden behind the
    // wizard window on Windows. On macOS this opens a sheet-less modal.
    try {
      const result = await dialog.showOpenDialog({
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
    } catch (err) {
      console.error('[main] pickLegacyFolder failed', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('wizard:importLegacy', async (event, folder: string) => {
    const detected = detectLegacyInstall(folder);
    if (!detected) return { ok: false, error: 'Selected folder is no longer a valid .bat install.' };
    const userData = app.getPath('userData');
    await copyLegacyData(detected, userData, (p) => {
      event.sender.send('wizard:importProgress', p);
    });
    const healthcheckPath = path.resolve(__dirname, '../dist/healthcheck.js');
    const ok = await runImportedHealthcheck(userData, healthcheckPath, process.execPath);
    return { ok: true, sessionValid: ok };
  });

  const firstRun = checkFirstRun(app.getPath('userData'));
  if (firstRun.needsWizard) {
    console.log(`[main] first-run check: ${firstRun.reason} — opening wizard`);
    createWizardWindow();
    // Supervisor stays idle until wizard:finish triggers supervisor.start().
  } else {
    console.log(`[main] first-run check: ok — starting supervisor`);
    supervisor.start();
  }
});

app.on('window-all-closed', () => {
  // Don't quit when last window closes — tray keeps the app alive.
  // (No event.preventDefault needed — the app default behavior here is
  // to keep running because we have a tray icon.)
});
