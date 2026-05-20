import type { BrowserContext } from 'playwright-core';
import { loadInventory } from './inventory.js';
import { pickBomb } from '../../tools/pickBomb.js';
import { loadSettings } from '../../ui/settingsStore.js';
import { runDoubleSidedCombat } from './doubleSidedEngine.js';
import type {
  FarmStrategy,
  FarmSessionInfo,
  FarmSessionOptions,
  FarmSessionResult,
} from './types.js';

/** Maverick descends to D3 regardless of native division. */
const FARM_DIVISION = 3;

/**
 * Maverick-D3 strategy: like {@link standardStrategy} but always fights in
 * division 3 and (when the operator opts in via the foreign-weapon policy)
 * tries a single bomb deploy per side before falling back to bare hands.
 *
 * Belt-and-suspenders check on the perk flag — the runner already routes
 * via `effectiveMode`, but a manual `modeOverride` on a non-Maverick account
 * would silently fail server-side. We log a warning so it's not mistaken
 * for a runner bug.
 */
async function runMaverickD3(
  ctx: BrowserContext,
  info: FarmSessionInfo,
  options: FarmSessionOptions,
): Promise<FarmSessionResult> {
  const settings = loadSettings();
  const useBombs = settings.emptyDiv.foreignWeaponPolicy === 'bomb-then-bazooka';

  if (info.hasMaverick !== true && settings.maverickManual !== true) {
    console.warn(
      '[maverickD3] warning: hasMaverick=false and maverickManual not set — ' +
        'D3 deploys will likely be rejected server-side. Forcing via override.',
    );
  }

  // One inventory read per session — picks the best bomb available (or null).
  const inventory = await loadInventory(ctx, info.csrf);
  const bomb = useBombs ? pickBomb(inventory) : null;

  return runDoubleSidedCombat(ctx, info, options, {
    strategyId: 'maverickD3',
    division: FARM_DIVISION,
    bomb,
  });
}

export const maverickD3Strategy: FarmStrategy = {
  id: 'maverickD3',
  run: runMaverickD3,
};
