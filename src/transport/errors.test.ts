import { describe, it, expect } from 'vitest';
import {
  ForbiddenError,
  EnergyExhaustedError,
  PartialBattleError,
} from './errors.js';

describe('shared transport errors', () => {
  describe('ForbiddenError', () => {
    it('captures endpoint context in the message', () => {
      const err = new ForbiddenError('/en/military/fightDeploy-startDeploy');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ForbiddenError');
      expect(err.endpoint).toBe('/en/military/fightDeploy-startDeploy');
      expect(err.message).toContain('/en/military/fightDeploy-startDeploy');
      expect(err.message.toLowerCase()).toContain('forbidden');
    });
  });

  describe('EnergyExhaustedError', () => {
    it('captures pool energy + last message', () => {
      const err = new EnergyExhaustedError(0, 'not enough energy');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('EnergyExhaustedError');
      expect(err.poolEnergy).toBe(0);
      expect(err.lastMessage).toBe('not enough energy');
    });

    it('handles null pool energy gracefully', () => {
      const err = new EnergyExhaustedError(null);
      expect(err.poolEnergy).toBeNull();
      expect(err.message).toContain('poolEnergy=?');
    });
  });

  describe('PartialBattleError', () => {
    it('captures both sides plus failure stage', () => {
      const sideA = {
        side: 'invader' as const,
        countryId: 1,
        attempts: 1,
        verified: true,
        fuelLeft: 60,
        deploymentId: 999,
      };
      const cause = new Error('travel blocked');
      const err = new PartialBattleError(42, 'Florida', sideA, 'travel-b', cause);
      expect(err.battleId).toBe(42);
      expect(err.regionName).toBe('Florida');
      expect(err.sideA).toBe(sideA);
      expect(err.stage).toBe('travel-b');
      expect(err.cause).toBe(cause);
      expect(err.message).toContain('Florida');
      expect(err.message).toContain('travel-b');
      expect(err.message).toContain('travel blocked');
    });
  });
});
