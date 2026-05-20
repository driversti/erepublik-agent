import { describe, it, expect } from 'vitest';
import { resolveDoubleSidedOpts } from './doubleSidedEngine.js';
import type { FarmSessionOptions } from './types.js';

describe('resolveDoubleSidedOpts', () => {
  it('uses opts values over env when both are present', () => {
    process.env.ERP_FARM_MAX_TRAVEL_CC = '999';
    try {
      const cfg = resolveDoubleSidedOpts({ maxBattles: 5, maxTravelCC: 300 } as FarmSessionOptions);
      expect(cfg.maxTravelCC).toBe(300);
    } finally {
      delete process.env.ERP_FARM_MAX_TRAVEL_CC;
    }
  });

  it('falls back to env var when opts.maxTravelCC is undefined', () => {
    process.env.ERP_FARM_MAX_TRAVEL_CC = '550';
    try {
      const cfg = resolveDoubleSidedOpts({ maxBattles: 5 } as FarmSessionOptions);
      expect(cfg.maxTravelCC).toBe(550);
    } finally {
      delete process.env.ERP_FARM_MAX_TRAVEL_CC;
    }
  });

  it('uses default (400) when neither opts nor env is set', () => {
    delete process.env.ERP_FARM_MAX_TRAVEL_CC;
    const cfg = resolveDoubleSidedOpts({ maxBattles: 5 } as FarmSessionOptions);
    expect(cfg.maxTravelCC).toBe(400);
  });

  it('parses blocked / whitelist CSV from env', () => {
    process.env.ERP_FARM_BLOCKED_COUNTRIES = '10,20, 30';
    process.env.ERP_FARM_WHITELIST_COUNTRIES = '99,100';
    try {
      const cfg = resolveDoubleSidedOpts({ maxBattles: 1 } as FarmSessionOptions);
      expect(cfg.blockedCountries).toEqual([10, 20, 30]);
      expect(cfg.whitelistCountries).toEqual([99, 100]);
    } finally {
      delete process.env.ERP_FARM_BLOCKED_COUNTRIES;
      delete process.env.ERP_FARM_WHITELIST_COUNTRIES;
    }
  });

  it('preserves opts.notify when supplied', () => {
    const notify = (_m: string) => undefined;
    const cfg = resolveDoubleSidedOpts({ maxBattles: 1, notify } as FarmSessionOptions);
    expect(cfg.notify).toBe(notify);
  });

  it('defaults interBattleSleepMs to 5000 and honors env + opts overrides', () => {
    delete process.env.ERP_FARM_INTER_BATTLE_SLEEP_MS;
    expect(
      resolveDoubleSidedOpts({ maxBattles: 1 } as FarmSessionOptions).interBattleSleepMs,
    ).toBe(5000);

    process.env.ERP_FARM_INTER_BATTLE_SLEEP_MS = '7500';
    try {
      expect(
        resolveDoubleSidedOpts({ maxBattles: 1 } as FarmSessionOptions).interBattleSleepMs,
      ).toBe(7500);
      // opts override beats env
      expect(
        resolveDoubleSidedOpts({
          maxBattles: 1,
          interBattleSleepMs: 2000,
        } as FarmSessionOptions).interBattleSleepMs,
      ).toBe(2000);
    } finally {
      delete process.env.ERP_FARM_INTER_BATTLE_SLEEP_MS;
    }
  });
});
