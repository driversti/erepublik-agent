import { describe, it, expect } from 'vitest';
import { snapshotHash, formatDigest } from './digests.js';
import type { DailyState } from '../memory/schema.js';
import type { WeeklyState } from '../memory/weeklyState.js';
import type { WeeklyFuelState } from '../memory/weeklyFuelState.js';

function makeState(overrides: Partial<DailyState> = {}): DailyState {
  return {
    eRepublikDay: 100,
    completedActions: {},
    claimedMissionIds: [],
    claimedChestThresholds: [],
    lastDigestHash: null,
    awaySince: null,
    notifiedNoJobToday: false,
    ...overrides,
  };
}

function makeWeekly(overrides: Partial<WeeklyState> = {}): WeeklyState {
  return {
    lastClaimedRewardId: null,
    ...overrides,
  };
}

function makeFuel(overrides: Partial<WeeklyFuelState> = {}): WeeklyFuelState {
  return {
    week: 20,
    spent: 0,
    hitsLanded: 0,
    lastFarmedAt: null,
    nextEligibleAt: null,
    cyclesSkipped: 0,
    weekStartInventory: null,
    ...overrides,
  };
}

describe('snapshotHash', () => {
  it('is stable across calls for the same inputs', () => {
    const a = snapshotHash(makeState(), makeWeekly(), makeFuel());
    const b = snapshotHash(makeState(), makeWeekly(), makeFuel());
    expect(a).toBe(b);
  });

  it('changes when daily state changes meaningfully', () => {
    const before = snapshotHash(makeState(), makeWeekly(), makeFuel());
    const after = snapshotHash(
      makeState({ claimedMissionIds: [1, 2] }),
      makeWeekly(),
      makeFuel(),
    );
    expect(after).not.toBe(before);
  });

  it('ignores `lastDigestHash` field (avoids self-referential drift)', () => {
    const a = snapshotHash(makeState({ lastDigestHash: 'aaaaaaaaaaaa' }), makeWeekly(), makeFuel());
    const b = snapshotHash(makeState({ lastDigestHash: 'zzzzzzzzzzzz' }), makeWeekly(), makeFuel());
    expect(a).toBe(b);
  });

  it('ignores `nextEligibleAt` + `cyclesSkipped` on fuel state', () => {
    const a = snapshotHash(makeState(), makeWeekly(), makeFuel());
    const b = snapshotHash(
      makeState(),
      makeWeekly(),
      makeFuel({ nextEligibleAt: '2026-05-20T12:00:00Z', cyclesSkipped: 99 }),
    );
    expect(a).toBe(b);
  });

  it('does change when fuel.spent shifts', () => {
    const a = snapshotHash(makeState(), makeWeekly(), makeFuel({ spent: 10 }));
    const b = snapshotHash(makeState(), makeWeekly(), makeFuel({ spent: 20 }));
    expect(a).not.toBe(b);
  });
});

describe('formatDigest', () => {
  it('includes the day label and all action flags', () => {
    const out = formatDigest(
      150,
      makeState({
        completedActions: {
          work: { at: '2026-05-19T10:00:00Z', source: 'agent' },
          train: { at: '2026-05-19T10:05:00Z', source: 'agent' },
        },
      }),
      makeWeekly(),
      makeFuel(),
      70,
    );
    expect(out).toContain('day 150');
    expect(out).toContain('Work ✅');
    expect(out).toContain('Train ✅');
    expect(out).toContain('VIP ⏳');
    expect(out).toContain('Food ⏳');
  });

  it('interpolates the supplied weekly budget into the fuel line', () => {
    const out = formatDigest(1, makeState(), makeWeekly(), makeFuel({ spent: 23 }), 140);
    expect(out).toContain('spent 23/140');
  });

  it('shows em-dash for empty claimed lists', () => {
    const out = formatDigest(1, makeState(), makeWeekly(), makeFuel(), 70);
    expect(out).toContain('Missions claimed: —');
    expect(out).toContain('Chests claimed: —');
  });
});
