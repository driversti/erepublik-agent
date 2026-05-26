// electron-updater is a CommonJS module; in ESM context we must use the
// default import + destructure pattern instead of named imports.
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { dialog, app, type BrowserWindow } from 'electron';

export interface UpdaterCallbacks {
  onUpdateAvailable: (version: string) => void;
  onUpdateNotAvailable: () => void;
  onUpdateDownloaded: (version: string) => void;
  onError: (err: Error) => void;
}

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
  autoUpdater.on('update-downloaded', (info) => {
    cb.onUpdateDownloaded(info.version);
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

export interface ManualCheckResult {
  status: 'available' | 'none' | 'error';
  detail?: string;
}

export async function manualCheck(): Promise<ManualCheckResult> {
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

export function showManualResultDialog(parentWindow: BrowserWindow | undefined, result: ManualCheckResult): void {
  const opts =
    result.status === 'available'
      ? {
          type: 'info' as const,
          message: `Update available: v${result.detail}`,
          detail: 'Quit the app to install. The current install will continue running until you quit.',
          buttons: ['OK'],
        }
      : result.status === 'none'
        ? {
            type: 'info' as const,
            message: `You are on the latest version (v${app.getVersion()}).`,
            buttons: ['OK'],
          }
        : {
            type: 'error' as const,
            message: 'Update check failed',
            detail: result.detail ?? 'Unknown error',
            buttons: ['OK'],
          };

  if (parentWindow) {
    dialog.showMessageBox(parentWindow, opts);
  } else {
    dialog.showMessageBox(opts);
  }
}
