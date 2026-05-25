import { readFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sessionsDir } from '../paths.js';
import { atomicWriteFileSync, quarantineCorruptedFile } from '../util/atomicWrite.js';
import { DailyState, emptyState } from './schema.js';

function ensureDir(): void {
  // sessionsDir() already mkdirs.
  sessionsDir();
}

function filePath(day: number): string {
  return join(sessionsDir(), `daily-state-${day}.json`);
}

function archivePath(day: number): string {
  return join(sessionsDir(), `daily-state-${day}.archive.json`);
}

export interface LoadResult {
  state: DailyState;
  rolledOver: boolean;
}

export function loadOrInit(currentDay: number): LoadResult {
  ensureDir();
  const target = filePath(currentDay);

  if (existsSync(target)) {
    try {
      const parsed = DailyState.parse(JSON.parse(readFileSync(target, 'utf8')));
      return { state: parsed, rolledOver: false };
    } catch (err) {
      // File exists but is unreadable as DailyState — most commonly an empty
      // or NUL-filled file left over from a hard reboot mid-write. Move it
      // aside so the runner can boot from a fresh state instead of looping on
      // the same parse error every cycle.
      const quarantined = quarantineCorruptedFile(target);
      console.warn(
        `[dailyState] daily-state-${currentDay}.json was unreadable (${(err as Error).message}); ` +
          `quarantined to ${quarantined ?? '<rename failed>'} and starting from empty state`,
      );
      const fresh = emptyState(currentDay);
      atomicWriteFileSync(target, JSON.stringify(fresh, null, 2));
      return { state: fresh, rolledOver: false };
    }
  }

  // Archive any stale daily-state-*.json files (different day)
  let rolledOver = false;
  for (const entry of readdirSync(sessionsDir())) {
    const m = entry.match(/^daily-state-(\d+)\.json$/);
    if (m && Number(m[1]) !== currentDay) {
      const prev = Number(m[1]);
      renameSync(join(sessionsDir(), entry), archivePath(prev));
      rolledOver = true;
    }
  }

  const fresh = emptyState(currentDay);
  atomicWriteFileSync(target, JSON.stringify(fresh, null, 2));
  return { state: fresh, rolledOver };
}

export function save(state: DailyState): void {
  ensureDir();
  atomicWriteFileSync(filePath(state.eRepublikDay), JSON.stringify(state, null, 2));
}
