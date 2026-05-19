import { describe, it, expect } from 'vitest';
import { decideFarming } from './fuelBudget.js';
import type { WeeklyFuelState } from '../memory/weeklyFuelState.js';

const MID_WEEK = new Date('2026-05-15T12:00:00-07:00');

function weekly(overrides: Partial<WeeklyFuelState> = {}): WeeklyFuelState {
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

describe('decideFarming — weeklyBudget override (Task 4)', () => {
  it('uses default weekly budget of 70 when not supplied', () => {
    const d = decideFarming({
      weekly: weekly({ spent: 70 }),
      poolEnergy: 10_000,
      fuelInInventory: 5,
    });
    expect(d.shouldFarm).toBe(false);
    expect(d.reason).toMatch(/exhausted \(70\/70\)/);
  });

  it('honors a custom weekly budget when supplied (e.g., 140 for D11 air)', () => {
    const d = decideFarming({
      weekly: weekly({ spent: 70 }),
      poolEnergy: 10_000,
      fuelInInventory: 5,
      weeklyBudget: 140,
      now: MID_WEEK,
    });
    expect(d.shouldFarm).toBe(true);
    expect(d.diagnostics.remaining).toBe(70); // 140 - 70
  });

  it('blocks farming when spent meets the custom budget', () => {
    const d = decideFarming({
      weekly: weekly({ spent: 50 }),
      poolEnergy: 10_000,
      fuelInInventory: 5,
      weeklyBudget: 50,
      now: MID_WEEK,
    });
    expect(d.shouldFarm).toBe(false);
    expect(d.reason).toMatch(/exhausted \(50\/50\)/);
  });

  it('uses the custom budget for pacing calculations (mid-week target ≈ budget/2)', () => {
    const d = decideFarming({
      weekly: weekly({ spent: 0 }),
      poolEnergy: 10_000,
      fuelInInventory: 100,
      weeklyBudget: 140,
      now: MID_WEEK,
    });
    expect(d.shouldFarm).toBe(true);
    // weekFraction at MID_WEEK ≈ 0.43–0.57; target = floor(140 * weekFraction)
    expect(d.diagnostics.target).toBeGreaterThan(0);
    expect(d.diagnostics.target).toBeLessThan(140);
  });
});
