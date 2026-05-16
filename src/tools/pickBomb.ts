import type { InventoryWeapon } from './pickWeapon.js';

/** Big Bomb (5M dmg, quality 22) preferred; Small Bomb (1.5M in D4, quality 21) fallback. */
export function pickBomb(
  inventory: readonly InventoryWeapon[],
): { quality: 21 | 22; amount: number } | null {
  for (const q of [22, 21] as const) {
    const match = inventory.find(
      (item) => item.type === 'groundBomb' && item.quality === q && item.amount > 0,
    );
    if (match) return { quality: q, amount: match.amount };
  }
  return null;
}
