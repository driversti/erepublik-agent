/** A row from `mainStorage.items` of /en/economy/inventory-json. */
export interface InventoryWeapon {
  type: string;
  quality: number;
  amount: number;
}

/**
 * Return the highest-priority weapon of the requested `weaponType` that has
 * `amount > 0`. `null` means "no weapon available — fall back to bare hands".
 *
 * `weaponType` defaults to `'groundWeapon'` for backwards compatibility with
 * existing callers (standard, d4tw, maverickD3).
 */
export function pickWeapon(
  inventory: readonly InventoryWeapon[],
  priorityList: readonly number[],
  weaponType: 'groundWeapon' | 'airWeapon' | 'groundBomb' = 'groundWeapon',
): { quality: number; amount: number } | null {
  for (const q of priorityList) {
    const match = inventory.find(
      (item) => item.type === weaponType && item.quality === q && item.amount > 0,
    );
    if (match) return { quality: match.quality, amount: match.amount };
  }
  return null;
}
