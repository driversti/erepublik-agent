# D4-TW Air Strategy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new farming strategy `d4tw-air` for native D4 accounts with low strength (<350k) that farms cheap Battle Hero medals in Division 11 (air) battles in the native country, preferring native=invader (losing) sides with 30k damage target and falling back to defender at 50k. Includes UI controls, abroad pre-flight with auto travel-home to native country, and strategy-aware fuel-gate energy threshold.

**Architecture:** Mirror `d4tw` shape. Extract shared inventory helpers into `src/farm/strategies/inventory.ts`. New `d4twAir.ts` strategy with the differences (D11 filter, aircraft rank, invader-first ordering, useWeapon toggle, Q1–Q5 priority). Runner gains a `mode === 'd4tw-air'` branch that loads inventory once, computes `estimateMinEnergy` for the optimistic side, decides whether to travel home, then runs strategy. `decideFarming` accepts optional `minEnergyPerBattle`. New `travelToCountry` helper in `tools/travel.ts`. `pickWeapon` parameterised by `weaponType` for ground vs air.

**Tech Stack:** TypeScript (ESM via tsx, no build step), Zod, vitest, Playwright-driven CloakBrowser. All file imports use `.js` suffixes.

**Reference:** `docs/superpowers/specs/2026-05-19-d4tw-air-strategy-design.md`.

---

## Pre-flight: confirm two API field names from real responses

Before any code changes, the implementer must run one live request to confirm exact JSON field names. Both are unverified from training data and the codebase doesn't reference them.

- [ ] **Step 0a: Identify aircraft rank field name**

Use the bootstrapped browser context (or a manual fetch against a live session) to run:

```bash
# Inside a temp tsx scratch script using openSession + apiCall — easiest path
# is to add a one-off console.log to runner.ts, run `npm start`, copy the
# response, then revert. Alternatively, in DevTools after logging into
# erepublik.com:
fetch('/en/main/citizen-profile-json-personal/' + erepublik.citizen.citizenId)
  .then(r => r.json()).then(j => console.log(JSON.stringify(j.military.militaryData, null, 2)));
```

Record which of the following the JSON uses — note it in a comment in the implementation file:
- `airRankNumber`
- `air_rank_number`
- `aircraftRankNumber`
- Nested under another object (e.g. `military.aircraftData.rankNumber`)

- [ ] **Step 0b: Identify aircraft weapon `type` string in inventory**

In DevTools or via a scratch fetch:

```bash
fetch('/en/economy/inventory-json').then(r => r.json())
  .then(j => console.log([...new Set(j.find(c => c.id === 'mainStorage').items.map(i => i.type))]));
```

Record the type string for aircraft weapons (likely `aircraftWeapon`). Use this value in Task 1 below.

---

## Task 1: Parameterise `pickWeapon` by weapon type (preparatory refactor)

**Files:**
- Modify: `src/tools/pickWeapon.ts`
- Modify: `src/tools/pickWeapon.test.ts` (if it exists) — confirm grep first

**Rationale:** Current `pickWeapon` is hardcoded to `type === 'groundWeapon'`. Air weapons have a different `type` string. Add an optional parameter, default to `'groundWeapon'` so existing callers don't change.

- [ ] **Step 1: Find existing pickWeapon callers**

Run: `grep -rn "pickWeapon" /Users/driversti/Projects/erepublik/erepublik-agent/src --include="*.ts"`
Expected: usage in `d4tw.ts` (and `farm/strategies/inventory.ts` after Task 2). Note all callers — they will all stay on the `groundWeapon` default.

- [ ] **Step 2: Write the failing test**

If `src/tools/pickWeapon.test.ts` does not exist, create it. Otherwise extend it.

```ts
import { describe, it, expect } from 'vitest';
import { pickWeapon } from './pickWeapon.js';

describe('pickWeapon weaponType parameter', () => {
  const inv = [
    { type: 'groundWeapon', quality: 7, amount: 100 },
    { type: 'aircraftWeapon', quality: 5, amount: 50 },
    { type: 'aircraftWeapon', quality: 3, amount: 10 },
  ];

  it('defaults to groundWeapon', () => {
    expect(pickWeapon(inv, [7, 5])).toEqual({ quality: 7, amount: 100 });
  });

  it('picks aircraftWeapon when requested', () => {
    expect(pickWeapon(inv, [5, 4, 3, 2, 1], 'aircraftWeapon'))
      .toEqual({ quality: 5, amount: 50 });
  });

  it('returns null when no matching type is present', () => {
    const groundOnly = [{ type: 'groundWeapon', quality: 7, amount: 100 }];
    expect(pickWeapon(groundOnly, [5, 4, 3], 'aircraftWeapon')).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/tools/pickWeapon.test.ts`
Expected: FAIL — the aircraftWeapon test cannot resolve because the second arg `'aircraftWeapon'` is not accepted.

- [ ] **Step 4: Implement the parameter**

Replace the body of `src/tools/pickWeapon.ts`:

```ts
/** A row from `mainStorage.items` of /en/economy/inventory-json. */
export interface InventoryWeapon {
  type: string;
  quality: number;
  amount: number;
}

/**
 * Return the highest-priority weapon of the requested `weaponType` that has
 * `amount > 0`. `null` means "no weapon available — fall back to bare hands".
 *
 * `weaponType` defaults to `'groundWeapon'` for backwards compatibility with
 * existing callers (standard, d4tw, maverickD3).
 */
export function pickWeapon(
  inventory: readonly InventoryWeapon[],
  priorityList: readonly number[],
  weaponType: string = 'groundWeapon',
): { quality: number; amount: number } | null {
  for (const q of priorityList) {
    const match = inventory.find(
      (item) => item.type === weaponType && item.quality === q && item.amount > 0,
    );
    if (match) return { quality: match.quality, amount: match.amount };
  }
  return null;
}
```

- [ ] **Step 5: Run all tests to verify nothing regressed**

Run: `npm test`
Expected: PASS (all existing tests, plus the new pickWeapon tests).

- [ ] **Step 6: Commit**

```bash
git add src/tools/pickWeapon.ts src/tools/pickWeapon.test.ts
git commit -m "refactor(pickWeapon): parameterise by weaponType (default groundWeapon)"
```

---

## Task 2: Extract shared inventory helpers into `farm/strategies/inventory.ts`

**Files:**
- Create: `src/farm/strategies/inventory.ts`
- Modify: `src/farm/strategies/d4tw.ts` (remove private `loadInventory`, `resolveWeapon`, `ResolvedWeapon`; import from `./inventory.js`)

**Rationale:** Both `d4twAir.ts` (new) and `runner.ts` need `loadInventory` + `resolveWeapon`. Extracting them to a shared module avoids duplication.

- [ ] **Step 1: Create the new module**

Write `src/farm/strategies/inventory.ts`:

```ts
import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../../transport/apiCall.js';
import { pickWeapon, type InventoryWeapon } from '../../tools/pickWeapon.js';
import { FIREPOWER } from '../../tools/damageFormula.js';

interface InventoryCategory {
  id?: string;
  items?: InventoryWeapon[];
}

/** GET /economy/inventory-json → mainStorage items. */
export async function loadInventory(
  ctx: BrowserContext,
  csrf: string,
): Promise<InventoryWeapon[]> {
  const { body } = await apiCall<InventoryCategory[]>(ctx, {
    method: 'GET',
    path: '/en/economy/inventory-json',
    csrf,
  });
  const main = Array.isArray(body) ? body.find((c) => c.id === 'mainStorage') : undefined;
  return main?.items ?? [];
}

export interface ResolvedWeapon {
  /** Quality 1-7, or -1 for bare hands. */
  quality: number;
  /** Firepower for the damage formula. */
  firepower: number;
  /** Ammo on hand (Infinity for bare hands). */
  amountOnHand: number;
}

/**
 * Pick the best available weapon of `weaponType` from `inventory` according
 * to `priority`. Returns bare-hands defaults when nothing matches.
 */
export function resolveWeapon(
  inventory: readonly InventoryWeapon[],
  priority: readonly number[],
  weaponType: string = 'groundWeapon',
): ResolvedWeapon {
  const picked = pickWeapon(inventory, priority, weaponType);
  if (!picked) {
    return {
      quality: -1,
      firepower: FIREPOWER.bare,
      amountOnHand: Number.POSITIVE_INFINITY,
    };
  }
  const fpKey = `Q${picked.quality}` as keyof typeof FIREPOWER;
  return {
    quality: picked.quality,
    firepower: FIREPOWER[fpKey],
    amountOnHand: picked.amount,
  };
}

export type { InventoryWeapon };
```

- [ ] **Step 2: Update d4tw.ts to import from the shared module**

In `src/farm/strategies/d4tw.ts`:

Remove the local `interface InventoryCategory`, `loadInventory`, `interface ResolvedWeapon`, and `resolveWeapon` (lines ~26–61).

Replace the existing `pickWeapon` / `InventoryWeapon` import lines (top of file) with:

```ts
import { loadInventory, resolveWeapon, type InventoryWeapon } from './inventory.js';
```

Remove the now-unused `apiCall` import if d4tw.ts no longer references it directly. Run grep:

```bash
grep -n "apiCall\|pickWeapon" src/farm/strategies/d4tw.ts
```

Keep imports that are still used; drop the rest. Same for `import { pickWeapon, type InventoryWeapon } from '../../tools/pickWeapon.js'` — replace with the line above.

- [ ] **Step 3: Run all tests to confirm d4tw behavior unchanged**

Run: `npm test`
Expected: PASS — d4tw refactor is mechanical, no test changes expected.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/farm/strategies/inventory.ts src/farm/strategies/d4tw.ts
git commit -m "refactor(strategies): extract loadInventory/resolveWeapon to inventory.ts"
```

---

## Task 3: Extend `FarmSessionInfo` and `FarmSessionOptions`, register new StrategyId

**Files:**
- Modify: `src/farm/strategies/types.ts`

- [ ] **Step 1: Update types.ts**

Open `src/farm/strategies/types.ts`. Make the following edits:

1. Add `airRankNumber` to `FarmSessionInfo`. After the `rankNumber: number | null;` line, add:

```ts
  /** Aircraft rank number (1+). Null when profile fetch failed or field missing. */
  airRankNumber: number | null;
```

2. Add `preloadedInventory` to `FarmSessionOptions`. Anywhere inside the interface, e.g. after `handoffSleepMs?: number;`:

```ts
  /**
   * Pre-loaded inventory snapshot from the runner. When supplied, strategies
   * SHOULD use it instead of issuing their own `/economy/inventory-json` GET,
   * to keep the per-cycle HTTP budget small. Strategies that need fresher
   * data may still re-fetch — the contract is "use if present, fetch if not".
   */
  preloadedInventory?: import('./inventory.js').InventoryWeapon[];
```

3. Update `StrategyId` union:

```ts
export type StrategyId = 'standard' | 'd4tw' | 'maverickD3' | 'd4tw-air';
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: errors will surface in `runner.ts` (needs to populate `airRankNumber`) and `farmRunner.ts` (also constructs FarmSessionInfo). We'll fix those as we touch each file.

- [ ] **Step 3: Patch the callers temporarily so typecheck passes**

In `src/agent/runner.ts`, locate where `FarmSessionInfo` is constructed (around line 419–430) and add:

```ts
            airRankNumber: ctxInfo.airRankNumber,
```

In `src/farmRunner.ts`, locate the equivalent construction (around line 50–60) and add:

```ts
      airRankNumber: raw.airRankNumber,
```

(Both `ctxInfo.airRankNumber` and `raw.airRankNumber` will resolve to `null` until Task 4 extracts them — that is fine for now.)

- [ ] **Step 4: Add nullable airRankNumber to the upstream CtxInfo types**

In `src/browser/session.ts`, locate the type definition (around line 50–70 — the exported `CtxInfo` interface). Add:

```ts
  airRankNumber: number | null;
```

In the return object at the bottom (around line 258–262), add:

```ts
    airRankNumber: null,   // populated in Task 4
```

- [ ] **Step 5: Typecheck again**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS — no behavior changed.

- [ ] **Step 7: Commit**

```bash
git add src/farm/strategies/types.ts src/browser/session.ts src/agent/runner.ts src/farmRunner.ts
git commit -m "feat(types): add airRankNumber and preloadedInventory; register 'd4tw-air' StrategyId"
```

---

## Task 4: Extract aircraft rank in `session.ts`

**Files:**
- Modify: `src/browser/session.ts`

- [ ] **Step 1: Add airRank extraction next to rankNumber**

In `src/browser/session.ts`, inside the `if (citizenId != null)` block where `rankNumber` is read (around line 215–230). After the line:

```ts
      rankNumber = typeof milData?.rankNumber === 'number' ? milData.rankNumber : null;
```

Add:

```ts
      // TODO(verify): confirm exact JSON key during implementation —
      // candidates are `airRankNumber`, `air_rank_number`, or nested
      // under `aircraftData`. Replace this read once verified (see plan §0a).
      airRankNumber = typeof milData?.airRankNumber === 'number'
        ? milData.airRankNumber
        : null;
```

Declare the local variable next to the others (~line 215):

```ts
  let airRankNumber: number | null = null;
```

Replace the `airRankNumber: null` placeholder in the return object with `airRankNumber,` (drop the literal `null`).

- [ ] **Step 2: Manually verify against a live response**

After bootstrap, run `npm start` once with a short LOOP_INTERVAL_MS. In the runner's log, add temporarily next to the citizen-profile read:

```ts
console.log('[debug] militaryData keys:', Object.keys(milData ?? {}));
```

Confirm the key matches `airRankNumber`. If it does not (e.g. snake_case), update the read accordingly. Remove the debug log when done.

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/browser/session.ts
git commit -m "feat(session): extract airRankNumber from citizen profile"
```

---

## Task 5: Extend Settings with `d4twAir` block and `detected.airRankNumber`

**Files:**
- Modify: `src/ui/settingsStore.ts`

- [ ] **Step 1: Add the Zod schema**

In `src/ui/settingsStore.ts`, after the `D4TWSettings` block:

```ts
const D4TWAirSettings = z.object({
  targetDamageAttacker: z.number().int().positive().default(30_000),
  targetDamageDefender: z.number().int().positive().default(50_000),
  maxBattlesPerSession: z.number().int().min(1).max(10).default(1),
  useWeapon: z.boolean().default(false),
  weaponPriority: z.array(z.number().int().min(1).max(5)).default([5, 4, 3, 2, 1]),
});
```

Update the `StrategyId` enum:

```ts
const StrategyId = z.enum(['standard', 'd4tw', 'maverickD3', 'd4tw-air']);
```

Add `airRankNumber` to `DetectedState`:

```ts
const DetectedState = z.object({
  division: z.number().int().nullable().default(null),
  hasMaverick: z.boolean().nullable().default(null),
  airRankNumber: z.number().int().nullable().default(null),
  citizenId: z.number().int().nullable().default(null),
  countryId: z.number().int().nullable().default(null),
  lastUpdated: z.string().nullable().default(null),
});
```

Add the `d4twAir` block to the main `Settings`:

```ts
  d4twAir: D4TWAirSettings.default(() => ({
    targetDamageAttacker: 30_000,
    targetDamageDefender: 50_000,
    maxBattlesPerSession: 1,
    useWeapon: false,
    weaponPriority: [5, 4, 3, 2, 1],
  })),
```

Update the `detected` default in `Settings.parse({...})` to include `airRankNumber: null`.

- [ ] **Step 2: Write a test for backwards compat**

If `src/ui/settingsStore.test.ts` exists, add to it. Otherwise create it:

```ts
import { describe, it, expect } from 'vitest';
import { Settings } from './settingsStore.js';

describe('Settings d4twAir defaults', () => {
  it('parses an old settings.json without d4twAir', () => {
    const parsed = Settings.parse({
      paused: false,
      farmEnabled: true,
      modeOverride: null,
      maverickManual: null,
      // No d4twAir block
    });
    expect(parsed.d4twAir).toEqual({
      targetDamageAttacker: 30_000,
      targetDamageDefender: 50_000,
      maxBattlesPerSession: 1,
      useWeapon: false,
      weaponPriority: [5, 4, 3, 2, 1],
    });
  });

  it('accepts d4tw-air as a modeOverride', () => {
    const parsed = Settings.parse({ modeOverride: 'd4tw-air' });
    expect(parsed.modeOverride).toBe('d4tw-air');
  });

  it('rejects weaponPriority entries above 5', () => {
    expect(() =>
      Settings.parse({ d4twAir: { weaponPriority: [7, 6, 5] } }),
    ).toThrow();
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/ui/settingsStore.test.ts`
Expected: PASS.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settingsStore.ts src/ui/settingsStore.test.ts
git commit -m "feat(settings): add d4twAir block and detected.airRankNumber"
```

---

## Task 6: Implement `estimateMinEnergy` pure function (TDD)

**Files:**
- Create: `src/farm/strategies/d4twAir.ts` (initial skeleton with just this function)
- Create: `src/farm/strategies/d4twAir.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/farm/strategies/d4twAir.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { estimateMinEnergy } from './d4twAir.js';
import type { InventoryWeapon } from './inventory.js';

const cfg = {
  targetDamageAttacker: 30_000,
  targetDamageDefender: 50_000,
  useWeapon: false,
  weaponPriority: [5, 4, 3, 2, 1] as number[],
};

describe('estimateMinEnergy', () => {
  it('returns MIN_DEPLOY_ENERGY (30) when strength is null', () => {
    const info = { strength: null, airRankNumber: 20 };
    expect(estimateMinEnergy(info, cfg, [])).toBe(30);
  });

  it('returns MIN_DEPLOY_ENERGY (30) when airRankNumber is null', () => {
    const info = { strength: 100_000, airRankNumber: null };
    expect(estimateMinEnergy(info, cfg, [])).toBe(30);
  });

  it('bare hands, low strength: 30k target = 3 hits = 30 energy', () => {
    // S=100k, R=20, FP=0 → D = 10 * (1+250) * (1+4) * 1 = 12_550
    // hits = ceil(30000/12550) = 3 → energy = max(3*10, 30) = 30
    const info = { strength: 100_000, airRankNumber: 20 };
    expect(estimateMinEnergy(info, { ...cfg, useWeapon: false }, [])).toBe(30);
  });

  it('uses MIN_DEPLOY_ENERGY (30) when hits*10 is below 30', () => {
    // Strong account: S=300k, R=30, FP=100 (Q5) → D huge → 1 hit
    const info = { strength: 300_000, airRankNumber: 30 };
    const inv: InventoryWeapon[] = [
      { type: 'aircraftWeapon', quality: 5, amount: 99 },
    ];
    const got = estimateMinEnergy(info, { ...cfg, useWeapon: true }, inv);
    expect(got).toBe(30);
  });

  it('uses weapon FP when useWeapon=true and weapon is present', () => {
    // S=50k, R=15, useWeapon, Q5 (FP=100) → D = 10*(1+125)*(1+3)*2 = 10_080
    // hits for 30k = ceil(30000/10080) = 3 → energy = 30
    const info = { strength: 50_000, airRankNumber: 15 };
    const inv: InventoryWeapon[] = [
      { type: 'aircraftWeapon', quality: 5, amount: 50 },
    ];
    expect(estimateMinEnergy(info, { ...cfg, useWeapon: true }, inv)).toBe(30);
  });

  it('falls back to bare hands when useWeapon=true but inventory has no air weapon', () => {
    const info = { strength: 50_000, airRankNumber: 15 };
    const groundOnly: InventoryWeapon[] = [
      { type: 'groundWeapon', quality: 7, amount: 100 },
    ];
    // bare hands: S=50k, R=15, FP=0 → D = 10*126*4*1 = 5_040
    // hits = ceil(30000/5040) = 6 → energy = max(6*10, 30) = 60
    const got = estimateMinEnergy(info, { ...cfg, useWeapon: true }, groundOnly);
    expect(got).toBe(60);
  });

  it('large targets scale energy linearly above MIN_DEPLOY_ENERGY', () => {
    // very weak account: S=10k, R=10, FP=0 → D = 10*(1+25)*(1+2)*1 = 780
    // hits for 30k = ceil(30000/780) = 39 → energy = 390
    const info = { strength: 10_000, airRankNumber: 10 };
    expect(estimateMinEnergy(info, { ...cfg, useWeapon: false }, [])).toBe(390);
  });
});
```

- [ ] **Step 2: Create the skeleton + implementation**

`src/farm/strategies/d4twAir.ts`:

```ts
import { damagePerHit, FIREPOWER } from '../../tools/damageFormula.js';
import { resolveWeapon, type InventoryWeapon } from './inventory.js';

export const ENERGY_PER_HIT = 10;
export const MIN_DEPLOY_ENERGY = 30;
export const AIRCRAFT_WEAPON_TYPE = 'aircraftWeapon';   // TODO: verify against live inventory JSON (plan §0b)

export interface MinEnergyInfo {
  strength: number | null;
  airRankNumber: number | null;
}

export interface MinEnergyCfg {
  targetDamageAttacker: number;
  useWeapon: boolean;
  weaponPriority: readonly number[];
}

/**
 * Estimate the minimum energy required to land a single d4tw-air medal on the
 * OPTIMISTIC (invader / losing) side. Used by the runner to compute the
 * `minEnergyPerBattle` hint for `decideFarming`. The strategy itself re-checks
 * with the real per-battle side and fresh pool energy before deploying.
 */
export function estimateMinEnergy(
  info: MinEnergyInfo,
  cfg: MinEnergyCfg,
  inventory: readonly InventoryWeapon[],
): number {
  if (info.strength == null || info.airRankNumber == null) return MIN_DEPLOY_ENERGY;

  const fp = cfg.useWeapon
    ? resolveWeapon(inventory, cfg.weaponPriority, AIRCRAFT_WEAPON_TYPE).firepower
    : FIREPOWER.bare;

  const dmg = damagePerHit(info.strength, info.airRankNumber, fp);
  if (dmg <= 0) return MIN_DEPLOY_ENERGY;

  const hits = Math.ceil(cfg.targetDamageAttacker / dmg);
  return Math.max(hits * ENERGY_PER_HIT, MIN_DEPLOY_ENERGY);
}
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run src/farm/strategies/d4twAir.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/farm/strategies/d4twAir.ts src/farm/strategies/d4twAir.test.ts
git commit -m "feat(d4tw-air): estimateMinEnergy pure function with TDD coverage"
```

---

## Task 7: Add invader-first ordering helper (TDD)

**Files:**
- Modify: `src/farm/strategies/d4twAir.ts`
- Modify: `src/farm/strategies/d4twAir.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/farm/strategies/d4twAir.test.ts`:

```ts
import { orderByPreferredSide } from './d4twAir.js';
import type { FarmableBattle } from '../../tools/battles.js';

const make = (id: number, invader: number, defender: number, division = 11): FarmableBattle =>
  ({
    battleId: id,
    invaderId: invader,
    defenderId: defender,
    division,
    battleZoneId: 0,
    zoneId: 0,
    regionName: `Region${id}`,
  } as FarmableBattle);

describe('orderByPreferredSide', () => {
  const nativeCountryId = 71;

  it('puts native=invader battles before native=defender', () => {
    const battles = [
      make(1, 99, nativeCountryId),  // native = defender
      make(2, nativeCountryId, 99),  // native = invader
      make(3, 88, nativeCountryId),  // native = defender
      make(4, nativeCountryId, 77),  // native = invader
    ];
    const out = orderByPreferredSide(battles, nativeCountryId).map((b) => b.battleId);
    expect(out).toEqual([2, 4, 1, 3]);
  });

  it('returns invader-only list unchanged when no defender battles', () => {
    const battles = [make(1, nativeCountryId, 99), make(2, nativeCountryId, 88)];
    expect(orderByPreferredSide(battles, nativeCountryId).map((b) => b.battleId))
      .toEqual([1, 2]);
  });

  it('returns defender-only list when no invader battles', () => {
    const battles = [make(1, 99, nativeCountryId), make(2, 88, nativeCountryId)];
    expect(orderByPreferredSide(battles, nativeCountryId).map((b) => b.battleId))
      .toEqual([1, 2]);
  });

  it('returns empty list when no battles', () => {
    expect(orderByPreferredSide([], nativeCountryId)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/farm/strategies/d4twAir.test.ts`
Expected: FAIL — `orderByPreferredSide` is not exported.

- [ ] **Step 3: Implement the function**

Append to `src/farm/strategies/d4twAir.ts`:

```ts
import type { FarmableBattle } from '../../tools/battles.js';

/**
 * Order battles for the d4tw-air strategy: native=invader (losing side) first,
 * native=defender (fallback, higher damage target) second. Stable order
 * within each bucket — preserves input order for deterministic behavior.
 */
export function orderByPreferredSide(
  battles: readonly FarmableBattle[],
  nativeCountryId: number,
): FarmableBattle[] {
  const invaders: FarmableBattle[] = [];
  const defenders: FarmableBattle[] = [];
  for (const b of battles) {
    if (b.invaderId === nativeCountryId) invaders.push(b);
    else if (b.defenderId === nativeCountryId) defenders.push(b);
  }
  return [...invaders, ...defenders];
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/farm/strategies/d4twAir.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/farm/strategies/d4twAir.ts src/farm/strategies/d4twAir.test.ts
git commit -m "feat(d4tw-air): orderByPreferredSide helper"
```

---

## Task 8: Extend `decideFarming` with optional `minEnergyPerBattle`

**Files:**
- Modify: `src/agent/fuelBudget.ts`
- Modify: `src/agent/fuelBudget.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/agent/fuelBudget.test.ts`:

```ts
describe('decideFarming minEnergyPerBattle override', () => {
  const baseWeekly: WeeklyFuelState = {
    week: 0,
    spent: 0,
    hitsLanded: 0,
    lastFarmedAt: null,
    nextEligibleAt: null,
    cyclesSkipped: 0,
    weekStartInventory: null,
  };

  it('uses ENERGY_PER_BATTLE (66) by default', () => {
    const d = decideFarming({
      weekly: baseWeekly,
      poolEnergy: 50,
      fuelInInventory: 5,
    });
    expect(d.shouldFarm).toBe(false);
    expect(d.reason).toMatch(/50 < 66/);
  });

  it('uses minEnergyPerBattle when supplied', () => {
    const d = decideFarming({
      weekly: baseWeekly,
      poolEnergy: 40,
      fuelInInventory: 5,
      minEnergyPerBattle: 30,
    });
    expect(d.shouldFarm).toBe(true);
  });

  it('still blocks when pool is below the supplied minEnergyPerBattle', () => {
    const d = decideFarming({
      weekly: baseWeekly,
      poolEnergy: 20,
      fuelInInventory: 5,
      minEnergyPerBattle: 30,
    });
    expect(d.shouldFarm).toBe(false);
    expect(d.reason).toMatch(/20 < 30/);
  });
});
```

If `WeeklyFuelState` import or type names differ from this snippet, copy the existing pattern at the top of `fuelBudget.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/agent/fuelBudget.test.ts -t "minEnergyPerBattle"`
Expected: FAIL — `minEnergyPerBattle` is not accepted by `FarmInputs`.

- [ ] **Step 3: Update the implementation**

In `src/agent/fuelBudget.ts`, add the field to `FarmInputs`:

```ts
export interface FarmInputs {
  weekly: WeeklyFuelState;
  poolEnergy: number;
  fuelInInventory: number;
  maxBattlesPerSession?: number;
  /**
   * Override the default `ENERGY_PER_BATTLE` floor in the gate's hard-stop
   * check. Strategies like `d4tw-air` farm cheaper medals (~30 energy/medal)
   * and pass a smaller value to avoid being blocked when the standard 66
   * threshold would falsely reject a viable cycle.
   */
  minEnergyPerBattle?: number;
  now?: Date;
}
```

In `decideFarming`, replace the pool-energy hard-stop check:

```ts
  const minEnergy = inputs.minEnergyPerBattle ?? ENERGY_PER_BATTLE;
  if (inputs.poolEnergy < minEnergy) {
    return no(`pool energy ${inputs.poolEnergy} < ${minEnergy} (one battle)`);
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/fuelBudget.test.ts`
Expected: PASS (all existing tests + the three new ones).

- [ ] **Step 5: Commit**

```bash
git add src/agent/fuelBudget.ts src/agent/fuelBudget.test.ts
git commit -m "feat(fuelBudget): accept minEnergyPerBattle override"
```

---

## Task 9: Implement `runD4twAir` strategy run loop

**Files:**
- Modify: `src/farm/strategies/d4twAir.ts`
- Modify: `src/farm/strategies/index.ts`

- [ ] **Step 1: Add imports and constants to d4twAir.ts**

At the top of `src/farm/strategies/d4twAir.ts`, replace existing imports with:

```ts
import type { BrowserContext } from 'playwright-core';
import { damagePerHit, FIREPOWER } from '../../tools/damageFormula.js';
import { deployWeapon, skinForDivision, getDeployInventory } from '../../tools/farm.js';
import { listMyCountryActiveBattles, isSideEmpty, type FarmableBattle } from '../../tools/battles.js';
import { loadInventory, resolveWeapon, type InventoryWeapon } from './inventory.js';
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
import {
  formatBattleFailureMessage,
  formatBattleSuccessMessage,
} from '../../util/battleNotification.js';
```

Keep `ENERGY_PER_HIT`, `MIN_DEPLOY_ENERGY`, `AIRCRAFT_WEAPON_TYPE` exports already added in Task 6. Add (or move) the `emptyResult` helper next to them:

```ts
function emptyResult(reason: string, stopReason: StopReason): FarmSessionResult {
  return {
    farmedCount: 0,
    wins: [],
    skipped: [{ battleId: 0, regionName: '', reason }],
    stopReason,
    fuelLeftAtEnd: null,
    poolEnergyAtEnd: null,
    totalTravelCC: 0,
    hops: 0,
    sequence: '(no hops)',
  };
}
```

- [ ] **Step 2: Implement `runD4twAir`**

Append to `src/farm/strategies/d4twAir.ts`:

```ts
async function runD4twAir(
  ctx: BrowserContext,
  info: FarmSessionInfo,
  options: FarmSessionOptions,
): Promise<FarmSessionResult> {
  const settings = loadSettings();
  const cfg = settings.d4twAir;

  // ── Pre-flight ──────────────────────────────────────────────────────────
  if (info.strength == null || info.airRankNumber == null) {
    const msg = 'd4tw-air: strength/airRank unavailable — skipping cycle';
    console.log(`[d4tw-air] ${msg}`);
    await Promise.resolve(options.notify?.(`⚠️ ${msg}`)).catch(() => undefined);
    return emptyResult(msg, 'no-candidates');
  }
  if (info.currentCountryId !== info.countryId) {
    const msg = `d4tw-air: not in native country (current=${info.currentCountryId}, native=${info.countryId}) — skipping`;
    console.log(`[d4tw-air] ${msg}`);
    return emptyResult(msg, 'no-candidates');
  }

  // ── Discovery ───────────────────────────────────────────────────────────
  const all: FarmableBattle[] = await listMyCountryActiveBattles(ctx, info.csrf, info.countryId);
  const d11 = all.filter((c) => c.division === 11);
  if (d11.length === 0) {
    const msg = `d4tw-air: no D11 native battles (country=${info.countryId})`;
    console.log(`[d4tw-air] ${msg}`);
    return emptyResult(msg, 'no-candidates');
  }
  const ordered = orderByPreferredSide(d11, info.countryId);

  // ── Weapon (reuse preloaded inventory when available) ───────────────────
  const inventory = options.preloadedInventory ?? (await loadInventory(ctx, info.csrf));
  const weapon = cfg.useWeapon
    ? resolveWeapon(inventory, cfg.weaponPriority, AIRCRAFT_WEAPON_TYPE)
    : { quality: -1, firepower: FIREPOWER.bare, amountOnHand: Number.POSITIVE_INFINITY };

  const dmgPerHit = damagePerHit(info.strength, info.airRankNumber, weapon.firepower);
  console.log(
    `[d4tw-air] weapon=${weapon.quality === -1 ? 'bare' : `Q${weapon.quality}`} ` +
      `fp=${weapon.firepower} dmg/hit=${Math.floor(dmgPerHit)} ammo=${weapon.amountOnHand === Number.POSITIVE_INFINITY ? '∞' : weapon.amountOnHand}`,
  );

  // ── Battle loop ─────────────────────────────────────────────────────────
  const cap = Math.min(cfg.maxBattlesPerSession, ordered.length);
  const wins: WinSummary[] = [];
  const skipped: SkipSummary[] = [];
  const stopReason: StopReason = 'completed';
  let lastFuel: number | null = null;
  let lastPoolEnergy: number | null = null;

  for (let i = 0; i < cap; i++) {
    const battle = ordered[i];
    const mySide: 'invader' | 'defender' =
      battle.invaderId === info.countryId ? 'invader' : 'defender';
    const targetDmg =
      mySide === 'invader' ? cfg.targetDamageAttacker : cfg.targetDamageDefender;

    // Empty side check (D11)
    const empty = await isSideEmpty(
      ctx,
      info.csrf,
      battle.battleId,
      11,
      battle.battleZoneId,
      battle.zoneId,
      mySide,
      battle.invaderId,
      battle.defenderId,
    ).catch((err: Error) => {
      console.log(`[d4tw-air] battle ${battle.battleId}: empty-check failed: ${err.message}`);
      return null;
    });
    if (empty === null) {
      skipped.push({ battleId: battle.battleId, regionName: battle.regionName, reason: 'empty-check failed' });
      continue;
    }
    if (!empty.isEmpty) {
      skipped.push({
        battleId: battle.battleId,
        regionName: battle.regionName,
        reason: `side ${mySide} not empty (dom=${empty.domination})`,
      });
      continue;
    }

    // Energy + ammo recompute with the real side
    const hitsNeeded = Math.ceil(targetDmg / dmgPerHit);
    const energyToSpend = Math.max(hitsNeeded * ENERGY_PER_HIT, MIN_DEPLOY_ENERGY);

    // Battlefield page navigation is REQUIRED before deploy fetch — see d4tw.ts comment.
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`https://www.erepublik.com/en/military/battlefield/${battle.battleId}`, {
      waitUntil: 'domcontentloaded',
    });

    const inv = await getDeployInventory(
      ctx,
      info.csrf,
      battle.battleId,
      info.countryId,
      battle.battleZoneId,
    );
    const poolEnergy = inv.poolEnergy ?? 0;
    lastPoolEnergy = poolEnergy;

    const ammoOk = weapon.amountOnHand === Number.POSITIVE_INFINITY || weapon.amountOnHand >= hitsNeeded;
    if (poolEnergy < energyToSpend || !ammoOk) {
      const msg =
        `need ${energyToSpend}e + ${hitsNeeded} ammo, have ${poolEnergy}e / ` +
        `${weapon.amountOnHand === Number.POSITIVE_INFINITY ? '∞' : weapon.amountOnHand} ammo`;
      console.log(`[d4tw-air] skipped battle ${battle.battleId} (${battle.regionName}) — ${msg}`);
      await Promise.resolve(
        options.notify?.(
          formatBattleFailureMessage(
            {
              battleId: battle.battleId,
              battleZoneId: battle.battleZoneId,
              regionName: battle.regionName,
              invaderCountryId: battle.invaderId,
              defenderCountryId: battle.defenderId,
              division: 11,
            },
            msg,
          ),
        ),
      ).catch(() => undefined);
      skipped.push({ battleId: battle.battleId, regionName: battle.regionName, reason: msg });
      continue;
    }

    console.log(
      `[d4tw-air] 🎯 #${battle.battleId} ${battle.regionName} (${mySide}) ` +
        `target=${targetDmg} hits=${hitsNeeded} energy=${energyToSpend}`,
    );

    const sideCountryId = mySide === 'invader' ? battle.invaderId : battle.defenderId;
    const otherCountryId = mySide === 'invader' ? battle.defenderId : battle.invaderId;
    const skin = inv.skinId ?? skinForDivision(11);

    if (options.dryRun) {
      console.log('[d4tw-air]    (dry-run — no POST)');
      const outcome: SideOutcome = {
        side: mySide,
        countryId: sideCountryId,
        attempts: 0,
        verified: false,
        fuelLeft: null,
        deploymentId: null,
      };
      const otherOutcome: SideOutcome = {
        side: mySide === 'invader' ? 'defender' : 'invader',
        countryId: otherCountryId,
        attempts: 0,
        verified: false,
        fuelLeft: null,
        deploymentId: null,
      };
      wins.push({
        battleId: battle.battleId,
        regionName: battle.regionName,
        inv: mySide === 'invader' ? outcome : otherOutcome,
        def: mySide === 'defender' ? outcome : otherOutcome,
      });
      continue;
    }

    const result = await deployWeapon(
      ctx,
      info.csrf,
      battle.battleId,
      battle.battleZoneId,
      sideCountryId,
      weapon.quality,
      energyToSpend,
      skin,
    );

    if (!result.success) {
      const msg = `deploy failed: ${result.message}`;
      console.log(`[d4tw-air]    ❌ ${msg}`);
      await Promise.resolve(
        options.notify?.(
          formatBattleFailureMessage(
            {
              battleId: battle.battleId,
              battleZoneId: battle.battleZoneId,
              regionName: battle.regionName,
              invaderCountryId: battle.invaderId,
              defenderCountryId: battle.defenderId,
              division: 11,
            },
            msg,
          ),
        ),
      ).catch(() => undefined);
      skipped.push({ battleId: battle.battleId, regionName: battle.regionName, reason: msg });
      continue;
    }

    if (result.fuelLeft != null) lastFuel = result.fuelLeft;
    console.log(`[d4tw-air]    ✅ deployed; fuel=${result.fuelLeft ?? '?'}`);

    const outcome: SideOutcome = {
      side: mySide,
      countryId: sideCountryId,
      attempts: 1,
      verified: true,
      fuelLeft: result.fuelLeft,
      deploymentId: result.deploymentId,
    };
    const otherOutcome: SideOutcome = {
      side: mySide === 'invader' ? 'defender' : 'invader',
      countryId: otherCountryId,
      attempts: 0,
      verified: false,
      fuelLeft: null,
      deploymentId: null,
    };
    wins.push({
      battleId: battle.battleId,
      regionName: battle.regionName,
      inv: mySide === 'invader' ? outcome : otherOutcome,
      def: mySide === 'defender' ? outcome : otherOutcome,
    });
    await Promise.resolve(
      options.notify?.(
        formatBattleSuccessMessage({
          battleId: battle.battleId,
          battleZoneId: battle.battleZoneId,
          regionName: battle.regionName,
          invaderCountryId: battle.invaderId,
          defenderCountryId: battle.defenderId,
          division: 11,
        }),
      ),
    ).catch(() => undefined);
  }

  return {
    farmedCount: wins.length,
    wins,
    skipped,
    stopReason,
    fuelLeftAtEnd: lastFuel,
    poolEnergyAtEnd: lastPoolEnergy,
    totalTravelCC: 0,
    hops: wins.length,
    sequence: wins.length > 0 ? `d4tw-air×${wins.length}` : '(no hops)',
  };
}

export const d4twAirStrategy: FarmStrategy = {
  id: 'd4tw-air',
  run: runD4twAir,
};
```

- [ ] **Step 3: Register the strategy**

In `src/farm/strategies/index.ts`:

Add the import:

```ts
import { d4twAirStrategy } from './d4twAir.js';
```

Add the registry entry:

```ts
const registry: Partial<Record<StrategyId, FarmStrategy>> = {
  standard: standardStrategy,
  d4tw: d4twStrategy,
  maverickD3: maverickD3Strategy,
  'd4tw-air': d4twAirStrategy,
};
```

Re-export at the bottom:

```ts
export { d4twAirStrategy } from './d4twAir.js';
```

- [ ] **Step 4: Typecheck and run tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/farm/strategies/d4twAir.ts src/farm/strategies/index.ts
git commit -m "feat(d4tw-air): implement runD4twAir and register strategy"
```

---

## Task 10: Add `travelToCountry` helper (TDD)

**Files:**
- Modify: `src/tools/travel.ts`
- Create: `src/tools/travel.test.ts` (if missing — confirm first)

- [ ] **Step 1: Check whether tests already exist**

Run: `ls src/tools/travel.test.ts 2>/dev/null || echo "missing"`

If missing, create the file with imports + a basic existing-test skeleton (copy a small example from another `*.test.ts` for vitest mock setup). If present, append to it.

- [ ] **Step 2: Write failing tests**

```ts
import { describe, it, expect, vi } from 'vitest';
import { travelToCountry } from './travel.js';

// Helpers: build a fake BrowserContext that lets apiCall reach a mocked fetcher.
// In this codebase, apiCall is imported from '../transport/apiCall.js'; the
// easiest mocking is via `vi.mock`. See an existing strategy test for the
// established pattern, e.g. src/farm/strategies/standard.test.ts (if present)
// or the test in fuelBudget.

vi.mock('../transport/apiCall.js', () => ({
  apiCall: vi.fn(),
}));

import { apiCall } from '../transport/apiCall.js';
const apiCallMock = vi.mocked(apiCall);

const ctx = {} as never;
const csrf = 'test-csrf';

describe('travelToCountry', () => {
  beforeEach(() => apiCallMock.mockReset());

  it('returns success when cheapest region is within budget and travel succeeds', async () => {
    apiCallMock
      .mockResolvedValueOnce({
        body: {
          countries: { '71': { regions: [501, 502] } },
          regions: {
            '501': { id: 501, cost: 50 },
            '502': { id: 502, cost: 20 },
          },
        },
      } as never)
      .mockResolvedValueOnce({ body: { error: 0, message: 'success' } } as never);

    const r = await travelToCountry(ctx, csrf, 71, 999, 100);

    expect(r.attempted).toBe(true);
    expect(r.success).toBe(true);
    expect(r.costCC).toBe(20);
    expect(r.regionId).toBe(502);
  });

  it('rejects when cheapest cost exceeds maxCC', async () => {
    apiCallMock.mockResolvedValueOnce({
      body: {
        countries: { '71': { regions: [501] } },
        regions: { '501': { id: 501, cost: 600 } },
      },
    } as never);

    const r = await travelToCountry(ctx, csrf, 71, 999, 500);

    expect(r.attempted).toBe(false);
    expect(r.success).toBe(false);
    expect(r.costCC).toBe(600);
    expect(r.message).toMatch(/600.+500/);
    // Travel POST should not have been called
    expect(apiCallMock).toHaveBeenCalledTimes(1);
  });

  it('reports no reachable region when target country has none', async () => {
    apiCallMock.mockResolvedValueOnce({
      body: {
        countries: {},
        regions: {},
      },
    } as never);

    const r = await travelToCountry(ctx, csrf, 71, 999, 500);

    expect(r.attempted).toBe(false);
    expect(r.success).toBe(false);
    expect(r.regionId).toBeNull();
    expect(r.message).toMatch(/no reachable region/);
  });

  it('reports failure when travel POST returns error != 0', async () => {
    apiCallMock
      .mockResolvedValueOnce({
        body: {
          countries: { '71': { regions: [501] } },
          regions: { '501': { id: 501, cost: 30 } },
        },
      } as never)
      .mockResolvedValueOnce({ body: { error: 1, message: 'not enough currency' } } as never);

    const r = await travelToCountry(ctx, csrf, 71, 999, 500);

    expect(r.attempted).toBe(true);
    expect(r.success).toBe(false);
    expect(r.message).toBe('not enough currency');
  });
});
```

- [ ] **Step 3: Run tests — expect failure**

Run: `npx vitest run src/tools/travel.test.ts`
Expected: FAIL — `travelToCountry` is not exported.

- [ ] **Step 4: Implement `travelToCountry`**

Append to `src/tools/travel.ts`:

```ts
interface RawTravelDataCountriesResponse {
  countries?: Record<string, { regions?: number[] }>;
  regions?: Record<string, { id: number; cost: number }>;
}

export interface TravelToCountryResult {
  /** True if /main/travel was POSTed (false → rejected by guard, no side-effect). */
  attempted: boolean;
  /** True when /main/travel returned `error: 0`. */
  success: boolean;
  /** Cost (local CC) of the cheapest region in target country, when known. */
  costCC: number | null;
  /** Cheapest region selected (null when none reachable). */
  regionId: number | null;
  /** Server message or local rejection reason. */
  message: string;
}

/**
 * Travel to the cheapest entry region of a target country. Used by the
 * d4tw-air strategy to return to native country when farming-eligible
 * battles exist abroad. Unlike `travelHome`, the destination is the country
 * (not the citizen's residence), since residence may be outside native.
 *
 * Issues two POSTs: `/main/travelData` to discover region costs, then
 * `/main/travel` to perform the move. The travel-data form mirrors the
 * shape used by `travelHome` (battleId=0, holdingId=0).
 */
export async function travelToCountry(
  ctx: BrowserContext,
  csrf: string,
  toCountryId: number,
  fromRegionId: number,
  maxCC: number,
): Promise<TravelToCountryResult> {
  // 1. Discover cheapest region in target country
  const { body: data } = await apiCall<RawTravelDataCountriesResponse>(ctx, {
    method: 'POST',
    path: '/en/main/travelData',
    csrf,
    form: { holdingId: 0, battleId: 0, regionId: fromRegionId },
  });
  const country = data.countries?.[String(toCountryId)];
  if (!country?.regions?.length) {
    return {
      attempted: false,
      success: false,
      costCC: null,
      regionId: null,
      message: 'no reachable region',
    };
  }
  let best: { regionId: number; cost: number } | null = null;
  for (const rid of country.regions) {
    const r = data.regions?.[String(rid)];
    if (!r) continue;
    if (!best || r.cost < best.cost) best = { regionId: r.id, cost: r.cost };
  }
  if (!best) {
    return {
      attempted: false,
      success: false,
      costCC: null,
      regionId: null,
      message: 'no reachable region',
    };
  }
  if (best.cost > maxCC) {
    return {
      attempted: false,
      success: false,
      costCC: best.cost,
      regionId: best.regionId,
      message: `cost ${best.cost}cc exceeds budget ${maxCC}cc`,
    };
  }

  // 2. Travel
  const { body } = await apiCall<RawTravelResponse>(ctx, {
    method: 'POST',
    path: '/en/main/travel',
    csrf,
    form: {
      check: 'moveAction',
      travelMethod: 'preferCurrency',
      inRegionId: best.regionId,
      toCountryId,
    },
  });
  return {
    attempted: true,
    success: body.error === 0,
    costCC: best.cost,
    regionId: best.regionId,
    message: body.message ?? '',
  };
}
```

- [ ] **Step 5: Verify tests pass**

Run: `npx vitest run src/tools/travel.test.ts`
Expected: PASS.

- [ ] **Step 6: Run all tests + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/travel.ts src/tools/travel.test.ts
git commit -m "feat(travel): add travelToCountry helper for non-residence destinations"
```

---

## Task 11: Wire the d4tw-air branch into the runner

**Files:**
- Modify: `src/agent/runner.ts`

This is the largest single edit. Take it step by step.

- [ ] **Step 1: Add imports**

At the top of `src/agent/runner.ts`, add:

```ts
import { listMyCountryActiveBattles } from '../tools/battles.js';
import { loadInventory, resolveWeapon } from '../farm/strategies/inventory.js';
import { estimateMinEnergy, AIRCRAFT_WEAPON_TYPE } from '../farm/strategies/d4twAir.js';
import { travelToCountry } from '../tools/travel.js';
import type { InventoryWeapon } from '../tools/pickWeapon.js';
```

- [ ] **Step 2: Update the FarmSessionInfo construction**

Already done partially in Task 3 — verify the call site at ~line 419–432 now reads `airRankNumber: ctxInfo.airRankNumber,`. Should not need another change.

- [ ] **Step 3: Restructure the farm-gate branch**

Locate the block starting at `const decision = settings.farmEnabled ? decideFarming({` (~line 374). Replace the entire block up to (but not including) `if (decision.shouldFarm && ...)` with:

```ts
    // Resolve mode early so we can branch the gate inputs for d4tw-air.
    const mode = settings.farmEnabled && ctxInfo.division != null
      ? effectiveMode(
          { modeOverride: settings.modeOverride, maverickManual: settings.maverickManual },
          { division: ctxInfo.division, hasMaverick: ctxInfo.hasMaverick },
        )
      : null;

    // d4tw-air requires real inventory + air rank to estimate per-cycle cost.
    let minEnergyPerBattle: number | undefined;
    let preloadedInventory: InventoryWeapon[] | undefined;
    if (mode === 'd4tw-air') {
      try {
        preloadedInventory = await loadInventory(ctx, csrf);
      } catch (err) {
        console.warn(`[cycle] d4tw-air: loadInventory failed: ${(err as Error).message}`);
        preloadedInventory = undefined;
      }
      if (preloadedInventory && ctxInfo.strength != null && ctxInfo.airRankNumber != null) {
        minEnergyPerBattle = estimateMinEnergy(
          { strength: ctxInfo.strength, airRankNumber: ctxInfo.airRankNumber },
          settings.d4twAir,
          preloadedInventory,
        );
      }
    }

    // Abroad pre-flight for d4tw-air: travel home if we have a battle to
    // fight + enough energy + ammo. Otherwise, leave abroad and let the
    // idle-branch return-home (`awaySince`-driven) handle it.
    if (
      mode === 'd4tw-air' &&
      ctxInfo.currentCountryId !== countryId &&
      preloadedInventory != null &&
      ctxInfo.strength != null &&
      ctxInfo.airRankNumber != null &&
      ctxInfo.currentRegionId != null
    ) {
      try {
        const allNative = await listMyCountryActiveBattles(ctx, csrf, countryId).catch(() => [] as never[]);
        const d11native = allNative.filter((b) => b.division === 11);
        const cfg = settings.d4twAir;

        const hasEnergy =
          minEnergyPerBattle != null && (ctxInfo.energy ?? 0) >= minEnergyPerBattle;
        const hasAmmo =
          !cfg.useWeapon ||
          resolveWeapon(preloadedInventory, cfg.weaponPriority, AIRCRAFT_WEAPON_TYPE).amountOnHand > 0;

        if (d11native.length > 0 && hasEnergy && hasAmmo) {
          const t = await travelToCountry(
            ctx,
            csrf,
            countryId,
            ctxInfo.currentRegionId,
            settings.travel.returnHomeMaxCC,
          );
          if (t.success) {
            console.log(`[cycle] d4tw-air: traveled to native (cost=${t.costCC}cc)`);
            await notifier.send(`🛫 traveled home (${t.costCC}cc) to fight D11 medal`);
            // Refresh context — currentCountryId/region/CSRF changed
            ctxInfo = await extractCitizenContext(ctx, { refresh: true });
            // csrf is captured earlier in the cycle; refresh it from new context
            csrf = ctxInfo.csrf ?? csrf;
            state.awaySince = null;
          } else {
            console.log(`[cycle] d4tw-air: cannot travel home — ${t.message}`);
            await notifier.send(`⚠️ d4tw-air: cannot travel home — ${t.message}`);
          }
        }
      } catch (err) {
        console.warn(`[cycle] d4tw-air abroad pre-flight threw: ${(err as Error).message}`);
      }
    }

    const decision = settings.farmEnabled
      ? decideFarming({
          weekly: fuel,
          poolEnergy: ctxInfo.energy ?? 0,
          fuelInInventory: fuelAtCycleStart,
          maxBattlesPerSession: settings.emptyDiv.maxBattlesPerSession,
          minEnergyPerBattle,
        })
      : {
          shouldFarm: false as const,
          reason: 'disabled via settings.farmEnabled',
          battlesThisSession: 0,
          diagnostics: {
            target: 0,
            spent: fuel.spent,
            ahead: 0,
            remaining: 0,
            weekFraction: 0,
          },
        };
    lastDecisionReason = decision.reason;
    lastWeekFuelTarget = Math.floor(70 * decision.diagnostics.weekFraction);
    console.log(
      `[cycle] farm: ${decision.shouldFarm ? '✅' : '⏭'} ${decision.reason} ` +
        `(week=${decision.diagnostics.weekFraction.toFixed(3)})`,
    );
```

- [ ] **Step 4: Update the `decision.shouldFarm` branch to use the pre-resolved `mode` and pass `preloadedInventory`**

The existing block already recomputes `mode = effectiveMode(...)` inline. Remove that and use the outer `mode` variable. Update the `getStrategy(mode).run(...)` call's third arg to pass `preloadedInventory`. Around line 408–432:

```ts
    if (
      decision.shouldFarm &&
      mode != null &&
      ctxInfo.division != null &&
      ctxInfo.citizenId != null &&
      ctxInfo.residenceRegionId != null
    ) {
      const residenceCountryId = ctxInfo.residenceCountryId ?? countryId;
      try {
        if (lastMode !== null && lastMode !== mode) {
          appendHistory({ type: 'mode', from: lastMode, to: mode });
        }
        lastMode = mode;
        console.log(`[cycle] strategy: ${mode}`);
        const result = await getStrategy(mode).run(
          ctx,
          {
            csrf,
            citizenId: ctxInfo.citizenId,
            countryId,
            division: ctxInfo.division,
            residenceRegionId: ctxInfo.residenceRegionId,
            residenceCountryId,
            strength: ctxInfo.strength,
            rankNumber: ctxInfo.rankNumber,
            airRankNumber: ctxInfo.airRankNumber,
            hasMaverick: ctxInfo.hasMaverick,
            currentCountryId: ctxInfo.currentCountryId,
          },
          {
            maxBattles: decision.battlesThisSession,
            notify: (m) => notifier.send(m),
            preloadedInventory,
          },
        );
        // ... existing bookkeeping (fuel.spent, hitsLanded, etc.) unchanged
```

(Keep the rest of the block — `fuel.spent += consumed`, `appendHistory({ type: 'battle' ... })`, etc. — as-is.)

- [ ] **Step 5: Patch `csrf` mutability**

`csrf` is currently `const` in runCycle. The abroad pre-flight may refresh context, which yields a new CSRF. Change the `const` to `let` where it's declared (search for `const csrf = ` at top of `runCycle` and change to `let`).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If `ctxInfo` is `const`, change it to `let` similarly.

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: PASS (no runner unit-tests should regress — the runner is only exercised via integration today).

- [ ] **Step 8: Commit**

```bash
git add src/agent/runner.ts
git commit -m "feat(runner): wire d4tw-air mode (preflight inventory, abroad travel-home, gate hint)"
```

---

## Task 12: UI — dropdown option + settings panel

**Files:**
- Modify: `src/ui/public/index.html`
- Modify: `src/ui/public/app.js`
- Modify: `src/ui/snapshot.ts` (or wherever the snapshot is assembled) — surface `detected.airRankNumber`

- [ ] **Step 1: Add the dropdown option**

In `src/ui/public/index.html`, find the strategy `<select>` (the line with `<option value="d4tw">D4-TW (native, hit to target)</option>` is around line 39). Add immediately after:

```html
<option value="d4tw-air">D4 TW (air, low-strength medals)</option>
```

- [ ] **Step 2: Add the settings panel**

Place this panel after the existing `d4tw` panel (after the line `<code id="d4tw-weapons" class="bg-white border rounded px-2 py-1">—</code>` and its closing markup):

```html
<details class="border rounded p-3">
  <summary class="cursor-pointer font-medium">D4 TW (air) settings</summary>
  <div class="mt-3 grid gap-3">
    <label class="flex items-center gap-2">
      Target damage — attacker
      <input id="d4twAir-attacker" type="number" min="1" step="1000" class="border rounded px-2 py-1">
    </label>
    <label class="flex items-center gap-2">
      Target damage — defender
      <input id="d4twAir-defender" type="number" min="1" step="1000" class="border rounded px-2 py-1">
    </label>
    <label class="flex items-center gap-2">
      Max battles per session
      <input id="d4twAir-maxBattles" type="number" min="1" max="10" class="border rounded px-2 py-1">
    </label>
    <label class="flex items-center gap-2">
      <input id="d4twAir-useWeapon" type="checkbox">
      Use aircraft weapon (Q5→Q1 priority)
    </label>
    <div class="text-sm text-gray-600">
      Weapon priority: <code id="d4twAir-weapons" class="bg-white border rounded px-2 py-1">[5,4,3,2,1]</code>
    </div>
    <div class="text-sm text-gray-600">
      Aircraft rank: <span id="detected-airRank">—</span>
    </div>
  </div>
</details>
```

- [ ] **Step 3: Bind the inputs in app.js**

The file uses `document.getElementById(...)` + `scheduleSave((s) => { s.X = ... })` for change-handlers, and `renderSettingsForm(s)` writes element values from `s`. Follow that idiom exactly.

In `bindControls()` (after the `d4tw-maxBattles` binding at ~line 186), add:

```js
  const aAtt = document.getElementById('d4twAir-attacker');
  if (aAtt)
    aAtt.addEventListener('change', (e) =>
      scheduleSave((s) => {
        s.d4twAir = s.d4twAir || {};
        s.d4twAir.targetDamageAttacker = Number(e.target.value);
      }),
    );
  const aDef = document.getElementById('d4twAir-defender');
  if (aDef)
    aDef.addEventListener('change', (e) =>
      scheduleSave((s) => {
        s.d4twAir = s.d4twAir || {};
        s.d4twAir.targetDamageDefender = Number(e.target.value);
      }),
    );
  const aMaxB = document.getElementById('d4twAir-maxBattles');
  if (aMaxB)
    aMaxB.addEventListener('change', (e) =>
      scheduleSave((s) => {
        s.d4twAir = s.d4twAir || {};
        s.d4twAir.maxBattlesPerSession = Number(e.target.value);
      }),
    );
  const aUseW = document.getElementById('d4twAir-useWeapon');
  if (aUseW)
    aUseW.addEventListener('change', (e) =>
      scheduleSave((s) => {
        s.d4twAir = s.d4twAir || {};
        s.d4twAir.useWeapon = !!e.target.checked;
      }),
    );
```

In `renderSettingsForm(s)` (after the `d4tw-weapons` line at ~line 250–251), add:

```js
  const aAttE = document.getElementById('d4twAir-attacker');
  if (aAttE && document.activeElement !== aAttE)
    aAttE.value = String(s.d4twAir?.targetDamageAttacker ?? 30000);
  const aDefE = document.getElementById('d4twAir-defender');
  if (aDefE && document.activeElement !== aDefE)
    aDefE.value = String(s.d4twAir?.targetDamageDefender ?? 50000);
  const aMaxBE = document.getElementById('d4twAir-maxBattles');
  if (aMaxBE && document.activeElement !== aMaxBE)
    aMaxBE.value = String(s.d4twAir?.maxBattlesPerSession ?? 1);
  const aUseWE = document.getElementById('d4twAir-useWeapon');
  if (aUseWE && document.activeElement !== aUseWE)
    aUseWE.checked = !!s.d4twAir?.useWeapon;
  const aWeapons = document.getElementById('d4twAir-weapons');
  if (aWeapons) aWeapons.textContent = JSON.stringify(s.d4twAir?.weaponPriority ?? [5, 4, 3, 2, 1]);
  const airRank = document.getElementById('detected-airRank');
  if (airRank) airRank.textContent = s.detected?.airRankNumber != null ? String(s.detected.airRankNumber) : '—';
```

- [ ] **Step 4: Surface `airRankNumber` in the UiSnapshot**

In `src/ui/snapshot.ts` (or whichever module assembles the snapshot — grep for `detected:` to locate), ensure the `detected` block in the snapshot now includes `airRankNumber`. If the snapshot currently writes:

```ts
detected: { division, hasMaverick, citizenId, countryId, lastUpdated }
```

Update to:

```ts
detected: { division, hasMaverick, airRankNumber, citizenId, countryId, lastUpdated }
```

Look at where `detected` is mutated in `runner.ts` (search for `detected.division =` or similar) and add `detected.airRankNumber = ctxInfo.airRankNumber;` next to it. Persist via the same `saveSettings()` call.

- [ ] **Step 5: Smoke-test the UI manually**

Run: `npm start`

In a browser at `http://localhost:$PORT`, open the dashboard. Confirm:
- "D4 TW (air, low-strength medals)" is in the dropdown.
- The new panel renders with default values (30000 / 50000 / 1 / unchecked / [5,4,3,2,1]).
- Editing a value and clicking Save (or however the UI commits) updates `config/settings.json`.
- The runner log shows `[cycle] strategy: d4tw-air` after selecting it as `modeOverride`.

- [ ] **Step 6: Commit**

```bash
git add src/ui/public/index.html src/ui/public/app.js src/ui/snapshot.ts src/agent/runner.ts
git commit -m "feat(ui): d4tw-air panel and airRankNumber in snapshot"
```

---

## Task 13: Manual verification on a real account

**Files:** none — operator-driven QA pass.

- [ ] **Step 1: Run the full test suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Set modeOverride and run one cycle**

1. Edit `config/settings.json`: set `modeOverride` to `"d4tw-air"` and adjust `d4twAir.targetDamageAttacker` / `targetDamageDefender` if desired.
2. Run: `HEADED=true npm run agent` — single-cycle, headed for inspection.
3. Watch the log and the browser. Expected outcomes:

| Account state | Expected log |
|---|---|
| In native, with active D11 invader battle, empty side, energy sufficient | `[d4tw-air] 🎯 #... target=30000 hits=N energy=M` then `✅ deployed` |
| In native, all D11 sides not empty | `[d4tw-air] skipped battle ...` for each |
| In native, no D11 battles | `[d4tw-air] no D11 native battles` |
| Abroad, D11 battles + energy ok | `[cycle] d4tw-air: traveled to native (cost=Xcc)` + Telegram `🛫 traveled home` + then battle log |
| Abroad, D11 battles but `cost > maxCC` | Telegram `⚠️ d4tw-air: cannot travel home — cost Ycc exceeds budget Zcc` |
| Strength or airRank null (profile fetch failed) | `[d4tw-air] strength/airRank unavailable` |

- [ ] **Step 3: Spot-check the Telegram messages**

Confirm the success-battle URL deep-links to `https://www.erepublik.com/en/military/battlefield/{battleId}/{battleZoneId}` and lands on the D11 zone. Compare against the same battleId opened via the eRepublik UI manually.

- [ ] **Step 4: Document the manual checks**

If anything in §0 (aircraft rank field name, aircraft weapon type string) turned out different from what's hardcoded, edit the relevant file (`session.ts` or `d4twAir.ts:AIRCRAFT_WEAPON_TYPE`) and commit a fix:

```bash
git commit -am "fix(d4tw-air): correct {fieldName} after live API verification"
```

- [ ] **Step 5: Final commit (if any pending changes)**

```bash
git status
# If anything is pending, commit with a descriptive message.
```

---

## Self-review checklist for the implementer

After all tasks are done:

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `git log --oneline` shows one logical commit per task (Tasks 1–12)
- [ ] `config/settings.json` for an account that has never seen this feature still parses (Zod fills defaults)
- [ ] Switching `modeOverride` between `d4tw`, `d4tw-air`, `standard` in the UI changes runner behavior on the next cycle (logs reflect the active mode)
- [ ] Telegram emits one message per successful d4tw-air deploy
- [ ] Telegram emits one message per d4tw-air travel-home event (success or rejection)

---

## Spec coverage check

Each spec section maps to at least one task:

| Spec section | Tasks |
|---|---|
| §3.2 File layout (inventory.ts) | Task 2 |
| §4 Settings schema | Task 5 |
| §5 Aircraft rank extraction | Task 4 (+ §0a verification) |
| §6 Damage → energy estimation | Task 6 |
| §7 Fuel-gate change | Task 8 |
| §8 Runner integration + travelToCountry | Tasks 10, 11 |
| §9 Strategy implementation | Tasks 7, 9 |
| §10 UI | Task 12 |
| §11 Notifications | Tasks 9, 11 (via existing formatBattle*Message) |
| §12 Testing | Tasks 1, 5, 6, 7, 8, 10 (TDD inline) |
| §13 Error handling | Tasks 9, 11 (defensive returns) |
| §14 Migration / backwards compat | Task 5 (Zod-test for old settings.json) |
| §16 TODOs | §0a, §0b, Task 13 |
| `pickWeapon` parameterised (new finding) | Task 1 |
