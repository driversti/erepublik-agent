import { describe, expect, it } from 'vitest';
import { pickWeapon, type InventoryWeapon } from './pickWeapon.js';

const inv = (entries: Array<{ quality: number; amount: number }>): InventoryWeapon[] =>
  entries.map((e) => ({ type: 'groundWeapon', quality: e.quality, amount: e.amount }));

describe('pickWeapon', () => {
  it('returns the highest-priority weapon when present', () => {
    const result = pickWeapon(inv([{ quality: 7, amount: 100 }, { quality: 5, amount: 50 }]), [7, 6, 5]);
    expect(result).toEqual({ quality: 7, amount: 100 });
  });

  it('skips qualities with zero amount', () => {
    const result = pickWeapon(inv([{ quality: 7, amount: 0 }, { quality: 5, amount: 10 }]), [7, 6, 5]);
    expect(result).toEqual({ quality: 5, amount: 10 });
  });

  it('returns null when no priority quality is available', () => {
    const result = pickWeapon(inv([{ quality: 3, amount: 100 }]), [7, 6, 5]);
    expect(result).toBeNull();
  });

  it('returns null for an empty inventory', () => {
    expect(pickWeapon([], [7, 6, 5, 4, 3, 2, 1])).toBeNull();
  });

  it('returns null when priority list is empty', () => {
    expect(pickWeapon(inv([{ quality: 7, amount: 100 }]), [])).toBeNull();
  });

  it('honors priority order (e.g. [3, 7] picks 3 even when 7 has more)', () => {
    const result = pickWeapon(inv([{ quality: 7, amount: 100 }, { quality: 3, amount: 5 }]), [3, 7]);
    expect(result).toEqual({ quality: 3, amount: 5 });
  });

  it('ignores non-groundWeapon items', () => {
    const items: InventoryWeapon[] = [
      { type: 'groundBomb', quality: 22, amount: 100 } as InventoryWeapon,
      { type: 'groundWeapon', quality: 7, amount: 10 },
    ];
    expect(pickWeapon(items, [7])).toEqual({ quality: 7, amount: 10 });
  });
});
