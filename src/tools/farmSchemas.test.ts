import { describe, it, expect } from 'vitest';
import {
  RawDeployInventorySchema,
  RawDeployResponseSchema,
  parseDeployInventory,
  parseDeployResponse,
} from './farmSchemas.js';

describe('RawDeployInventorySchema', () => {
  it('accepts a full server response', () => {
    const r = RawDeployInventorySchema.safeParse({
      weapons: [
        { quality: -1, amount: null, damageperHit: 143 },
        { quality: 5, amount: 1169, damageperHit: 286 },
      ],
      vehicles: [
        { id: 30, isActive: true },
        { id: 40, isActive: false },
      ],
      poolEnergy: 6654,
      minEnergy: 10,
    });
    expect(r.success).toBe(true);
  });

  it('accepts an empty object (all fields are optional)', () => {
    expect(RawDeployInventorySchema.safeParse({}).success).toBe(true);
  });

  it('accepts a partial response with only some weapons', () => {
    const r = RawDeployInventorySchema.safeParse({
      weapons: [{ quality: 7, amount: 100, damageperHit: 500 }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects entirely-malformed responses (non-object root)', () => {
    expect(RawDeployInventorySchema.safeParse('not-an-object').success).toBe(false);
    expect(RawDeployInventorySchema.safeParse(42).success).toBe(false);
    expect(RawDeployInventorySchema.safeParse(null).success).toBe(false);
  });

  it('rejects responses where poolEnergy has the wrong type', () => {
    const r = RawDeployInventorySchema.safeParse({ poolEnergy: 'a-lot' });
    expect(r.success).toBe(false);
  });

  it('allows unknown extra fields (passthrough)', () => {
    const r = RawDeployInventorySchema.safeParse({
      poolEnergy: 100,
      newFutureField: 'whatever',
    });
    expect(r.success).toBe(true);
  });
});

describe('RawDeployResponseSchema', () => {
  it('accepts a successful deploy response', () => {
    const r = RawDeployResponseSchema.safeParse({
      error: false,
      deploymentId: 12345,
      data: { fuelLeft: 60 },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a failed deploy response with message only', () => {
    const r = RawDeployResponseSchema.safeParse({
      error: true,
      message: 'not enough energy',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a failed deploy response where data is explicitly null', () => {
    // Real-world eRepublik shape on failures (e.g. "wall already conquered",
    // "not enough energy"). Rejecting this used to throw a misleading
    // "API format changed" and bypass the retry/verify recovery path.
    const r = RawDeployResponseSchema.safeParse({
      error: true,
      message: 'Wall already conquered',
      data: null,
    });
    expect(r.success).toBe(true);
  });

  it('rejects responses missing the required `error` flag', () => {
    expect(RawDeployResponseSchema.safeParse({ message: 'hi' }).success).toBe(false);
  });

  it('rejects responses where `error` is the wrong type', () => {
    expect(RawDeployResponseSchema.safeParse({ error: 'no' }).success).toBe(false);
  });
});

describe('parseDeployInventory', () => {
  it('returns parsed data on a valid body', () => {
    const data = parseDeployInventory({ poolEnergy: 100, minEnergy: 10 });
    expect(data.poolEnergy).toBe(100);
  });

  it('throws an informative error with the source path on schema failure', () => {
    expect(() => parseDeployInventory({ poolEnergy: 'huge' })).toThrow(
      /eRepublik API format changed/i,
    );
    expect(() => parseDeployInventory({ poolEnergy: 'huge' })).toThrow(/poolEnergy/);
  });
});

describe('parseDeployResponse', () => {
  it('returns parsed data on a valid body', () => {
    const data = parseDeployResponse({ error: false, deploymentId: 1 });
    expect(data.error).toBe(false);
  });

  it('throws an informative error on schema failure', () => {
    expect(() => parseDeployResponse({ message: 'no error flag' })).toThrow(
      /eRepublik API format changed/i,
    );
  });
});
