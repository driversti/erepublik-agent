import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';

// --- Public types ------------------------------------------------------------

export interface FarmableBattle {
  battleId: number;
  start: number;
  zoneId: number;
  regionName: string;
  invaderId: number;
  defenderId: number;
  battleZoneId: number;
  wallFor: number;
  wallDom: number;
  intensityScale: string;
}

export interface FarmableBattlesResult {
  userDivision: number;
  total: number;
  candidates: FarmableBattle[];
}

export interface CitizenBattleEligibility {
  battleId: number;
  isMercenary: boolean;
  isFreedomFighter: boolean;
  hasFoughtFor: number[];
}

export type CitizenEligibilityMap = Record<number, CitizenBattleEligibility>;

export interface EmptyDivisionInfo {
  battleId: number;
  battleZoneId: number;
  zoneFinished: boolean;
  isEmpty: boolean;
  domination: number | null;
  wallFor: number | null;
}

// --- Raw API types -----------------------------------------------------------

interface RawWall {
  for: number;
  dom: number;
}

interface RawDivisionEntry {
  id: number;
  div: number;
  end: number | null;
  division_end: boolean;
  epic?: number;
  intensity_scale?: string;
  wall: RawWall;
}

interface RawBattle {
  id: number;
  zone_id: number;
  is_rw: boolean;
  is_as: boolean;
  start: number;
  region?: { id: number; name?: string };
  inv: { id: number };
  def: { id: number };
  div: Record<string, RawDivisionEntry>;
}

interface RawCampaignsList {
  battles?: Record<string, RawBattle>;
  time?: number;
}

interface RawCitizenBattle {
  isMercenary?: boolean;
  isFreedomFighter?: boolean;
  citizenStats?: Record<string, unknown> | null;
}

interface RawCitizenCampaigns {
  battles?: Record<string, RawCitizenBattle>;
}

interface RawBattleStats {
  zone_finished?: boolean;
  stats?: {
    current?: Record<string, Record<string, unknown>>;
  };
  division?: {
    bar?: Record<string, number>;
    domination?: Record<string, number>;
  };
}

// --- Implementation ----------------------------------------------------------

/**
 * Lists active battles where our home division has a contested/free wall
 * (`wall.dom === 50`) and is not yet over.
 *
 * Returns only the minimal data needed to decide whether to farm — caller must
 * follow up with isBattleDivisionEmpty() to confirm the division is truly empty.
 */
export async function listFarmableBattles(
  ctx: BrowserContext,
  csrf: string,
  userDivision: number,
): Promise<FarmableBattlesResult> {
  const { body } = await apiCall<RawCampaignsList>(ctx, {
    method: 'GET',
    path: '/en/military/campaignsJson/list',
    csrf,
  });

  const battles = body.battles ?? {};
  const candidates: FarmableBattle[] = [];

  for (const battle of Object.values(battles)) {
    // Skip internal wars (resistance/civil): no medal value for farming.
    if (battle.inv.id === battle.def.id) continue;

    for (const divEntry of Object.values(battle.div)) {
      if (divEntry.div !== userDivision) continue;
      if (divEntry.division_end !== false) continue;
      if (divEntry.wall.dom !== 50) continue;

      candidates.push({
        battleId: battle.id,
        start: battle.start,
        zoneId: battle.zone_id,
        regionName: battle.region?.name ?? `region-${battle.region?.id ?? '?'}`,
        invaderId: battle.inv.id,
        defenderId: battle.def.id,
        battleZoneId: divEntry.id,
        wallFor: divEntry.wall.for,
        wallDom: divEntry.wall.dom,
        intensityScale: divEntry.intensity_scale ?? 'unknown',
      });
    }
  }

  return {
    userDivision,
    total: Object.keys(battles).length,
    candidates,
  };
}

/**
 * Per-battle eligibility for the authenticated citizen:
 *  - isMercenary:      we can pick either side (foreign player)
 *  - isFreedomFighter: only relevant in resistance wars
 *  - hasFoughtFor:     country IDs we've already dealt damage for in this battle
 */
export async function getCitizenEligibility(
  ctx: BrowserContext,
  csrf: string,
): Promise<CitizenEligibilityMap> {
  const { body } = await apiCall<RawCitizenCampaigns>(ctx, {
    method: 'GET',
    path: '/en/military/campaignsJson/citizen',
    csrf,
  });
  const out: CitizenEligibilityMap = {};
  for (const [idStr, b] of Object.entries(body.battles ?? {})) {
    const battleId = Number(idStr);
    if (!Number.isFinite(battleId)) continue;
    const hasFoughtFor: number[] = [];
    if (b.citizenStats) {
      for (const k of Object.keys(b.citizenStats)) {
        const n = Number(k);
        if (Number.isFinite(n)) hasFoughtFor.push(n);
      }
    }
    out[battleId] = {
      battleId,
      isMercenary: b.isMercenary === true,
      isFreedomFighter: b.isFreedomFighter === true,
      hasFoughtFor,
    };
  }
  return out;
}

/**
 * Verifies that nobody has hit our division yet in the given battle/zone.
 *
 * The campaignsJson "wall.dom === 50" signal only tells us the wall is in a
 * neutral state — but that can also happen mid-fight when damage is balanced.
 * The battle-stats endpoint is authoritative: if `stats.current[zoneId][division]`
 * has no entries, no fighters have dealt damage in our division yet.
 */
export async function isBattleDivisionEmpty(
  ctx: BrowserContext,
  csrf: string,
  battleId: number,
  userDivision: number,
  battleZoneId: number,
  zoneId: number,
): Promise<EmptyDivisionInfo> {
  const { body } = await apiCall<RawBattleStats>(ctx, {
    method: 'GET',
    path: `/en/military/battle-stats/${battleId}/${userDivision}/${battleZoneId}`,
    csrf,
  });

  const zoneFinished = body.zone_finished === true;
  const zoneStats = body.stats?.current?.[String(zoneId)];
  const divStats = zoneStats ? (zoneStats as Record<string, unknown>)[String(userDivision)] : undefined;
  const isEmpty = !zoneFinished && !divStats;

  const domination = body.division?.domination?.[String(battleZoneId)] ?? null;
  const wallFor = body.division?.bar?.[String(battleZoneId)] ?? null;

  return {
    battleId,
    battleZoneId,
    zoneFinished,
    isEmpty,
    domination,
    wallFor,
  };
}
