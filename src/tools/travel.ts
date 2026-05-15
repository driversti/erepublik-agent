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
