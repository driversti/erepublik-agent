import { describe, it, expect } from 'vitest';
import { reconcileSpentWithInventory, type WeeklyFuelState } from './weeklyFuelState.js';

function fresh(overrides: Partial<WeeklyFuelState> = {}): WeeklyFuelState {
  return {
    week: 963,
    spent: 0,
    hitsLanded: 0,
    lastFarmedAt: null,
    nextEligibleAt: null,
    cyclesSkipped: 0,
    weekStartInventory: null,
    ...overrides,
  };
}

describe('reconcileSpentWithInventory', () => {
  it('locks weekStartInventory on the first cycle and reports baselineSet', () => {
    const r = reconcileSpentWithInventory(fresh(), 70);
    expect(r.baselineSet).toBe(true);
    expect(r.state.weekStartInventory).toBe(70);
    expect(r.state.spent).toBe(0);
    expect(r.externalBurnDetected).toBe(0);
  });

  it('does not reset baseline on subsequent cycles', () => {
    const r = reconcileSpentWithInventory(
      fresh({ weekStartInventory: 70, spent: 5 }),
      60,
    );
    expect(r.baselineSet).toBe(false);
    expect(r.state.weekStartInventory).toBe(70);
  });

  it('catches manual out-of-band fuel usage and bumps spent', () => {
    // Baseline 70, agent thinks it spent 5, but inventory shows only 50 left.
    // → real consumption is 20; 15 of it happened outside the agent.
    const r = reconcileSpentWithInventory(
      fresh({ weekStartInventory: 70, spent: 5 }),
      50,
    );
    expect(r.state.spent).toBe(20);
    expect(r.externalBurnDetected).toBe(15);
  });

  it('does not double-count when agent-tracked spent matches inventory delta', () => {
    const r = reconcileSpentWithInventory(
      fresh({ weekStartInventory: 70, spent: 20 }),
      50,
    );
    expect(r.state.spent).toBe(20);
    expect(r.externalBurnDetected).toBe(0);
  });

  it('does not decrease spent if inventory grew (mid-week purchase)', () => {
    // Started week with 70, agent burned 10 (spent=10), then bought 30 more.
    // Inventory now 90. baseline-current = 70-90 = -20 (negative, clamped to 0).
    // spent must remain 10.
    const r = reconcileSpentWithInventory(
      fresh({ weekStartInventory: 70, spent: 10 }),
      90,
    );
    expect(r.state.spent).toBe(10);
    expect(r.externalBurnDetected).toBe(0);
  });

  it('treats an immediate inventory drop on first cycle as zero external burn', () => {
    // First cycle locks baseline = current; spent stays 0.
    const r = reconcileSpentWithInventory(fresh({ spent: 0 }), 25);
    expect(r.state.weekStartInventory).toBe(25);
    expect(r.state.spent).toBe(0);
    expect(r.externalBurnDetected).toBe(0);
  });
});
