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
  }),
  claimedMissionIds: z.array(z.number().int()).default([]),
  claimedChestThresholds: z.array(z.number().int()).default([]),
  notifiedNoJobToday: z.boolean().default(false),
  lastDigestHash: z.string().nullable().default(null),
  // ISO timestamp of when we first observed the citizen outside their residence
  // region this day. Cleared when we observe a home location (manually or after
  // travelHome). Used by the return-home timer (mirrors ePlus startTimeAbroad).
  awaySince: z.string().nullable().default(null),
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
