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

  return {
    success: status === 200 && body.error !== true,
    offerId,
    amount,
    status,
    body,
  };
}

/** Composite: find cheapest Q1 food in the given country and buy 1 unit. */
export async function buyOneCheapestFood(
  ctx: BrowserContext,
  csrf: string,
  countryId: number,
  maxPriceWithTaxes: number,
): Promise<BuyResult & { price?: number }> {
  const offer = await getCheapestFood(ctx, csrf, countryId);
  if (!offer) return { success: false, reason: 'no_offers_available' };

  if (offer.priceWithTaxes > maxPriceWithTaxes) {
    return {
      success: false,
      offerId: offer.id,
      price: offer.priceWithTaxes,
      reason: `price_above_ceiling: ${offer.priceWithTaxes} > max ${maxPriceWithTaxes}`,
    };
  }

  const r = await buyFromOffer(ctx, csrf, offer.id, 1);
  return { ...r, price: offer.priceWithTaxes };
}
