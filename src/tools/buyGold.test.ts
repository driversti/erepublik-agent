import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseFirstSufficientOffer, summariseExchangePage } from './buyGold.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const REAL_EXCHANGE_HTML = readFileSync(join(FIXTURE_DIR, 'exchange-market.snippet.html'), 'utf8');

const ROW = (citizen: string, amount: string, offerId: string) => `
  <tr>
    <td><a>${citizen}</a></td>
    <td class="ex_amount"><strong><span>${amount}</span></strong></td>
    <td>1 = 1817.898 LTL</td>
    <td><input type="number"></td>
    <td><button id="purchase_${offerId}" class="btn">Buy</button></td>
  </tr>
`;

function pageWith(rows: string[]): string {
  return `<!doctype html><html><body>
    <table class="exchange_offers"><tbody>${rows.join('')}</tbody></table>
  </body></html>`;
}

describe('parseFirstSufficientOffer', () => {
  it('returns the first row with amount >= minAmount', () => {
    const html = pageWith([
      ROW('Alice', '5.00', '111'),
      ROW('Bob', '15.50', '222'),
      ROW('Carol', '100.00', '333'),
    ]);
    expect(parseFirstSufficientOffer(html, 10)).toEqual({ offerId: 222, amount: 15.5 });
  });

  it('handles fractional amounts (247.22 ≥ 10)', () => {
    const html = pageWith([ROW('Alice', '247.22', '999')]);
    expect(parseFirstSufficientOffer(html, 10)).toEqual({ offerId: 999, amount: 247.22 });
  });

  it('returns null when no offer meets the minimum', () => {
    const html = pageWith([ROW('Alice', '1.99', '1'), ROW('Bob', '5.00', '2')]);
    expect(parseFirstSufficientOffer(html, 10)).toBeNull();
  });

  it('returns null when there are no offer rows', () => {
    const html = '<!doctype html><html><body><div>nothing here</div></body></html>';
    expect(parseFirstSufficientOffer(html, 10)).toBeNull();
  });

  it('returns null when the offers table is missing', () => {
    const html = '<!doctype html><html><body><table><tr><td>x</td></tr></table></body></html>';
    expect(parseFirstSufficientOffer(html, 10)).toBeNull();
  });

  it('skips rows without a purchase_* button', () => {
    const html = pageWith([
      // First row has enough but no purchase button.
      `<tr><td><a>X</a></td><td class="ex_amount"><strong><span>50</span></strong></td><td></td><td></td><td><button id="cancel_1">Cancel</button></td></tr>`,
      ROW('Bob', '15.00', '777'),
    ]);
    expect(parseFirstSufficientOffer(html, 10)).toEqual({ offerId: 777, amount: 15 });
  });

  it('respects the minAmount argument', () => {
    const html = pageWith([ROW('Alice', '5.00', '1'), ROW('Bob', '15.00', '2')]);
    expect(parseFirstSufficientOffer(html, 1)).toEqual({ offerId: 1, amount: 5 });
    expect(parseFirstSufficientOffer(html, 20)).toBeNull();
  });

  it('handles amounts with thousand-separator commas (1,500 → 1500)', () => {
    const html = pageWith([ROW('Alice', '1,500.00', '42')]);
    expect(parseFirstSufficientOffer(html, 10)).toEqual({ offerId: 42, amount: 1500 });
  });

  // Regression: live eRepublik markup uses SINGLE-quoted attributes and
  // `<strong class='icon'>` — the original regex assumed double quotes and bare
  // `<strong>`, so it silently returned null on the real page.
  describe('against the real /en/economy/exchange-market fixture', () => {
    it('picks the first row (amount=1325.10, offerId=6849401) for minAmount=1', () => {
      expect(parseFirstSufficientOffer(REAL_EXCHANGE_HTML, 1)).toEqual({
        offerId: 6849401,
        amount: 1325.1,
      });
    });

    it('respects minAmount on real markup', () => {
      expect(parseFirstSufficientOffer(REAL_EXCHANGE_HTML, 10000)).toBeNull();
    });
  });
});

describe('summariseExchangePage', () => {
  it('extracts title, table presence, row count for a populated market', () => {
    const html = `<!doctype html><html><head><title>Monetary Market</title></head><body>
      <table class="exchange_offers"><tbody>
        ${ROW('Alice', '5.00', '1')}
        ${ROW('Bob', '10.00', '2')}
      </tbody></table>
    </body></html>`;
    const d = summariseExchangePage(html);
    expect(d.title).toBe('Monetary Market');
    expect(d.hasTable).toBe(true);
    expect(d.rowCount).toBe(2);
    expect(d.length).toBe(html.length);
    expect(d.snippet).not.toContain('\n');
  });

  it('flags a missing table (login redirect, captcha, etc.)', () => {
    const html = '<!doctype html><html><head><title>Sign In</title></head><body><form>...</form></body></html>';
    const d = summariseExchangePage(html);
    expect(d.title).toBe('Sign In');
    expect(d.hasTable).toBe(false);
    expect(d.rowCount).toBe(0);
  });

  it('caps snippet at 500 chars', () => {
    const html = '<html><body>' + 'x'.repeat(2000) + '</body></html>';
    expect(summariseExchangePage(html).snippet.length).toBe(500);
  });

  it('detects the real exchange_offers table (single-quoted attrs)', () => {
    const d = summariseExchangePage(REAL_EXCHANGE_HTML);
    expect(d.hasTable).toBe(true);
    expect(d.rowCount).toBeGreaterThan(0);
  });
});
