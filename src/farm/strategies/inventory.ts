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
}

/**
 * Pick the best available weapon of `weaponType` from `inventory` according
 * to `priority`. Returns bare-hands defaults when nothing matches.
 */
export function resolveWeapon(
  inventory: readonly InventoryWeapon[],
  priority: readonly number[],
  weaponType: 'groundWeapon' | 'airWeapon' | 'groundBomb' = 'groundWeapon',
): ResolvedWeapon {
  const picked = pickWeapon(inventory, priority, weaponType);
  if (!picked) {
    return {
      quality: -1,
      firepower: FIREPOWER.bare,
      amountOnHand: Number.POSITIVE_INFINITY,
    };
  }
  const fpKey = `Q${picked.quality}` as keyof typeof FIREPOWER;
  return {
    quality: picked.quality,
    firepower: FIREPOWER[fpKey],
    amountOnHand: picked.amount,
  };
}

export type { InventoryWeapon };
