# Train on all 4 training grounds (deterministic)

**Status**: design approved
**Date**: 2026-05-20
**Author**: Yurii Chekhotskyi
**Related code**: `src/tools/train.ts`, `src/agent/actions.ts`

## Goal

Train on **all** training grounds (not just Weights Room) when it makes economic sense — without adding a user-facing knob. The rule is fully derivable from the API response, so the bot decides deterministically per cycle.

## Background

eRepublik has 4 training grounds:

| Building | Default cost | Strength Q4 |
|---|---|---|
| Weights Room | 0 gold | +20 |
| Climbing Center | 0.19 gold | +10 |
| Shooting Range | 0.89 gold | +20 |
| Special Forces Center | 1.79 gold | +40 |

Two situations override the default cost:

1. **High-level players** (~level 200+, exact threshold unknown to us): all 4 grounds become free.
2. **Training contract holders** (paid premium, 15-day window): all 4 grounds get a discount (full or partial — wiki is vague, we don't measure).

The server resolves both situations and returns the actual per-account price in `effectiveCost`. We must rely on `effectiveCost`, not the static `cost`, to decide which grounds to train.

## Current state and bugs

`src/tools/train.ts` (current):

```ts
const trainable = (groundsData.grounds ?? []).filter(
  (g) => !g.trained && (g.cost === 0 || g.hasContract === true),
);
```

Two bugs:

- **`g.cost`** — uses the static price. A level-200+ player still has `cost: 1.79` for the SF ground, so the bot skips it even though it would be free.
- **`g.hasContract`** — this field does not exist on individual grounds. The API returns a top-level `hasTrainingContract: boolean`. The per-ground check is dead code: always `undefined === true → false`.

Effect today: only the Weights Room (the one with static `cost: 0`) is ever trained, regardless of player level or contract status.

## Verified API shape

`GET https://www.erepublik.com/en/main/training-grounds-json` for a level-200+ account with no contract:

```json
{
  "grounds": [
    { "id": 85434, "trained": true, "cost": 0,    "effectiveCost": 0, "quality": 4, ... },
    { "id": 363943, "trained": true, "cost": 0.19, "effectiveCost": 0, "quality": 4, ... },
    { "id": 1979243, "trained": true, "cost": 0.89, "effectiveCost": 0, "quality": 4, ... },
    { "id": 364274, "trained": true, "cost": 1.79, "effectiveCost": 0, "quality": 4, ... }
  ],
  "hasTrainingContract": false,
  "contracts": false,
  "canTrain": false,
  "hasFreeTrain": true
}
```

All 4 grounds have `effectiveCost: 0` even though `hasTrainingContract: false`. Source of truth: `effectiveCost`.

## Decision rule

Per ground, train iff:

```
!trained && (
  effectiveCost === 0
  ||
  (effectiveCost > 0 && hasTrainingContract === true)
)
```

Three branches:

| Player state | Branch | Result |
|---|---|---|
| Level 200+ (or any "all-free" condition) | `effectiveCost === 0` | Train all not-yet-trained grounds (up to 4) |
| Contract holder, full discount | `effectiveCost === 0` | Train all not-yet-trained grounds (up to 4) |
| Contract holder, partial discount | `effectiveCost > 0 && hasTrainingContract` | Train all not-yet-trained grounds (up to 4), paying reduced rate |
| No contract, level < threshold | both branches false | Train only Weights Room (the static-free one) |

(The `!trained` filter is applied in all rows — once-per-day idempotency is preserved.)

**No `userLevel` check in our code.** The API resolves the level threshold for us; hard-coding `>= 200` would duplicate (and risk diverging from) server logic. If eRepublik ever shifts the threshold, adds an anniversary event, or changes contract math, we automatically follow.

**No user-facing setting.** With the rule fully determinable from the API response, an opt-in knob would only let users misconfigure away the right answer. Contract-holders implicitly opt in by holding a contract.

## Implementation

### File layout

```
src/tools/
  train.ts            transport: GET grounds → selectGroundsToTrain → POST train (thin)
  train.policy.ts     NEW. Pure selectGroundsToTrain(resp): TrainingGround[]
  train.policy.test.ts NEW. Vitest matrix, no mocks.
```

### Types (`train.ts`)

```ts
export interface TrainingGround {
  id: number;
  trained: boolean;
  cost: number;          // informational
  effectiveCost: number; // authoritative
}

export interface TrainingGroundsResp {
  grounds: TrainingGround[];
  hasTrainingContract: boolean;
}
```

Both interfaces must be `export`ed so `train.policy.ts` can `import type` them.

Remove: per-ground `hasContract?: boolean` (does not exist on the wire).
Make `grounds` required (API always returns it; empty array if nothing).

### Pure decision (`train.policy.ts`)

```ts
import type { TrainingGround, TrainingGroundsResp } from './train.js';

export function selectGroundsToTrain(resp: TrainingGroundsResp): TrainingGround[] {
  return resp.grounds.filter((g) => {
    if (g.trained) return false;
    if (g.effectiveCost === 0) return true;
    if (resp.hasTrainingContract) return true;
    return false;
  });
}
```

No options, no side effects. Single export.

### Transport (`train.ts`)

```ts
export async function train(ctx: BrowserContext, csrf: string): Promise<TrainResult> {
  const { body: resp } = await apiCall<TrainingGroundsResp>(ctx, {
    method: 'GET', path: '/en/main/training-grounds-json', csrf,
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
    method: 'POST', path: '/en/economy/train', csrf, form,
  });

  return { success: status === 200, alreadyTrained: false, count: trainable.length, status, body };
}
```

Signature unchanged. `TrainResult` unchanged. Callers (`agent/actions.ts:67`) are untouched.

### Logging tweak (`agent/actions.ts`)

```ts
console.log(`[cycle] train: ${r.success ? '✅' : '❌'} count=${r.count} status=${r.status}`);
```

One-line change. Lets us see in logs whether 1 or 4 grounds were trained.

### No changes required to

- `src/agent/runner.ts` (no settings to plumb)
- `src/ui/settingsStore.ts` (no new field)
- `src/ui/public/*` (no new toggle)
- `src/memory/schema.ts` (`completedActions.train` semantics identical)
- `src/transport/allowlist.ts` (endpoints unchanged)
- `src/agent/cycle.ts` (reconcile rules unchanged)

## Testing

`src/tools/train.policy.test.ts` — vitest matrix, no I/O, no mocks:

| # | Scenario | grounds | hasTrainingContract | expected count |
|---|---|---|---|---|
| 1 | all trained | 4× `trained=true` | false | 0 |
| 2 | all trained, with contract | 4× `trained=true` | true | 0 |
| 3 | level-200+ player, idle | 4× `trained=false, effectiveCost=0` | false | 4 |
| 4 | level-200+ contract holder, idle | 4× `trained=false, effectiveCost=0` | true | 4 |
| 5 | low level, no contract | 1× free + 3× `effectiveCost>0`, none trained | false | 1 (free only) |
| 6 | low level, with contract | 1× free + 3× `effectiveCost>0`, none trained | true | 4 |
| 7 | partial mid-session | Weights trained, 3× paid not trained | true | 3 (paid only) |
| 8 | empty grounds | `[]` | false | 0 |

Run: `npm test` (vitest one-shot). Targets only the new test; no existing tests touched.

### Manual smoke

After merge, run `npm run agent` (single cycle) on a level-200+ account and verify the daily-state shows `train.source = 'agent'` and logs read `count=4`. A second invocation in the same eRepublik day must short-circuit (`count=0`, `alreadyTrained=true`).

## Risk and rollback

- **Risk surface**: 2 files (`train.ts`, `train.policy.ts`), 1 new test file, 1 log line. Allowlist, schema, UI, runner — untouched.
- **Worst case**: API drops `effectiveCost` from the response. Detection: all grounds get filtered out → 0 trained → cycle keeps trying every interval. Mitigation: defensive fallback `(g.effectiveCost ?? g.cost) === 0` (not adopted now — YAGNI; add if it ever happens).
- **Rollback**: revert the two-file commit; behavior reverts to Weights-Room-only training.

## Out of scope

- Detection / status display of training contract in UI snapshot or digest.
- Auto-purchasing training contracts.
- Per-ground gold-cost ceiling (`maxGoldPerSession`). The contract path caps at ~3 gold/day across all 4 Q4 buildings — acceptable for any contract holder by definition.
- Persisting per-day training detail (which grounds were trained). The single `completedActions.train` flag is enough; the daily reset makes it idempotent.
