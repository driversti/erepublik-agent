import type { BrowserContext } from 'playwright-core';
import type { DailyState } from '../memory/schema.js';
import type { Settings } from '../ui/settingsStore.js';
import { decideOvertime, type OvertimeDecision } from '../tools/workOvertime.policy.js';
import { getJobData, workOvertime, type OvertimePostResult, type JobDataResponse } from '../tools/workOvertime.js';
import { escapeMdV2 } from '../telegram/mdV2.js';

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
}

export interface RunOvertimeOutcome {
  decision: OvertimeDecision | { kind: 'failed'; error: string };
  post?: OvertimePostResult;
  /** Net pay if success, else null. Pulled up for easier logging. */
  netSalary?: number | null;
  currency?: string | null;
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
      // All client-side preconditions were clean (points, energy, cooldown,
      // employment all OK per /main/job-data), yet the server still rejected.
      // We don't actually know it's an employer cap — observed cases include
      // a literal "lock" message of unclear cause (see kb/Work_Overtime.md).
      // Pause OT for the day either way (retrying inside the same day burns
      // requests without changing the outcome and risks tripping flags).
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
    case 'skip-cooldown':
    case 'skip-points':
    case 'skip-energy':
      return { decision };
  }
}
