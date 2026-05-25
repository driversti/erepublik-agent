import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { sessionsDir } from '../paths.js';
import { atomicWriteFileSync, quarantineCorruptedFile } from '../util/atomicWrite.js';

function filePath(): string {
  return join(sessionsDir(), 'weekly-state.json');
}

export const WeeklyState = z.object({
  lastClaimedRewardId: z.number().int().nullable().default(null),
});

export type WeeklyState = z.infer<typeof WeeklyState>;

function emptyState(): WeeklyState {
  return { lastClaimedRewardId: null };
}

export function loadWeekly(): WeeklyState {
  // sessionsDir() already mkdirs.
  const file = filePath();
  if (!existsSync(file)) return emptyState();
  try {
    return WeeklyState.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    const quarantined = quarantineCorruptedFile(file);
    console.warn(
      `[weeklyState] weekly-state.json was unreadable (${(err as Error).message}); ` +
        `quarantined to ${quarantined ?? '<rename failed>'} and starting from empty state`,
    );
    return emptyState();
  }
}

export function saveWeekly(state: WeeklyState): void {
  // sessionsDir() already mkdirs.
  atomicWriteFileSync(filePath(), JSON.stringify(state, null, 2));
}
