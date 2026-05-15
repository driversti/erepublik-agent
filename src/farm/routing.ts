import type { FarmableBattle } from '../tools/battles.js';
import type { TravelOption } from '../tools/farm.js';

export interface RoutingHop {
  battleId: number;
  side: 'invader' | 'defender';
  fromRegionId: number;
  toRegionId: number;
  toCountryId: number;
  cost: number;
}

export interface RoutingState {
  regionId: number;
  countryId: number;
  totalTravelCC: number;
  hops: RoutingHop[];
}

export function initRoutingState(residenceRegionId: number, residenceCountryId: number): RoutingState {
  return {
    regionId: residenceRegionId,
    countryId: residenceCountryId,
    totalTravelCC: 0,
    hops: [],
  };
}

export interface OrderedSides {
  first: { side: 'invader' | 'defender'; countryId: number };
  second: { side: 'invader' | 'defender'; countryId: number };
}

/**
 * Decide which side to fight first.
 *
 * - If the player is already standing in one of the combatant countries → fight
 *   that side first (zero/cheap entry hop), then jump to the other side.
 * - If the player is in a third country (bridging case) → caller must use the
 *   `bridgingFirstSide` argument (already determined from comparing travel
 *   costs). This function just packages the result.
 */
export function orderSides(
  battle: Pick<FarmableBattle, 'invaderId' | 'defenderId'>,
  currentCountryId: number,
  bridgingFirstSide: 'invader' | 'defender' = 'invader',
): OrderedSides {
  if (currentCountryId === battle.invaderId) {
    return {
      first: { side: 'invader', countryId: battle.invaderId },
      second: { side: 'defender', countryId: battle.defenderId },
    };
  }
  if (currentCountryId === battle.defenderId) {
    return {
      first: { side: 'defender', countryId: battle.defenderId },
      second: { side: 'invader', countryId: battle.invaderId },
    };
  }
  // Bridging — caller picked which side is cheaper to reach first.
  if (bridgingFirstSide === 'defender') {
    return {
      first: { side: 'defender', countryId: battle.defenderId },
      second: { side: 'invader', countryId: battle.invaderId },
    };
  }
  return {
    first: { side: 'invader', countryId: battle.invaderId },
    second: { side: 'defender', countryId: battle.defenderId },
  };
}

/** Format the end-of-run sequence string from RoutingState.hops. */
export function formatSequence(hops: RoutingHop[]): string {
  if (hops.length === 0) return '(no hops)';
  const parts = hops.map((h) => `c${h.toCountryId}`);
  return parts.join(' → ');
}

export interface PickedBattle {
  battle: FarmableBattle;
  /** Travel that gets us into the FIRST side's country. May be 0 if we are already there. */
  firstHopCost: number;
  firstHopRegionId: number;
  firstHopCountryId: number;
  /** Travel from the first side's region to the second side's region. */
  secondHopCost: number;
  secondHopRegionId: number;
  secondHopCountryId: number;
  /** Set when the bridging branch was used. orderSides() needs this. */
  bridgingFirstSide: 'invader' | 'defender';
}

export interface PickNextDeps {
  /**
   * Fetch the cheapest travel option from `fromRegionId` into `toCountryId`
   * for the given battle. Returns null if the route is blocked.
   */
  getTravel: (
    battleId: number,
    fromRegionId: number,
    toCountryId: number,
  ) => Promise<TravelOption | null>;
  /** Per-hop ceiling — battles requiring a single hop above this are excluded. */
  maxTravelCC: number;
}

interface SidedBattleCost {
  battle: FarmableBattle;
  side: 'invader' | 'defender';
  region: TravelOption;
}

/**
 * Pick the next battle to farm.
 *
 * Plain English: "is there a battle in the country I'm already standing in?
 * If yes, pick the one whose OTHER side is cheapest to fly to next.
 * If no, just fly to the cheapest reachable battle anywhere."
 *
 * Returns null if nothing is reachable within `maxTravelCC`.
 */
export async function pickNext(
  state: RoutingState,
  remaining: FarmableBattle[],
  deps: PickNextDeps,
): Promise<PickedBattle | null> {
  // ── Tier 1: intra-country preference ──────────────────────────────────────
  const intra = remaining.filter(
    (b) => b.invaderId === state.countryId || b.defenderId === state.countryId,
  );

  if (intra.length > 0) {
    let best: PickedBattle | null = null;
    for (const battle of intra) {
      const firstSide: 'invader' | 'defender' =
        battle.invaderId === state.countryId ? 'invader' : 'defender';
      const firstCountryId = firstSide === 'invader' ? battle.invaderId : battle.defenderId;
      const secondCountryId = firstSide === 'invader' ? battle.defenderId : battle.invaderId;

      const firstHop = await deps.getTravel(battle.battleId, state.regionId, firstCountryId);
      if (!firstHop || firstHop.cost > deps.maxTravelCC) continue;

      const secondHop = await deps.getTravel(battle.battleId, firstHop.toRegionId, secondCountryId);
      if (!secondHop || secondHop.cost > deps.maxTravelCC) continue;

      const candidate: PickedBattle = {
        battle,
        firstHopCost: firstHop.cost,
        firstHopRegionId: firstHop.toRegionId,
        firstHopCountryId: firstHop.toCountryId,
        secondHopCost: secondHop.cost,
        secondHopRegionId: secondHop.toRegionId,
        secondHopCountryId: secondHop.toCountryId,
        bridgingFirstSide: firstSide,
      };
      // Lookahead tiebreaker: minimize the SECOND hop (we are paying near zero
      // for the first hop because we are already in that country).
      if (!best || candidate.secondHopCost < best.secondHopCost) {
        best = candidate;
      }
    }
    if (best) return best;
    // Fall through to bridging if every intra candidate exceeded the cap.
  }

  // ── Tier 2: bridge to next cluster ────────────────────────────────────────
  let best: PickedBattle | null = null;
  for (const battle of remaining) {
    const sides: SidedBattleCost[] = [];
    const inv = await deps.getTravel(battle.battleId, state.regionId, battle.invaderId);
    if (inv && inv.cost <= deps.maxTravelCC) {
      sides.push({ battle, side: 'invader', region: inv });
    }
    const def = await deps.getTravel(battle.battleId, state.regionId, battle.defenderId);
    if (def && def.cost <= deps.maxTravelCC) {
      sides.push({ battle, side: 'defender', region: def });
    }
    if (sides.length === 0) continue;

    sides.sort((a, b) => a.region.cost - b.region.cost);
    const cheapest = sides[0];
    const secondCountryId =
      cheapest.side === 'invader' ? battle.defenderId : battle.invaderId;

    const secondHop = await deps.getTravel(
      battle.battleId,
      cheapest.region.toRegionId,
      secondCountryId,
    );
    if (!secondHop || secondHop.cost > deps.maxTravelCC) continue;

    const candidate: PickedBattle = {
      battle,
      firstHopCost: cheapest.region.cost,
      firstHopRegionId: cheapest.region.toRegionId,
      firstHopCountryId: cheapest.region.toCountryId,
      secondHopCost: secondHop.cost,
      secondHopRegionId: secondHop.toRegionId,
      secondHopCountryId: secondHop.toCountryId,
      bridgingFirstSide: cheapest.side,
    };
    if (!best || candidate.firstHopCost < best.firstHopCost) {
      best = candidate;
    }
  }
  return best;
}
