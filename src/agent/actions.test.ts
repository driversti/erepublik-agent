import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emptyState } from '../memory/schema.js';

const buyOneGoldFromMarket = vi.fn();

vi.mock('../tools/buyGold.js', () => ({
  buyOneGoldFromMarket: (...a: unknown[]) => buyOneGoldFromMarket(...a),
}));

// Other tools the runAction switch imports — keep them as no-ops so the
// buyGold branch is exercised in isolation.
vi.mock('../tools/work.js', () => ({ work: vi.fn() }));
vi.mock('../tools/train.js', () => ({ train: vi.fn() }));
vi.mock('../tools/vip.js', () => ({ claimVip: vi.fn() }));
vi.mock('../tools/market.js', () => ({ buyOneCheapestFood: vi.fn() }));

const { runAction } = await import('./actions.js');

function notifyCaptor() {
  const calls: string[] = [];
  return { notify: async (m: string) => { calls.push(m); }, calls };
}

const baseOpts = (extra: Partial<{ buyGoldAmount: number }> = {}) => ({
  maxFoodPrice: 100,
  buyGoldAmount: 10,
  notify: notifyCaptor().notify,
  ...extra,
});

beforeEach(() => buyOneGoldFromMarket.mockReset());

describe('runAction("buyGold", …)', () => {
  it('success → flag with source: "agent", offerId, amount', async () => {
    const state = emptyState(6757);
    buyOneGoldFromMarket.mockResolvedValue({ success: true, offerId: 555, amount: 10, status: 200 });
    await runAction('buyGold', {} as any, 'csrf', 84, state, baseOpts());
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
    await runAction('buyGold', {} as any, 'csrf', 84, state, baseOpts());
    expect(state.completedActions.buyGold?.source).toBe('external');
  });

  it('failure → no flag, notify called once with reason', async () => {
    const state = emptyState(6757);
    const cap = notifyCaptor();
    buyOneGoldFromMarket.mockResolvedValue({ success: false, reason: 'http_500' });
    await runAction('buyGold', {} as any, 'csrf', 84, state, { ...baseOpts(), notify: cap.notify });
    expect(state.completedActions.buyGold).toBeUndefined();
    expect(cap.calls).toEqual([expect.stringContaining('http_500')]);
  });

  it('alreadyDone path does not call notify', async () => {
    const state = emptyState(6757);
    const cap = notifyCaptor();
    buyOneGoldFromMarket.mockResolvedValue({ success: true, alreadyDone: true, offerId: 1, amount: 10 });
    await runAction('buyGold', {} as any, 'csrf', 84, state, { ...baseOpts(), notify: cap.notify });
    expect(cap.calls).toEqual([]);
  });
});
