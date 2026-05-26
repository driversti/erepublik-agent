import type { BrowserContext } from 'playwright-core';
import {
  applyForJob,
  ensureEmployed,
  evaluateJobUpgrade,
  getJobMarket,
  resignFromJob,
  type EnsureEmployedAction,
  type JobUpgradeOpts,
} from '../tools/jobMarket.js';
import { escapeMdV2 } from '../telegram/mdV2.js';
import type { DailyState } from '../memory/schema.js';

export interface EmploymentSweepOptions {
  /** Master switch — when false the sweep is a no-op and assumes the citizen
   *  is employed (so the runner won't suppress the daily `work` POST). */
  autoEmploy: boolean;
  /** Optional: after today's `work` is done, resign + apply when a strictly-
   *  better offer is on the market. Skipped when undefined or `enabled:false`. */
  jobUpgrade?: { enabled: boolean } & JobUpgradeOpts;
  /** Async notifier (Telegram). Pass a no-op when chat isn't configured. */
  notify: (m: string) => Promise<void>;
}

export type EmploymentSweepAction =
  | EnsureEmployedAction
  | 'skipped'
  | 'error'
  | 'upgraded'
  | 'upgrade_failed';

export interface EmploymentSweepResult {
  /** Whether the citizen is believed to have an employer after the sweep.
   *  Drives whether the daily `work` POST is even attempted. */
  employed: boolean;
  action: EmploymentSweepAction;
  reason?: string;
  employerName?: string;
  salary?: number;
  netSalary?: number;
  currency?: string;
  /** Pre-upgrade net wage, only populated on `action: 'upgraded'`. Lets the
   *  runner render a `from → to` digest line without re-fetching the market. */
  previousNetSalary?: number;
}

/**
 * Per-cycle sweep that keeps the citizen employed.
 *
 * Before 2026-05-26 the auto-employ call was wedged inside `runAction('work')`,
 * so it only fired in cycles where `work` was still pending for the day. If
 * the citizen got fired or voluntarily resigned AFTER the daily work flag was
 * already set, the agent stayed dormant until the next 00:00 PST rollover —
 * meaning overtime + tomorrow's first work could miss the new employer.
 *
 * Now the sweep runs every cycle (cheap: one GET, plus at most one POST when
 * actually unemployed), so a mid-day resign is healed within `LOOP_INTERVAL_MS`.
 * `runAction('work')` is reduced to the pure `/economy/work` POST.
 *
 * Throttling: only the first `no_jobs` / `foreign_country` result of the day
 * sends a Telegram message — subsequent cycles log silently — to avoid spam
 * when the market is dry for hours. The throttle resets when we successfully
 * hire (`applied`) or at day rollover (DailyState is fresh).
 */
export async function runEmploymentSweep(
  ctx: BrowserContext,
  csrf: string,
  countryId: number,
  state: DailyState,
  opts: EmploymentSweepOptions,
): Promise<EmploymentSweepResult> {
  if (!opts.autoEmploy) {
    return { employed: true, action: 'skipped' };
  }
  try {
    const ensure = await ensureEmployed(ctx, csrf, countryId);
    if (ensure.action === 'applied') {
      state.notifiedNoJobToday = false;
      const wage = ensure.netSalary ?? ensure.salary ?? 0;
      // Console-log the hire for the local journal, but skip the per-event
      // Telegram message — successful hires are now surfaced once per cycle
      // by the end-of-cycle batch digest ([[feedback_telegram_batch_digest]]).
      console.log(
        `[cycle] 💼 auto-employ: hired by ${ensure.employerName} for ${wage} ${ensure.currency ?? ''}`.trim(),
      );
      return {
        employed: true,
        action: 'applied',
        employerName: ensure.employerName,
        salary: ensure.salary,
        netSalary: ensure.netSalary,
        currency: ensure.currency,
      };
    }
    if (ensure.action === 'none') {
      // Already employed — silent unless an upgrade is justified.
      if (
        opts.jobUpgrade?.enabled &&
        state.completedActions.work != null
      ) {
        return await maybeUpgradeJob(ctx, csrf, countryId, opts);
      }
      return { employed: true, action: 'none' };
    }
    // 'no_jobs'
    const reason = ensure.reason ?? ensure.action;
    console.log(`[cycle] auto-employ: skipped — ${reason}`);
    if (!state.notifiedNoJobToday) {
      await opts.notify(escapeMdV2(`⚠️ work skipped — ${reason}`));
      state.notifiedNoJobToday = true;
    }
    return { employed: false, action: ensure.action, reason };
  } catch (err) {
    const msg = `employment sweep threw: ${(err as Error).message}`;
    console.warn(`[cycle] ${msg}`);
    // Be optimistic: assume employed so the work POST is still attempted.
    // With the tightened isWorkSuccess check, a no-op response on an actually
    // unemployed account won't lock the daily flag, so the next cycle retries.
    return { employed: true, action: 'error', reason: msg };
  }
}

/**
 * Re-fetch the market with the citizen's current employer attached, evaluate
 * the best alternative, and (if it crosses both thresholds) resign + apply.
 *
 * Failure modes worth knowing:
 *   - Resign fails → still employed at old place, no harm. Returns 'none'.
 *   - Resign succeeds, apply fails → citizen is now UNEMPLOYED. Returns
 *     `{employed:false, action:'upgrade_failed'}` so the runner won't even
 *     attempt the daily work POST (which would silently no-op), and the next
 *     cycle's regular ensureEmployed branch picks them up.
 */
async function maybeUpgradeJob(
  ctx: BrowserContext,
  csrf: string,
  marketCountryId: number,
  opts: EmploymentSweepOptions,
): Promise<EmploymentSweepResult> {
  if (!opts.jobUpgrade) return { employed: true, action: 'none' };
  const market = await getJobMarket(ctx, csrf, marketCountryId, 1, 'desc');
  const decision = evaluateJobUpgrade(market, opts.jobUpgrade);
  if (!decision.shouldUpgrade || decision.best == null) {
    return { employed: true, action: 'none' };
  }
  const target = decision.best;
  const resign = await resignFromJob(ctx, csrf);
  if (!resign.success) {
    const msg = `⚠️ upgrade resign failed (HTTP ${resign.status}) — staying with current employer`;
    console.warn(`[cycle] ${msg}`);
    await opts.notify(escapeMdV2(msg));
    return { employed: true, action: 'none' };
  }
  const applied = await applyForJob(ctx, csrf, target.citizen.id, target.salary);
  if (!applied.success) {
    const msg =
      `🚨 auto-upgrade failed: resigned successfully but apply to ${target.citizen.name} ` +
      `(${target.netSalary} ${target.currency}) was rejected — citizen is now UNEMPLOYED. ` +
      `Reason: ${applied.message ?? `status=${applied.status}`}`;
    console.error(`[cycle] ${msg}`);
    await opts.notify(escapeMdV2(msg));
    return { employed: false, action: 'upgrade_failed', reason: applied.message ?? `status=${applied.status}` };
  }
  // Console-log the upgrade for the local journal; the Telegram surface is
  // the end-of-cycle batch digest ([[feedback_telegram_batch_digest]]) which
  // emits a single `📈 Job upgrade` line built from this return value.
  console.log(
    `[cycle] 📈 auto-upgrade: ${decision.currentNetSalary} → ${target.netSalary} ${target.currency} (hired by ${target.citizen.name})`,
  );
  return {
    employed: true,
    action: 'upgraded',
    employerName: target.citizen.name,
    salary: target.salary,
    netSalary: target.netSalary,
    currency: target.currency,
    /** Pre-upgrade net wage from the market response — used by the runner to
     *  render the `📈 Job upgrade: from → to` digest line. Falls back to
     *  `undefined` (not null) so it matches the interface field shape. */
    previousNetSalary: decision.currentNetSalary ?? undefined,
  };
}
