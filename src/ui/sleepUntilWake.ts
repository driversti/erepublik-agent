import { watch as fsWatch, type FSWatcher } from 'node:fs';

export type WakeReason = 'timeout' | 'file-changed';

/**
 * Sleep for `ms` milliseconds OR until the file at `path` changes — whichever
 * fires first. Returns the reason. If `path` doesn't exist or fs.watch is
 * unavailable, this degrades to a plain timeout.
 */
export function sleepUntilWake(ms: number, path: string): Promise<WakeReason> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    let watcher: FSWatcher | null = null;
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
      }
    };

    const settle = (reason: WakeReason) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(reason);
    };

    timer = setTimeout(() => settle('timeout'), ms);

    try {
      watcher = fsWatch(path, () => settle('file-changed'));
      // If the file is removed/renamed, fs.watch emits an error on some
      // platforms — degrade silently to timeout-only.
      watcher.on('error', () => {
        if (watcher) {
          try {
            watcher.close();
          } catch {
            /* ignore */
          }
        }
        watcher = null;
      });
    } catch {
      // fs.watch throws synchronously on missing path on some platforms.
      // Degrade to timeout-only.
    }
  });
}
