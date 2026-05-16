import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { sessionsDir } from '../paths.js';

function filePath(): string {
  return join(sessionsDir(), 'weekly-state.json');
}

export const WeeklyState = z.object({
  lastClaimedRewardId: z.number().int().nullable().default(null),
});

export type WeeklyState = z.infer<typeof WeeklyState>;

export function loadWeekly(): WeeklyState {
  // sessionsDir() already mkdirs.
  const file = filePath();
  if (!existsSync(file)) return { lastClaimedRewardId: null };
  return WeeklyState.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function saveWeekly(state: WeeklyState): void {
  // sessionsDir() already mkdirs.
  writeFileSync(filePath(), JSON.stringify(state, null, 2), 'utf8');
}
