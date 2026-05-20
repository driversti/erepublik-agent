import { describe, it, expect } from 'vitest';
import { DailyState, emptyState, overtimeStillPending } from './schema.js';

describe('DailyState schema', () => {
  it('emptyState produces a parseable DailyState', () => {
    const s = emptyState(6755);
    expect(DailyState.parse(s)).toEqual(s);
    expect(s.overtimeCapReachedAt).toBeNull();
    expect(s.completedActions.workOvertime).toBeUndefined();
  });

  it('round-trips through parse with optional workOvertime', () => {
    const raw = JSON.parse(JSON.stringify({
      ...emptyState(6755),
      completedActions: {
        work: { at: '2026-05-20T08:00:00Z', source: 'agent' },
        workOvertime: { at: '2026-05-20T08:10:00Z', source: 'agent' },
      },
      overtimeCapReachedAt: '2026-05-20T14:00:00Z',
    }));
    const parsed = DailyState.parse(raw);
    expect(parsed.completedActions.workOvertime).toEqual({
      at: '2026-05-20T08:10:00Z',
      source: 'agent',
    });
    expect(parsed.overtimeCapReachedAt).toBe('2026-05-20T14:00:00Z');
  });

  it('accepts legacy state files without overtimeCapReachedAt (defaults to null)', () => {
    const legacy = {
      eRepublikDay: 6755,
      completedActions: {},
      claimedMissionIds: [],
      claimedChestThresholds: [],
      notifiedNoJobToday: false,
      lastDigestHash: null,
      awaySince: null,
    };
    expect(DailyState.parse(legacy).overtimeCapReachedAt).toBeNull();
  });
});

describe('overtimeStillPending', () => {
  const baseState = emptyState(6755);

  it('returns false when settings disabled', () => {
    expect(overtimeStillPending(baseState, { enabled: false, mode: 'once-per-day' }))
      .toBe(false);
  });

  it('returns false when cap reached', () => {
    expect(overtimeStillPending(
      { ...baseState, overtimeCapReachedAt: '2026-05-20T14:00:00Z' },
      { enabled: true, mode: 'once-per-day' },
    )).toBe(false);
  });

  it('once-per-day: false when flag set, true when unset', () => {
    expect(overtimeStillPending(
      baseState,
      { enabled: true, mode: 'once-per-day' },
    )).toBe(true);
    const done = {
      ...baseState,
      completedActions: { workOvertime: { at: '2026-05-20T08:00:00Z', source: 'agent' as const } },
    };
    expect(overtimeStillPending(done, { enabled: true, mode: 'once-per-day' })).toBe(false);
  });

  it('when-available: always true regardless of flag', () => {
    const done = {
      ...baseState,
      completedActions: { workOvertime: { at: '2026-05-20T08:00:00Z', source: 'agent' as const } },
    };
    expect(overtimeStillPending(done, { enabled: true, mode: 'when-available' })).toBe(true);
  });
});
