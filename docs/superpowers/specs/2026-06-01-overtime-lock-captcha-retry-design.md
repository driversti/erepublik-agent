# Overtime `"lock"` → captcha-aware retry + work-first gate

**Date:** 2026-06-01
**Status:** Design approved, pending implementation plan
**Area:** `src/tools/workOvertime.policy.ts`, `src/agent/runOvertime.ts`, `src/memory/schema.ts`, `src/agent/runner.ts`

## Problem

When `POST /en/economy/workOvertime` returns a well-formed JSON body `{status: false, message: "lock"}`, the current code (`runOvertime.ts`) sets `state.overtimeCapReachedAt` and **pauses overtime until the next eRepublik day**. Operators see:

```
⛔ overtime rejected by server (msg="lock") — paused until day rollover
```

Two findings motivate this change:

1. **The `"lock"` cause is most likely eRepublik's own session-unlock captcha**, not a Cloudflare interstitial. A Cloudflare challenge returns HTML, which `processResponse` (`apiCall.ts:145-161`) turns into a `ForbiddenError` (403) or a `Non-JSON response` throw — neither of which produces the `msg="lock"` path. The `msg="lock"` path requires valid JSON from eRepublik itself. The captcha handler internally names this same state a *"session lock"* (`captcha.ts:210` → `'[captcha] detected on page — session lock active'`). The cycle-start captcha gate (`handleCaptchaIfPresent`) is DOM-based and can miss a lock that is only signalled on the AJAX response, so OT proceeds and hits the lock. Pausing OT for the whole day is too conservative — KB (`kb/Work_Overtime.md`) already records that a manual OT succeeded minutes later.

2. **The OT decision has no dependency on regular work having been done.** `decideOvertime` gates on enabled / cap / once-per-day / employed / cooldown / points / energy, but never on `state.completedActions.work`. In the cycle sequence regular `work` (runner.ts:329) does precede `workOvertime` (runner.ts:337), so we never OT-before-work *within a cycle*. But OT is called unconditionally every cycle, so a defensive work-first gate is cheap insurance that also matches the natural game flow (work, then overtime).

> Note: the specific `"lock"` case recorded in `kb/Work_Overtime.md` had `alreadyWorked: true`, so the work-first gate does **not** explain that incident. It is added as defense-in-depth, not as the root-cause fix. The captcha-retry path is the root-cause hypothesis.

## Goals

- On a `"lock"` rejection, do **not** silence OT for the day. Re-check for a session-unlock captcha; solve it if present (per config); retry OT on the next cycle regardless.
- Bound the retry so a persistent, unsolvable lock cannot spam `workOvertime` POSTs every cycle.
- Add a work-first gate to `decideOvertime`.
- Preserve current behaviour for **non-`lock`** `status:false` messages (still pause until rollover — those causes are unknown and stable).
- Full vitest coverage of the deterministic logic. No live captcha verification in scope.

## Non-goals

- Solving the underlying "why does eRepublik lock the session" question.
- Changing Cloudflare / 403 handling.
- Any change to the cycle-start captcha gate.

## Design

### 1. Work-first gate (`workOvertime.policy.ts`)

Add to `OvertimePolicyInput`:

```ts
state: {
  workOvertimeDone: boolean;
  capReached: boolean;
  workDoneToday: boolean;   // NEW — completedActions.work != null
}
```

Add decision variant `{ kind: 'skip-work-not-done' }`.

Placement in `decideOvertime` — **after** the employed check so `skip-not-employed` stays precise:

```
enabled → cap → once-per-day(done) → employed(jobOverTime==null)
  → [NEW] !workDoneToday → skip-work-not-done
  → cooldown → points → energy → go
```

`runOvertime.ts` populates `workDoneToday: state.completedActions.work != null`.

### 2. New `DailyState` field (`memory/schema.ts`)

```ts
overtimeLockRetries: z.number().int().default(0)
```

Counts consecutive `"lock"` rejections this game day where the captcha was **not** found-and-solved. Reset to 0 whenever a captcha is found and solved, and (naturally) on day rollover with the fresh daily file. `buildInitial`/default → 0.

### 3. `"lock"` handling (`runOvertime.ts`)

Split the current `post.success === false` branch:

**`message === "lock"`:**
1. Call injected `opts.recheckCaptcha()` (returns `{ present, solved }`).
2. If `present && solved` → `state.overtimeLockRetries = 0`. Do **not** set `overtimeCapReachedAt`. OT retries next cycle.
3. If not solved (captcha absent, or present-but-unsolved) → `state.overtimeLockRetries += 1`.
   - If `overtimeLockRetries >= LOCK_RETRY_LIMIT (5)` → set `overtimeCapReachedAt = now`, send a one-time alert (`⛔ overtime locked — N consecutive 'lock' rejections, pausing until day rollover`), behave as today.
   - Else → do **not** set `overtimeCapReachedAt`; OT retries next cycle. (Optionally a low-noise log line; no per-cycle Telegram spam.)

**any other `message`:** unchanged — `overtimeCapReachedAt = now` + existing `⛔ overtime rejected by server (msg="…")` alert.

`LOCK_RETRY_LIMIT = 5` as a module const.

### 4. Captcha injection (`runOvertime.ts` + `runner.ts`)

Extend `RunOvertimeOptions`:

```ts
recheckCaptcha?: () => Promise<{ present: boolean; solved: boolean }>;
```

Default (when omitted, e.g. older callers/tests not exercising lock): a no-op returning `{ present: false, solved: false }` — so absence of the dep degrades to "treat as unsolved", incrementing the counter, which is the safe direction.

Runner wiring (`runner.ts`, OT block ~line 337) passes a wrapper over the existing handler it already holds (`captchaCfg: CaptchaConfig`):

```ts
recheckCaptcha: async () => {
  const r = await handleCaptchaIfPresent(ctx, captchaCfg);
  return { present: r.detected, solved: r.solved };
}
```

This reuses the proven detect+2captcha+submit flow; no new captcha code.

### 5. Outcome / logging

`RunOvertimeOutcome` gains enough signal for the runner to log distinct tags:
- `⛔ lock — captcha solved, will retry`
- `⛔ lock — no captcha, retry N/5`
- `⛔ lock — retry limit hit, paused until rollover`
- `⛔ rejected (msg=…)` (non-lock, unchanged)

Exact representation (extra fields vs. a small discriminated result) decided in the implementation plan; the data above must be derivable.

## Testing (vitest only)

`workOvertime.policy.test.ts`:
- `workDoneToday: false` → `skip-work-not-done`.
- `workDoneToday: true` + otherwise-go inputs → `go`.
- Existing cases updated to pass `workDoneToday: true` so they still reach their asserted branch.

`runOvertime.test.ts` (mock `getJobData`/`workOvertime` + injected `recheckCaptcha` + `notify`):
- (a) `lock` + captcha present & solved → `overtimeCapReachedAt` stays null, `overtimeLockRetries` reset to 0, no pause alert.
- (b) `lock` + no captcha → `overtimeLockRetries` incremented, no `overtimeCapReachedAt`, no pause alert.
- (c) `lock` + counter reaches 5 → `overtimeCapReachedAt` set, one pause alert sent.
- (d) non-`lock` `status:false` → existing behaviour (`overtimeCapReachedAt` set + verbatim alert).
- (e) success path unchanged (no captcha recheck invoked).

## Risk / trade-offs

- **Retry pressure:** capped at 5 consecutive lock POSTs/day before falling back to the day-pause. Solving resets the counter, so a healthy solve→retry loop is unbounded only in the sense that it keeps succeeding.
- **`recheckCaptcha` cost:** only invoked on a `lock` rejection, not every cycle.
- **Provider `none`:** captcha will detect-but-not-solve → counter climbs to 5 → day-pause + alert, i.e. graceful degradation to roughly today's behaviour for operators without a solver configured.
