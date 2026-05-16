import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { eRepublikWeek } from '../erepublik/week.js';
import { sessionsDir } from '../paths.js';

function filePath(): string {
  return join(sessionsDir(), 'weekly-fuel-state.json');
}

export const WeeklyFuelState = z.object({
  /** Tuesday-anchored eRepublik week number. Mismatch with current week → reset. */
  week: z.number().int(),
  /** Fuel barrels deployed this week. Weekly cap = 70. */
  spent: z.number().int().nonnegative().default(0),
  /** Successful deploys this week (max 2/battle). Best-effort medal proxy. */
  hitsLanded: z.number().int().nonnegative().default(0),
  /** ISO of last successful farm session. */
  lastFarmedAt: z.string().nullable().default(null),
  /** ISO of earliest time we're allowed to farm again. Rolled at session end. */
  nextEligibleAt: z.string().nullable().default(null),
  /** Cycles we skipped despite budget allowing it. Metrics only. */
  cyclesSkipped: z.number().int().nonnegative().default(0),
});

export type WeeklyFuelState = z.infer<typeof WeeklyFuelState>;

function emptyState(week: number): WeeklyFuelState {
  return {
    week,
    spent: 0,
    hitsLanded: 0,
    lastFarmedAt: null,
    nextEligibleAt: null,
    cyclesSkipped: 0,
  };
}

export function loadFuel(now: Date = new Date()): { state: WeeklyFuelState; rolledOver: boolean } {
  // sessionsDir() already mkdirs.
  const currentWeek = eRepublikWeek(now);
  const file = filePath();
  if (!existsSync(file)) {
    return { state: emptyState(currentWeek), rolledOver: false };
  }
  const parsed = WeeklyFuelState.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (parsed.week === currentWeek) {
    return { state: parsed, rolledOver: false };
  }
  // Week rolled over — archive prior week for retrospective analysis.
  const archive = join(sessionsDir(), `weekly-fuel-${parsed.week}.archive.json`);
  writeFileSync(archive, JSON.stringify(parsed, null, 2), 'utf8');
  return { state: emptyState(currentWeek), rolledOver: true };
}

export function saveFuel(state: WeeklyFuelState): void {
  // sessionsDir() already mkdirs.
  writeFileSync(filePath(), JSON.stringify(state, null, 2), 'utf8');
}
