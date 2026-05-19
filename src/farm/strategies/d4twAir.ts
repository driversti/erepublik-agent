import { damagePerHit, FIREPOWER } from '../../tools/damageFormula.js';
import { resolveWeapon, type InventoryWeapon } from './inventory.js';
import type { FarmableBattle } from '../../tools/battles.js';

export const ENERGY_PER_HIT = 10;
export const MIN_DEPLOY_ENERGY = 30;
export const AIRCRAFT_WEAPON_TYPE = 'aircraftWeapon'; // TODO: verify against live inventory JSON (plan §0b)

export interface MinEnergyInfo {
  strength: number | null;
  airRankNumber: number | null;
}

export interface MinEnergyCfg {
  targetDamageAttacker: number;
  useWeapon: boolean;
  weaponPriority: readonly number[];
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
  if (info.strength == null || info.airRankNumber == null) return MIN_DEPLOY_ENERGY;

  const fp = cfg.useWeapon
    ? resolveWeapon(inventory, cfg.weaponPriority, AIRCRAFT_WEAPON_TYPE).firepower
    : FIREPOWER.bare;

  const dmg = damagePerHit(info.strength, info.airRankNumber, fp);

  const hits = Math.ceil(cfg.targetDamageAttacker / dmg);
  return Math.max(hits * ENERGY_PER_HIT, MIN_DEPLOY_ENERGY);
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
