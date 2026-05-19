import { damagePerHit, FIREPOWER } from '../../tools/damageFormula.js';
import { resolveWeapon, type InventoryWeapon } from './inventory.js';

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
