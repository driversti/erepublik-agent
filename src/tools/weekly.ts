import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';

interface WeeklyReward {
  id: number;
  status: string;
}

interface WeeklyChallengeData {
  error?: boolean;
  rewards?: { normal?: WeeklyReward[] };
}

export interface WeeklyStatus {
  maxCompleted: number | null;
  completedIds: number[];
}

export async function getWeeklyChallenge(ctx: BrowserContext, csrf: string): Promise<WeeklyStatus> {
  const { body } = await apiCall<WeeklyChallengeData>(ctx, {
    method: 'GET',
    path: '/en/main/weekly-challenge-data',
    csrf,
  });
  const completed = (body.rewards?.normal ?? []).filter((r) => r.status === 'completed');
  const completedIds = completed.map((r) => r.id);
  const maxCompleted = completedIds.length > 0 ? Math.max(...completedIds) : null;
  return { maxCompleted, completedIds };
}

export interface CollectWeeklyResult {
  claimed: boolean;
  maxRewardId: number | null;
  status?: number;
  body?: unknown;
  reason?: string;
}

export async function collectWeeklyChallenge(
  ctx: BrowserContext,
  csrf: string,
  lastClaimedRewardId: number | null,
): Promise<CollectWeeklyResult> {
  const status = await getWeeklyChallenge(ctx, csrf);

  if (status.maxCompleted == null) {
    return { claimed: false, maxRewardId: null, reason: 'no_completed_tiers' };
  }

  // Detect week reset: completed list smaller than what we previously claimed.
  // Caller is responsible for resetting memory if this returns indicates lower.
  const last = lastClaimedRewardId ?? 0;
  if (status.maxCompleted <= last) {
    return { claimed: false, maxRewardId: status.maxCompleted, reason: 'already_claimed' };
  }

  const { status: httpStatus, body } = await apiCall(ctx, {
    method: 'POST',
    path: '/en/main/weekly-challenge-collect-all',
    csrf,
    form: { maxRewardId: status.maxCompleted },
  });

  return {
    claimed: httpStatus === 200,
    maxRewardId: status.maxCompleted,
    status: httpStatus,
    body,
  };
}
