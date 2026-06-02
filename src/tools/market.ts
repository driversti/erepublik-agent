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
  const { offer } = await fetchFoodMarket(ctx, csrf, countryId, quality);
  return offer;
}

/**
 * Raw food-market query. Returns the cheapest offer plus the server's `can_buy`
 * flag for the queried market — the authoritative "am I allowed to buy here?"
 * signal. We also surface the offer's own `country_id` so callers can detect the
 * case where `marketplaceAjax` returns offers from a market other than the one
 * we asked for (which then fail the buy with "national or local market").
 */
export async function fetchFoodMarket(
  ctx: BrowserContext,
  csrf: string,
  countryId: number,
  quality = 1,
): Promise<{ offer: MarketOffer | null; canBuy: boolean | undefined }> {
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
  return { offer: offers.length > 0 ? offers[0] : null, canBuy: body.can_buy };
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
    const { offer, canBuy } = await fetchFoodMarket(ctx, csrf, countryId);
    // `can_buy` is the server's authoritative "are you allowed to buy in this
    // market?" flag (mirrors ePlus' buyGoods plugin). Skip a market it says no
    // to instead of firing a doomed buy that returns "national or local market".
    if (canBuy === false) {
      reasons.push(`${countryId}: not_buyable (can_buy=false)`);
      continue;
    }
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
    reasons.push(`${countryId}: ${r.reason ?? 'buy_failed'} (offerCountry=${offer.country_id})`);
  }

  return { success: false, reason: reasons.join('; ') };
}
