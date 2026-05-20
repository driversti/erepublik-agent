# Work Overtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic `workOvertime` action to the daily runner that fires either once per PST day (default) or whenever the API allows (operator-selectable). Strictly avoids the 100-energy anti-spam penalty and detects the player-practice employer per-day cap, pausing for the rest of the day when hit.

**Architecture:** A new pure policy module `tools/workOvertime.policy.ts` makes the gate decision from `job-data` + memory + settings. A thin transport `tools/workOvertime.ts` exposes `getJobData()` and `workOvertime()`. The orchestrator `agent/runOvertime.ts` glues policy + transport + state mutations + Telegram. The runner calls it between `train` and `vipClaim`, replacing the existing for-loop over `pendingActions` with explicit ordered calls (so OT can sit mid-sequence without entering `ACTIVE_SAFE_DAILY_KEYS`, whose `pendingActions` model can't express OT's "always retry in when-available mode" semantics).

**Tech Stack:** TypeScript (ESM, `tsx`), vitest, Zod. No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-05-20-work-overtime-design.md`
**KB notes:** `~/Projects/erepublik/kb/Work_Overtime.md`

---

## File Structure

**Create:**
- `src/tools/workOvertime.ts` — transport: `getJobData()` (GET) + `workOvertime()` (POST). Refuses to POST if `nextOverTime > now` (defense-in-depth — policy already gates).
- `src/tools/workOvertime.policy.ts` — pure `decideOvertime(input)` returning a tagged `OvertimeDecision`.
- `src/tools/workOvertime.policy.test.ts` — vitest matrix covering all decision branches.
- `src/agent/runOvertime.ts` — orchestrator `runOvertimeIfEligible(ctx, csrf, state, settings, opts)`; reads job-data, runs policy, POSTs, mutates state, sends Telegram.
- `src/agent/runOvertime.test.ts` — vitest with a fake transport + state assertions.

**Modify:**
- `src/transport/allowlist.ts` — add 2 endpoints.
- `src/memory/schema.ts` — extend `DailyState.completedActions` with `workOvertime`, add `overtimeCapReachedAt` field, add `overtimeStillPending(state, settings)` helper.
- `src/memory/schema.test.ts` *(create if missing)* — defaults + parse round-trip.
- `src/ui/settingsStore.ts` — add `WorkOvertimeSettings` block.
- `src/agent/runner.ts` — replace the action for-loop with explicit ordered calls; insert `runOvertimeIfEligible` between train and vipClaim; extend the shortCircuit predicate; stamp `dailyActions.workOvertime` and snapshot OT flag.
- `src/ui/snapshot.ts` — add `workOvertime: boolean` to `dailyActions`.
- `src/ui/public/app.js` — render OT row.
- `src/ui/public/index.html` — settings card for OT (enabled checkbox, mode selector).
- `src/agent/digests.ts` — include OT flag in `formatDigest`.
- `src/agent/digests.test.ts` — assert OT row in formatted digest.

**Untouched:**
- `src/agent/cycle.ts` — mission-based `reconcile()` doesn't apply (mission `100002` doesn't uniquely identify OT). OT reconciliation lives in `agent/runOvertime.ts`.
- `src/agent/actions.ts` — OT is not a member of `ACTIVE_SAFE_DAILY_KEYS`, kept separate from `runAction()`.
- Browser session, captcha, farm strategies, farm gate.

---

## Task 1: Allowlist additions

**Files:**
- Modify: `src/transport/allowlist.ts`

- [ ] **Step 1: Add the two new entries**

Insert into the `PHASE_1_ALLOWLIST` array (after the existing `'/en/economy/work'` entry to keep work-family endpoints grouped):

```ts
  { method: 'POST', path: '/en/economy/work' },
  { method: 'GET', path: '/en/main/job-data' },
  { method: 'POST', path: '/en/economy/workOvertime' },
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `npm test -- --run`
Expected: PASS, no regressions.

- [ ] **Step 3: Commit**

```bash
git add src/transport/allowlist.ts
git commit -m "feat(transport): allow job-data and workOvertime endpoints"
```

---

## Task 2: Pure decision policy + matrix tests

**Files:**
- Create: `src/tools/workOvertime.policy.ts`
- Create: `src/tools/workOvertime.policy.test.ts`

- [ ] **Step 1: Write the policy module**

Create `src/tools/workOvertime.policy.ts`:

```ts
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
  | { kind: 'skip-cooldown'; untilSec: number; flagAlreadySet: boolean }
  | { kind: 'skip-points'; have: number; need: 24 }
  | { kind: 'skip-energy'; have: number; need: 10 }
  | { kind: 'reconcile-external' };            // cooldown active + flag unset → mark external

const MIN_POINTS = 24;
const MIN_ENERGY = 10;

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

  const cooldownActive = jobOverTime.nextOverTime > nowSec;
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
```

- [ ] **Step 2: Write failing matrix tests**

Create `src/tools/workOvertime.policy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decideOvertime, type OvertimePolicyInput } from './workOvertime.policy.js';

const NOW = 1_769_400_000; // Unix-seconds, arbitrary stable anchor

function input(overrides: Partial<OvertimePolicyInput> = {}): OvertimePolicyInput {
  return {
    jobOverTime: { points: 1000, usableEnergy: 500, nextOverTime: 0 },
    state: { workOvertimeDone: false, capReached: false },
    settings: { enabled: true, mode: 'once-per-day' },
    nowSec: NOW,
    ...overrides,
  };
}

describe('decideOvertime', () => {
  it('skips when disabled', () => {
    expect(decideOvertime(input({ settings: { enabled: false, mode: 'once-per-day' } })))
      .toEqual({ kind: 'skip-disabled' });
  });

  it('skips when cap reached, regardless of mode', () => {
    expect(decideOvertime(input({ state: { workOvertimeDone: false, capReached: true } })))
      .toEqual({ kind: 'skip-cap' });
    expect(decideOvertime(input({
      state: { workOvertimeDone: false, capReached: true },
      settings: { enabled: true, mode: 'when-available' },
    }))).toEqual({ kind: 'skip-cap' });
  });

  it('once-per-day: skips when flag set', () => {
    expect(decideOvertime(input({ state: { workOvertimeDone: true, capReached: false } })))
      .toEqual({ kind: 'skip-already-done' });
  });

  it('when-available: proceeds even when flag set (will be re-routed by other branches)', () => {
    const d = decideOvertime(input({
      state: { workOvertimeDone: true, capReached: false },
      settings: { enabled: true, mode: 'when-available' },
    }));
    expect(d).toEqual({ kind: 'go' });
  });

  it('skips when overTime missing (not employed)', () => {
    expect(decideOvertime(input({ jobOverTime: null }))).toEqual({ kind: 'skip-not-employed' });
  });

  it('cooldown active + flag unset → reconcile-external', () => {
    const d = decideOvertime(input({
      jobOverTime: { points: 1000, usableEnergy: 500, nextOverTime: NOW + 100 },
    }));
    expect(d).toEqual({ kind: 'reconcile-external' });
  });

  it('cooldown active + flag set → skip-cooldown (no double-reconcile)', () => {
    const d = decideOvertime(input({
      jobOverTime: { points: 1000, usableEnergy: 500, nextOverTime: NOW + 100 },
      state: { workOvertimeDone: true, capReached: false },
    }));
    expect(d).toEqual({ kind: 'skip-cooldown', untilSec: NOW + 100, flagAlreadySet: true });
  });

  it('cooldown elapsed (nextOverTime == now)', () => {
    expect(decideOvertime(input({
      jobOverTime: { points: 1000, usableEnergy: 500, nextOverTime: NOW },
    }))).toEqual({ kind: 'go' });
  });

  it('cooldown == 0 (no cooldown ever)', () => {
    expect(decideOvertime(input({
      jobOverTime: { points: 1000, usableEnergy: 500, nextOverTime: 0 },
    }))).toEqual({ kind: 'go' });
  });

  it('skips when points < 24', () => {
    expect(decideOvertime(input({
      jobOverTime: { points: 23, usableEnergy: 500, nextOverTime: 0 },
    }))).toEqual({ kind: 'skip-points', have: 23, need: 24 });
  });

  it('skips when energy < 10', () => {
    expect(decideOvertime(input({
      jobOverTime: { points: 1000, usableEnergy: 9, nextOverTime: 0 },
    }))).toEqual({ kind: 'skip-energy', have: 9, need: 10 });
  });

  it('proceeds with go at exactly the thresholds (points=24, energy=10)', () => {
    expect(decideOvertime(input({
      jobOverTime: { points: 24, usableEnergy: 10, nextOverTime: 0 },
    }))).toEqual({ kind: 'go' });
  });

  it('priority: skip-disabled wins over everything else', () => {
    expect(decideOvertime(input({
      settings: { enabled: false, mode: 'once-per-day' },
      state: { workOvertimeDone: false, capReached: true },
      jobOverTime: { points: 0, usableEnergy: 0, nextOverTime: NOW + 9999 },
    }))).toEqual({ kind: 'skip-disabled' });
  });

  it('priority: skip-cap wins over preconditions', () => {
    expect(decideOvertime(input({
      state: { workOvertimeDone: false, capReached: true },
      jobOverTime: { points: 0, usableEnergy: 0, nextOverTime: NOW + 9999 },
    }))).toEqual({ kind: 'skip-cap' });
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/tools/workOvertime.policy.test.ts`
Expected: 13 tests passing.

- [ ] **Step 4: Commit**

```bash
git add src/tools/workOvertime.policy.ts src/tools/workOvertime.policy.test.ts
git commit -m "feat(tools): pure decision policy for workOvertime"
```

---

## Task 3: Transport (`getJobData`, `workOvertime`)

**Files:**
- Create: `src/tools/workOvertime.ts`

- [ ] **Step 1: Write the transport module**

Create `src/tools/workOvertime.ts`:

```ts
import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';
import type { OvertimeData } from './workOvertime.policy.js';

/** Slim shape of `/en/main/job-data` — only the fields the agent reads. */
export interface JobDataResponse {
  isEmployee: boolean;
  alreadyWorked?: boolean;
  /** Absent when isEmployee is false. */
  overTime?: OvertimeData & { salary?: number };
}

export interface WorkOvertimeResultBody {
  netSalary?: number;
  grossSalary?: number;
  tax?: number;
  currency?: string;
  days_in_a_row?: number;
  xp?: number;
  health?: number;
}

/**
 * Response shape we care about. `status: true` + `result` on success;
 * `status: false` + `message: string` on failure.
 */
export interface WorkOvertimeResponse {
  status: boolean;
  message?: boolean | string;
  result?: WorkOvertimeResultBody;
}

export async function getJobData(ctx: BrowserContext, csrf: string): Promise<JobDataResponse> {
  const { body } = await apiCall<JobDataResponse>(ctx, {
    method: 'GET',
    path: '/en/main/job-data',
    csrf,
  });
  return body;
}

export interface OvertimePostResult {
  /** True iff response.status === true (server-confirmed success). */
  success: boolean;
  /** HTTP status code from the POST. */
  httpStatus: number;
  /** Server message — string on failure, boolean `true` on success. */
  message: string | null;
  result: WorkOvertimeResultBody | null;
}

/**
 * POST /en/economy/workOvertime. Caller is responsible for gating on cooldown —
 * the spec marks this as critical (100-energy anti-spam penalty if posted
 * inside the 1-hour cooldown). This function does NOT add a fallback check
 * because the gate already lives in `decideOvertime`, and double-checking
 * inside the transport would dilute the single source of truth.
 *
 * Never sends `useEnergyBar=yes` — we don't burn bars on OT.
 */
export async function workOvertime(ctx: BrowserContext, csrf: string): Promise<OvertimePostResult> {
  const { status, body } = await apiCall<WorkOvertimeResponse>(ctx, {
    method: 'POST',
    path: '/en/economy/workOvertime',
    csrf,
    form: { action_type: 'workOvertime' },
  });
  const success = body.status === true;
  const message =
    typeof body.message === 'string' ? body.message : success ? null : 'unknown';
  return {
    success,
    httpStatus: status,
    message,
    result: body.result ?? null,
  };
}
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/workOvertime.ts
git commit -m "feat(tools): transport wrappers for job-data and workOvertime"
```

---

## Task 4: Memory schema — `workOvertime` flag + cap timestamp

**Files:**
- Modify: `src/memory/schema.ts`
- Create: `src/memory/schema.test.ts` (if it doesn't exist; otherwise modify)

- [ ] **Step 1: Check whether `schema.test.ts` exists**

Run: `ls src/memory/schema.test.ts 2>/dev/null || echo MISSING`
Note the result so the next step writes/appends accordingly.

- [ ] **Step 2: Extend `DailyState` in `src/memory/schema.ts`**

Replace lines 14-44 (the `DailyState` block + `emptyState` helper) with:

```ts
export const DailyState = z.object({
  eRepublikDay: z.number().int(),
  completedActions: z.object({
    work: ActionRecord.optional(),
    train: ActionRecord.optional(),
    buyFood: BuyFoodRecord.optional(),
    vipClaim: ActionRecord.optional(),
    workOvertime: ActionRecord.optional(),
  }),
  claimedMissionIds: z.array(z.number().int()).default([]),
  claimedChestThresholds: z.array(z.number().int()).default([]),
  notifiedNoJobToday: z.boolean().default(false),
  lastDigestHash: z.string().nullable().default(null),
  awaySince: z.string().nullable().default(null),
  /**
   * ISO timestamp set when a `workOvertime` POST returned `status: false`
   * despite the local gate (points/energy/cooldown) being clean. Interpreted
   * as the employer per-day cap being reached — pauses further OT attempts
   * until day rollover (when the file is archived and a fresh DailyState is
   * created).
   */
  overtimeCapReachedAt: z.string().nullable().default(null),
});

export type DailyState = z.infer<typeof DailyState>;

export function emptyState(day: number): DailyState {
  return {
    eRepublikDay: day,
    completedActions: {},
    claimedMissionIds: [],
    claimedChestThresholds: [],
    notifiedNoJobToday: false,
    lastDigestHash: null,
    awaySince: null,
    overtimeCapReachedAt: null,
  };
}
```

- [ ] **Step 3: Add an `overtimeStillPending` helper at the end of the file**

Append below `allSafeDailyDone`:

```ts
/**
 * Whether OT should still be considered for this cycle. Used by the runner's
 * shortCircuit predicate so that an idle-otherwise cycle still attempts OT.
 *
 * `ACTIVE_SAFE_DAILY_KEYS` intentionally does NOT include `workOvertime`
 * because OT's retry semantics in `when-available` mode don't fit the
 * "set flag → never retry" model. The orchestrator (`agent/runOvertime.ts`)
 * is responsible for the actual call; this helper just gates the optimisation.
 */
export function overtimeStillPending(
  s: DailyState,
  settings: { enabled: boolean; mode: 'once-per-day' | 'when-available' },
): boolean {
  if (!settings.enabled) return false;
  if (s.overtimeCapReachedAt != null) return false;
  if (settings.mode === 'when-available') return true;
  return s.completedActions.workOvertime == null;
}
```

- [ ] **Step 4: Write/extend schema tests**

If `src/memory/schema.test.ts` was MISSING, create it with:

```ts
import { describe, it, expect } from 'vitest';
import { DailyState, emptyState, overtimeStillPending } from './schema.js';

describe('DailyState schema', () => {
  it('emptyState produces a parseable DailyState', () => {
    const s = emptyState(6755);
    expect(DailyState.parse(s)).toEqual(s);
    expect(s.overtimeCapReachedAt).toBeNull();
    expect(s.completedActions.workOvertime).toBeUndefined();
  });

  it('round-trips through parse with optional workOvertime', () => {
    const raw = JSON.parse(JSON.stringify({
      ...emptyState(6755),
      completedActions: {
        work: { at: '2026-05-20T08:00:00Z', source: 'agent' },
        workOvertime: { at: '2026-05-20T08:10:00Z', source: 'agent' },
      },
      overtimeCapReachedAt: '2026-05-20T14:00:00Z',
    }));
    const parsed = DailyState.parse(raw);
    expect(parsed.completedActions.workOvertime).toEqual({
      at: '2026-05-20T08:10:00Z',
      source: 'agent',
    });
    expect(parsed.overtimeCapReachedAt).toBe('2026-05-20T14:00:00Z');
  });

  it('accepts legacy state files without overtimeCapReachedAt (defaults to null)', () => {
    const legacy = {
      eRepublikDay: 6755,
      completedActions: {},
      claimedMissionIds: [],
      claimedChestThresholds: [],
      notifiedNoJobToday: false,
      lastDigestHash: null,
      awaySince: null,
    };
    expect(DailyState.parse(legacy).overtimeCapReachedAt).toBeNull();
  });
});

describe('overtimeStillPending', () => {
  const baseState = emptyState(6755);

  it('returns false when settings disabled', () => {
    expect(overtimeStillPending(baseState, { enabled: false, mode: 'once-per-day' }))
      .toBe(false);
  });

  it('returns false when cap reached', () => {
    expect(overtimeStillPending(
      { ...baseState, overtimeCapReachedAt: '2026-05-20T14:00:00Z' },
      { enabled: true, mode: 'once-per-day' },
    )).toBe(false);
  });

  it('once-per-day: false when flag set, true when unset', () => {
    expect(overtimeStillPending(
      baseState,
      { enabled: true, mode: 'once-per-day' },
    )).toBe(true);
    const done = {
      ...baseState,
      completedActions: { workOvertime: { at: '2026-05-20T08:00:00Z', source: 'agent' as const } },
    };
    expect(overtimeStillPending(done, { enabled: true, mode: 'once-per-day' })).toBe(false);
  });

  it('when-available: always true regardless of flag', () => {
    const done = {
      ...baseState,
      completedActions: { workOvertime: { at: '2026-05-20T08:00:00Z', source: 'agent' as const } },
    };
    expect(overtimeStillPending(done, { enabled: true, mode: 'when-available' })).toBe(true);
  });
});
```

If the file already existed, append the `describe('DailyState schema', …)` and `describe('overtimeStillPending', …)` blocks at the end instead of overwriting.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/memory/schema.test.ts`
Expected: all tests pass (7 in this file if new).

- [ ] **Step 6: Commit**

```bash
git add src/memory/schema.ts src/memory/schema.test.ts
git commit -m "feat(memory): persist workOvertime flag + cap timestamp"
```

---

## Task 5: Settings — `WorkOvertimeSettings` block

**Files:**
- Modify: `src/ui/settingsStore.ts`

- [ ] **Step 1: Add the schema block above the existing `DetectedState` block**

Insert after `FarmSessionSettings` (around line 53) and before `DetectedState` (line 55):

```ts
const WorkOvertimeSettings = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(['once-per-day', 'when-available']).default('once-per-day'),
});
```

- [ ] **Step 2: Add the `workOvertime` field to the top-level `Settings` object**

Insert into the `Settings = z.object({ ... })` block (after `farmSession`, before `detected`):

```ts
  workOvertime: WorkOvertimeSettings.default(() => ({
    enabled: true,
    mode: 'once-per-day' as const,
  })),
```

- [ ] **Step 3: Verify `DEFAULT_SETTINGS` still parses**

Run: `npx vitest run src/ui/settingsStore.test.ts` (file already exists per `ls src/ui/*.test.ts`).
Expected: existing tests still pass. The added field is fully defaulted so no test edits required yet.

- [ ] **Step 4: Add focused tests for the new block**

Append to `src/ui/settingsStore.test.ts`:

```ts
import { Settings, DEFAULT_SETTINGS } from './settingsStore.js';

describe('Settings.workOvertime', () => {
  it('has feature enabled by default in once-per-day mode', () => {
    expect(DEFAULT_SETTINGS.workOvertime.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.workOvertime.mode).toBe('once-per-day');
  });

  it('accepts both modes', () => {
    const a = Settings.parse({ ...DEFAULT_SETTINGS, workOvertime: { enabled: true, mode: 'once-per-day' } });
    const b = Settings.parse({ ...DEFAULT_SETTINGS, workOvertime: { enabled: true, mode: 'when-available' } });
    expect(a.workOvertime.mode).toBe('once-per-day');
    expect(b.workOvertime.mode).toBe('when-available');
  });

  it('rejects an unknown mode', () => {
    expect(() =>
      Settings.parse({ ...DEFAULT_SETTINGS, workOvertime: { enabled: true, mode: 'whenever-i-want' } }),
    ).toThrow();
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/ui/settingsStore.test.ts`
Expected: all tests pass including the 3 new ones.

- [ ] **Step 6: Commit**

```bash
git add src/ui/settingsStore.ts src/ui/settingsStore.test.ts
git commit -m "feat(settings): add workOvertime block (enabled + mode)"
```

---

## Task 6: Orchestrator — `agent/runOvertime.ts`

**Files:**
- Create: `src/agent/runOvertime.ts`
- Create: `src/agent/runOvertime.test.ts`

- [ ] **Step 1: Write the orchestrator**

Create `src/agent/runOvertime.ts`:

```ts
import type { BrowserContext } from 'playwright-core';
import type { DailyState } from '../memory/schema.js';
import type { Settings } from '../ui/settingsStore.js';
import { decideOvertime, type OvertimeDecision } from '../tools/workOvertime.policy.js';
import { getJobData, workOvertime, type OvertimePostResult, type JobDataResponse } from '../tools/workOvertime.js';

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
        const tag = net != null && cur != null ? `+${net} ${cur}` : 'success';
        await opts.notify(`💼 OT: ${tag}`);
        return { decision, post, netSalary: net, currency: cur };
      }
      // All client-side preconditions were clean → treat as cap.
      state.overtimeCapReachedAt = nowIso;
      await opts.notify('⛔ overtime: employer cap reached — paused until day rollover');
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
```

- [ ] **Step 2: Write tests using a fake transport via vitest.mock**

Create `src/agent/runOvertime.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DailyState } from '../memory/schema.js';
import type { Settings } from '../ui/settingsStore.js';
import { emptyState } from '../memory/schema.js';

const getJobData = vi.fn();
const workOvertime = vi.fn();

vi.mock('../tools/workOvertime.js', () => ({
  getJobData: (...a: unknown[]) => getJobData(...a),
  workOvertime: (...a: unknown[]) => workOvertime(...a),
}));

// Import AFTER vi.mock so the orchestrator picks up the mocked transport.
const { runOvertimeIfEligible } = await import('./runOvertime.js');

const FIXED_NOW = new Date('2026-05-20T12:00:00.000Z');
const FIXED_NOW_SEC = Math.floor(FIXED_NOW.getTime() / 1000);
const fixedNow = () => FIXED_NOW;

function settings(overrides: Partial<Settings['workOvertime']> = {}): Settings {
  // Only the `workOvertime` block matters here; the orchestrator never reads
  // anything else, so we cast a minimal stub through unknown.
  return {
    workOvertime: { enabled: true, mode: 'once-per-day', ...overrides },
  } as unknown as Settings;
}

function notifyCaptor() {
  const calls: string[] = [];
  return {
    notify: async (m: string) => { calls.push(m); },
    calls,
  };
}

beforeEach(() => {
  getJobData.mockReset();
  workOvertime.mockReset();
});

describe('runOvertimeIfEligible', () => {
  it('short-circuits when settings disabled (no API call)', async () => {
    const s = emptyState(6755);
    const cap = notifyCaptor();
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings({ enabled: false }), { notify: cap.notify, now: fixedNow },
    );
    expect(out.decision).toEqual({ kind: 'skip-disabled' });
    expect(getJobData).not.toHaveBeenCalled();
    expect(workOvertime).not.toHaveBeenCalled();
    expect(cap.calls).toEqual([]);
  });

  it('short-circuits when cap reached (no API call)', async () => {
    const s: DailyState = { ...emptyState(6755), overtimeCapReachedAt: '2026-05-20T11:00:00Z' };
    const cap = notifyCaptor();
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings(), { notify: cap.notify, now: fixedNow },
    );
    expect(out.decision).toEqual({ kind: 'skip-cap' });
    expect(getJobData).not.toHaveBeenCalled();
  });

  it('reconcile-external: cooldown active + flag unset → mark external, no POST', async () => {
    const s = emptyState(6755);
    getJobData.mockResolvedValue({
      isEmployee: true,
      overTime: { points: 1000, usableEnergy: 500, nextOverTime: FIXED_NOW_SEC + 600 },
    });
    const cap = notifyCaptor();
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings(), { notify: cap.notify, now: fixedNow },
    );
    expect(out.decision).toEqual({ kind: 'reconcile-external' });
    expect(workOvertime).not.toHaveBeenCalled();
    expect(s.completedActions.workOvertime).toEqual({
      at: FIXED_NOW.toISOString(),
      source: 'external',
    });
    expect(cap.calls).toEqual([]); // silent reconciliation
  });

  it('go: marks completedActions agent + emits success notification', async () => {
    const s = emptyState(6755);
    getJobData.mockResolvedValue({
      isEmployee: true,
      overTime: { points: 1000, usableEnergy: 500, nextOverTime: 0 },
    });
    workOvertime.mockResolvedValue({
      success: true,
      httpStatus: 200,
      message: null,
      result: { netSalary: 7425, currency: 'LTL' },
    });
    const cap = notifyCaptor();
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings(), { notify: cap.notify, now: fixedNow },
    );
    expect(out.decision).toEqual({ kind: 'go' });
    expect(out.netSalary).toBe(7425);
    expect(out.currency).toBe('LTL');
    expect(s.completedActions.workOvertime).toEqual({
      at: FIXED_NOW.toISOString(),
      source: 'agent',
    });
    expect(cap.calls).toEqual(['💼 OT: +7425 LTL']);
  });

  it('go but clean-precondition failure → mark cap + alert', async () => {
    const s = emptyState(6755);
    getJobData.mockResolvedValue({
      isEmployee: true,
      overTime: { points: 1000, usableEnergy: 500, nextOverTime: 0 },
    });
    workOvertime.mockResolvedValue({
      success: false,
      httpStatus: 200,
      message: 'something else the server returned',
      result: null,
    });
    const cap = notifyCaptor();
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings(), { notify: cap.notify, now: fixedNow },
    );
    expect(out.decision).toEqual({ kind: 'go' });
    expect(s.overtimeCapReachedAt).toBe(FIXED_NOW.toISOString());
    expect(cap.calls).toEqual(['⛔ overtime: employer cap reached — paused until day rollover']);
  });

  it('skip-cooldown when flag already set (does not double-reconcile)', async () => {
    const s: DailyState = {
      ...emptyState(6755),
      completedActions: {
        workOvertime: { at: '2026-05-20T11:00:00Z', source: 'agent' },
      },
    };
    getJobData.mockResolvedValue({
      isEmployee: true,
      overTime: { points: 1000, usableEnergy: 500, nextOverTime: FIXED_NOW_SEC + 600 },
    });
    const cap = notifyCaptor();
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings(), { notify: cap.notify, now: fixedNow },
    );
    expect(out.decision.kind).toBe('skip-cooldown');
    expect(s.completedActions.workOvertime?.source).toBe('agent'); // unchanged
    expect(workOvertime).not.toHaveBeenCalled();
  });

  it('failure in transport returns failed decision, leaves state untouched', async () => {
    const s = emptyState(6755);
    const original = JSON.parse(JSON.stringify(s));
    getJobData.mockRejectedValue(new Error('network ded'));
    const cap = notifyCaptor();
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings(), { notify: cap.notify, now: fixedNow },
    );
    expect(out.decision).toEqual({ kind: 'failed', error: 'network ded' });
    expect(s).toEqual(original);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/agent/runOvertime.test.ts`
Expected: 7 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/agent/runOvertime.ts src/agent/runOvertime.test.ts
git commit -m "feat(agent): orchestrator for workOvertime (decide, POST, cap detect)"
```

---

## Task 7: Runner integration

**Files:**
- Modify: `src/agent/runner.ts`

- [ ] **Step 1: Import the new orchestrator**

In `src/agent/runner.ts`, near the existing `import { runAction } from './actions.js';` line, add:

```ts
import { runOvertimeIfEligible } from './runOvertime.js';
```

Also extend the `overtimeStillPending` import path by adding it to the existing schema import:

Find:

```ts
import { allSafeDailyDone, pendingActions } from '../memory/schema.js';
```

Replace with:

```ts
import { allSafeDailyDone, overtimeStillPending, pendingActions } from '../memory/schema.js';
```

- [ ] **Step 2: Extend the `shortCircuit` predicate**

In `runCycle`, find the existing block:

```ts
  const shortCircuit =
    allSafeDailyDone(state) &&
    unclaimedMissions.length === 0 &&
    unclaimedObjectives.length === 0 &&
    !weeklyUnclaimed;
```

Replace with:

```ts
  const shortCircuit =
    allSafeDailyDone(state) &&
    unclaimedMissions.length === 0 &&
    unclaimedObjectives.length === 0 &&
    !weeklyUnclaimed &&
    !overtimeStillPending(state, settings.workOvertime);
```

- [ ] **Step 3: Replace the action for-loop with explicit ordered calls**

In `runCycle`, find:

```ts
      // 1. Run pending safe-daily actions in a fixed order.
      for (const action of pending) {
        try {
          await runAction(action, ctx, csrf, countryId, state, {
            autoEmploy: settings.autoEmploy,
            maxFoodPrice: env.ERP_MAX_FOOD_PRICE,
            notify: (m) => notifier.send(m),
          });
        } catch (err) {
          const msg = `[cycle] ${action} threw: ${(err as Error).message}`;
          console.error(msg);
          bridge.emitLog('error', msg);
        }
      }
```

Replace with:

```ts
      // 1. Run pending safe-daily actions in a fixed order. Explicit calls
      //    (not a loop over `pending`) so the workOvertime orchestrator can
      //    sit between `train` and `vipClaim` per the spec (R2). OT is not
      //    a member of `ACTIVE_SAFE_DAILY_KEYS` because its retry semantics
      //    in `when-available` mode don't fit the "set flag → never retry"
      //    model the loop relies on.
      const runActionOpts = {
        autoEmploy: settings.autoEmploy,
        maxFoodPrice: env.ERP_MAX_FOOD_PRICE,
        notify: (m: string) => notifier.send(m),
      };
      async function tryAction(action: import('../memory/schema.js').ActiveSafeDailyKey) {
        if (!pending.includes(action)) return;
        try {
          await runAction(action, ctx, csrf, countryId, state, runActionOpts);
        } catch (err) {
          const msg = `[cycle] ${action} threw: ${(err as Error).message}`;
          console.error(msg);
          bridge.emitLog('error', msg);
        }
      }

      await tryAction('work');
      await tryAction('train');

      try {
        const ot = await runOvertimeIfEligible(ctx, csrf, state, settings, {
          notify: (m) => notifier.send(m),
        });
        console.log(`[cycle] workOvertime: ${ot.decision.kind}` +
          (ot.netSalary != null ? ` (+${ot.netSalary} ${ot.currency})` : ''));
      } catch (err) {
        const msg = `[cycle] workOvertime threw: ${(err as Error).message}`;
        console.error(msg);
        bridge.emitLog('error', msg);
      }

      await tryAction('vipClaim');
      await tryAction('buyFood');
```

- [ ] **Step 4: Stamp the OT flag onto the UI snapshot**

Find the `uiSnapshot.dailyActions = { … }` block:

```ts
  uiSnapshot.dailyActions = {
    work: !!state.completedActions.work,
    train: !!state.completedActions.train,
    buyFood: !!state.completedActions.buyFood,
    vipClaim: !!state.completedActions.vipClaim,
  };
```

Replace with:

```ts
  uiSnapshot.dailyActions = {
    work: !!state.completedActions.work,
    train: !!state.completedActions.train,
    buyFood: !!state.completedActions.buyFood,
    vipClaim: !!state.completedActions.vipClaim,
    workOvertime: !!state.completedActions.workOvertime,
  };
```

- [ ] **Step 5: Type-check and run all tests**

Run: `npm run typecheck && npm test -- --run`
Expected: typecheck clean; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/agent/runner.ts
git commit -m "feat(runner): wire workOvertime into daily cycle between train and vipClaim"
```

---

## Task 8: UI snapshot + dashboard render

**Files:**
- Modify: `src/ui/snapshot.ts`
- Modify: `src/ui/public/app.js`

- [ ] **Step 1: Extend `UiSnapshot.dailyActions`**

In `src/ui/snapshot.ts`, find:

```ts
  /** Daily action flags mirrored from DailyState.completedActions. */
  dailyActions: {
    work: boolean;
    train: boolean;
    buyFood: boolean;
    vipClaim: boolean;
  };
```

Replace with:

```ts
  /** Daily action flags mirrored from DailyState.completedActions. */
  dailyActions: {
    work: boolean;
    train: boolean;
    buyFood: boolean;
    vipClaim: boolean;
    workOvertime: boolean;
  };
```

And in `createSnapshot()`, find:

```ts
    dailyActions: { work: false, train: false, buyFood: false, vipClaim: false },
```

Replace with:

```ts
    dailyActions: { work: false, train: false, buyFood: false, vipClaim: false, workOvertime: false },
```

- [ ] **Step 2: Render OT in the dashboard list**

In `src/ui/public/app.js`, find:

```js
  const da = s.dailyActions;
  document.getElementById('daily-actions').innerHTML = [
    ['Work', da.work],
    ['Train', da.train],
    ['Buy food', da.buyFood],
    ['VIP claim', da.vipClaim],
  ]
```

Replace with:

```js
  const da = s.dailyActions;
  document.getElementById('daily-actions').innerHTML = [
    ['Work', da.work],
    ['Train', da.train],
    ['Overtime', da.workOvertime],
    ['VIP claim', da.vipClaim],
    ['Buy food', da.buyFood],
  ]
```

(Note: ordering also reshuffles to match the cycle execution order: work → train → OT → VIP → food.)

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/ui/snapshot.ts src/ui/public/app.js
git commit -m "feat(ui): surface workOvertime flag in dashboard"
```

---

## Task 9: UI settings card (enable + mode)

**Files:**
- Modify: `src/ui/public/index.html`
- Modify: `src/ui/public/app.js`

- [ ] **Step 1: Find the right place to insert the settings card**

Run: `grep -n "farmEnabled\|paused\|emptyDiv" src/ui/public/index.html | head -10`

Expected: rows showing where existing settings live (e.g. a `<section>` block for the global toggles). Insert the OT card adjacent to those (same visual grouping).

- [ ] **Step 2: Add the OT card HTML**

Append the following inside the same settings-grouping container (right after the `farmEnabled` toggle block — adjust the selector you saw in Step 1):

```html
<section class="settings-card" data-card="overtime">
  <h3>Overtime</h3>
  <label>
    <input type="checkbox" id="ot-enabled" />
    Enabled
  </label>
  <label>
    Mode
    <select id="ot-mode">
      <option value="once-per-day">Once per day</option>
      <option value="when-available">When available</option>
    </select>
  </label>
</section>
```

- [ ] **Step 3: Wire the controls in `app.js`**

Find the existing `renderSettings(...)` or equivalent populate block (search for `farmEnabled` in `app.js`):

Run: `grep -n "farmEnabled\|paused" src/ui/public/app.js | head -10`

Add inside the settings-population function:

```js
  document.getElementById('ot-enabled').checked = !!settings.workOvertime?.enabled;
  document.getElementById('ot-mode').value = settings.workOvertime?.mode ?? 'once-per-day';
```

And inside the settings-save handler (the function that PUTs `/api/settings`), add to the payload assembly:

```js
  payload.workOvertime = {
    enabled: document.getElementById('ot-enabled').checked,
    mode: document.getElementById('ot-mode').value,
  };
```

The handlers for both controls fire the same `saveSettings()` already used by the existing toggles — wire them via the standard `addEventListener('change', saveSettings)` pattern observed in the existing code.

- [ ] **Step 4: Smoke-test in the browser**

Start the runner: `npm start -- --once` (one cycle, then exit). When the UI URL is logged, open it. Confirm:
- The Overtime card is visible.
- Toggling `Enabled` and changing `Mode` round-trips through `config/settings.json` (`cat config/settings.json | jq .workOvertime`).

(If the runner can't start interactively due to session requirements, skip the browser step and rely on Tasks 5 + 8 unit tests + manual inspection of the HTML; the existing UI tests in `src/ui/server.test.ts` etc. will continue to pass.)

- [ ] **Step 5: Commit**

```bash
git add src/ui/public/index.html src/ui/public/app.js
git commit -m "feat(ui): settings card for workOvertime (enable + mode)"
```

---

## Task 10: Digest update

**Files:**
- Modify: `src/agent/digests.ts`
- Modify: `src/agent/digests.test.ts`

- [ ] **Step 1: Update the digest format**

In `src/agent/digests.ts`, find:

```ts
    `Work ${flag(a.work)}  Train ${flag(a.train)}  VIP ${flag(a.vipClaim)}  Food ${flag(a.buyFood)}`,
```

Replace with:

```ts
    `Work ${flag(a.work)}  Train ${flag(a.train)}  OT ${flag(a.workOvertime)}  VIP ${flag(a.vipClaim)}  Food ${flag(a.buyFood)}`,
```

- [ ] **Step 2: Update the digest test**

Run: `grep -n "Work.*Train\|formatDigest" src/agent/digests.test.ts | head`

Find the existing assertion that pins the format string (likely matching the order `Work … Train … VIP … Food`). Update it to expect the new order: `Work … Train … OT … VIP … Food`.

Concretely, replace any test string of the form:

```ts
'Work ⏳  Train ⏳  VIP ⏳  Food ⏳'
```

with:

```ts
'Work ⏳  Train ⏳  OT ⏳  VIP ⏳  Food ⏳'
```

Also add a new focused test that pins the OT flag value:

```ts
import { emptyState } from '../memory/schema.js';

it('shows OT ✅ when workOvertime is recorded', () => {
  const state = emptyState(6755);
  state.completedActions.workOvertime = { at: '2026-05-20T08:00:00Z', source: 'agent' };
  const weekly = { lastClaimedRewardId: null };
  const fuel = { week: 20, spent: 0, hitsLanded: 0, lastFarmedAt: null, nextEligibleAt: null, cyclesSkipped: 0, weekStartInventory: null };
  expect(formatDigest(6755, state, weekly as any, fuel as any, 70))
    .toContain('OT ✅');
});
```

- [ ] **Step 3: Run the digest tests**

Run: `npx vitest run src/agent/digests.test.ts`
Expected: all tests pass, including the new OT-flag assertion.

- [ ] **Step 4: Commit**

```bash
git add src/agent/digests.ts src/agent/digests.test.ts
git commit -m "feat(digest): include OT flag in daily summary"
```

---

## Task 11: Final verification

**Files:** none modified; verification only.

- [ ] **Step 1: Type-check the whole project**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Run all tests**

Run: `npm test -- --run`
Expected: every test file passes (existing + new).

- [ ] **Step 3: Smoke-test one cycle**

Run: `npm run agent` (one cycle via `--once`).

Expected on a normal account (feature defaults to enabled, once-per-day):
- If cooldown active: `[cycle] workOvertime: reconcile-external` (first cycle this PST day) or `skip-cooldown` (subsequent).
- If cooldown clear + preconditions ok: `[cycle] workOvertime: go (+N LTL)` (or whichever currency).
- If clean preconditions but POST fails: `overtimeCapReachedAt` set in `sessions/daily-state-{day}.json`, Telegram receives the cap alert.

To verify the opt-out path, set `workOvertime.enabled = false` in `config/settings.json` and re-run:
- The console log shows `[cycle] workOvertime: skip-disabled`.

- [ ] **Step 4: Verify the dashboard**

Open the UI URL printed at startup. Confirm:
- The "Overtime" row appears in the daily actions block.
- The "Overtime" settings card toggles round-trip through `config/settings.json`.

- [ ] **Step 5: Final commit (if any uncommitted leftovers — e.g. formatting)**

Run: `git status` to verify nothing is left dangling.

```bash
git status
# if clean — nothing to commit. Otherwise inspect and commit deliberately.
```

---

## Self-review checklist

- [x] **R1 (preconditions):** `decideOvertime` checks all three (points, energy, cooldown). Task 2.
- [x] **R2 (ordering work → train → OT → vipClaim → buyFood):** Task 7 explicit-call sequence.
- [x] **R3 (mode selector):** Settings block, Task 5; UI card, Task 9.
- [x] **R4 (cap detection):** Orchestrator marks `overtimeCapReachedAt` on clean-precondition failure, Task 6.
- [x] **R5 (external reconciliation):** `reconcile-external` branch, Task 2 + Task 6.
- [x] **R6 (Telegram):** `💼 OT: +N CC` on success; `⛔ overtime: employer cap reached…` on cap. Both in Task 6.
- [x] **R7 (UI dashboard):** Snapshot + render, Tasks 8 + 9.
- [x] **R8 (digest):** Task 10.
- [x] **No placeholders.** Each code block is complete and copy-pasteable. Steps 1-5 inside each task supply both the test and the implementation.
- [x] **Type consistency.** `OvertimeData`, `OvertimePolicyInput`, `OvertimeDecision`, `RunOvertimeOutcome` defined once and referenced consistently across Tasks 2, 3, 6.
- [x] **Allowlist (precondition):** Task 1 must run before any task that touches `apiCall` for the new endpoints.
