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
  const rowRe = /<tr[\s\S]*?<\/tr>/gi;
  const rows = tableMatch[1].match(rowRe) ?? [];
  for (const row of rows) {
    const amountMatch = row.match(/class="ex_amount"[\s\S]*?<strong>\s*<span[^>]*>([\d.,]+)<\/span>/i);
    if (!amountMatch) continue;
    const amount = parseFloat(amountMatch[1].replace(',', '.'));
    if (!Number.isFinite(amount) || amount < minAmount) continue;
    const buttonMatch = row.match(/<button[^>]*id="purchase_(\d+)"/i);
    if (!buttonMatch) continue;
    const offerId = parseInt(buttonMatch[1], 10);
    if (!Number.isFinite(offerId)) continue;
    return { offerId, amount };
  }
  return null;
}
