// electron-updater is a CommonJS module; in ESM context we must use the
// default import + destructure pattern instead of named imports.
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { dialog, app, type BrowserWindow } from 'electron';

export interface UpdaterCallbacks {
  onUpdateAvailable: (version: string) => void;
  onUpdateNotAvailable: () => void;
  onError: (err: Error) => void;
}

export function configureUpdater(cb: UpdaterCallbacks): void {
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
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(cb.onError);
  }, 30_000);
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
