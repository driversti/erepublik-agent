import { app, BrowserWindow, dialog } from 'electron';
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
let isPaused = false;
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
      tray?.showBalloon('erepublik-agent', 'Reconfigure not yet wired in this build.');
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
  tray.setState({
    autostart: app.getLoginItemSettings().openAtLogin,
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

  supervisor.start();
});

app.on('window-all-closed', () => {
  // Don't quit when last window closes — tray keeps the app alive.
  // (No event.preventDefault needed — the app default behavior here is
  // to keep running because we have a tray icon.)
});
