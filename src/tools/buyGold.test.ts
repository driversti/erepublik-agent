import { describe, it, expect } from 'vitest';
import { parseFirstSufficientOffer } from './buyGold.js';

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
});
