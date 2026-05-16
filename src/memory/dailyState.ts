import { readFileSync, renameSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sessionsDir } from '../paths.js';
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
    const parsed = DailyState.parse(JSON.parse(readFileSync(target, 'utf8')));
    return { state: parsed, rolledOver: false };
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
  writeFileSync(target, JSON.stringify(fresh, null, 2), 'utf8');
  return { state: fresh, rolledOver };
}

export function save(state: DailyState): void {
  ensureDir();
  writeFileSync(filePath(state.eRepublikDay), JSON.stringify(state, null, 2), 'utf8');
}
