import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadWeekly, saveWeekly } from './weeklyState.js';

describe('weeklyState', () => {
  let tmpRoot: string;
  let originalRoot: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'erp-weekly-'));
    originalRoot = process.env.ERP_ROOT;
    process.env.ERP_ROOT = tmpRoot;
    mkdirSync(join(tmpRoot, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.ERP_ROOT;
    else process.env.ERP_ROOT = originalRoot;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns empty state when no file exists', () => {
    expect(loadWeekly()).toEqual({ lastClaimedRewardId: null });
  });

  it('round-trips a saved state', () => {
    saveWeekly({ lastClaimedRewardId: 42 });
    expect(loadWeekly()).toEqual({ lastClaimedRewardId: 42 });
  });

  it('writes atomically (no tmp file left behind)', () => {
    saveWeekly({ lastClaimedRewardId: 7 });
    const entries = readdirSync(join(tmpRoot, 'sessions'));
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('quarantines an empty file and recovers with empty state', () => {
    const file = join(tmpRoot, 'sessions', 'weekly-state.json');
    writeFileSync(file, '');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const state = loadWeekly();
      expect(state).toEqual({ lastClaimedRewardId: null });
      const quarantined = readdirSync(join(tmpRoot, 'sessions')).filter((n) =>
        n.startsWith('weekly-state.json.corrupted-'),
      );
      expect(quarantined).toHaveLength(1);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('quarantines a NUL-filled file', () => {
    const file = join(tmpRoot, 'sessions', 'weekly-state.json');
    writeFileSync(file, '\0\0\0\0');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const state = loadWeekly();
      expect(state).toEqual({ lastClaimedRewardId: null });
      const quarantined = readdirSync(join(tmpRoot, 'sessions')).filter((n) =>
        n.startsWith('weekly-state.json.corrupted-'),
      );
      expect(quarantined).toHaveLength(1);
      expect(readFileSync(join(tmpRoot, 'sessions', quarantined[0]), 'utf8')).toBe('\0\0\0\0');
    } finally {
      warn.mockRestore();
    }
  });
});
