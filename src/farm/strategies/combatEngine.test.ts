import { describe, it, expect } from 'vitest';
import { computeDeployPlan, buildOneSidedWin } from './combatEngine.js';
import type { SideOutcome } from './types.js';

describe('computeDeployPlan', () => {
  it('returns hitsNeeded floored to minDeployEnergy when target is tiny', () => {
    const plan = computeDeployPlan({
      targetDamage: 100,
      damagePerHit: 1_000,
      energyPerHit: 10,
      minDeployEnergy: 30,
      ammoOnHand: 99,
    });
    expect(plan.hitsNeeded).toBe(1);
    expect(plan.energyToSpend).toBe(30);
    expect(plan.ammoOk).toBe(true);
  });

  it('scales energy linearly when target requires many hits', () => {
    const plan = computeDeployPlan({
      targetDamage: 1_000,
      damagePerHit: 100,
      energyPerHit: 10,
      minDeployEnergy: 30,
      ammoOnHand: 99,
    });
    expect(plan.hitsNeeded).toBe(10);
    expect(plan.energyToSpend).toBe(100);
  });

  it('marks ammo insufficient when ammoOnHand < hitsNeeded', () => {
    const plan = computeDeployPlan({
      targetDamage: 1_000,
      damagePerHit: 100,
      energyPerHit: 10,
      minDeployEnergy: 30,
      ammoOnHand: 5,
    });
    expect(plan.hitsNeeded).toBe(10);
    expect(plan.ammoOk).toBe(false);
  });

  it('treats Infinity ammo (bare hands) as always sufficient', () => {
    const plan = computeDeployPlan({
      targetDamage: 1e9,
      damagePerHit: 100,
      energyPerHit: 10,
      minDeployEnergy: 30,
      ammoOnHand: Number.POSITIVE_INFINITY,
    });
    expect(plan.ammoOk).toBe(true);
  });

  describe('usesPerUnit (durability)', () => {
    // 1820 / 10 = 182 hits needed. With Q5 air (usesPerUnit=5),
    // 40 units carry 200 hits → sufficient; 30 units carry 150 → insufficient.
    it('multiplies ammoOnHand by usesPerUnit when checking sufficiency', () => {
      const plan = computeDeployPlan({
        targetDamage: 1820,
        damagePerHit: 10,
        energyPerHit: 10,
        minDeployEnergy: 30,
        ammoOnHand: 40,
        usesPerUnit: 5,
      });
      expect(plan.hitsNeeded).toBe(182);
      expect(plan.unitsNeeded).toBe(37); // ceil(182 / 5)
      expect(plan.ammoOk).toBe(true);
    });

    it('marks insufficient when ammoOnHand * usesPerUnit < hitsNeeded', () => {
      const plan = computeDeployPlan({
        targetDamage: 1820,
        damagePerHit: 10,
        energyPerHit: 10,
        minDeployEnergy: 30,
        ammoOnHand: 30,
        usesPerUnit: 5,
      });
      expect(plan.hitsNeeded).toBe(182);
      expect(plan.unitsNeeded).toBe(37);
      expect(plan.ammoOk).toBe(false);
    });

    it('treats Q7 ground (10 uses/unit) correctly', () => {
      // 100 hits needed, 10 units of Q7 = 100 hits → exactly enough.
      const plan = computeDeployPlan({
        targetDamage: 1000,
        damagePerHit: 10,
        energyPerHit: 10,
        minDeployEnergy: 30,
        ammoOnHand: 10,
        usesPerUnit: 10,
      });
      expect(plan.hitsNeeded).toBe(100);
      expect(plan.unitsNeeded).toBe(10);
      expect(plan.ammoOk).toBe(true);
    });

    it('defaults usesPerUnit to 1 when omitted (backward-compatible)', () => {
      // No usesPerUnit field — same behavior as before the fix.
      const plan = computeDeployPlan({
        targetDamage: 1000,
        damagePerHit: 100,
        energyPerHit: 10,
        minDeployEnergy: 30,
        ammoOnHand: 5,
      });
      expect(plan.hitsNeeded).toBe(10);
      expect(plan.ammoOk).toBe(false);
    });

    it('Infinity ammo stays sufficient regardless of usesPerUnit', () => {
      const plan = computeDeployPlan({
        targetDamage: 1e9,
        damagePerHit: 100,
        energyPerHit: 10,
        minDeployEnergy: 30,
        ammoOnHand: Number.POSITIVE_INFINITY,
        usesPerUnit: 1,
      });
      expect(plan.ammoOk).toBe(true);
    });
  });
});

describe('buildOneSidedWin', () => {
  const battle = { battleId: 42, regionName: 'Florida' };
  const fightingOutcome: SideOutcome = {
    side: 'invader',
    countryId: 1,
    attempts: 1,
    verified: true,
    fuelLeft: 60,
    deploymentId: 999,
  };

  it('places the fighting outcome on the correct invader slot', () => {
    const win = buildOneSidedWin(battle, 'invader', 1, 2, fightingOutcome);
    expect(win.inv).toBe(fightingOutcome);
    expect(win.def.side).toBe('defender');
    expect(win.def.countryId).toBe(2);
    expect(win.def.verified).toBe(false);
  });

  it('places the fighting outcome on the defender slot when mySide=defender', () => {
    const defOutcome: SideOutcome = { ...fightingOutcome, side: 'defender' };
    const win = buildOneSidedWin(battle, 'defender', 2, 1, defOutcome);
    expect(win.def).toBe(defOutcome);
    expect(win.inv.side).toBe('invader');
    expect(win.inv.countryId).toBe(1);
    expect(win.inv.verified).toBe(false);
  });

  it('preserves battle metadata', () => {
    const win = buildOneSidedWin(battle, 'invader', 1, 2, fightingOutcome);
    expect(win.battleId).toBe(42);
    expect(win.regionName).toBe('Florida');
  });
});
