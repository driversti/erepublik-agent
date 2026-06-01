import { describe, it, expect } from 'vitest';
import {
  applyMissionSweepResult,
  applyObjectiveSweepResult,
  applyWeeklySweepResult,
} from './rewardSweeper.js';
import type { DailyState } from '../memory/schema.js';
import type { WeeklyState } from '../memory/weeklyState.js';

function emptyDaily(): DailyState {
  return {
    eRepublikDay: 1,
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

describe('applyMissionSweepResult', () => {
  it('appends new claimed mission IDs without duplicates', () => {
    const state = emptyDaily();
    state.claimedMissionIds = [1, 2];
    applyMissionSweepResult(state, {
      claimed: [
        { id: 2, title: 'dup' },
        { id: 3, title: 'three' },
        { id: 4, title: 'four' },
      ],
      skipped: [],
      failed: [],
    });
    expect(state.claimedMissionIds).toEqual([1, 2, 3, 4]);
  });

  it('is a no-op when nothing is claimed', () => {
    const state = emptyDaily();
    state.claimedMissionIds = [1];
    applyMissionSweepResult(state, { claimed: [], skipped: [], failed: [] });
    expect(state.claimedMissionIds).toEqual([1]);
  });
});

describe('applyObjectiveSweepResult', () => {
  it('appends new claimed cost thresholds without duplicates', () => {
    const state = emptyDaily();
    state.claimedChestThresholds = [50];
    applyObjectiveSweepResult(state, { claimed: [50, 100, 150], failed: [] });
    expect(state.claimedChestThresholds).toEqual([50, 100, 150]);
  });
});

describe('applyWeeklySweepResult', () => {
  it('advances lastClaimedRewardId when the sweep claimed something', () => {
    const weekly: WeeklyState = { lastClaimedRewardId: 3 };
    applyWeeklySweepResult(weekly, { claimed: true, maxRewardId: 7 });
    expect(weekly.lastClaimedRewardId).toBe(7);
  });

  it('leaves lastClaimedRewardId unchanged when nothing claimed', () => {
    const weekly: WeeklyState = { lastClaimedRewardId: 3 };
    applyWeeklySweepResult(weekly, { claimed: false, maxRewardId: null, reason: 'nothing to claim' });
    expect(weekly.lastClaimedRewardId).toBe(3);
  });

  it('leaves lastClaimedRewardId unchanged when claimed=true but maxRewardId is null (defensive)', () => {
    const weekly: WeeklyState = { lastClaimedRewardId: 3 };
    applyWeeklySweepResult(weekly, { claimed: true, maxRewardId: null });
    expect(weekly.lastClaimedRewardId).toBe(3);
  });
});
