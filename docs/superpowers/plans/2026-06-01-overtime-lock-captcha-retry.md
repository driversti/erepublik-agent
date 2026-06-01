# Overtime `"lock"` → captcha-aware retry + work-first gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop treating an overtime `{status:false, message:"lock"}` response as a permanent day-pause; instead re-check/solve eRepublik's session-unlock captcha and retry next cycle (capped at 5 consecutive unsolved locks), and add a defensive work-first gate to the overtime decision.

**Architecture:** Pure decision logic (`workOvertime.policy.ts`) gains a `workDoneToday` input + `skip-work-not-done` branch. The orchestrator (`runOvertime.ts`) splits its `status:false` handling so `message === "lock"` runs an injected `recheckCaptcha()` and either resets a retry counter (solved) or increments it (unsolved), only pausing once the counter hits the limit. A new `DailyState.overtimeLockRetries` field tracks consecutive locks. The runner wires a real captcha re-check over the existing `handleCaptchaIfPresent` and logs precise tags.

**Tech Stack:** Node 22, TypeScript (ESM, `.js` import suffixes), Zod, vitest.

**Spec:** `docs/superpowers/specs/2026-06-01-overtime-lock-captcha-retry-design.md`

---

## File Structure

- Modify: `src/memory/schema.ts` — add `overtimeLockRetries` field + `emptyState` default.
- Modify: `src/memory/schema.test.ts` — assert new field default + legacy parse.
- Modify: `src/tools/workOvertime.policy.ts` — add `workDoneToday` input + `skip-work-not-done`.
- Modify: `src/tools/workOvertime.policy.test.ts` — new gate cases + thread `workDoneToday` through existing state overrides.
- Modify: `src/agent/runOvertime.ts` — `recheckCaptcha` option, `LOCK_RETRY_LIMIT`, lock branch, `workDoneToday` wiring, `lock` outcome field.
- Modify: `src/agent/runOvertime.test.ts` — work-set helper, lock-branch cases.
- Modify: `src/agent/runner.ts` — pass `recheckCaptcha`, refine OT log tags.

---

## Task 1: `DailyState.overtimeLockRetries` field

**Files:**
- Modify: `src/memory/schema.ts:19-60`
- Test: `src/memory/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/memory/schema.test.ts` inside the `describe('DailyState schema', ...)` block:

```ts
  it('emptyState seeds overtimeLockRetries to 0', () => {
    expect(emptyState(6755).overtimeLockRetries).toBe(0);
  });

  it('accepts legacy state files without overtimeLockRetries (defaults to 0)', () => {
    const legacy = {
      eRepublikDay: 6755,
      completedActions: {},
      claimedMissionIds: [],
      claimedChestThresholds: [],
      notifiedNoJobToday: false,
      lastDigestHash: null,
      awaySince: null,
      overtimeCapReachedAt: null,
    };
    expect(DailyState.parse(legacy).overtimeLockRetries).toBe(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/memory/schema.test.ts`
Expected: FAIL — `expected undefined to be 0` for `overtimeLockRetries`.

- [ ] **Step 3: Implement the field**

In `src/memory/schema.ts`, add the field to the `DailyState` object literal immediately after `overtimeCapReachedAt: z.string().nullable().default(null),` (currently line 44), before the closing `});`:

```ts
  /**
   * Count of consecutive `workOvertime` POSTs that returned
   * `{status:false, message:"lock"}` this game day where a session-unlock
   * captcha was NOT found-and-solved. Reset to 0 when a captcha is solved.
   * Once it reaches `LOCK_RETRY_LIMIT` (see runOvertime.ts) the orchestrator
   * sets `overtimeCapReachedAt` (pause until rollover). Fresh on day rollover.
   */
  overtimeLockRetries: z.number().int().default(0),
```

Then add to the `emptyState` return object (currently lines 50-59), after `overtimeCapReachedAt: null,`:

```ts
    overtimeLockRetries: 0,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/memory/schema.test.ts`
Expected: PASS (all cases, including pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/memory/schema.ts src/memory/schema.test.ts
git commit -m "feat(overtime): add DailyState.overtimeLockRetries counter"
```

---

## Task 2: Work-first gate in `decideOvertime`

**Files:**
- Modify: `src/tools/workOvertime.policy.ts:25-47` (types), `:61-99` (logic)
- Test: `src/tools/workOvertime.policy.test.ts`

- [ ] **Step 1: Update the test helper + existing state overrides**

In `src/tools/workOvertime.policy.test.ts`, change the base `input()` helper's `state` (line 9) to include `workDoneToday: true`:

```ts
    state: { workOvertimeDone: false, capReached: false, workDoneToday: true },
```

Then add `workDoneToday: true` to every explicit `state:` override in the file so they still reach their asserted branch:
- line ~23: `state: { workOvertimeDone: false, capReached: true, workDoneToday: true }`
- line ~26: `state: { workOvertimeDone: false, capReached: true, workDoneToday: true }`
- line ~32: `state: { workOvertimeDone: true, capReached: false, workDoneToday: true }`
- line ~38: `state: { workOvertimeDone: true, capReached: false, workDoneToday: true }`
- line ~56: `state: { workOvertimeDone: true, capReached: false, workDoneToday: true }`
- line ~59 (inside the skip-cooldown test): `state: { workOvertimeDone: true, capReached: false, workDoneToday: true }`
- line ~104-105 (skip-disabled priority): `state: { workOvertimeDone: false, capReached: true, workDoneToday: true }`
- line ~113 (skip-cap priority): `state: { workOvertimeDone: false, capReached: true, workDoneToday: true }`

- [ ] **Step 2: Write the failing tests for the new gate**

Add two new cases inside `describe('decideOvertime', ...)`:

```ts
  it('skips when regular work not done today (work-first gate)', () => {
    expect(decideOvertime(input({
      state: { workOvertimeDone: false, capReached: false, workDoneToday: false },
    }))).toEqual({ kind: 'skip-work-not-done' });
  });

  it('work-first gate sits after the employed check (unemployed → skip-not-employed)', () => {
    expect(decideOvertime(input({
      jobOverTime: null,
      state: { workOvertimeDone: false, capReached: false, workDoneToday: false },
    }))).toEqual({ kind: 'skip-not-employed' });
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/tools/workOvertime.policy.test.ts`
Expected: FAIL — TypeScript error on `workDoneToday` (not in type) and/or the new cases returning `go`/wrong kind.

- [ ] **Step 4: Implement the gate**

In `src/tools/workOvertime.policy.ts`, add `workDoneToday` to the `state` shape in `OvertimePolicyInput` (currently lines 26-30):

```ts
  state: {
    workOvertimeDone: boolean;      // true iff completedActions.workOvertime != null
    capReached: boolean;            // true iff overtimeCapReachedAt != null
    workDoneToday: boolean;         // true iff completedActions.work != null
  };
```

Add the new variant to `OvertimeDecision` (after the `skip-not-employed` line, currently line 43):

```ts
  | { kind: 'skip-work-not-done' }             // regular daily work not confirmed yet
```

In `decideOvertime`, insert the gate immediately **after** the employed check (`if (jobOverTime == null) return { kind: 'skip-not-employed' };`, currently line 74):

```ts
  // Defense-in-depth: never POST overtime before regular daily work is
  // confirmed done today. Placed after the employed check so an unemployed
  // citizen still surfaces as `skip-not-employed`.
  if (!state.workDoneToday) return { kind: 'skip-work-not-done' };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/tools/workOvertime.policy.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/tools/workOvertime.policy.ts src/tools/workOvertime.policy.test.ts
git commit -m "feat(overtime): add work-first gate to decideOvertime"
```

---

## Task 3: Lock-aware retry in `runOvertime.ts`

**Files:**
- Modify: `src/agent/runOvertime.ts:18-30` (options/outcome types), `:61-102` (decision + lock branch)
- Test: `src/agent/runOvertime.test.ts`

- [ ] **Step 1: Add a work-set helper + update existing tests that reach the POST/cooldown branches**

In `src/agent/runOvertime.test.ts`, add a helper near the other helpers (after `fixedNow`, ~line 19):

```ts
function stateWithWork(day: number): DailyState {
  const s = emptyState(day);
  s.completedActions.work = { at: '2026-05-20T09:00:00Z', source: 'agent' };
  return s;
}
```

Replace `emptyState(6755)` with `stateWithWork(6755)` in exactly these tests (they pass the work-first gate to reach cooldown/go):
- `'reconcile-external: cooldown active + flag unset → mark external, no POST'`
- `'go: marks completedActions agent and is silent (digest emits the OT line)'`
- `'go but clean-precondition failure → mark cap + alert'`

For `'skip-cooldown when flag already set (does not double-reconcile)'` (state built inline with spread of `emptyState`), add `work` to its `completedActions`:

```ts
    const s: DailyState = {
      ...emptyState(6755),
      completedActions: {
        work: { at: '2026-05-20T09:00:00Z', source: 'agent' },
        workOvertime: { at: '2026-05-20T11:00:00Z', source: 'agent' },
      },
    };
```

Leave `'short-circuits when settings disabled'`, `'short-circuits when cap reached'`, and `'failure in transport ...'` unchanged — they short-circuit before the work-first gate.

- [ ] **Step 2: Write the failing lock-branch tests**

Add these inside `describe('runOvertimeIfEligible', ...)`:

```ts
  it('lock + captcha present & solved → no cap, resets retry counter, no pause alert', async () => {
    const s = stateWithWork(6755);
    s.overtimeLockRetries = 2;
    getJobData.mockResolvedValue({
      isEmployee: true,
      overTime: { points: 1000, usableEnergy: 500, nextOverTime: 0 },
    });
    workOvertime.mockResolvedValue({ success: false, httpStatus: 200, message: 'lock', result: null });
    const cap = notifyCaptor();
    const recheckCaptcha = vi.fn().mockResolvedValue({ present: true, solved: true });
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings(), { notify: cap.notify, now: fixedNow, recheckCaptcha },
    );
    expect(out.decision).toEqual({ kind: 'go' });
    expect(recheckCaptcha).toHaveBeenCalledOnce();
    expect(s.overtimeCapReachedAt).toBeNull();
    expect(s.overtimeLockRetries).toBe(0);
    expect(out.lock).toEqual({ captchaSolved: true, retries: 0, paused: false, limit: 5 });
    expect(cap.calls).toEqual([]);
  });

  it('lock + no captcha → increments retry counter, no pause below limit', async () => {
    const s = stateWithWork(6755);
    s.overtimeLockRetries = 0;
    getJobData.mockResolvedValue({
      isEmployee: true,
      overTime: { points: 1000, usableEnergy: 500, nextOverTime: 0 },
    });
    workOvertime.mockResolvedValue({ success: false, httpStatus: 200, message: 'lock', result: null });
    const cap = notifyCaptor();
    const recheckCaptcha = vi.fn().mockResolvedValue({ present: false, solved: false });
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings(), { notify: cap.notify, now: fixedNow, recheckCaptcha },
    );
    expect(out.decision).toEqual({ kind: 'go' });
    expect(s.overtimeLockRetries).toBe(1);
    expect(s.overtimeCapReachedAt).toBeNull();
    expect(out.lock).toEqual({ captchaSolved: false, retries: 1, paused: false, limit: 5 });
    expect(cap.calls).toEqual([]);
  });

  it('lock + counter reaches limit (5) → set cap + one pause alert', async () => {
    const s = stateWithWork(6755);
    s.overtimeLockRetries = 4; // this lock pushes it to 5
    getJobData.mockResolvedValue({
      isEmployee: true,
      overTime: { points: 1000, usableEnergy: 500, nextOverTime: 0 },
    });
    workOvertime.mockResolvedValue({ success: false, httpStatus: 200, message: 'lock', result: null });
    const cap = notifyCaptor();
    const recheckCaptcha = vi.fn().mockResolvedValue({ present: false, solved: false });
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings(), { notify: cap.notify, now: fixedNow, recheckCaptcha },
    );
    expect(s.overtimeLockRetries).toBe(5);
    expect(s.overtimeCapReachedAt).toBe(FIXED_NOW.toISOString());
    expect(out.lock).toEqual({ captchaSolved: false, retries: 5, paused: true, limit: 5 });
    // No MDv2-reserved chars in this string (em-dash, quotes and comma are not
    // reserved; there are no ASCII hyphens), so escapeMdV2 is a no-op here.
    expect(cap.calls).toEqual([
      '⛔ overtime locked — 5 consecutive "lock" rejections, paused until day rollover',
    ]);
  });

  it('lock branch is not entered when recheckCaptcha omitted: defaults to unsolved (counter climbs)', async () => {
    const s = stateWithWork(6755);
    s.overtimeLockRetries = 0;
    getJobData.mockResolvedValue({
      isEmployee: true,
      overTime: { points: 1000, usableEnergy: 500, nextOverTime: 0 },
    });
    workOvertime.mockResolvedValue({ success: false, httpStatus: 200, message: 'lock', result: null });
    const cap = notifyCaptor();
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings(), { notify: cap.notify, now: fixedNow },
    );
    expect(s.overtimeLockRetries).toBe(1);
    expect(s.overtimeCapReachedAt).toBeNull();
    expect(out.lock).toEqual({ captchaSolved: false, retries: 1, paused: false, limit: 5 });
  });
```

Note: the existing `'go but clean-precondition failure → mark cap + alert'` test (now on `stateWithWork`) uses `message: 'something else the server returned'` — a **non-lock** message — and must still assert the old behaviour (`overtimeCapReachedAt` set + the verbatim `⛔ overtime rejected by server (msg=...)` alert, and `out.lock` undefined). Leave its assertions as-is.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/agent/runOvertime.test.ts`
Expected: FAIL — `recheckCaptcha` not in options type / `out.lock` undefined / counter not mutated.

- [ ] **Step 4: Implement the changes**

In `src/agent/runOvertime.ts`:

(a) Add the module constant near the top (after imports):

```ts
/**
 * Consecutive `"lock"` rejections (with no captcha solved) tolerated within a
 * game day before falling back to pausing OT until day rollover. Keeps a
 * persistent, unsolvable lock from spamming `workOvertime` POSTs every cycle.
 */
export const LOCK_RETRY_LIMIT = 5;
```

(b) Extend `RunOvertimeOptions` (currently lines 18-22):

```ts
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
```

(c) Extend `RunOvertimeOutcome` (currently lines 24-30) with a `lock` field:

```ts
export interface RunOvertimeOutcome {
  decision: OvertimeDecision | { kind: 'failed'; error: string };
  post?: OvertimePostResult;
  /** Net pay if success, else null. Pulled up for easier logging. */
  netSalary?: number | null;
  currency?: string | null;
  /** Populated only on a `"lock"` rejection — lets the runner log a precise tag. */
  lock?: { captchaSolved: boolean; retries: number; paused: boolean; limit: number };
}
```

(d) Add `workDoneToday` to the `decideOvertime` call's `state` (currently lines 62-66):

```ts
    state: {
      workOvertimeDone: state.completedActions.workOvertime != null,
      capReached: state.overtimeCapReachedAt != null,
      workDoneToday: state.completedActions.work != null,
    },
```

(e) Replace the post-failure block inside `case 'go':` (currently lines 89-102, from the comment `// All client-side preconditions were clean...` through `return { decision, post };`) with:

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/agent/runOvertime.test.ts`
Expected: PASS (all cases, including the updated existing ones).

- [ ] **Step 6: Commit**

```bash
git add src/agent/runOvertime.ts src/agent/runOvertime.test.ts
git commit -m "feat(overtime): retry on lock with captcha re-check, cap at 5"
```

---

## Task 4: Runner wiring (captcha re-check + log tags)

**Files:**
- Modify: `src/agent/runner.ts:337-365`

No unit test: the runner has no isolated harness for this path (per `erepublik-agent/CLAUDE.md`, runner behaviour is verified via the pure modules it calls + typecheck). Verification is `npm run typecheck` + full `npm test`.

- [ ] **Step 1: Pass `recheckCaptcha` into `runOvertimeIfEligible`**

In `src/agent/runner.ts`, change the options object at the OT call (currently lines 337-339) to:

```ts
        const ot = await runOvertimeIfEligible(ctx, csrf, state, settings, {
          notify: (m) => notifier.send(m),
          recheckCaptcha: async () => {
            // Reuse the proven detect+solve flow. On a "lock" rejection this
            // surfaces eRepublik's session-unlock captcha if present.
            const r = await handleCaptchaIfPresent(ctx, captchaCfg);
            return { present: r.detected, solved: r.solved };
          },
        });
```

(`handleCaptchaIfPresent` is already imported at `runner.ts:34`; `captchaCfg` is already in scope as a `runCycle` parameter at `runner.ts:102`.)

- [ ] **Step 2: Refine the rejection log tag**

Replace the `else` branch of the `if (ot.post?.success)` block (currently lines 357-363) with:

```ts
          } else if (ot.lock) {
            tag = ot.lock.captchaSolved
              ? '⛔ lock — captcha solved, will retry'
              : ot.lock.paused
                ? `⛔ lock — retry limit hit (${ot.lock.retries}/${ot.lock.limit}), paused until rollover`
                : `⛔ lock — no captcha solved, retry ${ot.lock.retries}/${ot.lock.limit}`;
          } else {
            // Server rejected even though our client-side preconditions were
            // clean. Don't claim "employer cap" — we don't actually know that.
            tag = `⛔ rejected (msg=${ot.post?.message ?? 'n/a'})`;
          }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — all suites green (schema, policy, runOvertime, and unrelated suites).

- [ ] **Step 5: Commit**

```bash
git add src/agent/runner.ts
git commit -m "feat(overtime): wire captcha re-check into runner + precise lock log tags"
```

---

## Final verification

- [ ] **Run full test suite + typecheck together**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all vitest suites pass.

- [ ] **Sanity-grep the new behaviour is reachable**

Run: `grep -n "overtimeLockRetries\|LOCK_RETRY_LIMIT\|skip-work-not-done\|recheckCaptcha" src/agent/runOvertime.ts src/agent/runner.ts src/tools/workOvertime.policy.ts src/memory/schema.ts`
Expected: matches in each file confirming the wiring is present.

---

## Self-Review notes

- **Spec coverage:** work-first gate (Task 2) ✓; `overtimeLockRetries` field (Task 1) ✓; lock branch with solve-resets-counter / unsolved-increments / limit-pauses (Task 3) ✓; non-lock unchanged (Task 3 existing test retained) ✓; `recheckCaptcha` injection + default no-op (Task 3) ✓; runner wiring + log tags (Task 4) ✓; tests vitest-only, no live captcha (all tasks) ✓.
- **Counter reset on rollover:** handled structurally — `loadOrInit` creates a fresh `emptyState` (with `overtimeLockRetries: 0`) on day change; no explicit reset code needed.
- **Type consistency:** `lock` outcome shape `{ captchaSolved, retries, paused, limit }` is identical in `runOvertime.ts`, its tests, and the runner reads (`ot.lock.captchaSolved/paused/retries/limit`). `workDoneToday` is the same name in the policy type, the policy tests, and the `runOvertime.ts` call site.
- **Placement decision:** work-first gate is placed after the employed check and before cooldown, per the approved spec. Consequence: with work not done + cooldown active, the result is `skip-work-not-done` (not `reconcile-external`); it self-heals next cycle once work is recorded.
