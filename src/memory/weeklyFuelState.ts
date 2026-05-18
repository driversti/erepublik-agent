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
  /**
   * Inventory baseline locked on the first cycle of the eRepublik week.
   * Lets the runner reconcile `spent` against actual inventory drops so manual
   * out-of-band fuel usage (other browser, mobile, etc.) is detected.
   * Null on a freshly-rolled week until the first cycle stamps it.
   */
  weekStartInventory: z.number().int().nonnegative().nullable().default(null),
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
    weekStartInventory: null,
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

export interface ReconcileResult {
  /** New state (mutated copy) with weekStartInventory and spent reconciled. */
  state: WeeklyFuelState;
  /** Whether weekStartInventory was set this call (first cycle of the week). */
  baselineSet: boolean;
  /**
   * How many barrels were attributed to out-of-band usage (this call).
   * Positive when `weekStartInventory − currentInventory` exceeds prior `spent`.
   */
  externalBurnDetected: number;
}

/**
 * Reconcile `spent` against the live inventory reading.
 *
 * Why: `spent` is only bumped by farm sessions the agent runs. If the operator
 * burns fuel manually in another browser, inventory drops but `spent` doesn't,
 * letting the agent overshoot the 70-barrel weekly cap. This catches that:
 *
 * - First cycle of the week (weekStartInventory==null) → lock baseline = current.
 * - Subsequent cycles → `spent = max(spent, baseline - current)`.
 *   - Manual burn → inventory falls below baseline-spent → spent catches up.
 *   - Mid-week purchase → inventory rises → `baseline-current` shrinks/goes negative
 *     → `max()` preserves agent-tracked spent. We never roll back.
 */
export function reconcileSpentWithInventory(
  state: WeeklyFuelState,
  currentInventory: number,
): ReconcileResult {
  const next = { ...state };
  let baselineSet = false;
  if (next.weekStartInventory == null) {
    next.weekStartInventory = currentInventory;
    baselineSet = true;
  }
  const observedSpent = Math.max(0, next.weekStartInventory - currentInventory);
  const externalBurnDetected = Math.max(0, observedSpent - next.spent);
  if (observedSpent > next.spent) {
    next.spent = observedSpent;
  }
  return { state: next, baselineSet, externalBurnDetected };
}
