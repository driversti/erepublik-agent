import { describe, it, expect } from 'vitest';
import { decideOvertime, type OvertimePolicyInput } from './workOvertime.policy.js';

const NOW = 1_769_400_000; // Unix-seconds, arbitrary stable anchor

function input(overrides: Partial<OvertimePolicyInput> = {}): OvertimePolicyInput {
  return {
    jobOverTime: { points: 1000, usableEnergy: 500, nextOverTime: 0 },
    state: { workOvertimeDone: false, capReached: false },
    settings: { enabled: true, mode: 'once-per-day' },
    nowSec: NOW,
    ...overrides,
  };
}

describe('decideOvertime', () => {
  it('skips when disabled', () => {
    expect(decideOvertime(input({ settings: { enabled: false, mode: 'once-per-day' } })))
      .toEqual({ kind: 'skip-disabled' });
  });

  it('skips when cap reached, regardless of mode', () => {
    expect(decideOvertime(input({ state: { workOvertimeDone: false, capReached: true } })))
      .toEqual({ kind: 'skip-cap' });
    expect(decideOvertime(input({
      state: { workOvertimeDone: false, capReached: true },
      settings: { enabled: true, mode: 'when-available' },
    }))).toEqual({ kind: 'skip-cap' });
  });

  it('once-per-day: skips when flag set', () => {
    expect(decideOvertime(input({ state: { workOvertimeDone: true, capReached: false } })))
      .toEqual({ kind: 'skip-already-done' });
  });

  it('when-available: proceeds even when flag set (will be re-routed by other branches)', () => {
    const d = decideOvertime(input({
      state: { workOvertimeDone: true, capReached: false },
      settings: { enabled: true, mode: 'when-available' },
    }));
    expect(d).toEqual({ kind: 'go' });
  });

  it('skips when overTime missing (not employed)', () => {
    expect(decideOvertime(input({ jobOverTime: null }))).toEqual({ kind: 'skip-not-employed' });
  });

  it('cooldown active + flag unset → reconcile-external', () => {
    const d = decideOvertime(input({
      jobOverTime: { points: 1000, usableEnergy: 500, nextOverTime: NOW + 100 },
    }));
    expect(d).toEqual({ kind: 'reconcile-external' });
  });

  it('cooldown active + flag set → skip-cooldown (no double-reconcile)', () => {
    const d = decideOvertime(input({
      jobOverTime: { points: 1000, usableEnergy: 500, nextOverTime: NOW + 100 },
      state: { workOvertimeDone: true, capReached: false },
      settings: { enabled: true, mode: 'when-available' },
    }));
    expect(d).toEqual({ kind: 'skip-cooldown', untilSec: NOW + 100, flagAlreadySet: true });
  });

  it('cooldown elapsed (nextOverTime == now)', () => {
    expect(decideOvertime(input({
      jobOverTime: { points: 1000, usableEnergy: 500, nextOverTime: NOW },
    }))).toEqual({ kind: 'go' });
  });

  it('cooldown == 0 (no cooldown ever)', () => {
    expect(decideOvertime(input({
      jobOverTime: { points: 1000, usableEnergy: 500, nextOverTime: 0 },
    }))).toEqual({ kind: 'go' });
  });

  it('skips when points < 24', () => {
    expect(decideOvertime(input({
      jobOverTime: { points: 23, usableEnergy: 500, nextOverTime: 0 },
    }))).toEqual({ kind: 'skip-points', have: 23, need: 24 });
  });

  it('skips when energy < 10', () => {
    expect(decideOvertime(input({
      jobOverTime: { points: 1000, usableEnergy: 9, nextOverTime: 0 },
    }))).toEqual({ kind: 'skip-energy', have: 9, need: 10 });
  });

  it('proceeds with go at exactly the thresholds (points=24, energy=10)', () => {
    expect(decideOvertime(input({
      jobOverTime: { points: 24, usableEnergy: 10, nextOverTime: 0 },
    }))).toEqual({ kind: 'go' });
  });

  it('priority: skip-disabled wins over everything else', () => {
    expect(decideOvertime(input({
      settings: { enabled: false, mode: 'once-per-day' },
      state: { workOvertimeDone: false, capReached: true },
      jobOverTime: { points: 0, usableEnergy: 0, nextOverTime: NOW + 9999 },
    }))).toEqual({ kind: 'skip-disabled' });
  });

  it('priority: skip-cap wins over preconditions', () => {
    expect(decideOvertime(input({
      state: { workOvertimeDone: false, capReached: true },
      jobOverTime: { points: 0, usableEnergy: 0, nextOverTime: NOW + 9999 },
    }))).toEqual({ kind: 'skip-cap' });
  });
});
