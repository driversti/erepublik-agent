/**
 * Pure decision function for the workOvertime action. Encodes the spec
 * (`docs/superpowers/specs/2026-05-20-work-overtime-design.md`, "Decision matrix")
 * with no side effects so it's fully unit-testable.
 *
 * Inputs:
 *   - jobOverTime: the `overTime` block from GET /en/main/job-data, or null when
 *     the citizen is unemployed / the field is absent.
 *   - state: minimal subset of DailyState we care about.
 *   - settings: workOvertime settings block (enabled + mode).
 *   - nowSec: current Unix-seconds. Pure-function input so tests can pin time.
 *
 * Output: a tagged decision the orchestrator switches on.
 */

export interface OvertimeData {
  /** Accumulated overtime points the citizen owns. */
  points: number;
  /** Energy available for overtime (mirrors `job-data.overTime.usableEnergy`). */
  usableEnergy: number;
  /** Unix-seconds when next OT is allowed. `0` means "available now". */
  nextOverTime: number;
}

export interface OvertimePolicyInput {
  jobOverTime: OvertimeData | null;
  state: {
    workOvertimeDone: boolean;      // true iff completedActions.workOvertime != null
    capReached: boolean;            // true iff overtimeCapReachedAt != null
    workDoneToday: boolean;         // true iff completedActions.work != null
  };
  settings: {
    enabled: boolean;
    mode: 'once-per-day' | 'when-available';
  };
  nowSec: number;
}

export type OvertimeDecision =
  | { kind: 'go' }
  | { kind: 'skip-disabled' }
  | { kind: 'skip-already-done' }              // once-per-day + flag set
  | { kind: 'skip-cap' }                       // employer cap was hit today
  | { kind: 'skip-not-employed' }              // overTime block absent
  | { kind: 'skip-work-not-done' }             // regular daily work not confirmed yet
  | { kind: 'skip-cooldown'; untilSec: number; flagAlreadySet: boolean }
  | { kind: 'skip-points'; have: number; need: 24 }
  | { kind: 'skip-energy'; have: number; need: 10 }
  | { kind: 'reconcile-external' };            // cooldown active + flag unset → mark external

const MIN_POINTS = 24;
const MIN_ENERGY = 10;
/**
 * Extra seconds to wait past `nextOverTime` before considering the cooldown
 * elapsed. Prevents a client clock running a few seconds ahead of the server
 * from triggering a POST while the server still considers cooldown active —
 * which would cost 100 energy (anti-spam penalty, see kb/Work_Overtime.md)
 * and produce a `status: false` response that the orchestrator would
 * mis-interpret as an employer cap.
 */
const COOLDOWN_BUFFER_SEC = 10;

export function decideOvertime(input: OvertimePolicyInput): OvertimeDecision {
  const { jobOverTime, state, settings, nowSec } = input;

  if (!settings.enabled) return { kind: 'skip-disabled' };
  if (state.capReached) return { kind: 'skip-cap' };

  // Once-per-day: if the daily flag is set (agent OR external), don't try again.
  // When-available: ignore the flag — we want to keep trying as long as the
  // server allows.
  if (settings.mode === 'once-per-day' && state.workOvertimeDone) {
    return { kind: 'skip-already-done' };
  }

  if (jobOverTime == null) return { kind: 'skip-not-employed' };

  // Defense-in-depth: never POST overtime before regular daily work is
  // confirmed done today. Placed after the employed check so an unemployed
  // citizen still surfaces as `skip-not-employed`.
  if (!state.workDoneToday) return { kind: 'skip-work-not-done' };

  const cooldownActive = jobOverTime.nextOverTime + COOLDOWN_BUFFER_SEC > nowSec;
  if (cooldownActive) {
    // Cooldown observed AND flag unset → someone else (player / other bot) did
    // OT recently. Mark external so the UI/digest reflect reality. The
    // orchestrator translates this into a state mutation without POSTing.
    //
    // Already-set flag means either (a) the agent just POSTed earlier in this
    // session (own footprint) or (b) we already marked external on a prior
    // cycle. Either way, no further action needed — just skip.
    if (!state.workOvertimeDone) {
      return { kind: 'reconcile-external' };
    }
    return { kind: 'skip-cooldown', untilSec: jobOverTime.nextOverTime, flagAlreadySet: true };
  }

  if (jobOverTime.points < MIN_POINTS) {
    return { kind: 'skip-points', have: jobOverTime.points, need: MIN_POINTS };
  }
  if (jobOverTime.usableEnergy < MIN_ENERGY) {
    return { kind: 'skip-energy', have: jobOverTime.usableEnergy, need: MIN_ENERGY };
  }

  return { kind: 'go' };
}
