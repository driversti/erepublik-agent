import { z } from 'zod';

const ActionSource = z.enum(['agent', 'external']);

const ActionRecord = z.object({
  at: z.string(),
  source: ActionSource,
});

const BuyFoodRecord = ActionRecord.extend({
  offerId: z.number().int().optional(),
});

export const DailyState = z.object({
  eRepublikDay: z.number().int(),
  completedActions: z.object({
    work: ActionRecord.optional(),
    train: ActionRecord.optional(),
    buyFood: BuyFoodRecord.optional(),
    vipClaim: ActionRecord.optional(),
    workOvertime: ActionRecord.optional(),
  }),
  claimedMissionIds: z.array(z.number().int()).default([]),
  claimedChestThresholds: z.array(z.number().int()).default([]),
  notifiedNoJobToday: z.boolean().default(false),
  lastDigestHash: z.string().nullable().default(null),
  // ISO timestamp of when we first observed the citizen outside their residence
  // region this day. Cleared when we observe a home location (manually or after
  // travelHome). Used by the return-home timer (mirrors ePlus startTimeAbroad).
  awaySince: z.string().nullable().default(null),
  /**
   * ISO timestamp set when a `workOvertime` POST returned `status: false`
   * despite the local gate (points/energy/cooldown) being clean. Interpreted
   * as the employer per-day cap being reached — pauses further OT attempts
   * until day rollover (when the file is archived and a fresh DailyState is
   * created).
   */
  overtimeCapReachedAt: z.string().nullable().default(null),
});

export type DailyState = z.infer<typeof DailyState>;

export function emptyState(day: number): DailyState {
  return {
    eRepublikDay: day,
    completedActions: {},
    claimedMissionIds: [],
    claimedChestThresholds: [],
    notifiedNoJobToday: false,
    lastDigestHash: null,
    awaySince: null,
    overtimeCapReachedAt: null,
  };
}

/** Safe-daily keys currently in scope (i.e. we have tools that perform them). */
export const ACTIVE_SAFE_DAILY_KEYS = ['work', 'train', 'vipClaim', 'buyFood'] as const;
export type ActiveSafeDailyKey = (typeof ACTIVE_SAFE_DAILY_KEYS)[number];

export function pendingActions(s: DailyState): ActiveSafeDailyKey[] {
  return ACTIVE_SAFE_DAILY_KEYS.filter((k) => s.completedActions[k] == null);
}

export function allSafeDailyDone(s: DailyState): boolean {
  return pendingActions(s).length === 0;
}

/**
 * Whether OT should still be considered for this cycle. Used by the runner's
 * shortCircuit predicate so that an idle-otherwise cycle still attempts OT.
 *
 * `ACTIVE_SAFE_DAILY_KEYS` intentionally does NOT include `workOvertime`
 * because OT's retry semantics in `when-available` mode don't fit the
 * "set flag → never retry" model. The orchestrator (`agent/runOvertime.ts`)
 * is responsible for the actual call; this helper just gates the optimisation.
 */
export function overtimeStillPending(
  s: DailyState,
  settings: { enabled: boolean; mode: 'once-per-day' | 'when-available' },
): boolean {
  if (!settings.enabled) return false;
  if (s.overtimeCapReachedAt != null) return false;
  if (settings.mode === 'when-available') return true;
  return s.completedActions.workOvertime == null;
}
