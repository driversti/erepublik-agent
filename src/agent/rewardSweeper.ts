import type { BrowserContext } from 'playwright-core';
import type { DailyState } from '../memory/schema.js';
import type { WeeklyState } from '../memory/weeklyState.js';
import {
  collectMissionRewards,
  type ClaimedMission,
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
 *   3. Returns a typed report describing *what was claimed this call* so the
 *      runner can fan out per-claim events into the cycle digest. The list is
 *      narrower than the cumulative state — exactly the new claims, with the
 *      title/threshold/tier metadata needed for Telegram.
 *   4. Reports a per-sweep summary via the supplied `onLog` / `onError`
 *      callbacks so the runner can fan out to console + electron bridge.
 *
 * Errors thrown by individual sweeps are caught and routed through `onError`
 * — one bad sweep should not abort the others.
 */

export interface SweeperLogger {
  log: (message: string) => void;
  error: (message: string) => void;
}

/** Per-cycle "what did the missions sweep just claim?" — drives the digest. */
export interface MissionSweepReport {
  claimed: ClaimedMission[];
}
/** Per-cycle "what did the chest sweep just claim?" — `threshold` values. */
export interface ObjectiveSweepReport {
  claimed: number[];
}
/** Per-cycle "did the weekly sweep tick a new tier?" — null = nothing claimed. */
export interface WeeklySweepReport {
  claimedTier: number | null;
}

export interface RewardSweepsReport {
  missions: MissionSweepReport;
  objectives: ObjectiveSweepReport;
  weekly: WeeklySweepReport;
}

// ── Pure state-merge helpers (covered by unit tests) ────────────────────────

export function applyMissionSweepResult(state: DailyState, result: CollectMissionsResult): void {
  for (const m of result.claimed) {
    if (!state.claimedMissionIds.includes(m.id)) state.claimedMissionIds.push(m.id);
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
): Promise<MissionSweepReport> {
  try {
    const r = await collectMissionRewards(ctx, csrf, state.claimedMissionIds);
    applyMissionSweepResult(state, r);
    if (r.claimed.length || r.failed.length) {
      const ids = r.claimed.map((c) => c.id).join(', ');
      logger.log(
        `[cycle] missions sweep: claimed=[${ids}] failed=${r.failed.length}`,
      );
    }
    return { claimed: r.claimed };
  } catch (err) {
    logger.error(`[cycle] collectMissionRewards threw: ${(err as Error).message}`);
    return { claimed: [] };
  }
}

export async function sweepObjectives(
  ctx: BrowserContext,
  csrf: string,
  state: DailyState,
  logger: SweeperLogger,
): Promise<ObjectiveSweepReport> {
  try {
    const r = await collectObjectiveRewards(ctx, csrf, state.claimedChestThresholds);
    applyObjectiveSweepResult(state, r);
    if (r.claimed.length || r.failed.length) {
      logger.log(
        `[cycle] objectives sweep: claimed=[${r.claimed.join(', ')}] failed=${r.failed.length}`,
      );
    }
    return { claimed: r.claimed };
  } catch (err) {
    logger.error(`[cycle] collectObjectiveRewards threw: ${(err as Error).message}`);
    return { claimed: [] };
  }
}

export async function sweepWeekly(
  ctx: BrowserContext,
  csrf: string,
  weekly: WeeklyState,
  logger: SweeperLogger,
): Promise<WeeklySweepReport> {
  try {
    // Remember the highest tier we'd already claimed BEFORE the sweep so we
    // can tell whether this call actually crossed any new ground — the merge
    // helper overwrites `weekly.lastClaimedRewardId` without preserving the
    // delta.
    const beforeTier = weekly.lastClaimedRewardId;
    const r = await collectWeeklyChallenge(ctx, csrf, weekly.lastClaimedRewardId);
    applyWeeklySweepResult(weekly, r);
    if (r.claimed && r.maxRewardId != null) {
      logger.log(`[cycle] weekly sweep: claimed up to ${r.maxRewardId}`);
      return {
        claimedTier:
          r.maxRewardId !== beforeTier ? r.maxRewardId : null,
      };
    }
    if (r.reason) {
      logger.log(`[cycle] weekly sweep: noop (${r.reason})`);
    }
    return { claimedTier: null };
  } catch (err) {
    logger.error(`[cycle] collectWeeklyChallenge threw: ${(err as Error).message}`);
    return { claimedTier: null };
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
): Promise<RewardSweepsReport> {
  const missions = await sweepMissions(ctx, csrf, state, logger);
  const objectives = await sweepObjectives(ctx, csrf, state, logger);
  const weeklyR = await sweepWeekly(ctx, csrf, weekly, logger);
  return { missions, objectives, weekly: weeklyR };
}
