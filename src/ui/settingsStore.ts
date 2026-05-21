import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir } from '../paths.js';

// ── Schema (matches spec §4.1) ──────────────────────────────────────────────

const StrategyId = z.enum(['standard', 'd4tw', 'maverickD3', 'd4tw-air']);

const D4TWSettings = z.object({
  targetDamageAttacker: z.number().int().positive().default(130_000_000),
  targetDamageDefender: z.number().int().positive().default(220_000_000),
  maxBattlesPerSession: z.number().int().min(1).max(10).default(1),
  weaponPriority: z.array(z.number().int().min(1).max(7)).default([7, 6, 5, 4, 3, 2, 1]),
  /**
   * Game minimum energy for a normal-weapon / bare-hands deploy in D4. Used
   * as the floor when `hitsNeeded * energyPerHit` is lower. Hard-coded as 30
   * by the eRepublik client; exposed here for emergency overrides only.
   */
  minDeployEnergy: z.number().int().min(1).default(30),
});

const D4TWAirSettings = z.object({
  targetDamageAttacker: z.number().int().positive().default(30_000),
  targetDamageDefender: z.number().int().positive().default(50_000),
  maxBattlesPerSession: z.number().int().min(1).max(10).default(1),
  useWeapon: z.boolean().default(false),
  weaponPriority: z.array(z.number().int().min(1).max(5)).default([5, 4, 3, 2, 1]),
  /** Same as D4TW.minDeployEnergy; documented inline for symmetry. */
  minDeployEnergy: z.number().int().min(1).default(30),
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

const WorkOvertimeSettings = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(['once-per-day', 'when-available']).default('once-per-day'),
});

const BuyGoldSettings = z.object({
  enabled: z.boolean().default(false),
  amount: z.number().int().min(0).max(10).default(10),
});

const DetectedState = z.object({
  division: z.number().int().nullable().default(null),
  hasMaverick: z.boolean().nullable().default(null),
  airRankNumber: z.number().int().nullable().default(null),
  citizenId: z.number().int().nullable().default(null),
  countryId: z.number().int().nullable().default(null),
  lastUpdated: z.string().nullable().default(null),
});

export const Settings = z.object({
  paused: z.boolean().default(false),
  farmEnabled: z.boolean().default(true),
  // Auto-apply for the highest-salary job in the citizen's country before
  // attempting the daily `work` action when the citizen is unemployed.
  autoEmploy: z.boolean().default(true),
  modeOverride: StrategyId.nullable().default(null),
  maverickManual: z.boolean().nullable().default(null),
  /**
   * Weekly cap on fuel barrels burned by the integrated farm gate. Default
   * 70 matches spread-mode farming (D1-D3, level < 70). Lifts to ~140 for
   * D11 air-only farming at level 70+. See [[fuel-economy]] in user memory.
   */
  weeklyFuelBudget: z.number().int().min(1).default(70),
  /**
   * Per-battle energy floor used by the Standard / empty-div strategy. The
   * gate refuses to fight when `poolEnergy < energyPerBattleStandard`. Set
   * to 66 because two Q-1 no-weapon hits cost 33 energy each, two sides.
   * Strategies with different per-battle cost (d4tw-air ≈30) pass their own
   * value via `decideFarming.minEnergyPerBattle`.
   */
  energyPerBattleStandard: z.number().int().min(1).default(66),
  d4tw: D4TWSettings.default(() => ({
    targetDamageAttacker: 130_000_000,
    targetDamageDefender: 220_000_000,
    maxBattlesPerSession: 1,
    weaponPriority: [7, 6, 5, 4, 3, 2, 1],
    minDeployEnergy: 30,
  })),
  d4twAir: D4TWAirSettings.default(() => ({
    targetDamageAttacker: 30_000,
    targetDamageDefender: 50_000,
    maxBattlesPerSession: 1,
    useWeapon: false,
    weaponPriority: [5, 4, 3, 2, 1],
    minDeployEnergy: 30,
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
  workOvertime: WorkOvertimeSettings.default(() => ({
    enabled: true,
    mode: 'once-per-day' as const,
  })),
  buyGold: BuyGoldSettings.default(() => ({ enabled: false, amount: 10 })),
  detected: DetectedState.default(() => ({
    division: null,
    hasMaverick: null,
    airRankNumber: null,
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

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  const norm = v.trim().toLowerCase();
  if (norm === 'true' || norm === '1' || norm === 'yes') return true;
  if (norm === 'false' || norm === '0' || norm === 'no') return false;
  return fallback;
}

/**
 * Build the initial settings object on first run, sourcing migrated values
 * from .env when present. Keys not in .env fall through to schema defaults.
 */
function buildInitial(): Settings {
  return Settings.parse({
    autoEmploy: envBool('ERP_AUTO_EMPLOY', true),
    emptyDiv: {
      maxBattlesPerSession: envNum('ERP_EMPTY_DIV_MAX_BATTLES_PER_SESSION', 3),
    },
    d4tw: {
      maxBattlesPerSession: envNum('ERP_D4TW_MAX_BATTLES_PER_SESSION', 1),
    },
    travel: {
      maxTravelCC: envNum('ERP_FARM_MAX_TRAVEL_CC', 100),
      returnHomeAfterMinutes: envNum('ERP_RETURN_HOME_AFTER_MINUTES', 15),
      returnHomeMaxCC: envNum('ERP_RETURN_HOME_MAX_CC', 500),
    },
    farmSession: {
      cooldownMinMinutes: envNum('ERP_SESSION_COOLDOWN_MIN_MIN', 30),
      cooldownMaxMinutes: envNum('ERP_SESSION_COOLDOWN_MAX_MIN', 90),
    },
    buyGold: {
      enabled: envBool('ERP_BUY_GOLD_ENABLED', false),
      amount: envNum('ERP_BUY_GOLD_AMOUNT', 10),
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
