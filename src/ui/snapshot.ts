import type { Settings } from './settingsStore.js';

export interface UiSnapshot {
  /** Unix ms of last successful cycle update (server uses for "last seen" UI label). */
  lastUpdatedAt: number | null;
  /** ISO of last cycle start, written even on paused / errored cycles. */
  lastCycleStartedAt: string | null;
  /** Reason string from the last farm-gate decision (or 'paused' / 'cycle-error'). */
  lastFarmReason: string | null;
  /** Game day at last update. */
  day: number | null;
  /** Citizen context from extractCitizenContext (subset to avoid leaking csrf, page state). */
  citizen: {
    id: number | null;
    countryId: number | null;
    division: number | null;
    energy: number | null;
    energyPoolLimit: number | null;
    fuelLeft: number | null;
    maxFuel: number | null;
    currentRegionId: number | null;
    residenceRegionId: number | null;
    atHome: boolean | null;
  };
  /** Daily action flags mirrored from DailyState.completedActions. */
  dailyActions: {
    work: boolean;
    train: boolean;
    buyFood: boolean;
    vipClaim: boolean;
  };
  /** From WeeklyFuelState — week-to-date pace numbers. */
  weeklyFuel: {
    week: number | null;
    spent: number;
    target: number;
    hitsLanded: number;
    cyclesSkipped: number;
  };
  /** Snapshot of the live `Settings` object (so the UI doesn't have to re-fetch). */
  settings: Settings | null;
  /** Last cycle's exception message, cleared on next successful cycle. */
  lastError: string | null;
}

export function createSnapshot(): UiSnapshot {
  return {
    lastUpdatedAt: null,
    lastCycleStartedAt: null,
    lastFarmReason: null,
    day: null,
    citizen: {
      id: null,
      countryId: null,
      division: null,
      energy: null,
      energyPoolLimit: null,
      fuelLeft: null,
      maxFuel: null,
      currentRegionId: null,
      residenceRegionId: null,
      atHome: null,
    },
    dailyActions: { work: false, train: false, buyFood: false, vipClaim: false },
    weeklyFuel: { week: null, spent: 0, target: 0, hitsLanded: 0, cyclesSkipped: 0 },
    settings: null,
    lastError: null,
  };
}
