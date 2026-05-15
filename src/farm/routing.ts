import type { FarmableBattle } from '../tools/battles.js';

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
