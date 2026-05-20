import type { BrowserContext } from 'playwright-core';
import { ensureEmployed } from '../tools/jobMarket.js';
import { work } from '../tools/work.js';
import { train } from '../tools/train.js';
import { claimVip } from '../tools/vip.js';
import { buyOneCheapestFood } from '../tools/market.js';
import type { ActiveSafeDailyKey, DailyState } from '../memory/schema.js';

export interface RunActionOptions {
  /** When true, attempt `ensureEmployed` before `work` (for unemployed citizens). */
  autoEmploy: boolean;
  /** Hard ceiling for `buyOneCheapestFood` — refuses any offer above this. */
  maxFoodPrice: number;
  /** Async notifier (Telegram). Pass a no-op when chat isn't configured. */
  notify: (m: string) => Promise<void>;
}

/**
 * Execute one safe-daily action (work / train / vipClaim / buyFood). The
 * `runCycle` loop is the only writer of state; this function mutates
 * `state.completedActions` on success. Errors propagate to the caller, which
 * already wraps each invocation in a per-action try/catch.
 *
 * Extracted from `runner.ts` so the daily-action policy lives next to the
 * action tools (`tools/work.ts`, `tools/train.ts`, …) rather than co-mingled
 * with the cycle orchestration, fuel gate, captcha, and UI snapshot logic.
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
    if (opts.autoEmploy) {
      try {
        const ensure = await ensureEmployed(ctx, csrf, countryId);
        if (ensure.action === 'applied') {
          state.notifiedNoJobToday = false;
          const wage = ensure.netSalary ?? ensure.salary;
          const msg =
            `💼 auto-employ: hired by ${ensure.employerName} ` +
            `for ${wage} ${ensure.currency ?? ''}`.trim();
          console.log(`[cycle] ${msg}`);
          await opts.notify(msg);
        } else if (ensure.action === 'no_jobs' || ensure.action === 'foreign_country') {
          const reason = ensure.reason ?? ensure.action;
          console.log(`[cycle] work: skipped — ${reason}`);
          if (!state.notifiedNoJobToday) {
            await opts.notify(`⚠️ work skipped — ${reason}`);
            state.notifiedNoJobToday = true;
          }
          return;
        }
      } catch (err) {
        console.warn(`[cycle] ensureEmployed threw: ${(err as Error).message} — attempting work anyway`);
      }
    }
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
}
