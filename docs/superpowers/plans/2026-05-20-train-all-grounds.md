# Train on all 4 training grounds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `tools/train.ts` so the daily-runner trains on all training grounds that are actually free for the player (per the API's `effectiveCost`) plus all paid grounds when the player holds a training contract. No new user setting; the rule is determinable from the API response.

**Architecture:** Extract the per-ground decision into a pure function `selectGroundsToTrain(resp)` in a new `train.policy.ts` module (mirrors the `agent/fuelBudget.ts ↔ farm/strategies/*.ts` split). `tools/train.ts` becomes a thin transport wrapper: GET status → policy filter → POST train. Bug fixes ride along: replace the wrong `cost === 0` check with `effectiveCost === 0`, drop the non-existent per-ground `hasContract` field, and add the real top-level `hasTrainingContract` field.

**Tech Stack:** TypeScript (ESM, `tsx`), vitest, Zod. No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-05-20-train-all-grounds-design.md`

---

## File Structure

**Create:**
- `src/tools/train.policy.ts` — pure `selectGroundsToTrain(resp)`, no I/O, no side effects
- `src/tools/train.policy.test.ts` — vitest matrix (8 cases), no mocks

**Modify:**
- `src/tools/train.ts` — export types, fix bug (`effectiveCost` not `cost`; drop `hasContract`; add `hasTrainingContract`), delegate filter to policy
- `src/agent/actions.ts:70` — log line now includes `count` so logs/history show whether 1 or 4 grounds were trained

**Untouched:**
- `src/transport/allowlist.ts` — endpoints already allow-listed
- `src/ui/settingsStore.ts`, `src/ui/public/*` — no new setting
- `src/memory/schema.ts`, `src/agent/cycle.ts`, `src/agent/runner.ts` — no orchestration change

---

## Task 1: Set up types and add failing tests

**Files:**
- Modify: `src/tools/train.ts` (lines 4-13 — interfaces only; do NOT touch the filter yet)
- Create: `src/tools/train.policy.test.ts`

- [ ] **Step 1: Export and reshape interfaces in `train.ts`**

Replace the current interfaces at the top of `src/tools/train.ts` (lines 4-13) with the corrected exported versions. Leave the `train()` function untouched for now — it will fail to compile after this step, which is expected and addressed in Step 4.

Replace:

```ts
interface TrainingGround {
  id: number;
  trained?: boolean;
  cost?: number;
  hasContract?: boolean;
}

interface TrainingGroundsResp {
  grounds?: TrainingGround[];
}
```

With:

```ts
export interface TrainingGround {
  id: number;
  trained: boolean;
  /** Static gold price for the building (informational only). */
  cost: number;
  /**
   * Server-resolved price after level bonuses, training contract, anniversary
   * events, etc. Source of truth for "is this free for me right now?".
   */
  effectiveCost: number;
}

export interface TrainingGroundsResp {
  grounds: TrainingGround[];
  /** Top-level flag — `true` while the player holds an active training contract. */
  hasTrainingContract: boolean;
}
```

- [ ] **Step 2: Write failing tests for `selectGroundsToTrain`**

Create `src/tools/train.policy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { selectGroundsToTrain } from './train.policy.js';
import type { TrainingGround, TrainingGroundsResp } from './train.js';

function ground(overrides: Partial<TrainingGround>): TrainingGround {
  return { id: 1, trained: false, cost: 0, effectiveCost: 0, ...overrides };
}

function resp(grounds: TrainingGround[], hasTrainingContract = false): TrainingGroundsResp {
  return { grounds, hasTrainingContract };
}

describe('selectGroundsToTrain', () => {
  it('returns [] when all grounds are already trained, no contract', () => {
    const r = resp([
      ground({ id: 1, trained: true, effectiveCost: 0 }),
      ground({ id: 2, trained: true, effectiveCost: 0 }),
      ground({ id: 3, trained: true, effectiveCost: 0 }),
      ground({ id: 4, trained: true, effectiveCost: 0 }),
    ]);
    expect(selectGroundsToTrain(r)).toEqual([]);
  });

  it('returns [] when all grounds are already trained, with contract', () => {
    const r = resp(
      [
        ground({ id: 1, trained: true, effectiveCost: 0 }),
        ground({ id: 2, trained: true, effectiveCost: 0.19 }),
        ground({ id: 3, trained: true, effectiveCost: 0.89 }),
        ground({ id: 4, trained: true, effectiveCost: 1.79 }),
      ],
      true,
    );
    expect(selectGroundsToTrain(r)).toEqual([]);
  });

  it('returns all 4 when effectiveCost is 0 for every ground (level-200+ case)', () => {
    const r = resp([
      ground({ id: 1, cost: 0, effectiveCost: 0 }),
      ground({ id: 2, cost: 0.19, effectiveCost: 0 }),
      ground({ id: 3, cost: 0.89, effectiveCost: 0 }),
      ground({ id: 4, cost: 1.79, effectiveCost: 0 }),
    ]);
    const picked = selectGroundsToTrain(r);
    expect(picked.map((g) => g.id)).toEqual([1, 2, 3, 4]);
  });

  it('returns all 4 when level-200+ AND contract holder (both branches satisfied)', () => {
    const r = resp(
      [
        ground({ id: 1, cost: 0, effectiveCost: 0 }),
        ground({ id: 2, cost: 0.19, effectiveCost: 0 }),
        ground({ id: 3, cost: 0.89, effectiveCost: 0 }),
        ground({ id: 4, cost: 1.79, effectiveCost: 0 }),
      ],
      true,
    );
    expect(selectGroundsToTrain(r)).toHaveLength(4);
  });

  it('returns only Weights Room when low level, no contract', () => {
    const r = resp([
      ground({ id: 1, cost: 0, effectiveCost: 0 }),
      ground({ id: 2, cost: 0.19, effectiveCost: 0.19 }),
      ground({ id: 3, cost: 0.89, effectiveCost: 0.89 }),
      ground({ id: 4, cost: 1.79, effectiveCost: 1.79 }),
    ]);
    expect(selectGroundsToTrain(r).map((g) => g.id)).toEqual([1]);
  });

  it('returns all 4 when low level WITH contract (paying reduced rate)', () => {
    const r = resp(
      [
        ground({ id: 1, cost: 0, effectiveCost: 0 }),
        ground({ id: 2, cost: 0.19, effectiveCost: 0.1 }),
        ground({ id: 3, cost: 0.89, effectiveCost: 0.4 }),
        ground({ id: 4, cost: 1.79, effectiveCost: 0.8 }),
      ],
      true,
    );
    expect(selectGroundsToTrain(r).map((g) => g.id)).toEqual([1, 2, 3, 4]);
  });

  it('returns only the not-trained paid grounds when Weights already done (idempotent within day)', () => {
    const r = resp(
      [
        ground({ id: 1, trained: true, cost: 0, effectiveCost: 0 }),
        ground({ id: 2, trained: false, cost: 0.19, effectiveCost: 0.1 }),
        ground({ id: 3, trained: false, cost: 0.89, effectiveCost: 0.4 }),
        ground({ id: 4, trained: false, cost: 1.79, effectiveCost: 0.8 }),
      ],
      true,
    );
    expect(selectGroundsToTrain(r).map((g) => g.id)).toEqual([2, 3, 4]);
  });

  it('returns [] when grounds array is empty', () => {
    expect(selectGroundsToTrain(resp([], false))).toEqual([]);
    expect(selectGroundsToTrain(resp([], true))).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests and typecheck — verify failures are the expected ones**

Run:

```bash
cd /Users/driversti/Projects/erepublik/erepublik-agent
npx vitest run src/tools/train.policy.test.ts
```

Expected: FAIL with "Failed to load url ./train.policy.js" or "Cannot find module './train.policy.js'". The test file itself compiles (types are now exported), but the policy module does not exist yet.

Also run:

```bash
npm run typecheck
```

Expected: FAIL with errors in `src/tools/train.ts` around the filter line — `Property 'cost' does not exist`, `Property 'hasContract' does not exist`, because we shaped `TrainingGround` to use `effectiveCost` and dropped `hasContract`. This is the red phase; Task 2 will fix it.

---

## Task 2: Implement the policy module

**Files:**
- Create: `src/tools/train.policy.ts`

- [ ] **Step 1: Create the pure function**

Create `src/tools/train.policy.ts`:

```ts
import type { TrainingGround, TrainingGroundsResp } from './train.js';

/**
 * Decide which training grounds to POST to `/economy/train` this cycle.
 *
 * Rules:
 *  - Skip grounds that have already been trained today (server tracks via
 *    `trained: true`).
 *  - Train any ground where the server-resolved price is zero. This covers
 *    high-level players (the game makes all 4 grounds free above some level
 *    threshold the wiki doesn't pin down), anniversary events, and full
 *    contract discounts.
 *  - Train paid grounds only if the player holds an active training contract
 *    (top-level `hasTrainingContract`). The contract is the implicit opt-in:
 *    by paying for a contract, the player chose to use it. Without one, we
 *    refuse to burn raw gold and fall back to the free Weights Room only.
 *
 * No options. The API response is the single source of truth.
 */
export function selectGroundsToTrain(resp: TrainingGroundsResp): TrainingGround[] {
  return resp.grounds.filter((g) => {
    if (g.trained) return false;
    if (g.effectiveCost === 0) return true;
    if (resp.hasTrainingContract) return true;
    return false;
  });
}
```

- [ ] **Step 2: Run policy tests — expect all 8 to pass**

Run:

```bash
npx vitest run src/tools/train.policy.test.ts
```

Expected: PASS, 8 tests passed.

Typecheck will still fail in `train.ts` (the inline filter is broken) — that's Task 3.

---

## Task 3: Wire policy into the transport layer

**Files:**
- Modify: `src/tools/train.ts` (the `train()` function body)

- [ ] **Step 1: Replace the inline filter with the policy call**

In `src/tools/train.ts`, find the `train()` function (lines 23-52) and replace the body so it delegates to the policy. Final shape of the file (entire contents shown so there is no ambiguity):

```ts
import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';
import { selectGroundsToTrain } from './train.policy.js';

export interface TrainingGround {
  id: number;
  trained: boolean;
  /** Static gold price for the building (informational only). */
  cost: number;
  /**
   * Server-resolved price after level bonuses, training contract, anniversary
   * events, etc. Source of truth for "is this free for me right now?".
   */
  effectiveCost: number;
}

export interface TrainingGroundsResp {
  grounds: TrainingGround[];
  /** Top-level flag — `true` while the player holds an active training contract. */
  hasTrainingContract: boolean;
}

export interface TrainResult {
  success: boolean;
  alreadyTrained: boolean;
  count: number;
  status?: number;
  body?: unknown;
}

export async function train(ctx: BrowserContext, csrf: string): Promise<TrainResult> {
  const { body: resp } = await apiCall<TrainingGroundsResp>(ctx, {
    method: 'GET',
    path: '/en/main/training-grounds-json',
    csrf,
  });

  const trainable = selectGroundsToTrain(resp);

  if (trainable.length === 0) {
    return { success: true, alreadyTrained: true, count: 0 };
  }

  const form: Record<string, string> = {};
  trainable.forEach((g, i) => {
    form[`grounds[${i}][id]`] = String(g.id);
    form[`grounds[${i}][train]`] = '1';
  });

  const { status, body } = await apiCall(ctx, {
    method: 'POST',
    path: '/en/economy/train',
    csrf,
    form,
  });

  return { success: status === 200, alreadyTrained: false, count: trainable.length, status, body };
}
```

Public signature (`train(ctx, csrf): Promise<TrainResult>`) is unchanged, so callers in `agent/actions.ts` keep compiling.

- [ ] **Step 2: Run typecheck — expect clean**

Run:

```bash
npm run typecheck
```

Expected: PASS, no errors.

- [ ] **Step 3: Run the full vitest suite — expect green**

Run:

```bash
npm test
```

Expected: PASS, all existing tests plus the 8 new policy tests.

---

## Task 4: Add count to the train log line

**Files:**
- Modify: `src/agent/actions.ts:70`

- [ ] **Step 1: Update the log line**

In `src/agent/actions.ts`, find the train action block (lines 67-72). Replace:

```ts
  if (action === 'train') {
    const r = await train(ctx, csrf);
    if (r.success) state.completedActions.train = { at, source: 'agent' };
    console.log(`[cycle] train: ${r.success ? '✅' : '❌'} status=${r.status}`);
    return;
  }
```

With:

```ts
  if (action === 'train') {
    const r = await train(ctx, csrf);
    if (r.success) state.completedActions.train = { at, source: 'agent' };
    console.log(`[cycle] train: ${r.success ? '✅' : '❌'} count=${r.count} status=${r.status}`);
    return;
  }
```

Only the `console.log` line changes — `count=${r.count}` added between the success icon and `status`. `r.count` already exists on `TrainResult`.

- [ ] **Step 2: Run typecheck and tests one more time**

Run:

```bash
npm run typecheck && npm test
```

Expected: PASS for both. No new tests for the log line — pure observability change.

---

## Task 5: Verify and commit

- [ ] **Step 1: Confirm git status is clean of unrelated drift**

Run:

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent status --short
```

Expected output should include (untracked items pre-existing in the repo from before this work are OK to leave alone):

```
M  src/agent/actions.ts
M  src/tools/train.ts
?? src/tools/train.policy.ts
?? src/tools/train.policy.test.ts
?? docs/superpowers/specs/2026-05-20-train-all-grounds-design.md
?? docs/superpowers/plans/2026-05-20-train-all-grounds.md
```

Pre-existing untracked items (`.claude/scheduled_tasks.lock`, `.junie/`, `CODE_REVIEW.md`, `code_review_report_part2.md`, `coding_agent_instructions.md`, `logs/`) — leave alone, they are not part of this work.

- [ ] **Step 2: Ask the user before committing**

Per the user's CLAUDE.md: always ask before creating commits. Pause and confirm the user wants the commit created now (vs. amending into a parent feature branch, splitting across two commits, etc.).

- [ ] **Step 3: On user approval, stage and commit**

Stage only the files this feature touches (no `git add -A`):

```bash
cd /Users/driversti/Projects/erepublik/erepublik-agent
git add \
  src/tools/train.ts \
  src/tools/train.policy.ts \
  src/tools/train.policy.test.ts \
  src/agent/actions.ts \
  docs/superpowers/specs/2026-05-20-train-all-grounds-design.md \
  docs/superpowers/plans/2026-05-20-train-all-grounds.md
```

Then commit with a HEREDOC body:

```bash
git commit -m "$(cat <<'EOF'
fix(train): use effectiveCost + contract to train all eligible grounds

Bot now trains every ground the server says is free for this account
(via `effectiveCost === 0`) plus all paid grounds when the player holds
an active training contract. Replaces the broken `cost === 0` filter
that ignored level-based and contract discounts, and removes the dead
per-ground `hasContract` check (the field never existed on the wire —
contract status lives in the top-level `hasTrainingContract`).

Decision logic lives in a new pure module `tools/train.policy.ts` to
keep `tools/train.ts` a thin transport wrapper, mirroring the split
between `agent/fuelBudget.ts` and `farm/strategies/*.ts`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Verify commit landed**

Run:

```bash
git log -1 --stat
```

Expected: one new commit on the current branch (`main` per session start status) touching the 6 files above, no others.

---

## Self-review

**Spec coverage**

| Spec requirement | Covered by |
|---|---|
| Replace `cost === 0` with `effectiveCost === 0` filter | Task 2 Step 1 (policy), Task 3 Step 1 (transport) |
| Drop non-existent per-ground `hasContract` | Task 1 Step 1 (type), Task 3 Step 1 (use of policy) |
| Add top-level `hasTrainingContract` field | Task 1 Step 1 (type), Task 2 Step 1 (filter branch) |
| Pure decision module separated from transport | Task 2 Step 1 (`train.policy.ts`) |
| Test matrix (8 cases) | Task 1 Step 2 (`train.policy.test.ts`) |
| Log `count` so we see 1 vs 4 grounds | Task 4 Step 1 (`actions.ts`) |
| No new setting / no UI changes | Verified by file list — `settingsStore.ts` and `ui/public/*` untouched |
| No allowlist changes | Verified — `transport/allowlist.ts` not in modified list |
| Idempotency within day preserved | Test case 7 (Weights trained, only paid returned) |

**Placeholder scan:** none. All code blocks contain complete code, all commands are runnable as written.

**Type consistency:**
- `TrainingGround.effectiveCost: number` (required) — used consistently in test fixtures, policy function, and the API typing.
- `TrainingGroundsResp.hasTrainingContract: boolean` (required) — same field name used everywhere it appears.
- `selectGroundsToTrain(resp: TrainingGroundsResp): TrainingGround[]` — single signature, no overloads.
- `TrainResult` shape — unchanged, callers in `actions.ts` only read `.success`, `.count`, `.status`, which all exist.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-05-20-train-all-grounds.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
