import type { BrowserContext } from 'playwright-core';
import { loadSettings } from '../../ui/settingsStore.js';
import { runOneSidedCombat, type CombatConfig } from './combatEngine.js';
import type {
  FarmStrategy,
  FarmSessionInfo,
  FarmSessionOptions,
  FarmSessionResult,
} from './types.js';

/**
 * D4-TW strategy: native country, native division (almost always D4 by the
 * time level/strength makes True-War viable), ONE big deploy per battle on
 * the side we natively belong to. Targets configured damage thresholds for
 * the True-War medal (130M attacker, 220M defender by default).
 *
 * This file is now a thin wrapper around the shared {@link runOneSidedCombat}
 * engine — see `combatEngine.ts` for the actual fight pipeline. The engine
 * was extracted to remove a ~280-line duplicate between this and `d4twAir.ts`.
 */
async function runD4TW(
  ctx: BrowserContext,
  info: FarmSessionInfo,
  options: FarmSessionOptions,
): Promise<FarmSessionResult> {
  const settings = loadSettings();
  const cfg = settings.d4tw;

  const config: CombatConfig = {
    strategyId: 'd4tw',
    logPrefix: '[d4tw]',
    sequenceTag: 'd4tw',
    division: info.division,
    rank: info.rankNumber,
    weaponPriority: cfg.weaponPriority,
    useWeapon: true,
    targetDamageAttacker: cfg.targetDamageAttacker,
    targetDamageDefender: cfg.targetDamageDefender,
    maxBattlesPerSession: cfg.maxBattlesPerSession,
    minDeployEnergy: cfg.minDeployEnergy,
    // Ground D4-TW shows damage targets in megadamage for readability.
    formatTargetDamage: (n) => `${(n / 1e6).toFixed(0)}M`,
  };

  return runOneSidedCombat(ctx, info, options, config);
}

export const d4twStrategy: FarmStrategy = {
  id: 'd4tw',
  run: runD4TW,
};
