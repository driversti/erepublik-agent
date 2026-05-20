import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../../transport/apiCall.js';
import { pickWeapon, type InventoryWeapon } from '../../tools/pickWeapon.js';
import { FIREPOWER } from '../../tools/damageFormula.js';

interface InventoryCategory {
  id?: string;
  items?: InventoryWeapon[];
}

/** GET /economy/inventory-json → mainStorage items. */
export async function loadInventory(
  ctx: BrowserContext,
  csrf: string,
): Promise<InventoryWeapon[]> {
  const { body } = await apiCall<InventoryCategory[]>(ctx, {
    method: 'GET',
    path: '/en/economy/inventory-json',
    csrf,
  });
  const main = Array.isArray(body) ? body.find((c) => c.id === 'mainStorage') : undefined;
  return main?.items ?? [];
}

export interface ResolvedWeapon {
  /** Quality 1-7, or -1 for bare hands. */
  quality: number;
  /** Firepower for the damage formula. */
  firepower: number;
  /** Ammo on hand (Infinity for bare hands). */
  amountOnHand: number;
  /**
   * Hits delivered per inventory unit (a.k.a. durability).
   * groundWeapon: Q1..Q6 = 1..6, Q7 = 10.
   * airWeapon:   Q1..Q5 = 1..5 (no higher tier exists).
   * groundBomb:  always 1 (each bomb is a single-deploy projectile).
   * bare hands:  1 (paired with `amountOnHand = Infinity`).
   */
  usesPerUnit: number;
}

type WeaponType = 'groundWeapon' | 'airWeapon' | 'groundBomb';

const DURABILITY: Record<WeaponType, Record<number, number>> = {
  groundWeapon: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 10 },
  airWeapon: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 },
  groundBomb: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 },
};

/**
 * Pick the best available weapon of `weaponType` from `inventory` according
 * to `priority`. Returns bare-hands defaults when nothing matches.
 */
export function resolveWeapon(
  inventory: readonly InventoryWeapon[],
  priority: readonly number[],
  weaponType: WeaponType = 'groundWeapon',
): ResolvedWeapon {
  const picked = pickWeapon(inventory, priority, weaponType);
  if (!picked) {
    return {
      quality: -1,
      firepower: FIREPOWER.bare,
      amountOnHand: Number.POSITIVE_INFINITY,
      usesPerUnit: 1,
    };
  }
  const fpKey = `Q${picked.quality}` as keyof typeof FIREPOWER;
  return {
    quality: picked.quality,
    firepower: FIREPOWER[fpKey],
    amountOnHand: picked.amount,
    usesPerUnit: DURABILITY[weaponType][picked.quality] ?? 1,
  };
}

export type { InventoryWeapon };
