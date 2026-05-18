import type { WeeklyFuelState } from '../memory/weeklyFuelState.js';
import { weekElapsedFraction } from '../erepublik/week.js';

/** Weekly fuel budget — spread mode (D1-D3, level <70). See [[fuel-economy]]. */
export const WEEKLY_BUDGET = 70;
/**
 * Q-1 no-weapon hits cost 33 energy each, two sides per battle.
 *
 * NOTE: this constant is **Standard-strategy-specific**. D4-TW (Phase 5) and
 * Maverick-D3-with-bombs (Phase 6) have very different per-battle energy
 * profiles (≈2000–5000 and ≈0 respectively). Before those strategies merge,
 * `decideFarming` must source this number from the active strategy
 * (`estimateEnergyPerBattle()`) instead of using this constant. See
 * `docs/superpowers/specs/2026-05-16-flexible-farming-config-design.md` §3.3.
 */
export const ENERGY_PER_BATTLE = 66;

/**
 * Default soft cap on battles within a single farm session, used when the
 * caller doesn't supply `FarmInputs.maxBattlesPerSession`. The live runner
 * sources this from `settings.emptyDiv.maxBattlesPerSession`, which is
 * UI-editable and `.env`-seedable via `ERP_EMPTY_DIV_MAX_BATTLES_PER_SESSION`.
 */
export const DEFAULT_MAX_BATTLES_PER_SESSION = 3;

/** Allow exceeding pace target by this many barrels before pumping the brakes. */
const PACE_OVERSHOOT_TOLERANCE = 5;

/**
 * Default cooldown range between farm sessions (in minutes). Persisted in
 * `nextEligibleAt`. Overridable via `settings.farmSession.cooldown{Min,Max}Minutes`
 * or `ERP_SESSION_COOLDOWN_{MIN,MAX}_MIN` env vars on first run.
 */
export const SESSION_COOLDOWN_MIN_MIN = 30;
export const SESSION_COOLDOWN_MAX_MIN = 90;

export interface FarmInputs {
  weekly: WeeklyFuelState;
  /** From `getDeployInventory` — current pool energy in points. */
  poolEnergy: number;
  /** From `getDeployInventory` — barrels of vehicle fuel in inventory. */
  fuelInInventory: number;
  /**
   * Hard cap on battles attempted in a single session. Runner passes
   * `settings.emptyDiv.maxBattlesPerSession`; falls back to
   * `DEFAULT_MAX_BATTLES_PER_SESSION` when omitted.
   */
  maxBattlesPerSession?: number;
  /** Defaults to `new Date()` — pass explicit Date for tests. */
  now?: Date;
}

export interface FarmDecision {
  shouldFarm: boolean;
  reason: string;
  /** Battles to attempt this session. 0 when shouldFarm=false. */
  battlesThisSession: number;
  /** For logging / digest. */
  diagnostics: {
    target: number;
    spent: number;
    ahead: number;
    remaining: number;
    weekFraction: number;
  };
}

/**
 * Pure decision function: given current state and inputs, returns whether to farm
 * and how many battles to attempt. Does not mutate state — the runner mutates
 * `WeeklyFuelState` after a session completes (or after a deliberate skip).
 */
export function decideFarming(inputs: FarmInputs): FarmDecision {
  const now = inputs.now ?? new Date();

  const weekFraction = weekElapsedFraction(now);
  const target = Math.floor(WEEKLY_BUDGET * weekFraction);
  const spent = inputs.weekly.spent;
  const ahead = spent - target;
  const remaining = WEEKLY_BUDGET - spent;

  const diagnostics = { target, spent, ahead, remaining, weekFraction };
  const no = (reason: string): FarmDecision => ({
    shouldFarm: false,
    reason,
    battlesThisSession: 0,
    diagnostics,
  });

  // ── Hard stops ─────────────────────────────────────────────────────────────
  if (remaining <= 0) return no(`weekly budget exhausted (${spent}/${WEEKLY_BUDGET})`);
  if (inputs.fuelInInventory <= 0) return no('no fuel barrels in inventory');
  if (inputs.poolEnergy < ENERGY_PER_BATTLE) {
    return no(`pool energy ${inputs.poolEnergy} < ${ENERGY_PER_BATTLE} (one battle)`);
  }

  // ── Cooldown jitter (set at end of previous session) ───────────────────────
  if (inputs.weekly.nextEligibleAt) {
    const eligibleMs = Date.parse(inputs.weekly.nextEligibleAt);
    if (Number.isFinite(eligibleMs) && now.getTime() < eligibleMs) {
      const waitMin = (eligibleMs - now.getTime()) / 60_000;
      return no(`cooldown: ${waitMin.toFixed(0)}m until next eligible`);
    }
  }

  // ── Pacing brake ───────────────────────────────────────────────────────────
  if (ahead >= PACE_OVERSHOOT_TOLERANCE) {
    return no(`ahead of pace (+${ahead} vs target ${target}); letting it equalize`);
  }

  // ── Session size ───────────────────────────────────────────────────────────
  const energyBudget = Math.floor(inputs.poolEnergy / ENERGY_PER_BATTLE);
  const fuelBudget = Math.min(inputs.fuelInInventory, remaining);
  // If we're behind pace, allow a small catch-up; otherwise just stay on rhythm.
  const paceBudget = Math.max(1, target - spent + 2);
  const sessionCap = Math.max(
    1,
    Math.floor(inputs.maxBattlesPerSession ?? DEFAULT_MAX_BATTLES_PER_SESSION),
  );
  const battlesThisSession = Math.min(sessionCap, energyBudget, fuelBudget, paceBudget);

  if (battlesThisSession <= 0) return no('session size rounded to 0');

  return {
    shouldFarm: true,
    reason: `pace: spent=${spent}/target=${target} (${ahead >= 0 ? '+' : ''}${ahead}), session=${battlesThisSession}`,
    battlesThisSession,
    diagnostics,
  };
}

/**
 * After a session ends (success OR forced stop), pick the next eligibility
 * timestamp. Caller should persist this on `WeeklyFuelState.nextEligibleAt`.
 */
export interface CooldownConfig {
  minMinutes?: number;
  maxMinutes?: number;
}

export function rollNextEligibleAt(
  now: Date = new Date(),
  rng: () => number = Math.random,
  config: CooldownConfig = {},
): string {
  const minMin = Math.max(0, config.minMinutes ?? SESSION_COOLDOWN_MIN_MIN);
  const maxMinRaw = Math.max(0, config.maxMinutes ?? SESSION_COOLDOWN_MAX_MIN);
  const maxMin = Math.max(minMin, maxMinRaw);
  const minMs = minMin * 60_000;
  const maxMs = maxMin * 60_000;
  const jitterMs = minMs + rng() * (maxMs - minMs);
  return new Date(now.getTime() + jitterMs).toISOString();
}
