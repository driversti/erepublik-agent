import { describe, it, expect } from 'vitest';
import { resolveWeapon, type InventoryWeapon } from './inventory.js';

describe('resolveWeapon', () => {
  it('returns bare-hands defaults when inventory is empty', () => {
    const r = resolveWeapon([], [7, 6, 5, 4, 3, 2, 1]);
    expect(r.quality).toBe(-1);
    expect(r.firepower).toBe(0); // FIREPOWER.bare
    expect(r.amountOnHand).toBe(Number.POSITIVE_INFINITY);
  });

  it('picks the highest-priority groundWeapon present', () => {
    const inv: InventoryWeapon[] = [
      { type: 'groundWeapon', quality: 5, amount: 25 },
      { type: 'groundWeapon', quality: 7, amount: 10 },
    ];
    const r = resolveWeapon(inv, [7, 6, 5, 4, 3, 2, 1]);
    expect(r.quality).toBe(7);
    expect(r.firepower).toBe(200); // FIREPOWER.Q7
    expect(r.amountOnHand).toBe(10);
  });

  it('respects weaponType — picks airWeapon when requested', () => {
    const inv: InventoryWeapon[] = [
      { type: 'groundWeapon', quality: 7, amount: 100 },
      { type: 'airWeapon', quality: 5, amount: 30 },
    ];
    const r = resolveWeapon(inv, [5, 4, 3, 2, 1], 'airWeapon');
    expect(r.quality).toBe(5);
    expect(r.firepower).toBe(100); // FIREPOWER.Q5
    expect(r.amountOnHand).toBe(30);
  });

  it('falls back to bare-hands when requested weaponType is missing', () => {
    const inv: InventoryWeapon[] = [
      { type: 'groundWeapon', quality: 7, amount: 100 },
    ];
    const r = resolveWeapon(inv, [5, 4, 3, 2, 1], 'airWeapon');
    expect(r.quality).toBe(-1);
    expect(r.firepower).toBe(0);
    expect(r.amountOnHand).toBe(Number.POSITIVE_INFINITY);
  });

  it('honors priority order — picks higher priority before lower', () => {
    const inv: InventoryWeapon[] = [
      { type: 'groundWeapon', quality: 3, amount: 50 },
      { type: 'groundWeapon', quality: 5, amount: 50 },
      { type: 'groundWeapon', quality: 4, amount: 50 },
    ];
    const r = resolveWeapon(inv, [5, 4, 3]);
    expect(r.quality).toBe(5);
  });
});
