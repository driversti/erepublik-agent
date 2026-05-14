import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const SESSIONS_DIR = resolve('sessions');
const FILE = join(SESSIONS_DIR, 'weekly-state.json');

export const WeeklyState = z.object({
  lastClaimedRewardId: z.number().int().nullable().default(null),
});

export type WeeklyState = z.infer<typeof WeeklyState>;

export function loadWeekly(): WeeklyState {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  if (!existsSync(FILE)) return { lastClaimedRewardId: null };
  return WeeklyState.parse(JSON.parse(readFileSync(FILE, 'utf8')));
}

export function saveWeekly(state: WeeklyState): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
}
