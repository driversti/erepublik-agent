import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';

// --- Public types ------------------------------------------------------------

export interface DeployInventory {
  skinId: number | null;
  poolEnergy: number;
  hasNoWeaponOption: boolean;
  /** Server-reported minimum energy per hit (typically 10). */
  minEnergy: number;
  /** Map of weapon quality → server-reported damage per hit.
   *  Key -1 = bare hands. Keys 1-7 = corresponding quality (ground or air).
   *  Authoritative source — includes natural-enemy bonus, boosters, terrain,
   *  and division-specific scaling that our local formula does NOT model. */
  damagePerHitByQuality: Record<number, number>;
}

/**
 * Fallback skin per division when no active vehicle is enrolled (most common
 * for ground divisions). Documented in the monorepo CLAUDE.md.
 */
export const DIVISION_SKIN: Record<number, number> = {
  1: 14,
  2: 15,
  3: 16,
  4: 17,
  11: 18,
};

export function skinForDivision(division: number): number {
  return DIVISION_SKIN[division] ?? 14;
}

export interface TravelOption {
  toCountryId: number;
  toRegionId: number;
  cost: number;
}

export interface DeployResult {
  success: boolean;
  fuelLeft: number | null;
  message: string;
  deploymentId: number | null;
}

export interface TravelResult {
  success: boolean;
  message: string;
}

// --- Raw API shapes (only the parts we care about) --------------------------

interface RawWeapon {
  quality: number;
  amount: number | null;
  /** Server-computed damage per hit for this weapon. Note JSON key is
   *  `damageperHit` (lowercase second `p` — eRepublik camelCase quirk). */
  damageperHit?: number;
}

interface RawVehicle {
  id: number;
  isActive: boolean;
}

interface RawDeployInventory {
  weapons?: RawWeapon[];
  vehicles?: RawVehicle[];
  poolEnergy?: number;
  /** Server-reported minimum energy per hit (typically 10). */
  minEnergy?: number;
}

interface RawTravelDataRegion {
  id: number;
  cost: number;
  countryId?: number;
}

interface RawTravelData {
  countries?: Record<string, { regions?: number[] }>;
  regions?: Record<string, RawTravelDataRegion>;
}

interface RawDeployResponse {
  error: boolean;
  message?: string;
  deploymentId?: number;
  data?: {
    fuelLeft?: number;
  };
}

interface RawTravelResponse {
  error: boolean;
  message?: string;
}

interface RawBattleConsole {
  // Keyed by sideCountryId as string → { fighterData: { [n]: { citizenId, ... } } }
  [sideCountryId: string]: unknown;
}

// --- Helpers ----------------------------------------------------------------

/**
 * Fetch deploy inventory: tells us which weapons exist for this side/zone,
 * which vehicle is active (skinId), and how much pool energy we have.
 */
const battleReferer = (battleId: number) => `https://www.erepublik.com/en/military/battlefield/${battleId}`;

export async function getDeployInventory(
  ctx: BrowserContext,
  csrf: string,
  battleId: number,
  sideCountryId: number,
  battleZoneId: number,
): Promise<DeployInventory> {
  const { body } = await apiCall<RawDeployInventory>(ctx, {
    method: 'POST',
    path: '/en/military/fightDeploy-getInventory',
    csrf,
    referer: battleReferer(battleId),
    form: {
      battleId,
      sideCountryId,
      battleZoneId,
    },
  });

  const activeVehicle = body.vehicles?.find((v) => v.isActive);
  const weapons = body.weapons ?? [];
  const hasNoWeaponOption = weapons.some((w) => w.quality === -1);

  const damagePerHitByQuality: Record<number, number> = {};
  for (const w of weapons) {
    if (typeof w.quality === 'number' && typeof w.damageperHit === 'number') {
      damagePerHitByQuality[w.quality] = w.damageperHit;
    }
  }

  return {
    skinId: activeVehicle?.id ?? null,
    poolEnergy: typeof body.poolEnergy === 'number' ? body.poolEnergy : 0,
    hasNoWeaponOption,
    minEnergy: typeof body.minEnergy === 'number' ? body.minEnergy : 10,
    damagePerHitByQuality,
  };
}

/**
 * Find the cheapest region in `toCountryId` to land in for a given battle.
 *
 * Returns null if travelData has no regions for that country (cannot travel —
 * usually means the country is at war and the route is blocked, or the player
 * is already there).
 */
export async function findCheapestTravelRegion(
  ctx: BrowserContext,
  csrf: string,
  battleId: number,
  residenceRegionId: number,
  toCountryId: number,
): Promise<TravelOption | null> {
  const { body } = await apiCall<RawTravelData>(ctx, {
    method: 'POST',
    path: '/en/main/travelData',
    csrf,
    referer: battleReferer(battleId),
    form: {
      holdingId: 0,
      battleId,
      regionId: residenceRegionId,
    },
  });

  const country = body.countries?.[String(toCountryId)];
  if (!country?.regions?.length) return null;

  let best: TravelOption | null = null;
  for (const regionId of country.regions) {
    const region = body.regions?.[String(regionId)];
    if (!region) continue;
    if (!best || region.cost < best.cost) {
      best = {
        toCountryId,
        toRegionId: region.id,
        cost: region.cost,
      };
    }
  }
  return best;
}

/**
 * Travel to the chosen side within a battle context.
 *
 * Note the form key is `inRegionId` (used by the campaign farmer) — not
 * `toRegionId`. The eRepublik client uses both names in different controllers
 * and the campaign-side endpoint expects `inRegionId`.
 */
export async function battlefieldTravel(
  ctx: BrowserContext,
  csrf: string,
  battleId: number,
  battleZoneId: number,
  sideCountryId: number,
  toCountryId: number,
  inRegionId: number,
): Promise<TravelResult> {
  const { body } = await apiCall<RawTravelResponse>(ctx, {
    method: 'POST',
    path: '/en/main/battlefieldTravel',
    csrf,
    referer: battleReferer(battleId),
    form: {
      battleId,
      battleZoneId,
      sideCountryId,
      toCountryId,
      inRegionId,
    },
  });
  return {
    success: body.error === false,
    message: body.message ?? '',
  };
}

/**
 * Fire one hit with the chosen weapon. For medal-farming an empty division,
 * use `weaponQuality=-1` (no weapon) with `totalEnergy=33`.
 *
 * The API requires at least one entry in the nested `energySources[N]` array.
 * Declaring Q1 food with amount=0 signals "I won't consume food — pull from
 * pool energy instead". The actual pool consumption is reflected in the
 * response's `data.energyTotal`.
 */
export async function deployWeapon(
  ctx: BrowserContext,
  csrf: string,
  battleId: number,
  battleZoneId: number,
  sideCountryId: number,
  weaponQuality: number,
  totalEnergy: number,
  skinId: number,
): Promise<DeployResult> {
  const { body } = await apiCall<RawDeployResponse>(ctx, {
    method: 'POST',
    path: '/en/military/fightDeploy-startDeploy',
    csrf,
    referer: battleReferer(battleId),
    form: {
      battleId,
      battleZoneId,
      sideCountryId,
      weaponQuality,
      totalEnergy,
      skinId,
      'energySources[0][quality]': 1,
      'energySources[0][amount]': 0,
    },
  });
  return {
    success: body.error === false,
    fuelLeft: typeof body.data?.fuelLeft === 'number' ? body.data.fuelLeft : null,
    message: body.message ?? '',
    deploymentId: typeof body.deploymentId === 'number' ? body.deploymentId : null,
  };
}

/**
 * Cancels any in-progress deployment for this battle. Idempotent — if nothing
 * is active, the server returns success anyway (or a benign error we ignore).
 */
export async function cancelDeploy(
  ctx: BrowserContext,
  csrf: string,
  battleId: number,
): Promise<{ message: string; error: boolean }> {
  const { body } = await apiCall<{ error: boolean; message?: string }>(ctx, {
    method: 'POST',
    path: '/en/military/fightDeploy-cancelDeploy',
    csrf,
    referer: battleReferer(battleId),
    form: { battleId },
  });
  return { error: body.error === true, message: body.message ?? '' };
}

/**
 * Check the battle leaderboard to confirm our citizen registered a hit for the
 * given side. Used as a fallback when deploy returns an error but the hit may
 * have actually gone through.
 */
export async function verifyHitRegistered(
  ctx: BrowserContext,
  csrf: string,
  battleId: number,
  zoneId: number,
  division: number,
  battleZoneId: number,
  sideCountryId: number,
  citizenId: number,
): Promise<boolean> {
  const { body } = await apiCall<RawBattleConsole>(ctx, {
    method: 'POST',
    path: '/en/military/battle-console',
    csrf,
    referer: battleReferer(battleId),
    form: {
      battleId,
      zoneId,
      round: zoneId,
      division,
      battleZoneId,
      action: 'battleStatistics',
      type: 'damage',
      leftPage: 1,
      rightPage: 1,
    },
  });
  const sideEntry = body[String(sideCountryId)] as
    | { fighterData?: Record<string, { citizenId?: number }> }
    | undefined;
  const fighters = sideEntry?.fighterData;
  if (!fighters) return false;
  for (const f of Object.values(fighters)) {
    if (f?.citizenId === citizenId) return true;
  }
  return false;
}
