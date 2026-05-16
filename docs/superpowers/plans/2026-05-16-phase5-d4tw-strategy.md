# Phase 5 — D4-TW Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the second farm strategy: D4 players in Training Wars deploy one big hit on their country's side per battle, when that side is empty in their division, with energy computed from the damage formula. Wire the dispatcher so the runner picks `d4tw` automatically when div=4 + no Maverick, or honors a UI override.

**Architecture:** Pure data-layer helpers (`damageFormula`, `pickWeapon`, `listMyCountryActiveBattles`, `isSideEmpty`) are added in `src/tools/` with vitest coverage. `extractCitizenContext` learns to fetch `strength`, `rankNumber`, and `hasMaverick` via the `citizen-profile-json-personal` endpoint (one call per cycle, cached on `CitizenContext`). A new `src/agent/modeSelector.ts` resolves the active strategy from `settings.modeOverride ?? autoMode(division, hasMaverick)`. `src/farm/strategies/d4tw.ts` orchestrates discovery → eligibility → empty-side check → formula-based energy compute → one POST to `deployWeapon`. The runner uses `getStrategy(effectiveMode)` instead of the hardcoded `'standard'`. **Formula-only deploy:** Spec §2.4's "hybrid in-page JS first, formula fallback" is implemented as formula-only in Phase 5; the in-page `sliderChange` integration is deferred to a future polish PR — the user's stated 130M/220M targets carry safety margin enough that formula-only correctness suffices.

**Tech Stack:** Same — TypeScript via `tsx`, Zod, vitest. Two new allow-list entries for the citizen profile + inventory endpoints.

**Spec:** `docs/superpowers/specs/2026-05-16-flexible-farming-config-design.md` §2.2 (D4-TW), §2.4 (damage formula), §2.5 (weapon priority), §3 (mode selection).

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/tools/damageFormula.ts` | **create** | Pure: `damagePerHit(strength, rank, firepower): number`. Static `FIREPOWER` table for Q1-Q7 + bare. |
| `src/tools/damageFormula.test.ts` | **create** | Vitest: reference values from KB (Recruit Q5 = 24, Sergeant Q7 = 112.50, etc.). |
| `src/tools/pickWeapon.ts` | **create** | Pure: `pickWeapon(inventory, priorityList)` returns the highest-priority weapon present in inventory (or `null` for bare hands). |
| `src/tools/pickWeapon.test.ts` | **create** | Vitest: priority order, fallback when missing, zero-amount filtered. |
| `src/tools/battles.ts` | modify | Add `listMyCountryActiveBattles(ctx, csrf, countryId)` + `isSideEmpty(ctx, csrf, battleId, division, side)`. Reuses existing `/military/campaignsJson/list` and `battle-stats` endpoints (already allow-listed). |
| `src/browser/session.ts` | modify | `extractCitizenContext` issues one extra GET to `citizen-profile-json-personal`, fills `strength`, `rankNumber`, `hasMaverick`. New fields on `CitizenContext`. |
| `src/transport/allowlist.ts` | modify | Add `GET /en/main/citizen-profile-json-personal/:id` and `GET /en/economy/inventory-json`. |
| `src/agent/modeSelector.ts` | **create** | `autoMode(division, hasMaverick): StrategyId`, `effectiveMode(settings, detected): StrategyId`. |
| `src/agent/modeSelector.test.ts` | **create** | Vitest: full truth table for autoMode + override precedence. |
| `src/farm/strategies/d4tw.ts` | **create** | The strategy implementation — discover, filter, deploy one side. Exports `d4twStrategy: FarmStrategy`. |
| `src/farm/strategies/index.ts` | modify | Register `d4twStrategy` in the dispatcher. |
| `src/agent/runner.ts` | modify | Replace hardcoded `getStrategy('standard')` with `getStrategy(effectiveMode(settings, ctxInfo))`. Update snapshot.detected from ctxInfo. Drop the modeOverride warning added in Phase 4 final-review (now wired). |
| `src/ui/snapshot.ts` | modify | (Optional) extend UiSnapshot.detected with `strength`, `rankNumber` for debug visibility. Defer if not needed. |

---

## Task 1: Damage formula

**Files:**
- Create: `src/tools/damageFormula.ts`
- Create: `src/tools/damageFormula.test.ts`

TDD pair. Reference values come from KB `Military_Formulas.md` table.

- [ ] **Step 1: Write failing tests**

Create `src/tools/damageFormula.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { damagePerHit, FIREPOWER } from './damageFormula.js';

describe('damagePerHit', () => {
  it('returns 10 for a Recruit (S=0, R=1) bare-handed', () => {
    // D = 10 * (1 + 0/400) * (1 + 1/5) * (1 + 0/100)
    //   = 10 * 1 * 1.2 * 1 = 12
    expect(damagePerHit(0, 1, FIREPOWER.bare)).toBeCloseTo(12, 5);
  });

  it('returns 24 for a Recruit with Q5 weapon (KB reference)', () => {
    expect(damagePerHit(0, 1, FIREPOWER.Q5)).toBeCloseTo(24, 5);
  });

  it('returns 36 for a Recruit with Q7 weapon (KB reference)', () => {
    expect(damagePerHit(0, 1, FIREPOWER.Q7)).toBeCloseTo(36, 5);
  });

  it('returns 112.5 for a Sergeant (S=100, R=10) with Q7 (KB reference)', () => {
    // D = 10 * (1 + 100/400) * (1 + 10/5) * (1 + 200/100)
    //   = 10 * 1.25 * 3 * 3 = 112.5
    expect(damagePerHit(100, 10, FIREPOWER.Q7)).toBeCloseTo(112.5, 5);
  });

  it('scales linearly with FP holding S and R fixed', () => {
    const baseline = damagePerHit(100, 10, FIREPOWER.bare); // FP=0 → ×1
    const q7 = damagePerHit(100, 10, FIREPOWER.Q7); // FP=200 → ×3
    expect(q7 / baseline).toBeCloseTo(3, 5);
  });

  it('matches the sample account values (S=423000, R=89, Q7) within 1%', () => {
    // Per the spec's damage-table sample: Q7 ≈ 596,994
    const d = damagePerHit(423000, 89, FIREPOWER.Q7);
    expect(d).toBeGreaterThan(593_000);
    expect(d).toBeLessThan(601_000);
  });

  it('FIREPOWER table matches the wiki', () => {
    expect(FIREPOWER.bare).toBe(0);
    expect(FIREPOWER.Q1).toBe(20);
    expect(FIREPOWER.Q2).toBe(40);
    expect(FIREPOWER.Q3).toBe(60);
    expect(FIREPOWER.Q4).toBe(80);
    expect(FIREPOWER.Q5).toBe(100);
    expect(FIREPOWER.Q6).toBe(120);
    expect(FIREPOWER.Q7).toBe(200);
  });
});
```

- [ ] **Step 2: Run RED** — `npm test --silent -- damageFormula` fails (module missing).

- [ ] **Step 3: Implement `src/tools/damageFormula.ts`**

```ts
/**
 * Per [[Military_Formulas]] (KB):
 *   D = 10 × (1 + S/400) × (1 + R/5) × (1 + FP/100)
 *
 * Excludes natural-enemy, boosters, terrain. Use as a base estimate; in
 * practice the operator's stated TW target damages carry enough safety
 * margin to absorb the multiplicative bonuses we don't model.
 */
export function damagePerHit(strength: number, rank: number, firepower: number): number {
  return 10 * (1 + strength / 400) * (1 + rank / 5) * (1 + firepower / 100);
}

/** Firepower per weapon quality. Bare hands = 0. */
export const FIREPOWER = {
  bare: 0,
  Q1: 20,
  Q2: 40,
  Q3: 60,
  Q4: 80,
  Q5: 100,
  Q6: 120,
  Q7: 200,
} as const;

export type WeaponQuality = keyof typeof FIREPOWER;
```

- [ ] **Step 4: Run GREEN** — `npm test --silent -- damageFormula` passes 7/7.

- [ ] **Step 5: Full suite + typecheck** — `npm run typecheck && npm test --silent` shows 48 (41 + 7 new).

- [ ] **Step 6: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/tools/damageFormula.ts src/tools/damageFormula.test.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(tools): damageFormula pure helper + FIREPOWER table"
```

---

## Task 2: Weapon picker

**Files:**
- Create: `src/tools/pickWeapon.ts`
- Create: `src/tools/pickWeapon.test.ts`

`inventory-json` returns an array of category objects; ground weapons live in `mainStorage` with `type === 'groundWeapon'` and `quality: 1..7`. The picker walks `weaponPriority` and returns the first quality that has `amount > 0`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { pickWeapon, type InventoryWeapon } from './pickWeapon.js';

const inv = (entries: Array<{ quality: number; amount: number }>): InventoryWeapon[] =>
  entries.map((e) => ({ type: 'groundWeapon', quality: e.quality, amount: e.amount }));

describe('pickWeapon', () => {
  it('returns the highest-priority weapon when present', () => {
    const result = pickWeapon(inv([{ quality: 7, amount: 100 }, { quality: 5, amount: 50 }]), [7, 6, 5]);
    expect(result).toEqual({ quality: 7, amount: 100 });
  });

  it('skips qualities with zero amount', () => {
    const result = pickWeapon(inv([{ quality: 7, amount: 0 }, { quality: 5, amount: 10 }]), [7, 6, 5]);
    expect(result).toEqual({ quality: 5, amount: 10 });
  });

  it('returns null when no priority quality is available', () => {
    const result = pickWeapon(inv([{ quality: 3, amount: 100 }]), [7, 6, 5]);
    expect(result).toBeNull();
  });

  it('returns null for an empty inventory', () => {
    expect(pickWeapon([], [7, 6, 5, 4, 3, 2, 1])).toBeNull();
  });

  it('returns null when priority list is empty', () => {
    expect(pickWeapon(inv([{ quality: 7, amount: 100 }]), [])).toBeNull();
  });

  it('honors priority order (e.g. [3, 7] picks 3 even when 7 has more)', () => {
    const result = pickWeapon(inv([{ quality: 7, amount: 100 }, { quality: 3, amount: 5 }]), [3, 7]);
    expect(result).toEqual({ quality: 3, amount: 5 });
  });

  it('ignores non-groundWeapon items', () => {
    const items: InventoryWeapon[] = [
      { type: 'groundBomb', quality: 22, amount: 100 } as InventoryWeapon,
      { type: 'groundWeapon', quality: 7, amount: 10 },
    ];
    expect(pickWeapon(items, [7])).toEqual({ quality: 7, amount: 10 });
  });
});
```

- [ ] **Step 2: Run RED.**

- [ ] **Step 3: Implement `src/tools/pickWeapon.ts`**

```ts
/** A row from `mainStorage.items` of /en/economy/inventory-json. */
export interface InventoryWeapon {
  type: string;
  quality: number;
  amount: number;
}

/**
 * Return the highest-priority `groundWeapon` quality that has `amount > 0`.
 * `null` means "no weapon available — fall back to bare hands".
 */
export function pickWeapon(
  inventory: readonly InventoryWeapon[],
  priorityList: readonly number[],
): { quality: number; amount: number } | null {
  for (const q of priorityList) {
    const match = inventory.find(
      (item) => item.type === 'groundWeapon' && item.quality === q && item.amount > 0,
    );
    if (match) return { quality: match.quality, amount: match.amount };
  }
  return null;
}
```

- [ ] **Step 4: GREEN — 7/7 pass.**

- [ ] **Step 5: Full suite (55 total).**

- [ ] **Step 6: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/tools/pickWeapon.ts src/tools/pickWeapon.test.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(tools): pickWeapon — priority-list based weapon selector"
```

---

## Task 3: Country battle discovery + empty-side check

**Files:**
- Modify: `src/tools/battles.ts`

The current `listFarmableBattles` filters to `wall.dom === 50`; TW battles are usually NOT at 50/50, so we need a separate code path. The current `isBattleDivisionEmpty` checks BOTH sides; for D4-TW we need to check one specific side.

- [ ] **Step 1: Read the existing `src/tools/battles.ts` to understand the response shape.** Particularly the structure of items returned from `/military/campaignsJson/list` and `/military/battle-stats/{battleId}/{div}/{battleZoneId}`. The new helpers reuse the same fetches, just different filtering.

- [ ] **Step 2: Append `listMyCountryActiveBattles` to `src/tools/battles.ts`**

The exact implementation depends on the current shape returned by `listFarmableBattles` — most likely the same raw response with a different filter. A reasonable shape:

```ts
/**
 * Active battles where the player's citizenship country is one of the sides.
 * Unlike `listFarmableBattles`, does NOT require wall.dom===50 — TW battles
 * are usually unbalanced. Caller must run `isSideEmpty` per candidate before
 * deploying.
 */
export async function listMyCountryActiveBattles(
  ctx: BrowserContext,
  csrf: string,
  countryId: number,
): Promise<FarmableBattle[]> {
  const full = await listFarmableBattles(ctx, csrf, 4 /* any division — we re-filter */);
  return full.candidates.filter(
    (c) =>
      !c.divisionEnd &&
      (c.invaderId === countryId || c.defenderId === countryId),
  );
}
```

(If `listFarmableBattles` returns `{ candidates: FarmableBattle[] }` and `FarmableBattle` has `divisionEnd`, `invaderId`, `defenderId` — confirm by reading the file. If not, adapt accordingly.)

- [ ] **Step 3: Append `isSideEmpty`**

```ts
/**
 * Check whether the specified side+division has zero damage. Used by D4-TW to
 * confirm our side is uncontested before deploying. Reuses the same
 * `/military/battle-stats` endpoint that `isBattleDivisionEmpty` uses, but
 * inspects only ONE side.
 */
export async function isSideEmpty(
  ctx: BrowserContext,
  csrf: string,
  battleId: number,
  division: number,
  battleZoneId: number,
  zoneId: number,
  side: 'invader' | 'defender',
): Promise<{ isEmpty: boolean; domination: number; zoneFinished: boolean }> {
  // ... reuse the existing fetch from isBattleDivisionEmpty; inspect only the
  // relevant side's damage instead of summing both.
}
```

The implementer should pattern-match against the existing `isBattleDivisionEmpty` function — the new helper is a near-duplicate with a one-side filter. A reasonable extraction is to factor a shared `fetchBattleStats` helper and have both `isBattleDivisionEmpty` and `isSideEmpty` call it. Decide during implementation whether to refactor or duplicate.

- [ ] **Step 4: Typecheck + tests** — `npm run typecheck && npm test --silent`. Tests still 55 (battles.ts has no tests today; we add coverage in the strategy task later).

- [ ] **Step 5: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/tools/battles.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(tools): listMyCountryActiveBattles + isSideEmpty helpers"
```

---

## Task 4: Extend `extractCitizenContext` + allow-list

**Files:**
- Modify: `src/browser/session.ts`
- Modify: `src/transport/allowlist.ts`

Add one more API read per cycle to fill `strength`, `rankNumber`, `hasMaverick`. Source confirmed in the spec: `GET /en/main/citizen-profile-json-personal/{citizenId}`, paths `military.militaryData.strength`, `military.militaryData.rankNumber`, `activePacks.division_switch_pack`.

- [ ] **Step 1: Add allow-list entries**

Read `src/transport/allowlist.ts`. Add to `PHASE_1_ALLOWLIST` (or wherever the registry lives):

```ts
{ method: 'GET', path: '/en/main/citizen-profile-json-personal/:id' },
{ method: 'GET', path: '/en/economy/inventory-json' },
```

The pattern matcher needs to handle `:id` as a wildcard — match the existing convention (e.g. some routes use `/:battleId` or regex). If the matcher is literal-only, add the path as `^\/en\/main\/citizen-profile-json-personal\/\d+$` regex or whatever the codebase pattern is. **Inspect first** before guessing.

- [ ] **Step 2: Extend `CitizenContext` interface in `src/browser/session.ts`**

Add three fields to `CitizenContext`:

```ts
  strength: number | null;
  rankNumber: number | null;
  hasMaverick: boolean | null;
```

- [ ] **Step 3: Fetch the profile inside `extractCitizenContext`**

After the existing globals-extract, if `citizenId` is available, fire one `apiCall(ctx, 'GET', '/en/main/citizen-profile-json-personal/${citizenId}')` and read:

```ts
strength = profile?.military?.militaryData?.strength ?? null;
rankNumber = profile?.military?.militaryData?.rankNumber ?? null;
hasMaverick = profile?.activePacks
  ? 'division_switch_pack' in profile.activePacks
  : null;
```

Wrap in try/catch so a profile-read failure doesn't break the cycle — log a warning, leave fields null. Standard mode doesn't need these; only d4tw/maverickD3 do, and those degrade gracefully when null (the strategy skips the cycle with a Telegram alert).

- [ ] **Step 4: Typecheck + tests** — 55 pass.

- [ ] **Step 5: Manual smoke** — `npm run agent` should now log a citizen line that includes strength/rank, OR a `[ctx] profile fetch failed: ...` warning.

```bash
cd /Users/driversti/Projects/erepublik/erepublik-agent
timeout 20 env ERP_ACCOUNT_SLUG=baryga2026 npm run agent 2>&1 | grep -E "citizen:|profile"
```

- [ ] **Step 6: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/browser/session.ts src/transport/allowlist.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(session): extract strength/rank/hasMaverick from citizen profile"
```

---

## Task 5: Mode selector

**Files:**
- Create: `src/agent/modeSelector.ts`
- Create: `src/agent/modeSelector.test.ts`

Pure decision functions: `autoMode(div, hasMaverick) → StrategyId`, `effectiveMode(settings, detected) → StrategyId`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { autoMode, effectiveMode } from './modeSelector.js';

describe('autoMode', () => {
  it('returns standard for div 1-3', () => {
    for (const d of [1, 2, 3]) expect(autoMode(d, false)).toBe('standard');
    for (const d of [1, 2, 3]) expect(autoMode(d, true)).toBe('standard');
  });
  it('returns d4tw for div 4 without Maverick', () => {
    expect(autoMode(4, false)).toBe('d4tw');
  });
  it('returns maverickD3 for div 4 with Maverick', () => {
    expect(autoMode(4, true)).toBe('maverickD3');
  });
  it('falls back to standard for unknown divisions (e.g. D11)', () => {
    expect(autoMode(11, false)).toBe('standard');
  });
  it('returns standard when division is null (pre-detection)', () => {
    expect(autoMode(null, false)).toBe('standard');
  });
});

describe('effectiveMode', () => {
  const settingsDefault = { modeOverride: null, maverickManual: null };
  it('uses autoMode when no override', () => {
    expect(effectiveMode(settingsDefault, { division: 4, hasMaverick: false })).toBe('d4tw');
  });
  it('honors modeOverride', () => {
    expect(effectiveMode({ modeOverride: 'maverickD3', maverickManual: null }, { division: 1, hasMaverick: false })).toBe('maverickD3');
  });
  it('maverickManual=true forces hasMaverick true even if detected=false', () => {
    expect(effectiveMode({ modeOverride: null, maverickManual: true }, { division: 4, hasMaverick: false })).toBe('maverickD3');
  });
  it('maverickManual=false forces hasMaverick false even if detected=true', () => {
    expect(effectiveMode({ modeOverride: null, maverickManual: false }, { division: 4, hasMaverick: true })).toBe('d4tw');
  });
});
```

- [ ] **Step 2: Run RED.**

- [ ] **Step 3: Implement `src/agent/modeSelector.ts`**

```ts
import type { StrategyId } from '../farm/strategies/index.js';

export function autoMode(division: number | null, hasMaverick: boolean): StrategyId {
  if (division == null) return 'standard';
  if (division <= 3) return 'standard';
  if (division === 4 && hasMaverick) return 'maverickD3';
  if (division === 4) return 'd4tw';
  return 'standard';
}

export interface ModeSettings {
  modeOverride: StrategyId | null;
  maverickManual: boolean | null;
}

export interface ModeDetected {
  division: number | null;
  hasMaverick: boolean | null;
}

export function effectiveMode(settings: ModeSettings, detected: ModeDetected): StrategyId {
  if (settings.modeOverride != null) return settings.modeOverride;
  const maverick = settings.maverickManual ?? detected.hasMaverick ?? false;
  return autoMode(detected.division, maverick);
}
```

- [ ] **Step 4: GREEN — 8 tests pass.**

- [ ] **Step 5: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/agent/modeSelector.ts src/agent/modeSelector.test.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(agent): modeSelector — auto + override → effective strategy id"
```

---

## Task 6: D4-TW strategy

**Files:**
- Create: `src/farm/strategies/d4tw.ts`
- Modify: `src/farm/strategies/index.ts`

The strategy implements `FarmStrategy` with `id: 'd4tw'`. Outline:

1. Discovery via `listMyCountryActiveBattles(ctx, csrf, info.countryId)`.
2. Filter: also confirm `info.currentRegionId` is in `info.countryId` (don't travel abroad for TW). If currently abroad, return early with `stopReason: 'no-candidates'` and a log line.
3. For each battle (capped at `settings.d4tw.maxBattlesPerSession`, default 1):
   - Identify our side (`mySide = info.countryId === battle.invaderId ? 'invader' : 'defender'`).
   - `isSideEmpty(...)` — if not empty, skip with reason.
   - Compute `damagePerHit` from `damagePerHit(strength, rank, FP[weaponQ])`.
   - Compute `hitsNeeded = ceil(targetDamage / damagePerHit)`, `energyToSpend = max(hitsNeeded * 10, 30)`.
   - Get inventory; `pickWeapon(inv, settings.d4tw.weaponPriority)` returns the weapon (or null = bare hands).
   - Pre-check: `poolEnergy >= energyToSpend` AND `ammoOnHand >= hitsNeeded` (skip ammo check if bare hands).
   - If pre-check fails: send Telegram alert (via `options.notify`), record a skip, continue.
   - Otherwise: one POST to `deployWeapon` with the chosen weapon + `energyToSpend`. Use the existing retry/verify mechanism from `tools/farm.ts` (don't re-implement).
4. Per-battle outcome → `WinSummary` (mark `def` or `inv` as null for the side we didn't fight — adapt the shared type). Or introduce a new `SingleSideWinSummary`. Simplest: reuse `WinSummary` but use the opposite side's `SideOutcome` as a dummy (with `attempts: 0, verified: false`) — uglier; pick during implementation.
5. Return `FarmSessionResult`.

The whole file will be ~150-200 lines. Heavy use of helpers from `tools/`.

- [ ] **Step 1: Inspect what `FarmStrategy` needs (re-read `src/farm/strategies/types.ts` and `standard.ts`).**

- [ ] **Step 2: Create `src/farm/strategies/d4tw.ts`**

This is a large file — the implementer should follow the `standard.ts` patterns closely:
- Same top-level structure: `resolveOpts()`, `runD4TW()`, exported `d4twStrategy: FarmStrategy`.
- New helper `loadInventory(ctx, csrf)` that calls `apiCall(ctx, 'GET', '/en/economy/inventory-json')` and extracts `mainStorage.items[]`.
- Reuse `deployWeapon` from `tools/farm.ts` for the actual fight.
- For `weaponPriority` from settings → translate to `FIREPOWER` value.

A reference skeleton:

```ts
import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../../transport/apiCall.js';
import { deployWeapon, skinForDivision } from '../../tools/farm.js';
import { listMyCountryActiveBattles, isSideEmpty, type FarmableBattle } from '../../tools/battles.js';
import { damagePerHit, FIREPOWER } from '../../tools/damageFormula.js';
import { pickWeapon, type InventoryWeapon } from '../../tools/pickWeapon.js';
import { loadSettings } from '../../ui/settingsStore.js';
import {
  type FarmStrategy,
  type FarmSessionInfo,
  type FarmSessionOptions,
  type FarmSessionResult,
  type SideOutcome,
  type WinSummary,
  type SkipSummary,
  type StopReason,
} from './types.js';

async function loadInventory(ctx: BrowserContext, csrf: string): Promise<InventoryWeapon[]> {
  const res = await apiCall(ctx, 'GET', '/en/economy/inventory-json');
  // mainStorage is the first category in the array per the inspected sample.
  const arr = (Array.isArray(res) ? res : []) as Array<{ id?: string; items?: InventoryWeapon[] }>;
  const main = arr.find((c) => c.id === 'mainStorage');
  return main?.items ?? [];
}

async function runD4TW(
  ctx: BrowserContext,
  info: FarmSessionInfo,
  options: FarmSessionOptions,
): Promise<FarmSessionResult> {
  const settings = loadSettings();
  const cfg = settings.d4tw;
  const wins: WinSummary[] = [];
  const skipped: SkipSummary[] = [];

  // Must be in own country (any region).
  // … fill in: read info.currentCountryId, bail if != info.countryId …

  const candidates = await listMyCountryActiveBattles(ctx, info.csrf, info.countryId);
  if (candidates.length === 0) {
    return { farmedCount: 0, wins, skipped, stopReason: 'no-candidates', /* fields … */ };
  }

  const inventory = await loadInventory(ctx, info.csrf);
  const picked = pickWeapon(inventory, cfg.weaponPriority);
  const weaponQuality = picked?.quality ?? -1;  // -1 = bare
  const firepower = picked ? FIREPOWER[`Q${picked.quality}` as keyof typeof FIREPOWER] : FIREPOWER.bare;

  // Need detected.strength + .rankNumber for the formula.
  // CitizenContext should now carry strength/rankNumber after Task 4.
  // (Adjust the FarmSessionInfo type if needed, or pass via options.)
  // … fill in pre-check / deploy loop, capped at min(maxBattlesPerSession, candidates.length) …
  // … on underspend → options.notify(...), skipped.push, continue …

  return {
    farmedCount: wins.length,
    wins,
    skipped,
    stopReason: 'completed',
    /* other fields populated similarly to standard.ts */
  };
}

export const d4twStrategy: FarmStrategy = {
  id: 'd4tw',
  run: runD4TW,
};
```

The implementer fills in the deploy loop. Refer back to `standard.ts:runStandard` for the loop structure (cap, log line, retry, error handling).

- [ ] **Step 3: Decide where strength/rankNumber come from.**

`FarmSessionInfo` doesn't have them today. Two options:
1. **Add to `FarmSessionInfo`** (extend the interface in `types.ts`). The runner reads them from `ctxInfo` and passes them in. Cleanest.
2. **Read via `extractCitizenContext` inside `runD4TW`**. Avoids interface change but duplicates page fetch.

Pick option 1. Modify `src/farm/strategies/types.ts`:

```ts
export interface FarmSessionInfo {
  // ... existing fields ...
  strength: number | null;
  rankNumber: number | null;
  hasMaverick: boolean | null;
  currentCountryId: number | null;
}
```

Then update both call sites in `runner.ts` and `farmRunner.ts` to pass these from `ctxInfo`.

- [ ] **Step 4: Register in `src/farm/strategies/index.ts`**

Add `d4twStrategy` to the registry:

```ts
import { d4twStrategy } from './d4tw.js';

const registry: Partial<Record<StrategyId, FarmStrategy>> = {
  standard: standardStrategy,
  d4tw: d4twStrategy,
};

export { d4twStrategy } from './d4tw.js';
```

- [ ] **Step 5: Typecheck** — `npm run typecheck`. PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/farm/strategies/d4tw.ts src/farm/strategies/index.ts src/farm/strategies/types.ts src/agent/runner.ts src/farmRunner.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(strategies): d4tw — single-side TW deploy with damage-formula budget"
```

---

## Task 7: Wire `effectiveMode` into the runner dispatcher

**Files:**
- Modify: `src/agent/runner.ts`

Replace the hardcoded `getStrategy('standard').run(...)` with `getStrategy(effectiveMode(...)).run(...)` and drop the Phase-4 warning that's now moot.

- [ ] **Step 1: Update import**

Add `import { effectiveMode } from './modeSelector.js';`.

- [ ] **Step 2: Compute mode + use it**

Find the existing `await getStrategy('standard').run(ctx, { ... }, ...)` call (around line 380). Just before the call, compute:

```ts
const mode = effectiveMode(
  { modeOverride: settings.modeOverride, maverickManual: settings.maverickManual },
  { division: ctxInfo.division, hasMaverick: ctxInfo.hasMaverick },
);
console.log(`[cycle] strategy: ${mode}`);
```

Replace `getStrategy('standard')` with `getStrategy(mode)`.

- [ ] **Step 3: Drop the Phase-4 modeOverride warning**

It was added in commit `293ff54` to flag unwired modes. Now that the dispatcher honors them, the warning is misleading. Remove the warning block.

- [ ] **Step 4: Update the `info` object passed to `.run(...)` to include the new fields**

The deploy info struct should now include `strength`, `rankNumber`, `hasMaverick`, `currentCountryId`. Read from `ctxInfo`.

- [ ] **Step 5: Update snapshot.detected**

After cycling: `uiSnapshot.detected = { division, hasMaverick, citizenId, countryId, lastUpdated: ISO }` — already in the UiSnapshot shape; just wire ctxInfo.

- [ ] **Step 6: Typecheck + tests + smoke**

```bash
npm run typecheck && npm test --silent
```

Then run the agent for one cycle to confirm no regression on a D1 account (effective mode should be 'standard'):

```bash
rm -f config/settings.json
timeout 30 env ERP_ACCOUNT_SLUG=baryga2026 npm run agent 2>&1 | grep -E "strategy:|farm|cycle"
```

Expected: `[cycle] strategy: standard`, normal Standard-mode farm-gate output, no exceptions.

- [ ] **Step 7: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/agent/runner.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(runner): dispatch via effectiveMode — honors modeOverride + auto"
```

---

## Task 8: Smoke test

**Files:** none — verification only.

Full validation that nothing regressed on Standard mode for the D1 test account.

- [ ] **Step 1: Clean state**

```bash
rm -f /Users/driversti/Projects/erepublik/erepublik-agent/config/settings.json
```

- [ ] **Step 2: Default-mode smoke (D1 account = standard)**

```bash
cd /Users/driversti/Projects/erepublik/erepublik-agent
ERP_ACCOUNT_SLUG=baryga2026 npm run agent > /tmp/p5-smoke.log 2>&1 &
PID=$!
sleep 10
echo "--- recent log ---"
tail -30 /tmp/p5-smoke.log

echo "--- strategy line ---"
grep "strategy:" /tmp/p5-smoke.log
```

Expected:
- `[cycle] strategy: standard` (because baryga is D1).
- Farm-gate logs unchanged.
- No exceptions.

- [ ] **Step 3: Manual mode override via PUT — verify it switches**

```bash
curl -s -X PUT http://localhost:3737/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"paused":false,"farmEnabled":true,"modeOverride":"d4tw","maverickManual":null,"d4tw":{"targetDamageAttacker":130000000,"targetDamageDefender":220000000,"maxBattlesPerSession":1,"weaponPriority":[7,6,5,4,3,2,1]},"emptyDiv":{"maxBattlesPerSession":3,"nativeWeaponPriority":[7,6,5,4,3,2,1],"foreignWeaponPolicy":"bomb-then-bazooka"},"travel":{"maxTravelCC":100,"returnHomeAfterMinutes":15,"returnHomeMaxCC":500},"detected":{"division":null,"hasMaverick":null,"citizenId":null,"countryId":null,"lastUpdated":null}}' \
  > /dev/null
sleep 12
echo "--- after override ---"
tail -30 /tmp/p5-smoke.log
```

Expected:
- `[runner] woken early — settings.json changed`.
- `[cycle] strategy: d4tw`.
- D4-TW logic runs. Since baryga is D1 (currentCountryId might mismatch native, no candidates, etc.), the strategy should return `stopReason: 'no-candidates'` or similar and log a clean skip — **NOT throw**.

If d4tw throws, that's a BLOCKED. Capture the error.

- [ ] **Step 4: Shutdown + cleanup**

```bash
kill -INT $PID 2>/dev/null
wait $PID 2>/dev/null
rm -f /Users/driversti/Projects/erepublik/erepublik-agent/config/settings.json
```

- [ ] **Step 5: Full vitest**

```bash
npm test --silent
```

Expected: ≥56 tests pass (41 + 7 damage + 7 pick + 8 mode = 63 if no test count drift; minor variation OK).

- [ ] **Step 6: No commit.**

---

## Self-Review Notes (for the implementer)

- The largest single task is Task 6 (`d4tw.ts`). Follow `standard.ts` for shape; don't re-invent the deploy/retry pattern.
- `FarmSessionInfo` interface change ripples to both call sites (`runner.ts` and `farmRunner.ts`). Don't forget the second one.
- Task 4 introduces a new HTTP call per cycle. On a D1 account this is wasted load — but it's cheap (~50 KB JSON), runs once per cycle, and Phase 5/6 need it. Don't over-optimize.
- The mode dropdown in the UI (added in Phase 4) becomes meaningful after Task 7. `maverickD3` will still throw because Phase 6 isn't here yet — the user can pick `d4tw` or `standard` safely.
- Real D4-TW validation needs a D4 account; this plan's smoke only validates "doesn't crash on D1 with d4tw mode forced". The owner is responsible for end-to-end TW verification on their own account.
- Spec §2.4's in-page `sliderChange` integration is deferred. The formula-only path is correct in the absence of multiplicative bonuses (NE, boosters, vehicle); the user's safety margin absorbs the gap.
- If `extractCitizenContext` profile fetch fails (network blip), the cycle continues with `strength=null` / `hasMaverick=null`. D4-TW strategy degrades gracefully: it sees `strength=null` and returns `stopReason: 'no-candidates'` with a log line instead of throwing.
