import type { BrowserContext } from 'playwright-core';
import type { InventoryWeapon } from './inventory.js';

// ── Shared types ────────────────────────────────────────────────────────────

export interface FarmSessionInfo {
  csrf: string;
  citizenId: number;
  countryId: number;
  division: number;
  residenceRegionId: number;
  residenceCountryId: number;
  /** Citizen military strength (from SERVER_DATA). Null if unavailable. */
  strength: number | null;
  /** Numeric rank (0-based progression value). Null if unavailable. */
  rankNumber: number | null;
  /** Aircraft rank number (1+). Null when profile fetch failed or field missing. */
  airRankNumber: number | null;
  /** Whether the citizen has the Maverick perk active. Null if unavailable. */
  hasMaverick: boolean | null;
  /** Country ID of the citizen's current physical location. Null if unavailable. */
  currentCountryId: number | null;
}

export interface FarmSessionOptions {
  /** Cap on battles to fight this session (gate-supplied). Hard cap. */
  maxBattles: number;
  /** When true, plan but never deploy. */
  dryRun?: boolean;
  maxTravelCC?: number;
  minFuel?: number;
  minBattleMinutes?: number;
  blockedCountries?: number[];
  whitelistCountries?: number[];
  weaponQuality?: number;
  totalEnergy?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  handoffSleepMs?: number;
  /**
   * Pre-loaded inventory snapshot from the runner. When supplied, strategies
   * SHOULD use it instead of issuing their own `/economy/inventory-json` GET,
   * to keep the per-cycle HTTP budget small. Strategies that need fresher
   * data may still re-fetch — the contract is "use if present, fetch if not".
   */
  preloadedInventory?: InventoryWeapon[];
  /** Retry budget for the side-B travel hop (medal-critical). */
  travelBRetryAttempts?: number;
  travelBRetryDelayMs?: number;
  /**
   * Sleep between battle iterations. Avoids the server's ~3s travel
   * rate-limit ("Travelling too fast. Try again in 3 second(s).") when one
   * battle's last travel and the next battle's first travel fire back-to-back.
   * Skipped on the first iteration.
   */
  interBattleSleepMs?: number;
  /** Optional notifier — invoked on partial-battle (side A landed, side B failed). */
  notify?: (msg: string) => void | Promise<void>;
}

export interface SideOutcome {
  side: 'invader' | 'defender';
  countryId: number;
  attempts: number;
  verified: boolean;
  fuelLeft: number | null;
  deploymentId: number | null;
}

export interface WinSummary {
  battleId: number;
  regionName: string;
  inv: SideOutcome;
  def: SideOutcome;
}

export interface SkipSummary {
  battleId: number;
  regionName: string;
  reason: string;
}

export type StopReason =
  | 'completed'
  | 'max-battles'
  | 'low-fuel'
  | 'low-energy'
  | 'forbidden'
  | 'energy-exhausted'
  | 'no-reachable'
  | 'no-candidates';

export interface FarmSessionResult {
  farmedCount: number;
  wins: WinSummary[];
  skipped: SkipSummary[];
  stopReason: StopReason;
  fuelLeftAtEnd: number | null;
  poolEnergyAtEnd: number | null;
  totalTravelCC: number;
  hops: number;
  sequence: string;
}

// ── Errors ──────────────────────────────────────────────────────────────────
// Classes themselves live in `src/transport/errors.ts` so `apiCall.ts` can
// throw `ForbiddenError` on HTTP 403 without creating an import cycle through
// the strategy layer. We re-export here to preserve the existing public surface
// (`./types.js`) for all existing strategy imports.

export {
  ForbiddenError,
  EnergyExhaustedError,
  PartialBattleError,
} from '../../transport/errors.js';

// ── Strategy interface ──────────────────────────────────────────────────────

export type StrategyId = 'standard' | 'd4tw' | 'maverickD3' | 'd4tw-air';

export interface FarmStrategy {
  readonly id: StrategyId;
  run(
    ctx: BrowserContext,
    info: FarmSessionInfo,
    options: FarmSessionOptions,
  ): Promise<FarmSessionResult>;
}
