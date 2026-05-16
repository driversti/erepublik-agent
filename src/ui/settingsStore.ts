import { z } from 'zod';

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
