import { z } from 'zod';

const ActionSource = z.enum(['agent', 'external']);

const ActionRecord = z.object({
  at: z.string(),
  source: ActionSource,
});

const BuyFoodRecord = ActionRecord.extend({
  offerId: z.number().int().optional(),
});

const BuyGoldRecord = ActionRecord.extend({
  offerId: z.number().int().optional(),
  amount: z.number().int().min(1).max(10).optional(),
});

export const DailyState = z.object({
  eRepublikDay: z.number().int(),
  completedActions: z.object({
    work: ActionRecord.optional(),
    train: ActionRecord.optional(),
    buyFood: BuyFoodRecord.optional(),
    vipClaim: ActionRecord.optional(),
    workOvertime: ActionRecord.optional(),
    buyGold: BuyGoldRecord.optional(),
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
  /**
   * Count of consecutive `workOvertime` POSTs that returned
   * `{status:false, message:"lock"}` this game day where a session-unlock
   * captcha was NOT found-and-solved. Reset to 0 when a captcha is solved.
   * Once it reaches `LOCK_RETRY_LIMIT` (see runOvertime.ts) the orchestrator
   * sets `overtimeCapReachedAt` (pause until rollover). Fresh on day rollover.
   * (The reset only matters below the limit; once the cap is set, the
   * `overtimeCapReachedAt` early-out fires first and OT stays paused until
   * day rollover regardless.)
   */
  overtimeLockRetries: z.number().int().default(0),
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
    overtimeLockRetries: 0,
  };
}

/** Safe-daily keys currently in scope (i.e. we have tools that perform them). */
export const ACTIVE_SAFE_DAILY_KEYS = ['work', 'train', 'vipClaim', 'buyFood', 'buyGold'] as const;
export type ActiveSafeDailyKey = (typeof ACTIVE_SAFE_DAILY_KEYS)[number];

export function pendingActions(s: DailyState): ActiveSafeDailyKey[] {
  return ACTIVE_SAFE_DAILY_KEYS.filter((k) => s.completedActions[k] == null);
}

/**
 * Returns true when every key in {@link ACTIVE_SAFE_DAILY_KEYS} has a completion
 * record. **Footgun:** some active keys are gated by settings (e.g. `buyGold`,
 * which is excluded when `settings.buyGold.enabled === false` or `amount === 0`).
 * For optional actions, callers must filter them out before relying on this
 * predicate — otherwise it will return `false` for a perfectly idle cycle just
 * because an opt-in action is disabled. The runner does this filtering at the
 * call site via `pending.length === 0` after applying the buyGold filter; see
 * `src/agent/runner.ts`. If you reach for this helper, replicate that filter.
 */
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
