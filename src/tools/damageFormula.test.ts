import { describe, expect, it } from 'vitest';
import { damagePerHit, FIREPOWER } from './damageFormula.js';

describe('damagePerHit', () => {
  it('returns 10 for a Recruit (S=0, R=1) bare-handed', () => {
    // D = 10 * (1 + 0/400) * (1 + 1/5) * (1 + 0/100)
    //   = 10 * 1 * 1.2 * 1 = 12
    expect(damagePerHit(0, 1, FIREPOWER.bare)).toBeCloseTo(12, 5);
  });

  it('returns 24 for a Recruit with Q5 weapon (KB reference)', () => {
    expect(damagePerHit(0, 1, FIREPOWER.Q5)).toBeCloseTo(24, 5);
  });

  it('returns 36 for a Recruit with Q7 weapon (KB reference)', () => {
    expect(damagePerHit(0, 1, FIREPOWER.Q7)).toBeCloseTo(36, 5);
  });

  it('returns 112.5 for a Sergeant (S=100, R=10) with Q7 (KB reference)', () => {
    // D = 10 * (1 + 100/400) * (1 + 10/5) * (1 + 200/100)
    //   = 10 * 1.25 * 3 * 3 = 112.5
    expect(damagePerHit(100, 10, FIREPOWER.Q7)).toBeCloseTo(112.5, 5);
  });

  it('scales linearly with FP holding S and R fixed', () => {
    const baseline = damagePerHit(100, 10, FIREPOWER.bare); // FP=0 → ×1
    const q7 = damagePerHit(100, 10, FIREPOWER.Q7); // FP=200 → ×3
    expect(q7 / baseline).toBeCloseTo(3, 5);
  });

  it('matches the sample account values (S=423000, R=89, Q7) within 1%', () => {
    // Per the spec's damage-table sample: Q7 ≈ 596,994
    const d = damagePerHit(423000, 89, FIREPOWER.Q7);
    expect(d).toBeGreaterThan(593_000);
    expect(d).toBeLessThan(601_000);
  });

  it('FIREPOWER table matches the wiki', () => {
    expect(FIREPOWER.bare).toBe(0);
    expect(FIREPOWER.Q1).toBe(20);
    expect(FIREPOWER.Q2).toBe(40);
    expect(FIREPOWER.Q3).toBe(60);
    expect(FIREPOWER.Q4).toBe(80);
    expect(FIREPOWER.Q5).toBe(100);
    expect(FIREPOWER.Q6).toBe(120);
    expect(FIREPOWER.Q7).toBe(200);
  });
});
