import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SETTINGS, loadSettings, saveSettings, Settings } from './settingsStore.js';

describe('settingsStore', () => {
  let tmpRoot: string;
  let originalRoot: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'erp-settings-'));
    originalRoot = process.env.ERP_ROOT;
    process.env.ERP_ROOT = tmpRoot;
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.ERP_ROOT;
    else process.env.ERP_ROOT = originalRoot;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('loadSettings', () => {
    it('creates default settings file on first run', () => {
      const settings = loadSettings();
      expect(settings).toEqual(DEFAULT_SETTINGS);
      expect(existsSync(join(tmpRoot, 'config', 'settings.json'))).toBe(true);
    });

    it('returns previously saved settings on subsequent runs', () => {
      const first = loadSettings();
      const file = join(tmpRoot, 'config', 'settings.json');
      const written = JSON.parse(readFileSync(file, 'utf8'));
      written.paused = true;
      writeFileSync(file, JSON.stringify(written, null, 2));

      const second = loadSettings();
      expect(second.paused).toBe(true);
      expect(first.paused).toBe(false);
    });

    it('migrates ERP_RETURN_HOME_AFTER_MINUTES from .env on first run', () => {
      process.env.ERP_RETURN_HOME_AFTER_MINUTES = '7';
      try {
        const settings = loadSettings();
        expect(settings.travel.returnHomeAfterMinutes).toBe(7);
      } finally {
        delete process.env.ERP_RETURN_HOME_AFTER_MINUTES;
      }
    });

    it('migrates ERP_FARM_MAX_TRAVEL_CC from .env on first run', () => {
      process.env.ERP_FARM_MAX_TRAVEL_CC = '250';
      try {
        const settings = loadSettings();
        expect(settings.travel.maxTravelCC).toBe(250);
      } finally {
        delete process.env.ERP_FARM_MAX_TRAVEL_CC;
      }
    });

    it('migrates ERP_EMPTY_DIV_MAX_BATTLES_PER_SESSION from .env on first run', () => {
      process.env.ERP_EMPTY_DIV_MAX_BATTLES_PER_SESSION = '5';
      try {
        const settings = loadSettings();
        expect(settings.emptyDiv.maxBattlesPerSession).toBe(5);
      } finally {
        delete process.env.ERP_EMPTY_DIV_MAX_BATTLES_PER_SESSION;
      }
    });

    it('migrates ERP_D4TW_MAX_BATTLES_PER_SESSION from .env on first run', () => {
      process.env.ERP_D4TW_MAX_BATTLES_PER_SESSION = '4';
      try {
        const settings = loadSettings();
        expect(settings.d4tw.maxBattlesPerSession).toBe(4);
      } finally {
        delete process.env.ERP_D4TW_MAX_BATTLES_PER_SESSION;
      }
    });

    it('migrates ERP_RETURN_HOME_MAX_CC from .env on first run', () => {
      process.env.ERP_RETURN_HOME_MAX_CC = '1000';
      try {
        const settings = loadSettings();
        expect(settings.travel.returnHomeMaxCC).toBe(1000);
      } finally {
        delete process.env.ERP_RETURN_HOME_MAX_CC;
      }
    });

    it('ignores .env values once settings.json exists', () => {
      loadSettings(); // creates default file with returnHomeAfterMinutes=15
      process.env.ERP_RETURN_HOME_AFTER_MINUTES = '99';
      try {
        const settings = loadSettings();
        expect(settings.travel.returnHomeAfterMinutes).toBe(15);
      } finally {
        delete process.env.ERP_RETURN_HOME_AFTER_MINUTES;
      }
    });

    it('throws on malformed JSON rather than silently using defaults', () => {
      const file = join(tmpRoot, 'config', 'settings.json');
      loadSettings(); // create dir
      writeFileSync(file, 'not valid json {');
      expect(() => loadSettings()).toThrow();
    });

    it('throws on schema mismatch rather than silently using defaults', () => {
      const file = join(tmpRoot, 'config', 'settings.json');
      loadSettings();
      writeFileSync(file, JSON.stringify({ paused: 'yes please' }));
      expect(() => loadSettings()).toThrow();
    });
  });

  describe('saveSettings', () => {
    it('persists changes that loadSettings later reads', () => {
      const first = loadSettings();
      first.paused = true;
      first.d4tw.targetDamageAttacker = 150_000_000;
      saveSettings(first);

      const second = loadSettings();
      expect(second.paused).toBe(true);
      expect(second.d4tw.targetDamageAttacker).toBe(150_000_000);
    });

    it('rejects payloads that fail schema validation', () => {
      const s = loadSettings();
      // @ts-expect-error — intentional invalid value
      s.paused = 'yes';
      expect(() => saveSettings(s)).toThrow();
    });

    it('does not leave a temp file behind on success', () => {
      const s = loadSettings();
      saveSettings(s);
      // Temp file uses `.tmp` suffix; final file is settings.json
      const dirContents = readFileSync(join(tmpRoot, 'config', 'settings.json'), 'utf8');
      expect(dirContents.length).toBeGreaterThan(0);
      const tmpFile = join(tmpRoot, 'config', 'settings.json.tmp');
      expect(existsSync(tmpFile)).toBe(false);
    });
  });
});

describe('Settings d4twAir defaults', () => {
  it('parses an old settings.json without d4twAir', () => {
    const parsed = Settings.parse({
      paused: false,
      farmEnabled: true,
      modeOverride: null,
      maverickManual: null,
      // No d4twAir block
    });
    expect(parsed.d4twAir).toEqual({
      targetDamageAttacker: 30_000,
      targetDamageDefender: 50_000,
      maxBattlesPerSession: 1,
      useWeapon: false,
      weaponPriority: [5, 4, 3, 2, 1],
      minDeployEnergy: 30,
    });
  });

  it('accepts d4tw-air as a modeOverride', () => {
    const parsed = Settings.parse({ modeOverride: 'd4tw-air' });
    expect(parsed.modeOverride).toBe('d4tw-air');
  });

  it('rejects weaponPriority entries above 5', () => {
    expect(() =>
      Settings.parse({ d4twAir: { weaponPriority: [7, 6, 5] } }),
    ).toThrow();
  });

  it('detected.airRankNumber defaults to null', () => {
    const parsed = Settings.parse({});
    expect(parsed.detected.airRankNumber).toBeNull();
  });

  it('rejects targetDamageAttacker of 0', () => {
    expect(() => Settings.parse({ d4twAir: { targetDamageAttacker: 0 } })).toThrow();
  });

  it('rejects targetDamageDefender of -1', () => {
    expect(() => Settings.parse({ d4twAir: { targetDamageDefender: -1 } })).toThrow();
  });

  it('rejects maxBattlesPerSession of 0', () => {
    expect(() => Settings.parse({ d4twAir: { maxBattlesPerSession: 0 } })).toThrow();
  });

  it('rejects maxBattlesPerSession above 10', () => {
    expect(() => Settings.parse({ d4twAir: { maxBattlesPerSession: 11 } })).toThrow();
  });
});

describe('Settings.workOvertime', () => {
  it('has feature enabled by default in once-per-day mode', () => {
    expect(DEFAULT_SETTINGS.workOvertime.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.workOvertime.mode).toBe('once-per-day');
  });

  it('accepts both modes', () => {
    const a = Settings.parse({ ...DEFAULT_SETTINGS, workOvertime: { enabled: true, mode: 'once-per-day' } });
    const b = Settings.parse({ ...DEFAULT_SETTINGS, workOvertime: { enabled: true, mode: 'when-available' } });
    expect(a.workOvertime.mode).toBe('once-per-day');
    expect(b.workOvertime.mode).toBe('when-available');
  });

  it('rejects an unknown mode', () => {
    expect(() =>
      Settings.parse({ ...DEFAULT_SETTINGS, workOvertime: { enabled: true, mode: 'whenever-i-want' } }),
    ).toThrow();
  });
});
