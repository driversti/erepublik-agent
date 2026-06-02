import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';

export interface MarketOffer {
  id: number;
  country_id: number;
  industry_id: number;
  citizen_id: number;
  amount: number;
  price: number;
  customization_level: number;
  priceWithTaxes: number;
  name?: string;
}

interface MarketAjaxResp {
  offers?: MarketOffer[];
  currency?: string;
  can_buy?: boolean;
  pages?: number;
}

const INDUSTRY_FOOD = 1;

export async function getCheapestFood(
  ctx: BrowserContext,
  csrf: string,
  countryId: number,
  quality = 1,
): Promise<MarketOffer | null> {
  const { body } = await apiCall<MarketAjaxResp>(ctx, {
    method: 'POST',
    path: '/en/economy/marketplaceAjax',
    csrf,
    form: {
      countryId,
      industryId: INDUSTRY_FOOD,
      quality,
      orderBy: 'price_asc',
      currentPage: 1,
      ajaxMarket: 1,
    },
  });
  const offers = body.offers ?? [];
  return offers.length > 0 ? offers[0] : null;
}

interface MarketActionsResp {
  error?: boolean;
  message?: string;
  currency?: number;
  gold?: number;
}

export interface BuyResult {
  success: boolean;
  offerId?: number;
  amount?: number;
  reason?: string;
  status?: number;
  body?: unknown;
}

export async function buyFromOffer(
  ctx: BrowserContext,
  csrf: string,
  offerId: number,
  amount: number,
): Promise<BuyResult> {
  // Phase-1 inviolable guard: never buy more than one unit.
  if (amount !== 1) {
    return { success: false, reason: `amount_must_be_one (got ${amount})` };
  }

  const { status, body } = await apiCall<MarketActionsResp>(ctx, {
    method: 'POST',
    path: '/en/economy/marketplaceActions',
    csrf,
    form: {
      offerId,
      amount,
      orderBy: 'price_asc',
      currentPage: 1,
      buyAction: 1,
    },
  });

  const success = status === 200 && body.error !== true;
  // Surface eRepublik's own failure text (e.g. "You don't have enough money",
  // "Insufficient stock available") so the cycle log/digest says *why* the buy
  // failed instead of a bare "failed". Falls back to the HTTP status otherwise.
  const reason = success
    ? undefined
    : (body.message ?? `http_${status}`);

  return {
    success,
    offerId,
    amount,
    reason,
    status,
    body,
  };
}

/**
 * Composite: find the cheapest Q1 food across the accessible markets and buy 1 unit.
 *
 * eRepublik only lets you buy from the market of the country you are physically
 * in OR from your national (citizenship) market — buying anywhere else returns
 * `"You can only buy products from your national or local market."`. So we try
 * each candidate market in the given preference order (caller passes
 * `[currentLocationCountry, citizenshipCountry]`), buying from the first one
 * that has an offer within the ceiling. Per-market failures are aggregated into
 * `reason` so the cycle log says exactly which market failed and why.
 */
export async function buyOneCheapestFood(
  ctx: BrowserContext,
  csrf: string,
  marketCountryIds: Array<number | null | undefined>,
  maxPriceWithTaxes: number,
): Promise<BuyResult & { price?: number; marketCountryId?: number }> {
  const candidates = [
    ...new Set(marketCountryIds.filter((c): c is number => typeof c === 'number')),
  ];
  if (candidates.length === 0) return { success: false, reason: 'no_market_country' };

  const reasons: string[] = [];
  for (const countryId of candidates) {
    const offer = await getCheapestFood(ctx, csrf, countryId);
    if (!offer) {
      reasons.push(`${countryId}: no_offers`);
      continue;
    }
    if (offer.priceWithTaxes > maxPriceWithTaxes) {
      reasons.push(`${countryId}: price_above_ceiling ${offer.priceWithTaxes} > ${maxPriceWithTaxes}`);
      continue;
    }
    const r = await buyFromOffer(ctx, csrf, offer.id, 1);
    if (r.success) return { ...r, price: offer.priceWithTaxes, marketCountryId: countryId };
    reasons.push(`${countryId}: ${r.reason ?? 'buy_failed'}`);
  }

  return { success: false, reason: reasons.join('; ') };
}
