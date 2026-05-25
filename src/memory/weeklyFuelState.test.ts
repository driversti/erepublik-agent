import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadFuel, saveFuel, reconcileSpentWithInventory, type WeeklyFuelState } from './weeklyFuelState.js';
import { eRepublikWeek } from '../erepublik/week.js';

function fresh(overrides: Partial<WeeklyFuelState> = {}): WeeklyFuelState {
  return {
    week: 963,
    spent: 0,
    hitsLanded: 0,
    lastFarmedAt: null,
    nextEligibleAt: null,
    cyclesSkipped: 0,
    weekStartInventory: null,
    ...overrides,
  };
}

describe('reconcileSpentWithInventory', () => {
  it('locks weekStartInventory on the first cycle and reports baselineSet', () => {
    const r = reconcileSpentWithInventory(fresh(), 70);
    expect(r.baselineSet).toBe(true);
    expect(r.state.weekStartInventory).toBe(70);
    expect(r.state.spent).toBe(0);
    expect(r.externalBurnDetected).toBe(0);
  });

  it('does not reset baseline on subsequent cycles', () => {
    const r = reconcileSpentWithInventory(
      fresh({ weekStartInventory: 70, spent: 5 }),
      60,
    );
    expect(r.baselineSet).toBe(false);
    expect(r.state.weekStartInventory).toBe(70);
  });

  it('catches manual out-of-band fuel usage and bumps spent', () => {
    // Baseline 70, agent thinks it spent 5, but inventory shows only 50 left.
    // → real consumption is 20; 15 of it happened outside the agent.
    const r = reconcileSpentWithInventory(
      fresh({ weekStartInventory: 70, spent: 5 }),
      50,
    );
    expect(r.state.spent).toBe(20);
    expect(r.externalBurnDetected).toBe(15);
  });

  it('does not double-count when agent-tracked spent matches inventory delta', () => {
    const r = reconcileSpentWithInventory(
      fresh({ weekStartInventory: 70, spent: 20 }),
      50,
    );
    expect(r.state.spent).toBe(20);
    expect(r.externalBurnDetected).toBe(0);
  });

  it('does not decrease spent if inventory grew (mid-week purchase)', () => {
    // Started week with 70, agent burned 10 (spent=10), then bought 30 more.
    // Inventory now 90. baseline-current = 70-90 = -20 (negative, clamped to 0).
    // spent must remain 10.
    const r = reconcileSpentWithInventory(
      fresh({ weekStartInventory: 70, spent: 10 }),
      90,
    );
    expect(r.state.spent).toBe(10);
    expect(r.externalBurnDetected).toBe(0);
  });

  it('treats an immediate inventory drop on first cycle as zero external burn', () => {
    // First cycle locks baseline = current; spent stays 0.
    const r = reconcileSpentWithInventory(fresh({ spent: 0 }), 25);
    expect(r.state.weekStartInventory).toBe(25);
    expect(r.state.spent).toBe(0);
    expect(r.externalBurnDetected).toBe(0);
  });
});

describe('loadFuel / saveFuel', () => {
  let tmpRoot: string;
  let originalRoot: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'erp-fuel-'));
    originalRoot = process.env.ERP_ROOT;
    process.env.ERP_ROOT = tmpRoot;
    mkdirSync(join(tmpRoot, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.ERP_ROOT;
    else process.env.ERP_ROOT = originalRoot;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('round-trips state and writes atomically', () => {
    const week = eRepublikWeek();
    saveFuel({
      week,
      spent: 12,
      hitsLanded: 6,
      lastFarmedAt: '2026-05-25T10:00:00.000Z',
      nextEligibleAt: '2026-05-25T11:00:00.000Z',
      cyclesSkipped: 2,
      weekStartInventory: 70,
    });
    const { state, rolledOver } = loadFuel();
    expect(rolledOver).toBe(false);
    expect(state.spent).toBe(12);
    expect(state.hitsLanded).toBe(6);
    expect(readdirSync(join(tmpRoot, 'sessions')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('returns empty state when no file exists', () => {
    const { state, rolledOver } = loadFuel();
    expect(rolledOver).toBe(false);
    expect(state.spent).toBe(0);
    expect(state.hitsLanded).toBe(0);
  });

  it('quarantines an empty state file and recovers with empty state', () => {
    const file = join(tmpRoot, 'sessions', 'weekly-fuel-state.json');
    writeFileSync(file, '');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { state, rolledOver } = loadFuel();
      expect(rolledOver).toBe(false);
      expect(state.spent).toBe(0);
      const quarantined = readdirSync(join(tmpRoot, 'sessions')).filter((n) =>
        n.startsWith('weekly-fuel-state.json.corrupted-'),
      );
      expect(quarantined).toHaveLength(1);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('quarantines a NUL-filled file', () => {
    const file = join(tmpRoot, 'sessions', 'weekly-fuel-state.json');
    writeFileSync(file, '\0\0\0\0');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { state } = loadFuel();
      expect(state.spent).toBe(0);
      const quarantined = readdirSync(join(tmpRoot, 'sessions')).filter((n) =>
        n.startsWith('weekly-fuel-state.json.corrupted-'),
      );
      expect(quarantined).toHaveLength(1);
      expect(readFileSync(join(tmpRoot, 'sessions', quarantined[0]), 'utf8')).toBe('\0\0\0\0');
    } finally {
      warn.mockRestore();
    }
  });

  it('archives the prior week atomically on rollover', () => {
    const week = eRepublikWeek();
    // Pretend a week has passed since this file was written.
    saveFuel({
      week: week - 1,
      spent: 50,
      hitsLanded: 25,
      lastFarmedAt: null,
      nextEligibleAt: null,
      cyclesSkipped: 0,
      weekStartInventory: 70,
    });

    const { rolledOver, state } = loadFuel();
    expect(rolledOver).toBe(true);
    expect(state.week).toBe(week);
    expect(state.spent).toBe(0);

    const entries = readdirSync(join(tmpRoot, 'sessions'));
    expect(entries).toContain(`weekly-fuel-${week - 1}.archive.json`);
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});
