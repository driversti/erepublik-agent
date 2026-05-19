import type { BrowserContext } from 'playwright-core';
import { type FarmableBattle } from '../../tools/battles.js';
import { damagePerHit, FIREPOWER } from '../../tools/damageFormula.js';
import { resolveWeapon, type InventoryWeapon } from './inventory.js';
import { loadSettings } from '../../ui/settingsStore.js';
import { runOneSidedCombat, type CombatConfig } from './combatEngine.js';
import type {
  FarmStrategy,
  FarmSessionInfo,
  FarmSessionOptions,
  FarmSessionResult,
} from './types.js';

export const ENERGY_PER_HIT = 10;
/** Game-default minimum energy floor for a deploy. Operators may override via
 *  `settings.d4twAir.minDeployEnergy` (and the matching D4TW field). */
export const DEFAULT_MIN_DEPLOY_ENERGY = 30;
export const AIR_WEAPON_TYPE = 'airWeapon' as const; // verified against live /economy/inventory-json (Q1-Q5 air-to-air missiles)
export const AIR_DIVISION = 11;

export interface MinEnergyInfo {
  strength: number | null;
  airRankNumber: number | null;
}

export interface MinEnergyCfg {
  targetDamageAttacker: number;
  useWeapon: boolean;
  weaponPriority: readonly number[];
  /** Optional override of {@link DEFAULT_MIN_DEPLOY_ENERGY}. */
  minDeployEnergy?: number;
}

/**
 * Estimate the minimum energy required to land a single d4tw-air medal on the
 * OPTIMISTIC (invader / losing) side. Used by the runner to compute the
 * `minEnergyPerBattle` hint for `decideFarming`. The strategy itself re-checks
 * with the real per-battle side and fresh pool energy before deploying.
 */
export function estimateMinEnergy(
  info: MinEnergyInfo,
  cfg: MinEnergyCfg,
  inventory: readonly InventoryWeapon[],
): number {
  const floor = cfg.minDeployEnergy ?? DEFAULT_MIN_DEPLOY_ENERGY;
  if (info.strength == null || info.airRankNumber == null) return floor;

  const fp = cfg.useWeapon
    ? resolveWeapon(inventory, cfg.weaponPriority, AIR_WEAPON_TYPE).firepower
    : FIREPOWER.bare;

  const dmg = damagePerHit(info.strength, info.airRankNumber, fp);

  const hits = Math.ceil(cfg.targetDamageAttacker / dmg);
  return Math.max(hits * ENERGY_PER_HIT, floor);
}

/**
 * Order battles for the d4tw-air strategy: native=invader (losing side) first,
 * native=defender (fallback, higher damage target) second. Stable order
 * within each bucket — preserves input order for deterministic behavior.
 */
export function orderByPreferredSide(
  battles: readonly FarmableBattle[],
  nativeCountryId: number,
): FarmableBattle[] {
  const invaders: FarmableBattle[] = [];
  const defenders: FarmableBattle[] = [];
  for (const b of battles) {
    if (b.invaderId === nativeCountryId) invaders.push(b);
    else if (b.defenderId === nativeCountryId) defenders.push(b);
  }
  return [...invaders, ...defenders];
}

/**
 * D4-TW-Air strategy: like {@link d4twStrategy} but always fights in
 * division 11 (regardless of the citizen's native division) with optional
 * use of air weapons. Thin wrapper around {@link runOneSidedCombat}.
 */
async function runD4twAir(
  ctx: BrowserContext,
  info: FarmSessionInfo,
  options: FarmSessionOptions,
): Promise<FarmSessionResult> {
  const settings = loadSettings();
  const cfg = settings.d4twAir;

  const config: CombatConfig = {
    strategyId: 'd4tw-air',
    logPrefix: '[d4tw-air]',
    sequenceTag: 'd4tw-air',
    division: AIR_DIVISION,
    rank: info.airRankNumber,
    weaponType: AIR_WEAPON_TYPE,
    weaponPriority: cfg.weaponPriority,
    useWeapon: cfg.useWeapon,
    targetDamageAttacker: cfg.targetDamageAttacker,
    targetDamageDefender: cfg.targetDamageDefender,
    maxBattlesPerSession: cfg.maxBattlesPerSession,
    minDeployEnergy: cfg.minDeployEnergy ?? DEFAULT_MIN_DEPLOY_ENERGY,
    orderBattles: orderByPreferredSide,
  };

  return runOneSidedCombat(ctx, info, options, config);
}

export const d4twAirStrategy: FarmStrategy = {
  id: 'd4tw-air',
  run: runD4twAir,
};
