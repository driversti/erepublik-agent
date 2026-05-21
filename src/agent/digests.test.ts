import { describe, it, expect } from 'vitest';
import { digestHash, formatDigest } from './digests.js';
import { emptyState } from '../memory/schema.js';
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
    overtimeCapReachedAt: null,
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

function digestFor(state: DailyState, weekly: WeeklyState, fuel: WeeklyFuelState): string {
  return formatDigest(state.eRepublikDay, state, weekly, fuel, 70);
}

describe('digestHash', () => {
  it('is stable across calls for the same digest text', () => {
    const text = digestFor(makeState(), makeWeekly(), makeFuel());
    expect(digestHash(text)).toBe(digestHash(text));
  });

  it('changes when the digest text differs (e.g. new claimed mission)', () => {
    const before = digestHash(digestFor(makeState(), makeWeekly(), makeFuel()));
    const after = digestHash(
      digestFor(makeState({ claimedMissionIds: [1, 2] }), makeWeekly(), makeFuel()),
    );
    expect(after).not.toBe(before);
  });

  // Regression: previously snapshotHash() included hidden state fields, so a
  // fresh fuel.lastFarmedAt timestamp (set on every farm cycle, even zero-hit
  // ones) flipped the hash and re-sent an identical-looking digest. By hashing
  // the formatted text itself, hidden state shifts can never spam Telegram.
  it('does NOT change when fuel.lastFarmedAt updates (hidden field)', () => {
    const a = digestHash(digestFor(makeState(), makeWeekly(), makeFuel()));
    const b = digestHash(
      digestFor(makeState(), makeWeekly(), makeFuel({ lastFarmedAt: '2026-05-20T17:20:00Z' })),
    );
    expect(a).toBe(b);
  });

  it('does NOT change when state.awaySince flips between null and a timestamp', () => {
    const a = digestHash(digestFor(makeState(), makeWeekly(), makeFuel()));
    const b = digestHash(
      digestFor(makeState({ awaySince: '2026-05-20T17:25:00Z' }), makeWeekly(), makeFuel()),
    );
    expect(a).toBe(b);
  });

  it('does NOT change when completedActions.work.at timestamp differs', () => {
    const a = digestHash(
      digestFor(
        makeState({ completedActions: { work: { at: '2026-05-20T07:00:00Z', source: 'agent' } } }),
        makeWeekly(),
        makeFuel(),
      ),
    );
    const b = digestHash(
      digestFor(
        makeState({ completedActions: { work: { at: '2026-05-20T17:39:00Z', source: 'agent' } } }),
        makeWeekly(),
        makeFuel(),
      ),
    );
    expect(a).toBe(b);
  });

  it('does change when fuel.spent shifts (visible in digest)', () => {
    const a = digestHash(digestFor(makeState(), makeWeekly(), makeFuel({ spent: 10 })));
    const b = digestHash(digestFor(makeState(), makeWeekly(), makeFuel({ spent: 20 })));
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
    expect(out).toContain('OT ⏳');
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

  it('shows OT ✅ when workOvertime is recorded', () => {
    const state = makeState();
    state.completedActions.workOvertime = { at: '2026-05-20T08:00:00Z', source: 'agent' };
    expect(formatDigest(state.eRepublikDay, state, makeWeekly(), makeFuel(), 70))
      .toContain('OT ✅');
  });

  it('omits Gold marker when buyGold is disabled', () => {
    const day = 6757;
    const state = emptyState(day);
    const weekly = { lastClaimedRewardId: null };
    const fuel = { week: 'w1', spent: 0, hitsLanded: 0 };
    const text = formatDigest(day, state as any, weekly as any, fuel as any, 70, {
      enabled: false,
      amount: 0,
    });
    expect(text).not.toContain('Gold');
  });

  it('includes Gold marker when buyGold is enabled', () => {
    const day = 6757;
    const state = emptyState(day);
    const weekly = { lastClaimedRewardId: null };
    const fuel = { week: 'w1', spent: 0, hitsLanded: 0 };
    const text = formatDigest(day, state as any, weekly as any, fuel as any, 70, {
      enabled: true,
      amount: 10,
    });
    expect(text).toContain('Gold ⏳');
  });

  it('shows ✅ for Gold when completedActions.buyGold is set', () => {
    const day = 6757;
    const state = emptyState(day);
    state.completedActions.buyGold = { at: '2026-05-21T00:00:00.000Z', source: 'agent', amount: 10 };
    const weekly = { lastClaimedRewardId: null };
    const fuel = { week: 'w1', spent: 0, hitsLanded: 0 };
    const text = formatDigest(day, state as any, weekly as any, fuel as any, 70, {
      enabled: true,
      amount: 10,
    });
    expect(text).toContain('Gold ✅');
  });
});
