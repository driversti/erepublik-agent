import type { BrowserContext } from 'playwright-core';
import type { DailyState } from '../memory/schema.js';
import type { Settings } from '../ui/settingsStore.js';
import { decideOvertime, type OvertimeDecision } from '../tools/workOvertime.policy.js';
import { getJobData, workOvertime, type OvertimePostResult, type JobDataResponse } from '../tools/workOvertime.js';
import { escapeMdV2 } from '../telegram/mdV2.js';

/**
 * Consecutive `"lock"` rejections (with no captcha solved) tolerated within a
 * game day before falling back to pausing OT until day rollover. Keeps a
 * persistent, unsolvable lock from spamming `workOvertime` POSTs every cycle.
 */
export const LOCK_RETRY_LIMIT = 5;

/**
 * Single OT attempt for this cycle. Mutates `state` (sets
 * `completedActions.workOvertime` and/or `overtimeCapReachedAt`) and emits
 * Telegram messages via `opts.notify`. Returns the decision + any POST result
 * so the runner can log a single concise line.
 *
 * Does NOT throw on transport errors — callers shouldn't have to wrap each
 * call site. Any error from `getJobData` / `workOvertime` is captured and
 * returned as a `failed` decision; the runner logs it.
 */
export interface RunOvertimeOptions {
  notify: (msg: string) => Promise<void>;
  /** Inject for tests. Falls back to `new Date()` in production. */
  now?: () => Date;
  /**
   * Re-check (and, if configured, solve) eRepublik's session-unlock captcha.
   * Invoked only on a `"lock"` rejection. Omitted in callers/tests that don't
   * exercise the lock path; absence degrades to "treat as unsolved".
   */
  recheckCaptcha?: () => Promise<{ present: boolean; solved: boolean }>;
}

export interface RunOvertimeOutcome {
  decision: OvertimeDecision | { kind: 'failed'; error: string };
  post?: OvertimePostResult;
  /** Net pay if success, else null. Pulled up for easier logging. */
  netSalary?: number | null;
  currency?: string | null;
  /** Populated only on a `"lock"` rejection — lets the runner log a precise tag. */
  lock?: { captchaSolved: boolean; retries: number; paused: boolean; limit: number };
}

export async function runOvertimeIfEligible(
  ctx: BrowserContext,
  csrf: string,
  state: DailyState,
  settings: Settings,
  opts: RunOvertimeOptions,
): Promise<RunOvertimeOutcome> {
  const now = opts.now ?? (() => new Date());
  const nowDate = now();
  const nowSec = Math.floor(nowDate.getTime() / 1000);
  const nowIso = nowDate.toISOString();

  // Early-out shortcut: skip the GET when feature is disabled or cap is set.
  // These short-circuits are also handled by the policy, but doing it here
  // saves an API call per cycle in the common "OT off" case.
  if (!settings.workOvertime.enabled) {
    return { decision: { kind: 'skip-disabled' } };
  }
  if (state.overtimeCapReachedAt != null) {
    return { decision: { kind: 'skip-cap' } };
  }

  let job: JobDataResponse;
  try {
    job = await getJobData(ctx, csrf);
  } catch (err) {
    return { decision: { kind: 'failed', error: (err as Error).message } };
  }

  const decision = decideOvertime({
    jobOverTime: job.overTime ?? null,
    state: {
      workOvertimeDone: state.completedActions.workOvertime != null,
      capReached: state.overtimeCapReachedAt != null,
      workDoneToday: state.completedActions.work != null,
    },
    settings: { enabled: settings.workOvertime.enabled, mode: settings.workOvertime.mode },
    nowSec,
  });

  switch (decision.kind) {
    case 'go': {
      let post: OvertimePostResult;
      try {
        post = await workOvertime(ctx, csrf);
      } catch (err) {
        return { decision: { kind: 'failed', error: (err as Error).message } };
      }
      if (post.success) {
        if (state.completedActions.workOvertime == null) {
          state.completedActions.workOvertime = { at: nowIso, source: 'agent' };
        }
        const net = post.result?.netSalary ?? null;
        const cur = post.result?.currency ?? null;
        // OT success is surfaced via the runner's end-of-cycle batch digest
        // ([[feedback_telegram_batch_digest]]). Sending a separate Telegram
        // message here would double-notify the operator.
        return { decision, post, netSalary: net, currency: cur };
      }
      // Server rejected even though our local gate (points/energy/cooldown)
      // was clean. `"lock"` is most likely eRepublik's session-unlock captcha
      // surfacing on the AJAX response (see the spec + kb/Work_Overtime.md):
      // re-check/solve it and retry next cycle rather than pausing the whole
      // day. Other messages stay conservative (pause until rollover).
      if (post.message === 'lock') {
        const recheck = opts.recheckCaptcha ?? (async () => ({ present: false, solved: false }));
        const captcha = await recheck();
        if (captcha.present && captcha.solved) {
          state.overtimeLockRetries = 0;
          return {
            decision,
            post,
            lock: { captchaSolved: true, retries: 0, paused: false, limit: LOCK_RETRY_LIMIT },
          };
        }
        state.overtimeLockRetries += 1;
        const paused = state.overtimeLockRetries >= LOCK_RETRY_LIMIT;
        if (paused) {
          state.overtimeCapReachedAt = nowIso;
          await opts.notify(
            escapeMdV2(
              `⛔ overtime locked — ${state.overtimeLockRetries} consecutive "lock" rejections, paused until day rollover`,
            ),
          );
        }
        return {
          decision,
          post,
          lock: { captchaSolved: false, retries: state.overtimeLockRetries, paused, limit: LOCK_RETRY_LIMIT },
        };
      }
      // Non-`lock` rejection: cause unknown and stable — pause until rollover.
      state.overtimeCapReachedAt = nowIso;
      await opts.notify(
        escapeMdV2(
          `⛔ overtime rejected by server (msg="${post.message ?? 'n/a'}") — paused until day rollover`,
        ),
      );
      return { decision, post };
    }

    case 'reconcile-external': {
      state.completedActions.workOvertime = { at: nowIso, source: 'external' };
      return { decision };
    }

    // All "skip-*" branches are no-ops on state; the runner logs and moves on.
    case 'skip-disabled':
    case 'skip-already-done':
    case 'skip-cap':
    case 'skip-not-employed':
    case 'skip-work-not-done':
    case 'skip-cooldown':
    case 'skip-points':
    case 'skip-energy':
      return { decision };
  }
}
