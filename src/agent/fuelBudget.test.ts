import { describe, it, expect } from 'vitest';
import { decideFarming, DEFAULT_MAX_BATTLES_PER_SESSION } from './fuelBudget.js';
import type { WeeklyFuelState } from '../memory/weeklyFuelState.js';

// Pick "now" deep enough into the week that the pacing brake doesn't fire
// before energy/fuel/cap budgets do, so the cap is the binding constraint.
const MID_WEEK = new Date('2026-05-15T12:00:00-07:00'); // Friday afternoon PST

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

describe('decideFarming minEnergyPerBattle override', () => {
  const baseWeekly: WeeklyFuelState = {
    week: 0,
    spent: 0,
    hitsLanded: 0,
    lastFarmedAt: null,
    nextEligibleAt: null,
    cyclesSkipped: 0,
    weekStartInventory: null,
  };

  it('uses ENERGY_PER_BATTLE (66) by default', () => {
    const d = decideFarming({
      weekly: baseWeekly,
      poolEnergy: 50,
      fuelInInventory: 5,
    });
    expect(d.shouldFarm).toBe(false);
    expect(d.reason).toMatch(/50 < 66/);
  });

  it('uses minEnergyPerBattle when supplied', () => {
    const d = decideFarming({
      weekly: baseWeekly,
      poolEnergy: 40,
      fuelInInventory: 5,
      minEnergyPerBattle: 30,
    });
    expect(d.shouldFarm).toBe(true);
  });

  it('still blocks when pool is below the supplied minEnergyPerBattle', () => {
    const d = decideFarming({
      weekly: baseWeekly,
      poolEnergy: 20,
      fuelInInventory: 5,
      minEnergyPerBattle: 30,
    });
    expect(d.shouldFarm).toBe(false);
    expect(d.reason).toMatch(/20 < 30/);
  });
});

describe('decideFarming — maxBattlesPerSession cap', () => {
  it('uses DEFAULT_MAX_BATTLES_PER_SESSION (3) when not specified', () => {
    const decision = decideFarming({
      weekly: weekly(),
      poolEnergy: 10_000,
      fuelInInventory: 100,
      now: MID_WEEK,
    });
    expect(decision.shouldFarm).toBe(true);
    expect(decision.battlesThisSession).toBeLessThanOrEqual(DEFAULT_MAX_BATTLES_PER_SESSION);
  });

  it('honors a custom maxBattlesPerSession when supplied', () => {
    const decision = decideFarming({
      weekly: weekly(),
      poolEnergy: 10_000,
      fuelInInventory: 100,
      maxBattlesPerSession: 7,
      now: MID_WEEK,
    });
    expect(decision.shouldFarm).toBe(true);
    // With plenty of energy/fuel and a generous pace budget mid-week, the
    // cap is the binding constraint.
    expect(decision.battlesThisSession).toBe(7);
  });

  it('clamps maxBattlesPerSession to a minimum of 1', () => {
    const decision = decideFarming({
      weekly: weekly(),
      poolEnergy: 10_000,
      fuelInInventory: 100,
      maxBattlesPerSession: 0,
      now: MID_WEEK,
    });
    expect(decision.shouldFarm).toBe(true);
    expect(decision.battlesThisSession).toBe(1);
  });
});
