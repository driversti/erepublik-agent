import type { BrowserContext } from 'playwright-core';
import { work } from '../tools/work.js';
import { train } from '../tools/train.js';
import { claimVip } from '../tools/vip.js';
import { buyOneCheapestFood } from '../tools/market.js';
import { buyOneGoldFromMarket } from '../tools/buyGold.js';
import type { ActiveSafeDailyKey, DailyState } from '../memory/schema.js';

export interface RunActionOptions {
  /** Hard ceiling for `buyOneCheapestFood` — refuses any offer above this. */
  maxFoodPrice: number;
  /** Configured gold amount (1..10). Runner pre-filter ensures we never reach this branch with 0. */
  buyGoldAmount: number;
  /** Async notifier (Telegram). Pass a no-op when chat isn't configured. */
  notify: (m: string) => Promise<void>;
}

/**
 * Execute one safe-daily action (work / train / vipClaim / buyFood). The
 * `runCycle` loop is the only writer of state; this function mutates
 * `state.completedActions` on success. Errors propagate to the caller, which
 * already wraps each invocation in a per-action try/catch.
 *
 * Auto-employment is handled separately by `runEmploymentSweep` in the runner,
 * which fires every cycle so a mid-day resign is healed within LOOP_INTERVAL_MS.
 * The runner gates the `work` branch on the sweep's `employed` result.
 */
export async function runAction(
  action: ActiveSafeDailyKey,
  ctx: BrowserContext,
  csrf: string,
  countryId: number,
  state: DailyState,
  opts: RunActionOptions,
): Promise<void> {
  const at = new Date().toISOString();
  if (action === 'work') {
    const r = await work(ctx, csrf);
    if (r.success) state.completedActions.work = { at, source: 'agent' };
    console.log(`[cycle] work: ${r.success ? '✅' : '❌'} status=${r.status}`);
    return;
  }
  if (action === 'train') {
    const r = await train(ctx, csrf);
    if (r.success) state.completedActions.train = { at, source: 'agent' };
    console.log(`[cycle] train: ${r.success ? '✅' : '❌'} count=${r.count} status=${r.status}`);
    return;
  }
  if (action === 'vipClaim') {
    const r = await claimVip(ctx, csrf);
    if (r.success) state.completedActions.vipClaim = { at, source: 'agent' };
    console.log(`[cycle] vipClaim: ${r.success ? '✅' : '❌'}`);
    return;
  }
  if (action === 'buyFood') {
    const r = await buyOneCheapestFood(ctx, csrf, countryId, opts.maxFoodPrice);
    if (r.success && r.offerId != null) {
      state.completedActions.buyFood = { at, source: 'agent', offerId: r.offerId };
    }
    const tag = r.success ? `✅ @ ${r.price}` : `⏭  ${r.reason ?? 'failed'}`;
    console.log(`[cycle] buyFood: ${tag}`);
    return;
  }
  if (action === 'buyGold') {
    const r = await buyOneGoldFromMarket(ctx, csrf, opts.buyGoldAmount);
    if (r.success) {
      state.completedActions.buyGold = {
        at,
        source: r.alreadyDone ? 'external' : 'agent',
        offerId: r.offerId,
        amount: r.amount,
      };
    } else {
      await opts.notify(`⚠️ buy gold failed — ${r.reason ?? 'unknown'}`);
    }
    const tag = r.success
      ? r.alreadyDone
        ? '⏭ already done (daily cap)'
        : `✅ ${r.amount}g via offer ${r.offerId}`
      : `❌ ${r.reason ?? 'unknown'}`;
    console.log(`[cycle] buyGold: ${tag}`);
    return;
  }
}
