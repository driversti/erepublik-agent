import { describe, it, expect } from 'vitest';
import { estimateMinEnergy } from './d4twAir.js';
import type { InventoryWeapon } from './inventory.js';

const cfg = {
  targetDamageAttacker: 30_000,
  targetDamageDefender: 50_000,
  useWeapon: false,
  weaponPriority: [5, 4, 3, 2, 1] as number[],
};

describe('estimateMinEnergy', () => {
  it('returns MIN_DEPLOY_ENERGY (30) when strength is null', () => {
    const info = { strength: null, airRankNumber: 20 };
    expect(estimateMinEnergy(info, cfg, [])).toBe(30);
  });

  it('returns MIN_DEPLOY_ENERGY (30) when airRankNumber is null', () => {
    const info = { strength: 100_000, airRankNumber: null };
    expect(estimateMinEnergy(info, cfg, [])).toBe(30);
  });

  it('bare hands, low strength: 30k target = 3 hits = 30 energy', () => {
    // S=100k, R=20, FP=0 → D = 10 * (1+250) * (1+4) * 1 = 12_550
    // hits = ceil(30000/12550) = 3 → energy = max(3*10, 30) = 30
    const info = { strength: 100_000, airRankNumber: 20 };
    expect(estimateMinEnergy(info, { ...cfg, useWeapon: false }, [])).toBe(30);
  });

  it('uses MIN_DEPLOY_ENERGY (30) when hits*10 is below 30', () => {
    // Strong account: S=300k, R=30, FP=100 (Q5) → D huge → 1 hit
    const info = { strength: 300_000, airRankNumber: 30 };
    const inv: InventoryWeapon[] = [
      { type: 'aircraftWeapon', quality: 5, amount: 99 },
    ];
    const got = estimateMinEnergy(info, { ...cfg, useWeapon: true }, inv);
    expect(got).toBe(30);
  });

  it('uses weapon FP when useWeapon=true and weapon is present', () => {
    // S=50k, R=15, useWeapon, Q5 (FP=100) → D = 10*(1+125)*(1+3)*2 = 10_080
    // hits for 30k = ceil(30000/10080) = 3 → energy = 30
    const info = { strength: 50_000, airRankNumber: 15 };
    const inv: InventoryWeapon[] = [
      { type: 'aircraftWeapon', quality: 5, amount: 50 },
    ];
    expect(estimateMinEnergy(info, { ...cfg, useWeapon: true }, inv)).toBe(30);
  });

  it('falls back to bare hands when useWeapon=true but inventory has no air weapon', () => {
    const info = { strength: 50_000, airRankNumber: 15 };
    const groundOnly: InventoryWeapon[] = [
      { type: 'groundWeapon', quality: 7, amount: 100 },
    ];
    // bare hands: S=50k, R=15, FP=0 → D = 10*126*4*1 = 5_040
    // hits = ceil(30000/5040) = 6 → energy = max(6*10, 30) = 60
    const got = estimateMinEnergy(info, { ...cfg, useWeapon: true }, groundOnly);
    expect(got).toBe(60);
  });

  it('large targets scale energy linearly above MIN_DEPLOY_ENERGY', () => {
    // very weak account: S=10k, R=10, FP=0 → D = 10*(1+25)*(1+2)*1 = 780
    // hits for 30k = ceil(30000/780) = 39 → energy = 390
    const info = { strength: 10_000, airRankNumber: 10 };
    expect(estimateMinEnergy(info, { ...cfg, useWeapon: false }, [])).toBe(390);
  });
});
