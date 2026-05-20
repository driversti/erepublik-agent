import type { BrowserContext } from 'playwright-core';
import type { DailyState } from '../memory/schema.js';
import type { WeeklyState } from '../memory/weeklyState.js';
import {
  collectMissionRewards,
  type CollectResult as CollectMissionsResult,
} from '../tools/claim.js';
import {
  collectObjectiveRewards,
  type CollectObjectivesResult,
} from '../tools/objectives.js';
import {
  collectWeeklyChallenge,
  type CollectWeeklyResult,
} from '../tools/weekly.js';

/**
 * Bundle the three idempotent reward sweeps (missions / objectives / weekly
 * challenge) so the cycle file isn't repeating the same try/log/state-merge
 * boilerplate three times.
 *
 * Each sweep:
 *   1. Calls the per-domain `collect…` tool.
 *   2. Merges newly-claimed IDs into the supplied state (via the pure
 *      `apply…SweepResult` helpers, which are testable in isolation).
 *   3. Reports a per-sweep summary via the supplied `onLog` / `onError`
 *      callbacks so the runner can fan out to console + electron bridge.
 *
 * Errors thrown by individual sweeps are caught and routed through `onError`
 * — one bad sweep should not abort the others.
 */

export interface SweeperLogger {
  log: (message: string) => void;
  error: (message: string) => void;
}

// ── Pure state-merge helpers (covered by unit tests) ────────────────────────

export function applyMissionSweepResult(state: DailyState, result: CollectMissionsResult): void {
  for (const id of result.claimed) {
    if (!state.claimedMissionIds.includes(id)) state.claimedMissionIds.push(id);
  }
}

export function applyObjectiveSweepResult(state: DailyState, result: CollectObjectivesResult): void {
  for (const cost of result.claimed) {
    if (!state.claimedChestThresholds.includes(cost)) state.claimedChestThresholds.push(cost);
  }
}

export function applyWeeklySweepResult(weekly: WeeklyState, result: CollectWeeklyResult): void {
  if (result.claimed && result.maxRewardId != null) {
    weekly.lastClaimedRewardId = result.maxRewardId;
  }
}

// ── IO sweeps (composed in the runner; one call per cycle) ──────────────────

export async function sweepMissions(
  ctx: BrowserContext,
  csrf: string,
  state: DailyState,
  logger: SweeperLogger,
): Promise<void> {
  try {
    const r = await collectMissionRewards(ctx, csrf, state.claimedMissionIds);
    applyMissionSweepResult(state, r);
    if (r.claimed.length || r.failed.length) {
      logger.log(
        `[cycle] missions sweep: claimed=[${r.claimed.join(', ')}] failed=${r.failed.length}`,
      );
    }
  } catch (err) {
    logger.error(`[cycle] collectMissionRewards threw: ${(err as Error).message}`);
  }
}

export async function sweepObjectives(
  ctx: BrowserContext,
  csrf: string,
  state: DailyState,
  logger: SweeperLogger,
): Promise<void> {
  try {
    const r = await collectObjectiveRewards(ctx, csrf, state.claimedChestThresholds);
    applyObjectiveSweepResult(state, r);
    if (r.claimed.length || r.failed.length) {
      logger.log(
        `[cycle] objectives sweep: claimed=[${r.claimed.join(', ')}] failed=${r.failed.length}`,
      );
    }
  } catch (err) {
    logger.error(`[cycle] collectObjectiveRewards threw: ${(err as Error).message}`);
  }
}

export async function sweepWeekly(
  ctx: BrowserContext,
  csrf: string,
  weekly: WeeklyState,
  logger: SweeperLogger,
): Promise<void> {
  try {
    const r = await collectWeeklyChallenge(ctx, csrf, weekly.lastClaimedRewardId);
    applyWeeklySweepResult(weekly, r);
    if (r.claimed && r.maxRewardId != null) {
      logger.log(`[cycle] weekly sweep: claimed up to ${r.maxRewardId}`);
    } else if (r.reason) {
      logger.log(`[cycle] weekly sweep: noop (${r.reason})`);
    }
  } catch (err) {
    logger.error(`[cycle] collectWeeklyChallenge threw: ${(err as Error).message}`);
  }
}

/**
 * Run all three sweeps in sequence. Order matches the original runner.ts
 * behaviour (missions → objectives → weekly). Failures are isolated per sweep.
 */
export async function runRewardSweeps(
  ctx: BrowserContext,
  csrf: string,
  state: DailyState,
  weekly: WeeklyState,
  logger: SweeperLogger,
): Promise<void> {
  await sweepMissions(ctx, csrf, state, logger);
  await sweepObjectives(ctx, csrf, state, logger);
  await sweepWeekly(ctx, csrf, weekly, logger);
}
