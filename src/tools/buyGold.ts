import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';
import { apiCallHtml } from '../transport/apiCallHtml.js';

export interface GoldOffer {
  offerId: number;
  amount: number;
}

/**
 * Parse the monetary-market HTML page and return the first offer with
 * `amount >= minAmount`. The page is rate-sorted ascending, so the first
 * sufficient row is also the cheapest.
 *
 * Selectors mirror ePlus' buyGoldPlugin so both clients stay drift-resistant.
 * Returns null when nothing qualifies — including malformed HTML.
 */
export function parseFirstSufficientOffer(html: string, minAmount: number): GoldOffer | null {
  // Match each <tr>…</tr> inside the .exchange_offers table. Using a regex
  // (not DOMParser) keeps the parser portable to Node-side tests without
  // needing jsdom in the runtime path.
  const tableMatch = html.match(/<table[^>]*class="[^"]*\bexchange_offers\b[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return null;
  // Split on the literal "<tr" opener — bounds each per-row scan even when the
  // closing </tr> is missing (truncated response, malformed HTML). The first
  // chunk is the prefix before the first <tr> and is discarded.
  const rowChunks = tableMatch[1].split(/<tr\b/i).slice(1);
  for (const chunk of rowChunks) {
    const closeIdx = chunk.search(/<\/tr>/i);
    const row = closeIdx === -1 ? chunk : chunk.slice(0, closeIdx);
    const amountMatch = row.match(/class="ex_amount"[\s\S]*?<strong>\s*<span[^>]*>([\d.,]+)<\/span>/i);
    if (!amountMatch) continue;
    // Strip thousand-separator commas. We've never observed eRepublik use a
    // comma as the decimal separator on this page (locale is forced to en),
    // so '.' is always the decimal point.
    const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount < minAmount) continue;
    const buttonMatch = row.match(/<button[^>]*id="purchase_(\d+)"/i);
    if (!buttonMatch) continue;
    const offerId = parseInt(buttonMatch[1], 10);
    if (!Number.isFinite(offerId)) continue;
    return { offerId, amount };
  }
  return null;
}

export interface BuyGoldResult {
  success: boolean;
  /** Server confirmed via "maximum limit": daily cap already hit. Runner records source:'external'. */
  alreadyDone?: boolean;
  offerId?: number;
  amount?: number;
  reason?: string;
  status?: number;
}

interface PurchaseResp {
  error?: boolean;
  message?: string;
}

/**
 * Composite: fetch the exchange market page, pick the first offer with
 * `amount >= requestedAmount`, and POST a purchase for that amount. Returns a
 * `BuyGoldResult` shaped so the runner can either flip `completedActions.buyGold`
 * (success or alreadyDone) or alert + retry (anything else).
 *
 * Server responses observed:
 *  - success → `{ error: false, message: "...success...", gold: ..., currency: ... }`
 *  - already-bought-today → `{ error: true, message: "...maximum limit..." }`
 *  - other failures → `{ error: true, message: "<diagnostic>" }`
 */
export async function buyOneGoldFromMarket(
  ctx: BrowserContext,
  csrf: string,
  requestedAmount: number,
): Promise<BuyGoldResult> {
  if (requestedAmount < 1 || requestedAmount > 10) {
    return { success: false, reason: `amount_out_of_range: ${requestedAmount}` };
  }

  const { html } = await apiCallHtml(ctx, {
    method: 'GET',
    path: '/en/economy/exchange-market',
  });
  const offer = parseFirstSufficientOffer(html, requestedAmount);
  if (!offer) {
    return { success: false, reason: `no_offer_with_amount_>=_${requestedAmount}` };
  }

  const { status, body } = await apiCall<PurchaseResp>(ctx, {
    method: 'POST',
    path: '/en/economy/exchange/purchase/',
    csrf,
    form: {
      offerId: offer.offerId,
      amount: requestedAmount,
      buyAction: 1,
    },
  });

  if (body.error === true && /maximum limit/i.test(body.message ?? '')) {
    return { success: true, alreadyDone: true, offerId: offer.offerId, amount: requestedAmount, status };
  }
  if (status === 200 && body.error !== true) {
    return { success: true, offerId: offer.offerId, amount: requestedAmount, status };
  }
  return {
    success: false,
    offerId: offer.offerId,
    amount: requestedAmount,
    status,
    reason: body.message ?? `http_${status}`,
  };
}
