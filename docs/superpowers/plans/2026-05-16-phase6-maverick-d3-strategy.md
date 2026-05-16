# Phase 6 — Maverick-D3 Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the third farm strategy: D4 players with Maverick descend to D3 and farm empty-div battles like Standard, but using bombs (0 energy) instead of bare-hands deploys. Maverick auto-detection already lands in Phase 5 via `hasMaverick`; this phase just wires the strategy.

**Architecture:** A new `src/farm/strategies/maverickD3.ts` mirrors `standard.ts` but with two changes: (1) discovery + empty-check force `division=3` regardless of the player's native div; (2) weapon selection prefers bombs (`pickBomb`) over groundWeapons. Register in the dispatcher. The runner's `effectiveMode` (Phase 5) already routes to `maverickD3` when the auto-detected `hasMaverick` is true.

**Spec:** `docs/superpowers/specs/2026-05-16-flexible-farming-config-design.md` §2.3 (Maverick-D3), §2.5 (foreign weapon policy).

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/tools/pickBomb.ts` | **create** | `pickBomb(inventory): { quality: 22 \| 21; amount } \| null`. Big Bomb (q=22, 5M dmg) preferred, Small Bomb (q=21) fallback. |
| `src/tools/pickBomb.test.ts` | **create** | Vitest: Big preferred, Small fallback, empty/zero handling. |
| `src/farm/strategies/maverickD3.ts` | **create** | Strategy implementation, parallel to standard.ts but div=3 + bomb-first deploy. |
| `src/farm/strategies/index.ts` | modify | Register `maverickD3Strategy`. |

Bazooka support deferred — no sample inventory contains them yet, so we'd be guessing the `type` field. Bare-hands fallback is the safety net if no bombs.

---

## Task 1: `pickBomb` helper

**Files:**
- Create: `src/tools/pickBomb.ts`
- Create: `src/tools/pickBomb.test.ts`

TDD.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { pickBomb } from './pickBomb.js';
import type { InventoryWeapon } from './pickWeapon.js';

const inv = (entries: Array<{ type: string; quality: number; amount: number }>): InventoryWeapon[] => entries;

describe('pickBomb', () => {
  it('returns Big Bomb when present (quality=22)', () => {
    const result = pickBomb(inv([
      { type: 'groundBomb', quality: 22, amount: 100 },
      { type: 'groundBomb', quality: 21, amount: 50 },
    ]));
    expect(result).toEqual({ quality: 22, amount: 100 });
  });

  it('falls back to Small Bomb (quality=21) when Big absent', () => {
    const result = pickBomb(inv([{ type: 'groundBomb', quality: 21, amount: 50 }]));
    expect(result).toEqual({ quality: 21, amount: 50 });
  });

  it('returns null when no bombs', () => {
    expect(pickBomb([])).toBeNull();
    expect(pickBomb(inv([{ type: 'groundWeapon', quality: 7, amount: 100 }]))).toBeNull();
  });

  it('skips zero-amount bombs', () => {
    const result = pickBomb(inv([
      { type: 'groundBomb', quality: 22, amount: 0 },
      { type: 'groundBomb', quality: 21, amount: 10 },
    ]));
    expect(result).toEqual({ quality: 21, amount: 10 });
  });

  it('ignores non-groundBomb items', () => {
    expect(pickBomb(inv([{ type: 'groundWeapon', quality: 22, amount: 100 }]))).toBeNull();
  });
});
```

- [ ] **Step 2: Run RED.**

- [ ] **Step 3: Implement `src/tools/pickBomb.ts`**

```ts
import type { InventoryWeapon } from './pickWeapon.js';

/** Big Bomb (5M dmg, quality 22) preferred; Small Bomb (1.5M in D4, quality 21) fallback. */
export function pickBomb(
  inventory: readonly InventoryWeapon[],
): { quality: 21 | 22; amount: number } | null {
  for (const q of [22, 21] as const) {
    const match = inventory.find(
      (item) => item.type === 'groundBomb' && item.quality === q && item.amount > 0,
    );
    if (match) return { quality: q, amount: match.amount };
  }
  return null;
}
```

- [ ] **Step 4: GREEN.** 5 tests pass.

- [ ] **Step 5: Full suite + typecheck — 69 total (64 + 5 new).**

- [ ] **Step 6: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/tools/pickBomb.ts src/tools/pickBomb.test.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(tools): pickBomb — Big Bomb first, Small Bomb fallback"
```

---

## Task 2: `maverickD3` strategy

**Files:**
- Create: `src/farm/strategies/maverickD3.ts`
- Modify: `src/farm/strategies/index.ts`

The strategy mirrors `standard.ts` but with two changes:
1. `info.division` is **ignored** — pass `3` everywhere (`listFarmableBattles`, `isBattleDivisionEmpty`, `deployWeapon` skin).
2. Weapon selection: `pickBomb(inventory)` first, fall back to bare hands. The `deployWeapon` call uses `quality: 22` or `21` (for the bomb) or `1` (bare hands fallback) with `energy: 0` (bombs are inventory-only) or `33` (bare).

- [ ] **Step 1: Read references**

- `src/farm/strategies/standard.ts` — full reference. This strategy clones the both-side travel + deploy loop with two replacements.
- `src/tools/farm.ts` — `deployWeapon` signature; understand how `energy` parameter behaves when 0 (likely the deploy form silently bumps to the minimum).
- `src/tools/pickBomb.ts` (just added).

If `deployWeapon` cannot accept `energy: 0` for bombs (i.e. game still requires minimum 11), pass `11` to satisfy the floor. The implementer reads `tools/farm.ts` to confirm.

- [ ] **Step 2: Create `src/farm/strategies/maverickD3.ts`**

Use `standard.ts` as the template. Concretely:

1. Copy `standard.ts` to `maverickD3.ts`.
2. Replace all references to `info.division` with the literal `3` in the relevant calls:
   - `listFarmableBattles(ctx, info.csrf, 3)`
   - `isBattleDivisionEmpty(ctx, info.csrf, c.battleId, 3, c.battleZoneId, c.zoneId)`
   - `skinForDivision(3)` for fallback skin
3. Add an inventory read at session start (mirror d4tw.ts pattern):
   ```ts
   const inventory = await loadInventory(ctx, info.csrf);
   const bomb = pickBomb(inventory);
   ```
4. Replace the `deployWithRetry` call with a bomb-aware version. The simplest: keep `deployWithRetry` for bare-hands fallback, but BEFORE calling it, if `bomb` is non-null, call `deployWeapon` directly with the bomb quality and `energy: 11` (or whatever the minimum the game accepts for special weapons — confirm in `tools/farm.ts`).
5. Pre-flight: refuse to run if `info.hasMaverick !== true && settings.maverickManual !== true`. (Belt-and-suspenders — the dispatcher already routes via `effectiveMode`, but the strategy should self-validate.)

A reference skeleton:

```ts
import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../../transport/apiCall.js';
import {
  battlefieldTravel,
  cancelDeploy,
  deployWeapon,
  findCheapestTravelRegion,
  getDeployInventory,
  skinForDivision,
  verifyHitRegistered,
  type TravelOption,
} from '../../tools/farm.js';
import {
  getCitizenEligibility,
  isBattleDivisionEmpty,
  listFarmableBattles,
  type FarmableBattle,
} from '../../tools/battles.js';
import { pickBomb } from '../../tools/pickBomb.js';
import type { InventoryWeapon } from '../../tools/pickWeapon.js';
import {
  advanceRouting,
  formatSequence,
  initRoutingState,
  orderSides,
  pickNext,
  type RoutingState,
} from '../routing.js';
import { loadSettings } from '../../ui/settingsStore.js';
import {
  EnergyExhaustedError,
  ForbiddenError,
  PartialBattleError,
  type FarmStrategy,
  type FarmSessionInfo,
  type FarmSessionOptions,
  type FarmSessionResult,
  type SideOutcome,
  type SkipSummary,
  type StopReason,
  type WinSummary,
} from './types.js';

const FARM_DIVISION = 3; // Maverick-D3 always farms in D3 regardless of native div.
const BOMB_ENERGY = 11;  // Game min for special weapons; bombs consume no real energy.
const BARE_ENERGY = 33;  // Standard fallback when no bombs left.

async function loadInventory(ctx: BrowserContext, csrf: string): Promise<InventoryWeapon[]> {
  const res = (await apiCall(ctx, 'GET', '/en/economy/inventory-json')) as Array<{ id?: string; items?: InventoryWeapon[] }>;
  const main = Array.isArray(res) ? res.find((c) => c.id === 'mainStorage') : undefined;
  return main?.items ?? [];
}

async function runMaverickD3(
  ctx: BrowserContext,
  info: FarmSessionInfo,
  options: FarmSessionOptions,
): Promise<FarmSessionResult> {
  // Settings re-read inside strategy (parallel to d4tw.ts).
  const settings = loadSettings();
  const policy = settings.emptyDiv.foreignWeaponPolicy;

  // … rest mirrors standard.ts's runStandard with FARM_DIVISION substituted for info.division …
  // Key differences from standard.ts:
  //   - Use FARM_DIVISION (3) wherever standard uses info.division for filter/empty-check/skin
  //   - Before each deploy: pickBomb(inventory). If non-null & policy='bomb-then-bazooka',
  //     call deployWeapon with quality=bomb.quality, energy=BOMB_ENERGY.
  //     Otherwise (no bombs, OR policy='no-weapon'): use bare hands as standard does.
}

export const maverickD3Strategy: FarmStrategy = {
  id: 'maverickD3',
  run: runMaverickD3,
};
```

The implementer fills in the loop body by copying from `standard.ts` and applying the two replacements. **Don't re-derive the routing/retry logic — copy and adapt.**

- [ ] **Step 3: Register in `src/farm/strategies/index.ts`**

```ts
import { maverickD3Strategy } from './maverickD3.js';

const registry: Partial<Record<StrategyId, FarmStrategy>> = {
  standard: standardStrategy,
  d4tw: d4twStrategy,
  maverickD3: maverickD3Strategy,
};

// ... existing exports ...
export { maverickD3Strategy } from './maverickD3.js';
```

- [ ] **Step 4: Typecheck + tests**

`npm run typecheck && npm test --silent`. 69 still pass.

- [ ] **Step 5: Smoke test**

The smoke can't trigger Maverick-D3 on the baryga (D1) account directly via auto-detection, but we can force it via `modeOverride: 'maverickD3'`:

```bash
cd /Users/driversti/Projects/erepublik/erepublik-agent
rm -f config/settings.json
ERP_ACCOUNT_SLUG=baryga2026 npm run agent > /tmp/p6-smoke.log 2>&1 &
PID=$!
sleep 8
curl -s -X PUT http://localhost:3737/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"paused":false,"farmEnabled":true,"modeOverride":"maverickD3","maverickManual":null,"d4tw":{"targetDamageAttacker":130000000,"targetDamageDefender":220000000,"maxBattlesPerSession":1,"weaponPriority":[7,6,5,4,3,2,1]},"emptyDiv":{"maxBattlesPerSession":3,"nativeWeaponPriority":[7,6,5,4,3,2,1],"foreignWeaponPolicy":"bomb-then-bazooka"},"travel":{"maxTravelCC":100,"returnHomeAfterMinutes":15,"returnHomeMaxCC":500},"detected":{"division":null,"hasMaverick":null,"citizenId":null,"countryId":null,"lastUpdated":null}}' \
  > /dev/null
sleep 12
grep -E "strategy:|mvd3|maverickD3" /tmp/p6-smoke.log
kill -INT $PID 2>/dev/null
wait $PID 2>/dev/null
rm -f config/settings.json
```

Expected: `[cycle] strategy: maverickD3`. The strategy itself might no-op (no D3 battles findable for a non-D4 account) but must not throw.

- [ ] **Step 6: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/farm/strategies/maverickD3.ts src/farm/strategies/index.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(strategies): maverickD3 — D4 with Maverick farms D3 empty-div with bombs"
```

---

## Task 3: Smoke test

**Files:** none — verification only.

- [ ] **Step 1: Clean state.** `rm -f config/settings.json`.

- [ ] **Step 2: Default cycle.** Verify auto-mode still chooses standard for the D1 account.

```bash
ERP_ACCOUNT_SLUG=baryga2026 npm run agent > /tmp/p6-final.log 2>&1 &
PID=$!
sleep 10
grep "strategy:" /tmp/p6-final.log
```

Expected: `[cycle] strategy: standard`.

- [ ] **Step 3: Force maverickD3 via modeOverride, then via maverickManual.**

(Use the curl PUT from Task 2 Step 5, OR a second curl after step 2 with `maverickManual: true`.)

Expected: `[cycle] strategy: maverickD3`. No exceptions.

- [ ] **Step 4: Shutdown + cleanup.**

```bash
kill -INT $PID 2>/dev/null
wait $PID 2>/dev/null
rm -f config/settings.json
```

- [ ] **Step 5: Full vitest.**

`npm test --silent`. 69 tests.

---

## Self-Review Notes

- Maverick auto-detect was wired in Phase 5 — Phase 6 just adds the strategy. The dispatcher already routes correctly when `hasMaverick === true`.
- Bombs only ship Big + Small in Phase 6. Bazookas TBD when a real bazooka inventory is observed.
- The `foreignWeaponPolicy: 'no-weapon'` setting causes the strategy to skip bombs entirely and behave like Standard from a bare-hands deploy standpoint — useful for users who want to conserve bombs.
- Empty-side check for Maverick-D3 is the SAME as Standard (both sides empty), not the one-side-empty d4tw uses. Maverick is empty-div farming, not TW.
- Real Maverick-D3 validation needs a D4+Maverick account; smoke only confirms no crash on forced-mode for a D1 account.
