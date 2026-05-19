import { loadOrInit, save } from '../memory/dailyState.js';
import { loadWeekly, saveWeekly, type WeeklyState } from '../memory/weeklyState.js';
import { loadFuel, saveFuel, type WeeklyFuelState } from '../memory/weeklyFuelState.js';
import type { DailyState } from '../memory/schema.js';

/**
 * Persistence ports for `runCycle`. Default implementation is file-backed
 * (see {@link defaultStateProviders}); tests can substitute in-memory ports
 * to exercise the cycle logic without touching disk or eRepublik's clock.
 *
 * Why a struct of functions, not a class: the underlying memory modules are
 * stateless utilities, and passing a struct keeps the type surface easy to
 * mock (`vi.fn()` per field) without instantiating anything.
 */
export interface StateProviders {
  loadDaily: (day: number) => { state: DailyState; rolledOver: boolean };
  saveDaily: (state: DailyState) => void;
  loadWeekly: () => WeeklyState;
  saveWeekly: (state: WeeklyState) => void;
  loadFuel: () => { state: WeeklyFuelState; rolledOver: boolean };
  saveFuel: (state: WeeklyFuelState) => void;
}

export const defaultStateProviders: StateProviders = {
  loadDaily: loadOrInit,
  saveDaily: save,
  loadWeekly,
  saveWeekly,
  loadFuel,
  saveFuel,
};
