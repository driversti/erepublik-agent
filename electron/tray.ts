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
