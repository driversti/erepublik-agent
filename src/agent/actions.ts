import type { BrowserContext } from 'playwright-core';
import { work } from '../tools/work.js';
import { train } from '../tools/train.js';
import { claimVip } from '../tools/vip.js';
import { buyOneCheapestFood } from '../tools/market.js';
import { buyOneGoldFromMarket } from '../tools/buyGold.js';
import type { ActiveSafeDailyKey, DailyState } from '../memory/schema.js';
import type { CycleEvent } from './cycleEvents.js';
import { escapeMdV2 } from '../telegram/mdV2.js';

export interface RunActionOptions {
  /** Hard ceiling for `buyOneCheapestFood` — refuses any offer above this. */
  maxFoodPrice: number;
  /** Configured gold amount (1..10). Runner pre-filter ensures we never reach this branch with 0. */
  buyGoldAmount: number;
  /** Async notifier (Telegram). Pass a no-op when chat isn't configured. */
  notify: (m: string) => Promise<void>;
}

/**
 * Execute one safe-daily action (work / train / vipClaim / buyFood / buyGold).
 *
 * Returns a `CycleEvent` when the action SUCCESSFULLY ran (so the runner can
 * include it in the end-of-cycle batch digest), or `null` when the action
 * was a no-op / failure. The caller is responsible for pushing the returned
 * event into the per-cycle accumulator.
 *
 * The `runCycle` loop is the only writer of state; this function mutates
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
): Promise<CycleEvent | null> {
  const at = new Date().toISOString();
  if (action === 'work') {
    const r = await work(ctx, csrf);
    if (r.success) state.completedActions.work = { at, source: 'agent' };
    console.log(`[cycle] work: ${r.success ? '✅' : '❌'} status=${r.status}`);
    return r.success ? { kind: 'work' } : null;
  }
  if (action === 'train') {
    const r = await train(ctx, csrf);
    if (r.success) state.completedActions.train = { at, source: 'agent' };
    console.log(`[cycle] train: ${r.success ? '✅' : '❌'} count=${r.count} status=${r.status}`);
    // Only surface to the digest when we actually drilled — `alreadyTrained`
    // means the day's training was already done before this cycle started.
    if (!r.success || r.alreadyTrained) return null;
    return { kind: 'train', count: r.count };
  }
  if (action === 'vipClaim') {
    const r = await claimVip(ctx, csrf);
    if (r.success) state.completedActions.vipClaim = { at, source: 'agent' };
    console.log(`[cycle] vipClaim: ${r.success ? '✅' : '❌'}`);
    return r.success ? { kind: 'vipClaim' } : null;
  }
  if (action === 'buyFood') {
    const r = await buyOneCheapestFood(ctx, csrf, countryId, opts.maxFoodPrice);
    if (r.success && r.offerId != null) {
      state.completedActions.buyFood = { at, source: 'agent', offerId: r.offerId };
    }
    const tag = r.success ? `✅ @ ${r.price}` : `⏭  ${r.reason ?? 'failed'}`;
    console.log(`[cycle] buyFood: ${tag}`);
    if (r.success && r.price != null) return { kind: 'buyFood', price: r.price };
    return null;
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
      // Failure stays a real-time Telegram alert — it needs operator attention
      // (insufficient CC, no offer, server reject) and shouldn't wait for the
      // end-of-cycle digest.
      await opts.notify(escapeMdV2(`⚠️ buy gold failed — ${r.reason ?? 'unknown'}`));
    }
    const tag = r.success
      ? r.alreadyDone
        ? '⏭ already done (daily cap)'
        : `✅ ${r.amount}g via offer ${r.offerId}`
      : `❌ ${r.reason ?? 'unknown'}`;
    console.log(`[cycle] buyGold: ${tag}`);
    // `alreadyDone` means the cap was already burned earlier today by another
    // process; the agent didn't actually spend CC, so it doesn't belong in the
    // "this cycle achievements" digest.
    if (!r.success || r.alreadyDone) return null;
    return { kind: 'buyGold', amount: opts.buyGoldAmount };
  }
  return null;
}
