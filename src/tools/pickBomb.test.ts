import { describe, expect, it } from 'vitest';
import { pickBomb } from './pickBomb.js';
import type { InventoryWeapon } from './pickWeapon.js';

const inv = (entries: Array<{ type: string; quality: number; amount: number }>): InventoryWeapon[] => entries;

describe('pickBomb', () => {
  it('returns Big Bomb when present (quality=22)', () => {
    const result = pickBomb(inv([
      { type: 'groundBomb', quality: 22, amount: 100 },
      { type: 'groundBomb', quality: 21, amount: 50 },
    ]));
    expect(result).toEqual({ quality: 22, amount: 100 });
  });

  it('falls back to Small Bomb (quality=21) when Big absent', () => {
    const result = pickBomb(inv([{ type: 'groundBomb', quality: 21, amount: 50 }]));
    expect(result).toEqual({ quality: 21, amount: 50 });
  });

  it('returns null when no bombs', () => {
    expect(pickBomb([])).toBeNull();
    expect(pickBomb(inv([{ type: 'groundWeapon', quality: 7, amount: 100 }]))).toBeNull();
  });

  it('skips zero-amount bombs', () => {
    const result = pickBomb(inv([
      { type: 'groundBomb', quality: 22, amount: 0 },
      { type: 'groundBomb', quality: 21, amount: 10 },
    ]));
    expect(result).toEqual({ quality: 21, amount: 10 });
  });

  it('ignores non-groundBomb items', () => {
    expect(pickBomb(inv([{ type: 'groundWeapon', quality: 22, amount: 100 }]))).toBeNull();
  });
});
