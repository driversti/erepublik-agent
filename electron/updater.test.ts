import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { checkForUpdates, onSpy } = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  onSpy: vi.fn(),
}));

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      checkForUpdates,
      on: onSpy,
    },
  },
}));

vi.mock('electron', () => ({
  dialog: { showMessageBox: vi.fn() },
  app: { getVersion: () => '0.2.0' },
}));

import { configureUpdater } from './updater.js';

describe('configureUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    checkForUpdates.mockReset();
    checkForUpdates.mockResolvedValue(undefined);
    onSpy.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the startup check ~30s after configure', async () => {
    configureUpdater({
      onUpdateAvailable: vi.fn(),
      onUpdateNotAvailable: vi.fn(),
      onUpdateDownloaded: vi.fn(),
      onError: vi.fn(),
    });

    expect(checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('fires a recurring check every 24h after the startup check', async () => {
    configureUpdater({
      onUpdateAvailable: vi.fn(),
      onUpdateNotAvailable: vi.fn(),
      onUpdateDownloaded: vi.fn(),
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(checkForUpdates).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it('routes check failures to onError without throwing', async () => {
    const onError = vi.fn();
    checkForUpdates.mockRejectedValue(new Error('network down'));

    configureUpdater({
      onUpdateAvailable: vi.fn(),
      onUpdateNotAvailable: vi.fn(),
      onUpdateDownloaded: vi.fn(),
      onError,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('dispose() cancels both the startup timer and the daily interval', async () => {
    const handle = configureUpdater({
      onUpdateAvailable: vi.fn(),
      onUpdateNotAvailable: vi.fn(),
      onUpdateDownloaded: vi.fn(),
      onError: vi.fn(),
    });

    handle.dispose();
    await vi.advanceTimersByTimeAsync(30_000 + 48 * 60 * 60 * 1000);
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

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
});
