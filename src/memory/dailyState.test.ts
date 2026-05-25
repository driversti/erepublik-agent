import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadOrInit, save } from './dailyState.js';
import { emptyState } from './schema.js';

describe('dailyState', () => {
  let tmpRoot: string;
  let originalRoot: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'erp-daily-'));
    originalRoot = process.env.ERP_ROOT;
    process.env.ERP_ROOT = tmpRoot;
    mkdirSync(join(tmpRoot, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.ERP_ROOT;
    else process.env.ERP_ROOT = originalRoot;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('loadOrInit', () => {
    it('creates a fresh state file when none exists', () => {
      const { state, rolledOver } = loadOrInit(6760);
      expect(state).toEqual(emptyState(6760));
      expect(rolledOver).toBe(false);
      expect(existsSync(join(tmpRoot, 'sessions', 'daily-state-6760.json'))).toBe(true);
    });

    it('returns the persisted state on subsequent calls', () => {
      const first = loadOrInit(6760).state;
      first.completedActions.work = { at: '2026-05-25T08:00:00.000Z', source: 'agent' };
      save(first);

      const { state } = loadOrInit(6760);
      expect(state.completedActions.work?.source).toBe('agent');
    });

    it('quarantines an empty state file and recovers with fresh state', () => {
      const file = join(tmpRoot, 'sessions', 'daily-state-6760.json');
      writeFileSync(file, '');

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { state, rolledOver } = loadOrInit(6760);
        expect(state).toEqual(emptyState(6760));
        expect(rolledOver).toBe(false);
        // Fresh state file rewritten in place.
        expect(JSON.parse(readFileSync(file, 'utf8')).eRepublikDay).toBe(6760);
        // Quarantine artifact left behind.
        const quarantined = readdirSync(join(tmpRoot, 'sessions')).filter((n) =>
          n.startsWith('daily-state-6760.json.corrupted-'),
        );
        expect(quarantined).toHaveLength(1);
        expect(warn).toHaveBeenCalledOnce();
      } finally {
        warn.mockRestore();
      }
    });

    it('quarantines a NUL-filled state file and recovers with fresh state', () => {
      const file = join(tmpRoot, 'sessions', 'daily-state-6760.json');
      writeFileSync(file, '\0\0\0\0\0\0\0');

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { state } = loadOrInit(6760);
        expect(state.eRepublikDay).toBe(6760);
        const quarantined = readdirSync(join(tmpRoot, 'sessions')).filter((n) =>
          n.startsWith('daily-state-6760.json.corrupted-'),
        );
        expect(quarantined).toHaveLength(1);
        expect(readFileSync(join(tmpRoot, 'sessions', quarantined[0]), 'utf8')).toBe('\0\0\0\0\0\0\0');
      } finally {
        warn.mockRestore();
      }
    });

    it('quarantines a state file containing non-DailyState JSON', () => {
      const file = join(tmpRoot, 'sessions', 'daily-state-6760.json');
      writeFileSync(file, '{"unrelated":true}');

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { state } = loadOrInit(6760);
        expect(state).toEqual(emptyState(6760));
        const quarantined = readdirSync(join(tmpRoot, 'sessions')).filter((n) =>
          n.startsWith('daily-state-6760.json.corrupted-'),
        );
        expect(quarantined).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('save', () => {
    it('does not leave a tmp file behind', () => {
      const { state } = loadOrInit(6760);
      save(state);
      const entries = readdirSync(join(tmpRoot, 'sessions'));
      expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    });
  });
});
