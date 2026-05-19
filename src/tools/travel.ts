import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';

export interface TravelHomeOptions {
  /**
   * Reject the trip if the residence-region travel cost exceeds this many
   * local CC. When unset, no pre-check is performed and the travel is
   * attempted unconditionally — the call will simply fail with `error: 1`
   * if the citizen is short on currency/tickets. The pre-check costs one
   * extra HTTP request (`/main/travelData`, ~200 KB response).
   */
  maxCostCC?: number;
}

export interface TravelHomeResult {
  /** True if we actually called `/main/travel` (false → skipped by guard). */
  attempted: boolean;
  /** True when `/main/travel` returned `error: 0`. */
  success: boolean;
  /**
   * Cost reported by `/main/travelData` for the residence region. Only
   * populated when `maxCostCC` was supplied (otherwise the pre-check is
   * skipped and the cost stays unknown).
   */
  costCC: number | null;
  /** Reason for skipping (over budget) or the server's response message. */
  message?: string;
}

interface RawTravelDataResponse {
  regions?: Record<
    string,
    {
      id?: number;
      cost?: number;
      canMove?: boolean;
    }
  >;
  alreadyInRegion?: boolean | string;
}

interface RawTravelResponse {
  error?: number;
  message?: string;
}

/**
 * Travel the citizen back to their residence region.
 *
 * Mirrors the ePlus returnHome plugin's POST shape
 * (`check=moveAction&travelMethod=preferCurrency&inRegionId=…&toCountryId=…`).
 * Travel home is **not** free — it costs local CC scaled to distance — so the
 * caller should pass a `maxCostCC` budget unless they're sure the cost is
 * acceptable.
 *
 * Returns `{ attempted: false }` when the cost guard rejects the trip; the
 * caller can then surface a Telegram alert.
 */
export async function travelHome(
  ctx: BrowserContext,
  csrf: string,
  residenceRegionId: number,
  residenceCountryId: number,
  opts: TravelHomeOptions = {},
): Promise<TravelHomeResult> {
  let costCC: number | null = null;

  if (opts.maxCostCC != null) {
    const { body } = await apiCall<RawTravelDataResponse>(ctx, {
      method: 'POST',
      path: '/en/main/travelData',
      csrf,
      form: { holdingId: 0, battleId: 0, regionId: residenceRegionId },
    });
    if (body.alreadyInRegion === true) {
      return {
        attempted: false,
        success: true,
        costCC: 0,
        message: 'already in residence region',
      };
    }
    const region = body.regions?.[String(residenceRegionId)];
    const c = typeof region?.cost === 'number' ? region.cost : null;
    costCC = c;
    if (c != null && c > opts.maxCostCC) {
      return {
        attempted: false,
        success: false,
        costCC: c,
        message: `cost ${c}cc exceeds budget ${opts.maxCostCC}cc`,
      };
    }
  }

  const { body } = await apiCall<RawTravelResponse>(ctx, {
    method: 'POST',
    path: '/en/main/travel',
    csrf,
    form: {
      check: 'moveAction',
      travelMethod: 'preferCurrency',
      inRegionId: residenceRegionId,
      toCountryId: residenceCountryId,
    },
  });

  return {
    attempted: true,
    success: body.error === 0,
    costCC,
    message: body.message ?? '',
  };
}

interface RawTravelDataCountriesResponse {
  countries?: Record<string, { regions?: number[] }>;
  regions?: Record<string, { id: number; cost: number }>;
}

export interface TravelToCountryResult {
  /** True if /main/travel was POSTed (false → rejected by guard, no side-effect). */
  attempted: boolean;
  /** True when /main/travel returned `error: 0`. */
  success: boolean;
  /** Cost (local CC) of the cheapest region in target country, when known. */
  costCC: number | null;
  /** Cheapest region selected (null when none reachable). */
  regionId: number | null;
  /** Server message or local rejection reason. */
  message: string;
}

/**
 * Travel to the cheapest entry region of a target country. Used by the
 * d4tw-air strategy to return to native country when farming-eligible
 * battles exist abroad. Unlike `travelHome`, the destination is the country
 * (not the citizen's residence), since residence may be outside native.
 *
 * Issues two POSTs: `/main/travelData` to discover region costs, then
 * `/main/travel` to perform the move. The travel-data form mirrors the
 * shape used by `travelHome` (battleId=0, holdingId=0).
 */
export async function travelToCountry(
  ctx: BrowserContext,
  csrf: string,
  toCountryId: number,
  fromRegionId: number,
  maxCC: number,
): Promise<TravelToCountryResult> {
  // 1. Discover cheapest region in target country
  const { body: data } = await apiCall<RawTravelDataCountriesResponse>(ctx, {
    method: 'POST',
    path: '/en/main/travelData',
    csrf,
    form: { holdingId: 0, battleId: 0, regionId: fromRegionId },
  });
  const country = data.countries?.[String(toCountryId)];
  if (!country?.regions?.length) {
    return {
      attempted: false,
      success: false,
      costCC: null,
      regionId: null,
      message: 'no reachable region',
    };
  }
  let best: { regionId: number; cost: number } | null = null;
  for (const rid of country.regions) {
    const r = data.regions?.[String(rid)];
    if (!r) continue;
    if (!best || r.cost < best.cost) best = { regionId: r.id, cost: r.cost };
  }
  if (!best) {
    return {
      attempted: false,
      success: false,
      costCC: null,
      regionId: null,
      message: 'no reachable region',
    };
  }
  if (best.cost > maxCC) {
    return {
      attempted: false,
      success: false,
      costCC: best.cost,
      regionId: best.regionId,
      message: `cost ${best.cost}cc exceeds budget ${maxCC}cc`,
    };
  }

  // 2. Travel
  const { body } = await apiCall<RawTravelResponse>(ctx, {
    method: 'POST',
    path: '/en/main/travel',
    csrf,
    form: {
      check: 'moveAction',
      travelMethod: 'preferCurrency',
      inRegionId: best.regionId,
      toCountryId,
    },
  });
  return {
    attempted: true,
    success: body.error === 0,
    costCC: best.cost,
    regionId: best.regionId,
    message: body.message ?? '',
  };
}
