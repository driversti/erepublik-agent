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
