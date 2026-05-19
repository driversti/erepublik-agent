import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../transport/apiCall.js', () => ({
  apiCall: vi.fn(),
}));

import { getDeployInventory } from './farm.js';
import { apiCall } from '../transport/apiCall.js';

const apiCallMock = vi.mocked(apiCall);

const ctx = {} as never;
const csrf = 'test-csrf';

describe('getDeployInventory', () => {
  beforeEach(() => apiCallMock.mockReset());

  it('parses minEnergy + damagePerHitByQuality from a full server response', async () => {
    apiCallMock.mockResolvedValueOnce({
      body: {
        weapons: [
          {
            quality: -1,
            amount: null,
            damageperHit: 143,
            attributes: { firepower: null, maxEnergy: null },
          },
          {
            quality: 5,
            amount: 1169,
            damageperHit: 286,
            attributes: { firepower: '+100%', maxEnergy: 58450 },
          },
        ],
        vehicles: [
          { id: 30, isActive: true },
          { id: 40, isActive: false },
        ],
        poolEnergy: 6654,
        minEnergy: 10,
      },
    } as never);

    const inv = await getDeployInventory(ctx, csrf, 863500, 72, 37861235);

    expect(inv.skinId).toBe(30);
    expect(inv.poolEnergy).toBe(6654);
    expect(inv.hasNoWeaponOption).toBe(true);
    expect(inv.minEnergy).toBe(10);
    expect(inv.damagePerHitByQuality).toEqual({
      [-1]: 143,
      5: 286,
    });
  });

  it('returns empty damagePerHitByQuality when weapons array is missing', async () => {
    apiCallMock.mockResolvedValueOnce({
      body: {
        vehicles: [{ id: 17, isActive: true }],
        poolEnergy: 1000,
        minEnergy: 10,
      },
    } as never);

    const inv = await getDeployInventory(ctx, csrf, 1, 72, 1);

    expect(inv.skinId).toBe(17);
    expect(inv.poolEnergy).toBe(1000);
    expect(inv.hasNoWeaponOption).toBe(false);
    expect(inv.damagePerHitByQuality).toEqual({});
    expect(inv.minEnergy).toBe(10);
  });

  it('defaults minEnergy to 10 when missing from response', async () => {
    apiCallMock.mockResolvedValueOnce({
      body: {
        weapons: [{ quality: -1, amount: null, damageperHit: 50 }],
        poolEnergy: 500,
        // no minEnergy
      },
    } as never);

    const inv = await getDeployInventory(ctx, csrf, 1, 72, 1);

    expect(inv.minEnergy).toBe(10);
    expect(inv.damagePerHitByQuality).toEqual({ [-1]: 50 });
  });

  it('skips weapons without damageperHit (defensive against partial data)', async () => {
    apiCallMock.mockResolvedValueOnce({
      body: {
        weapons: [
          { quality: -1, amount: null },               // no damageperHit
          { quality: 7, amount: 100, damageperHit: 500 },
        ],
        poolEnergy: 0,
      },
    } as never);

    const inv = await getDeployInventory(ctx, csrf, 1, 72, 1);

    expect(inv.damagePerHitByQuality).toEqual({ 7: 500 });
  });

  it('defaults poolEnergy to 0 and skinId to null when fields are missing', async () => {
    apiCallMock.mockResolvedValueOnce({
      body: {},
    } as never);

    const inv = await getDeployInventory(ctx, csrf, 1, 72, 1);

    expect(inv.skinId).toBeNull();
    expect(inv.poolEnergy).toBe(0);
    expect(inv.hasNoWeaponOption).toBe(false);
    expect(inv.minEnergy).toBe(10);
    expect(inv.damagePerHitByQuality).toEqual({});
  });
});
