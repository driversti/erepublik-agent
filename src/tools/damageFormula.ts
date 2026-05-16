/**
 * Per [[Military_Formulas]] (KB):
 *   D = 10 × (1 + S/400) × (1 + R/5) × (1 + FP/100)
 *
 * Excludes natural-enemy, boosters, terrain. Use as a base estimate; in
 * practice the operator's stated TW target damages carry enough safety
 * margin to absorb the multiplicative bonuses we don't model.
 */
export function damagePerHit(strength: number, rank: number, firepower: number): number {
  return 10 * (1 + strength / 400) * (1 + rank / 5) * (1 + firepower / 100);
}

/** Firepower per weapon quality. Bare hands = 0. */
export const FIREPOWER = {
  bare: 0,
  Q1: 20,
  Q2: 40,
  Q3: 60,
  Q4: 80,
  Q5: 100,
  Q6: 120,
  Q7: 200,
} as const;

export type WeaponQuality = keyof typeof FIREPOWER;
