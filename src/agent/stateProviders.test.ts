import { describe, it, expect } from 'vitest';
import { defaultStateProviders, type StateProviders } from './stateProviders.js';

describe('StateProviders shape', () => {
  it('defaultStateProviders exposes all 6 ports', () => {
    expect(typeof defaultStateProviders.loadDaily).toBe('function');
    expect(typeof defaultStateProviders.saveDaily).toBe('function');
    expect(typeof defaultStateProviders.loadWeekly).toBe('function');
    expect(typeof defaultStateProviders.saveWeekly).toBe('function');
    expect(typeof defaultStateProviders.loadFuel).toBe('function');
    expect(typeof defaultStateProviders.saveFuel).toBe('function');
  });

  it('runCycle callers can supply an in-memory implementation', () => {
    // Type-only assertion: this should compile.
    const fake: StateProviders = {
      loadDaily: () => ({
        state: {
          eRepublikDay: 1,
          completedActions: {},
          claimedMissionIds: [],
          claimedChestThresholds: [],
          notifiedNoJobToday: false,
          lastDigestHash: null,
          awaySince: null,
          overtimeCapReachedAt: null,
          overtimeLockRetries: 0,
          storageFullNotifiedAt: null,
        },
        rolledOver: false,
      }),
      saveDaily: () => undefined,
      loadWeekly: () => ({ lastClaimedRewardId: null }),
      saveWeekly: () => undefined,
      loadFuel: () => ({
        state: {
          week: 1,
          spent: 0,
          hitsLanded: 0,
          lastFarmedAt: null,
          nextEligibleAt: null,
          cyclesSkipped: 0,
          weekStartInventory: null,
        },
        rolledOver: false,
      }),
      saveFuel: () => undefined,
    };
    expect(fake.loadDaily(1).state.eRepublikDay).toBe(1);
  });
});
