/** A row from `mainStorage.items` of /en/economy/inventory-json. */
export interface InventoryWeapon {
  type: string;
  quality: number;
  amount: number;
}

/**
 * Return the highest-priority `groundWeapon` quality that has `amount > 0`.
 * `null` means "no weapon available — fall back to bare hands".
 */
export function pickWeapon(
  inventory: readonly InventoryWeapon[],
  priorityList: readonly number[],
): { quality: number; amount: number } | null {
  for (const q of priorityList) {
    const match = inventory.find(
      (item) => item.type === 'groundWeapon' && item.quality === q && item.amount > 0,
    );
    if (match) return { quality: match.quality, amount: match.amount };
  }
  return null;
}
