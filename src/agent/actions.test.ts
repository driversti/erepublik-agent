import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emptyState } from '../memory/schema.js';

const buyOneGoldFromMarket = vi.fn();
const buyOneCheapestFood = vi.fn();
const getStorageStatus = vi.fn();

vi.mock('../tools/buyGold.js', () => ({
  buyOneGoldFromMarket: (...a: unknown[]) => buyOneGoldFromMarket(...a),
}));

// Other tools the runAction switch imports — keep them as no-ops so the
// buyGold branch is exercised in isolation.
vi.mock('../tools/work.js', () => ({ work: vi.fn() }));
vi.mock('../tools/train.js', () => ({ train: vi.fn() }));
vi.mock('../tools/vip.js', () => ({ claimVip: vi.fn() }));
vi.mock('../tools/market.js', () => ({
  buyOneCheapestFood: (...a: unknown[]) => buyOneCheapestFood(...a),
}));
vi.mock('../tools/storage.js', () => ({
  getStorageStatus: (...a: unknown[]) => getStorageStatus(...a),
}));

const { runAction } = await import('./actions.js');

function notifyCaptor() {
  const calls: string[] = [];
  return { notify: async (m: string) => { calls.push(m); }, calls };
}

const baseOpts = (extra: Partial<{ buyGoldAmount: number }> = {}) => ({
  maxFoodPrice: 100,
  foodMarketCountryIds: [84],
  buyGoldAmount: 10,
  notify: notifyCaptor().notify,
  ...extra,
});

beforeEach(() => {
  buyOneGoldFromMarket.mockReset();
  buyOneCheapestFood.mockReset();
  getStorageStatus.mockReset();
});

describe('runAction("buyGold", …)', () => {
  it('success → flag with source: "agent", offerId, amount', async () => {
    const state = emptyState(6757);
    buyOneGoldFromMarket.mockResolvedValue({ success: true, offerId: 555, amount: 10, status: 200 });
    await runAction('buyGold', {} as any, 'csrf', state, baseOpts());
    expect(state.completedActions.buyGold).toMatchObject({
      source: 'agent',
      offerId: 555,
      amount: 10,
    });
    expect(state.completedActions.buyGold?.at).toEqual(expect.any(String));
  });

  it('alreadyDone:true → flag with source: "external"', async () => {
    const state = emptyState(6757);
    buyOneGoldFromMarket.mockResolvedValue({
      success: true, alreadyDone: true, offerId: 555, amount: 10, status: 200,
    });
    await runAction('buyGold', {} as any, 'csrf', state, baseOpts());
    expect(state.completedActions.buyGold?.source).toBe('external');
  });

  it('failure → no flag, notify called once with MarkdownV2-escaped reason', async () => {
    const state = emptyState(6757);
    const cap = notifyCaptor();
    // Reason contains chars reserved in MarkdownV2 (_, >, =) to guard against
    // regressions of the Telegram HTTP 400 we hit on `no_offer_with_amount_>=_1`.
    buyOneGoldFromMarket.mockResolvedValue({ success: false, reason: 'no_offer_with_amount_>=_1' });
    await runAction('buyGold', {} as any, 'csrf', state, { ...baseOpts(), notify: cap.notify });
    expect(state.completedActions.buyGold).toBeUndefined();
    expect(cap.calls).toEqual([
      '⚠️ buy gold failed — no\\_offer\\_with\\_amount\\_\\>\\=\\_1',
    ]);
  });

  it('alreadyDone path does not call notify', async () => {
    const state = emptyState(6757);
    const cap = notifyCaptor();
    buyOneGoldFromMarket.mockResolvedValue({ success: true, alreadyDone: true, offerId: 1, amount: 10 });
    await runAction('buyGold', {} as any, 'csrf', state, { ...baseOpts(), notify: cap.notify });
    expect(cap.calls).toEqual([]);
  });
});

describe('runAction("buyFood", …) — storage full', () => {
  it('skips the buy, notifies once, and leaves buyFood pending', async () => {
    const state = emptyState(6757);
    const cap = notifyCaptor();
    getStorageStatus.mockResolvedValue({
      usedStorage: 500,
      totalStorage: 500,
      availableStorage: 0,
      storagePercentage: '100%',
    });

    await runAction('buyFood', {} as any, 'csrf', state, { ...baseOpts(), notify: cap.notify });

    // Never attempted the doomed purchase…
    expect(buyOneCheapestFood).not.toHaveBeenCalled();
    // …left buyFood pending so it retries once space is freed…
    expect(state.completedActions.buyFood).toBeUndefined();
    // …and alerted exactly once, stamping the once/day gate.
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0]).toContain('Storage full');
    expect(state.storageFullNotifiedAt).toEqual(expect.any(String));

    // Second cycle same day: still skips, but no second alert.
    await runAction('buyFood', {} as any, 'csrf', state, { ...baseOpts(), notify: cap.notify });
    expect(cap.calls).toHaveLength(1);
  });

  it('buys normally when storage has space', async () => {
    const state = emptyState(6757);
    getStorageStatus.mockResolvedValue({ usedStorage: 100, totalStorage: 500, availableStorage: 400 });
    buyOneCheapestFood.mockResolvedValue({ success: true, offerId: 7, price: 3.2 });

    const evt = await runAction('buyFood', {} as any, 'csrf', state, baseOpts());

    expect(buyOneCheapestFood).toHaveBeenCalledOnce();
    expect(state.completedActions.buyFood).toMatchObject({ source: 'agent', offerId: 7 });
    expect(evt).toEqual({ kind: 'buyFood', price: 3.2 });
  });
});
