import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir } from '../paths.js';

// ── Schema (matches spec §4.1) ──────────────────────────────────────────────

const StrategyId = z.enum(['standard', 'd4tw', 'maverickD3']);

const D4TWSettings = z.object({
  targetDamageAttacker: z.number().int().positive().default(130_000_000),
  targetDamageDefender: z.number().int().positive().default(220_000_000),
  maxBattlesPerSession: z.number().int().min(1).max(10).default(1),
  weaponPriority: z.array(z.number().int().min(1).max(7)).default([7, 6, 5, 4, 3, 2, 1]),
});

const EmptyDivSettings = z.object({
  maxBattlesPerSession: z.number().int().min(1).max(10).default(3),
  nativeWeaponPriority: z.array(z.number().int().min(1).max(7)).default([7, 6, 5, 4, 3, 2, 1]),
  foreignWeaponPolicy: z.enum(['bomb-then-bazooka', 'no-weapon']).default('bomb-then-bazooka'),
});

const TravelSettings = z.object({
  maxTravelCC: z.number().int().nonnegative().default(100),
  returnHomeAfterMinutes: z.number().int().min(0).default(15),
  returnHomeMaxCC: z.number().int().positive().default(500),
});

const FarmSessionSettings = z
  .object({
    cooldownMinMinutes: z.number().int().min(0).default(30),
    cooldownMaxMinutes: z.number().int().min(0).default(90),
  })
  .refine((s) => s.cooldownMaxMinutes >= s.cooldownMinMinutes, {
    message: 'cooldownMaxMinutes must be >= cooldownMinMinutes',
    path: ['cooldownMaxMinutes'],
  });

const DetectedState = z.object({
  division: z.number().int().nullable().default(null),
  hasMaverick: z.boolean().nullable().default(null),
  citizenId: z.number().int().nullable().default(null),
  countryId: z.number().int().nullable().default(null),
  lastUpdated: z.string().nullable().default(null),
});

export const Settings = z.object({
  paused: z.boolean().default(false),
  farmEnabled: z.boolean().default(true),
  modeOverride: StrategyId.nullable().default(null),
  maverickManual: z.boolean().nullable().default(null),
  d4tw: D4TWSettings.default(() => ({
    targetDamageAttacker: 130_000_000,
    targetDamageDefender: 220_000_000,
    maxBattlesPerSession: 1,
    weaponPriority: [7, 6, 5, 4, 3, 2, 1],
  })),
  emptyDiv: EmptyDivSettings.default(() => ({
    maxBattlesPerSession: 3,
    nativeWeaponPriority: [7, 6, 5, 4, 3, 2, 1],
    foreignWeaponPolicy: 'bomb-then-bazooka' as const,
  })),
  travel: TravelSettings.default(() => ({
    maxTravelCC: 100,
    returnHomeAfterMinutes: 15,
    returnHomeMaxCC: 500,
  })),
  farmSession: FarmSessionSettings.default(() => ({
    cooldownMinMinutes: 30,
    cooldownMaxMinutes: 90,
  })),
  detected: DetectedState.default(() => ({
    division: null,
    hasMaverick: null,
    citizenId: null,
    countryId: null,
    lastUpdated: null,
  })),
});

export type Settings = z.infer<typeof Settings>;

/** Fully-defaulted settings object. Used as fallback when no file exists. */
export const DEFAULT_SETTINGS: Settings = Settings.parse({});

// ── Persistence ──────────────────────────────────────────────────────────────

function filePath(): string {
  return join(configDir(), 'settings.json');
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build the initial settings object on first run, sourcing migrated values
 * from .env when present. Keys not in .env fall through to schema defaults.
 */
function buildInitial(): Settings {
  return Settings.parse({
    travel: {
      maxTravelCC: envNum('ERP_FARM_MAX_TRAVEL_CC', 100),
      returnHomeAfterMinutes: envNum('ERP_RETURN_HOME_AFTER_MINUTES', 15),
      returnHomeMaxCC: envNum('ERP_RETURN_HOME_MAX_CC', 500),
    },
    farmSession: {
      cooldownMinMinutes: envNum('ERP_SESSION_COOLDOWN_MIN_MIN', 30),
      cooldownMaxMinutes: envNum('ERP_SESSION_COOLDOWN_MAX_MIN', 90),
    },
  });
}

export function loadSettings(): Settings {
  const file = filePath();
  if (!existsSync(file)) {
    const initial = buildInitial();
    writeFileSync(file, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return Settings.parse(raw);
}

/**
 * Atomic write: serialize to a temp file then rename over the target.
 * Rename is atomic on POSIX and Windows NTFS, so a concurrent reader either
 * sees the old file or the new one — never a torn write.
 */
export function saveSettings(settings: Settings): void {
  const validated = Settings.parse(settings);
  const file = filePath();
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(validated, null, 2), 'utf8');
  renameSync(tmp, file);
}
