# D4-TW Air Medal Strategy — Design

**Status:** Draft, awaiting user review
**Date:** 2026-05-19
**Author:** brainstorm session with the operator

## 1. Goal

Add a new farming strategy targeting **native D4 accounts with low strength (<350k)** that want
to farm gold via cheap **Battle Hero medals in Division 11 (air)** battles inside their native
country.

The existing `d4tw` strategy assumes a strong account capable of pouring 130M+ damage per medal.
For low-strength accounts that's impractical: 30k–50k damage in D11 is achievable in 1–3 hits
and yields the same 2 gold per medal.

## 2. Game-mechanic context

- **Air battles** all happen in Division 11, parallel to ground D1–D4. Anyone with an aircraft
  rank can deploy.
- **Battle Hero medal** is awarded to the player with highest damage per round, per division.
  2 gold per medal.
- **Ping-pong (TW) dynamics:** in training-war battles between allied countries, the attacking
  country is expected to lose the round by design. A round is therefore the "losing" side for
  whichever country is currently `invaderId`.
- **Damage formula** (from `Military_Formulas.md`):
  `D = 10 × (1 + S/400) × (1 + R/5) × (1 + FP/100)`
  where R is *aircraft* rank for D11 (not military rank). Boosters / natural enemy bonuses
  are excluded from the base formula — so target thresholds should be set with headroom.
- **Aircraft weapons** exist only at quality Q1..Q5 (Q6/Q7 are ground-only). Players also
  deploy bare-handed (FP=0) in D11.
- **Fuel cost:** each deploy consumes 1 vehicle fuel barrel from inventory, regardless of
  damage poured.

## 3. Design overview

**New strategy `d4tw-air`** — mirror of `d4tw` in structure, but:
- Filters battles to `division === 11` (not `info.division`).
- Uses aircraft rank, not military rank.
- Orders candidates: native=invader (losing side) first; native=defender (fallback) second.
- Configurable per-side damage targets (default 30k attacker, 50k defender).
- Optional aircraft weapon (UI checkbox); priority `[5,4,3,2,1]` when on.

Existing strategies (`standard`, `d4tw`, `maverickD3`) are untouched.

### 3.1 Strategy resolution

**No changes** to `autoMode`. The new strategy is reachable only via explicit
`settings.modeOverride = 'd4tw-air'` in the UI. This keeps existing users on the
`d4tw` auto-resolution they already rely on.

### 3.2 File layout

| File | Change |
|---|---|
| `src/farm/strategies/d4twAir.ts` | NEW — strategy implementation |
| `src/farm/strategies/d4twAir.test.ts` | NEW — unit tests for `estimateMinEnergy` + ordering |
| `src/farm/strategies/inventory.ts` | NEW — extract `loadInventory` and `resolveWeapon` from `d4tw.ts` (now private there) into a shared module; both `d4tw.ts` and `d4twAir.ts` import from here, and so does `runner.ts` |
| `src/farm/strategies/d4tw.ts` | EDIT — replace private `loadInventory` / `resolveWeapon` with imports from `./inventory.js` (no behavior change) |
| `src/farm/strategies/types.ts` | EDIT — `StrategyId` += `'d4tw-air'`; `FarmSessionInfo.airRankNumber: number \| null`; `FarmSessionOptions.preloadedInventory?: InventoryWeapon[]` |
| `src/farm/strategies/index.ts` | EDIT — register `d4twAirStrategy` |
| `src/agent/fuelBudget.ts` | EDIT — `decideFarming` accepts optional `minEnergyPerBattle` |
| `src/agent/fuelBudget.test.ts` | EDIT — coverage for `minEnergyPerBattle` override |
| `src/agent/runner.ts` | EDIT — `d4tw-air` branch: load inventory, estimate min energy, abroad pre-flight + auto travel-home |
| `src/browser/session.ts` | EDIT — extract `airRankNumber` from citizen profile JSON |
| `src/tools/travel.ts` | EDIT — add `travelToCountry(ctx, csrf, toCountryId, maxCC)` helper |
| `src/ui/settingsStore.ts` | EDIT — `Settings.d4twAir` block + `StrategyId` enum + `detected.airRankNumber` |
| `src/ui/public/index.html` | EDIT — new `<details>` panel + dropdown option |
| `src/ui/public/app.js` | EDIT — bind/load/save the new fields |
| `src/ui/snapshot.ts` (or equivalent) | EDIT — propagate `detected.airRankNumber` |

No changes to `daily-state-*.json`, `weekly-fuel-state.json`, allow-list, or any other
strategy's code paths.

## 4. Settings schema

Extend `Settings` (Zod) in `src/ui/settingsStore.ts`:

```ts
const StrategyId = z.enum(['standard', 'd4tw', 'maverickD3', 'd4tw-air']);

const D4TWAirSettings = z.object({
  targetDamageAttacker: z.number().int().positive().default(30_000),
  targetDamageDefender: z.number().int().positive().default(50_000),
  maxBattlesPerSession: z.number().int().min(1).max(10).default(1),
  useWeapon: z.boolean().default(false),
  weaponPriority: z.array(z.number().int().min(1).max(5)).default([5, 4, 3, 2, 1]),
});

// inside Settings:
d4twAir: D4TWAirSettings.default(() => ({
  targetDamageAttacker: 30_000,
  targetDamageDefender: 50_000,
  maxBattlesPerSession: 1,
  useWeapon: false,
  weaponPriority: [5, 4, 3, 2, 1],
})),
```

Extend `DetectedState` with `airRankNumber: z.number().int().nullable().default(null)`.

**.env seeding:** not added — d4tw-air is UI-only configurable. Future env vars can be added
if needed.

**Backwards compat:** existing `settings.json` files without `d4twAir` get the default block
from Zod. Existing `modeOverride` values continue to work.

## 5. Aircraft rank extraction

In `src/browser/session.ts`, inside the `citizen-profile-json-personal` fetch block:

```ts
const airRankNumber =
  typeof milData?.airRankNumber === 'number' ? milData.airRankNumber : null;
```

**TODO for implementer:** the exact JSON field name is unconfirmed. KB calls it
`air_rank_number`. The existing code uses the camelCase `rankNumber` (which suggests the
JSON delivers camelCase). Before merging, the implementer must run one real request to
`/main/citizen-profile-json-personal/{citizenId}` and confirm the actual key path
(`airRankNumber` vs `air_rank_number` vs nested under `aircraftData` or similar). If null,
strategy gracefully skips with `'strength/airRank unavailable'`.

Propagate the value through `CtxInfo`, then into `FarmSessionInfo.airRankNumber`.

## 6. Damage → energy estimation

New pure helper exported from `d4twAir.ts`:

```ts
const ENERGY_PER_HIT = 10;
const MIN_DEPLOY_ENERGY = 30;

export function estimateMinEnergy(
  info: { strength: number | null; airRankNumber: number | null },
  cfg: { targetDamageAttacker: number; useWeapon: boolean; weaponPriority: number[] },
  inventory: InventoryWeapon[],
): number {
  if (info.strength == null || info.airRankNumber == null) return MIN_DEPLOY_ENERGY;

  // estimate is for the OPTIMISTIC (invader / losing) side — gate only blocks
  // when even the cheapest target won't fit. The strategy re-checks per battle.
  const target = cfg.targetDamageAttacker;

  const fp = cfg.useWeapon
    ? resolveWeapon(inventory, cfg.weaponPriority).firepower   // always defined; bare fallback is internal to resolveWeapon
    : FIREPOWER.bare;

  const dmg = damagePerHit(info.strength, info.airRankNumber, fp);
  if (dmg <= 0) return MIN_DEPLOY_ENERGY;

  const hits = Math.ceil(target / dmg);
  return Math.max(hits * ENERGY_PER_HIT, MIN_DEPLOY_ENERGY);
}
```

Re-uses existing `damagePerHit` (`src/tools/damageFormula.ts`), `FIREPOWER` constants,
`resolveWeapon`. The same calculation is performed *again* per-battle inside the strategy
with the actual `mySide` and a fresh `getDeployInventory.poolEnergy` — that is the
authoritative pre-deploy check.

## 7. Fuel-gate change

`src/agent/fuelBudget.ts` — single optional field:

```ts
export interface FarmInputs {
  // ... existing fields
  minEnergyPerBattle?: number;   // default = ENERGY_PER_BATTLE (66)
}

// inside decideFarming:
const minEnergy = inputs.minEnergyPerBattle ?? ENERGY_PER_BATTLE;
if (inputs.poolEnergy < minEnergy) {
  return no(`pool energy ${inputs.poolEnergy} < ${minEnergy} (one battle)`);
}
```

Other strategies don't pass the field → default 66 stays. Behavior for `standard`, `d4tw`,
`maverickD3` is unchanged.

## 8. Runner integration

In the farm-gate branch of `runCycle` (`src/agent/runner.ts`), introduce a `d4tw-air` block
**before** `decideFarming`:

```ts
const mode = effectiveMode(settings, detected);

let minEnergyPerBattle: number | undefined;
let preloadedInventory: InventoryWeapon[] | undefined;

if (mode === 'd4tw-air') {
  // Always load real inventory + use real pool energy. Optimistic estimates risk
  // wasted fuel barrels if the actual weapon FP is lower than assumed.
  preloadedInventory = await loadInventory(ctx, info.csrf).catch(() => undefined);
  if (preloadedInventory && info.strength != null && info.airRankNumber != null) {
    minEnergyPerBattle = estimateMinEnergy(info, settings.d4twAir, preloadedInventory);
  }

  // Pre-flight: if abroad but eligible battles + resources exist, travel home first.
  const abroad = info.currentCountryId !== info.countryId;
  if (abroad && preloadedInventory && info.strength != null && info.airRankNumber != null) {
    const allNative = await listMyCountryActiveBattles(ctx, info.csrf, info.countryId).catch(() => []);
    const d11 = allNative.filter((b) => b.division === 11);

    if (d11.length > 0) {
      const cfg = settings.d4twAir;
      const hasEnergy = (info.energy ?? 0) >= (minEnergyPerBattle ?? Infinity);
      const hasAmmo = !cfg.useWeapon
        || resolveWeapon(preloadedInventory, cfg.weaponPriority).amountOnHand > 0;

      if (hasEnergy && hasAmmo) {
        const traveled = await travelToCountry(
          ctx, info.csrf, info.countryId, settings.travel.returnHomeMaxCC,
        );
        if (traveled.ok) {
          await notify(`🛫 traveled home (${traveled.cost}cc) to fight D11 medal`);
          info = await extractCitizenContext({ refresh: true });   // CSRF + currentCountryId refresh
        } else {
          await notify(`⚠️ d4tw-air: cannot travel home — ${traveled.reason}`);
          // fall through; strategy's own currentCountryId guard will skip the cycle
        }
      }
      // else: !hasEnergy || !hasAmmo → leave abroad; existing idle-branch travelHome
      // (awaySince-driven) will eventually move the citizen.
    }
  }
}

const decision = decideFarming({
  weekly: fuel,
  poolEnergy: info.energy ?? 0,
  fuelInInventory,
  maxBattlesPerSession: settings.emptyDiv.maxBattlesPerSession,
  minEnergyPerBattle,
});

if (decision.shouldFarm) {
  const strategy = getStrategy(mode);
  const result = await strategy.run(ctx, info, {
    ...baseOpts,
    preloadedInventory,
  });
  // ... existing fuel.spent / hitsLanded / lastFarmedAt bookkeeping
}
```

### 8.1 New helper `travelToCountry`

`src/tools/travel.ts`:

```ts
/**
 * Travel to the cheapest entry region of a target country. Used by d4tw-air to
 * return to native country when farming-eligible battles exist abroad. Unlike
 * travelHome, the target is the country (not residence), since residence may be
 * outside the citizen's native country.
 */
export async function travelToCountry(
  ctx: BrowserContext,
  csrf: string,
  toCountryId: number,
  maxCC: number,
): Promise<{ ok: true; cost: number; regionId: number } | { ok: false; reason: string }> {
  const cheapest = await findCheapestTravelRegion(ctx, csrf, toCountryId);
  if (cheapest == null) return { ok: false, reason: 'no reachable region' };
  if (cheapest.cost > maxCC) return { ok: false, reason: `cost ${cheapest.cost} > max ${maxCC}` };

  const { body } = await apiCall(ctx, {
    method: 'POST',
    path: '/en/main/travel',
    csrf,
    formBody: {
      check: 'moveAction',
      travelMethod: 'preferCurrency',
      inRegionId: String(cheapest.regionId),
      toCountryId: String(toCountryId),
    },
  });
  if ((body as { message?: string })?.message !== 'success') {
    return { ok: false, reason: (body as { message?: string })?.message ?? 'travel failed' };
  }
  return { ok: true, cost: cheapest.cost, regionId: cheapest.regionId };
}
```

`findCheapestTravelRegion` is the existing helper in `tools/farm.ts`. `/main/travel` is
already in the allow-list.

## 9. Strategy implementation (`src/farm/strategies/d4twAir.ts`)

Mirror of `d4tw.ts` with the differences in §3 / §6. Pseudo:

```ts
async function runD4twAir(ctx, info, options): Promise<FarmSessionResult> {
  const settings = loadSettings();
  const cfg = settings.d4twAir;

  // Pre-flight
  if (info.strength == null || info.airRankNumber == null) {
    return emptyResult('strength/airRank unavailable', 'no-candidates');
  }
  if (info.currentCountryId !== info.countryId) {
    return emptyResult('not in native country', 'no-candidates');
  }

  // Discovery — D11-only filter
  const all = await listMyCountryActiveBattles(ctx, info.csrf, info.countryId);
  const d11 = all.filter((b) => b.division === 11);
  if (d11.length === 0) return emptyResult('no D11 native battles', 'no-candidates');

  // Order: invader-side (losing — 30k) → defender-side (fallback — 50k)
  const ordered = [
    ...d11.filter((b) => b.invaderId === info.countryId),
    ...d11.filter((b) => b.defenderId === info.countryId),
  ];

  // Weapon — reuse preloaded inventory if runner provided it
  const inventory = options.preloadedInventory ?? await loadInventory(ctx, info.csrf);
  const weapon = cfg.useWeapon
    ? resolveWeapon(inventory, cfg.weaponPriority)
    : { quality: -1, firepower: FIREPOWER.bare, amountOnHand: Infinity };

  const dmgPerHit = damagePerHit(info.strength, info.airRankNumber, weapon.firepower);

  // Battle loop
  const cap = Math.min(cfg.maxBattlesPerSession, ordered.length);
  for (let i = 0; i < cap; i++) {
    const battle = ordered[i];
    const mySide = battle.invaderId === info.countryId ? 'invader' : 'defender';
    const targetDmg = mySide === 'invader' ? cfg.targetDamageAttacker : cfg.targetDamageDefender;

    // Empty side required
    const empty = await isSideEmpty(
      ctx, info.csrf, battle.battleId, 11, battle.battleZoneId,
      battle.zoneId, mySide, battle.invaderId, battle.defenderId,
    ).catch(() => null);
    if (empty == null) { skipped.push({reason: 'empty-check failed'}); continue; }
    if (!empty.isEmpty) { skipped.push({reason: `side ${mySide} not empty`}); continue; }

    // Re-check energy + ammo with fresh pool
    const hits = Math.ceil(targetDmg / dmgPerHit);
    const energy = Math.max(hits * ENERGY_PER_HIT, MIN_DEPLOY_ENERGY);

    await page.goto(`https://www.erepublik.com/en/military/battlefield/${battle.battleId}`, ...);
    const inv = await getDeployInventory(ctx, info.csrf, battle.battleId, info.countryId, battle.battleZoneId);
    const ammoOk = weapon.amountOnHand === Infinity || weapon.amountOnHand >= hits;
    if (inv.poolEnergy < energy || !ammoOk) {
      const msg = `need ${energy}e + ${hits} ammo, have ${inv.poolEnergy}e / ${weapon.amountOnHand}`;
      skipped.push({reason: msg});
      await notify(formatBattleFailureMessage({...division: 11}, msg));
      continue;
    }

    if (options.dryRun) { /* mirror d4tw dryRun path */ continue; }

    const sideCountryId = mySide === 'invader' ? battle.invaderId : battle.defenderId;
    const skin = inv.skinId ?? skinForDivision(11);
    const result = await deployWeapon(
      ctx, info.csrf, battle.battleId, battle.battleZoneId,
      sideCountryId, weapon.quality, energy, skin,
    );
    if (!result.success) {
      skipped.push({reason: result.message});
      await notify(formatBattleFailureMessage({...division: 11}, result.message));
      continue;
    }

    wins.push({ battleId, regionName, ... });
    await notify(formatBattleSuccessMessage({...division: 11}));
  }

  return { farmedCount: wins.length, wins, skipped, stopReason, fuelLeftAtEnd, ... };
}

export const d4twAirStrategy: FarmStrategy = { id: 'd4tw-air', run: runD4twAir };
```

**Forbidden / EnergyExhausted handling:** identical to `d4tw` — bubble up to runner, which
aborts the runner-loop (`ForbiddenError`) or stops cleanly (`EnergyExhaustedError`).

## 10. UI

`src/ui/public/index.html`:

```html
<!-- mode dropdown -->
<option value="d4tw-air">D4 TW (air, low-strength medals)</option>

<!-- new panel -->
<details class="border rounded p-3">
  <summary>D4 TW (air) settings</summary>
  <label>Target damage — attacker side
    <input id="d4twAir-attacker" type="number" min="1">
  </label>
  <label>Target damage — defender side
    <input id="d4twAir-defender" type="number" min="1">
  </label>
  <label>Max battles per session
    <input id="d4twAir-maxBattles" type="number" min="1" max="10">
  </label>
  <label>
    <input id="d4twAir-useWeapon" type="checkbox"> Use aircraft weapon
  </label>
  <div>Weapon priority: <code id="d4twAir-weapons">[5,4,3,2,1]</code></div>
  <small>Aircraft rank: <span id="detected-airRank">—</span></small>
</details>
```

`src/ui/public/app.js`: bind the new IDs to `settings.d4twAir.*`; PUT on change (the runner
wakes via `fs.watch` on `settings.json`).

`weaponPriority` is read-only for now (consistent with d4tw); drag-and-drop reorder is a
future enhancement.

`detected.airRankNumber` is read from `/api/snapshot` and rendered alongside division /
maverick info.

## 11. Notifications

Per-battle Telegram messages via `cfg.notify` (already plumbed in runner):

| Event | Message |
|---|---|
| Successful deploy | `💥 [#{battleId} {Region}](url) — 🇽🇽 vs 🇽🇽 · D11` |
| Skipped battle (empty/energy/ammo/deploy fail) | `⚠️ [#{battleId} {Region}](url) — 🇽🇽 vs 🇽🇽 · D11` + reason |
| Travel home (abroad pre-flight) | `🛫 traveled home ({cost}cc) to fight D11 medal` |
| Travel home failed | `⚠️ d4tw-air: cannot travel home — {reason}` |

Existing `formatBattleSuccessMessage` / `formatBattleFailureMessage` accept `division` in
the payload and build the deep-link `/military/battlefield/{battleId}/{battleZoneId}` —
which lands on the D11 zone. `disable_web_page_preview: true` is already set in the
notifier.

Session-level stops (`ForbiddenError`, `EnergyExhaustedError`) intentionally skip
per-battle notification — they surface in the runner's digest, matching existing
strategies.

## 12. Testing

| File | Coverage |
|---|---|
| `d4twAir.test.ts` (new) | `estimateMinEnergy` — strength/rank/FP combos, `useWeapon=false`, empty inventory, null strength/rank → MIN_DEPLOY_ENERGY |
| `d4twAir.test.ts` (new) | Ordering — invader-first → defender-fallback, with 0/1/many on each side |
| `fuelBudget.test.ts` (extend) | `minEnergyPerBattle=30` doesn't block when pool=40; blocks when pool=20; `undefined` falls back to `ENERGY_PER_BATTLE=66` |
| `travelToCountry.test.ts` (new) | Reject when `cost > maxCC`; success path; failed travel path |
| `settingsStore.test.ts` (extend) | Old `settings.json` without `d4twAir` → Zod fills defaults; `modeOverride='d4tw-air'` is accepted |

End-to-end Playwright-driven test of `runD4twAir` is intentionally omitted — equivalent
coverage exists via manual verification with a real test account in `npm start` with
`modeOverride='d4tw-air'`.

## 13. Error handling

| Scenario | Behavior |
|---|---|
| `info.strength == null` or `airRankNumber == null` | `emptyResult('strength/airRank unavailable', 'no-candidates')` |
| `currentCountryId !== countryId` (abroad) | Runner pre-flight may travel home (§8); otherwise strategy returns `'not in native country'` `no-candidates` |
| No D11 native battles | `emptyResult('no D11 native battles', 'no-candidates')` |
| All D11 sides not empty | `wins=[]`, `skipped=[…]`, `stopReason='completed'` |
| Pool energy insufficient for a specific battle | Per-battle skip + failure notification; barrel **not** consumed |
| `Forbidden` from deploy | `ForbiddenError` → runner-loop aborts (existing contract) |
| `EnergyExhaustedError` | Bubbles up, runner stops cleanly |
| Aircraft rank JSON field name differs | Implementer-resolved during one-time live verification (TODO §5) |
| `loadInventory` fails in runner pre-flight | `preloadedInventory = undefined`; strategy reads on its own (graceful fallback); estimate skipped → gate uses default 66 |
| `travelToCountry` fails (cost > max, network) | Notify + skip cycle |

## 14. Migration / backwards compatibility

- Existing `config/settings.json` without `d4twAir` → Zod default block populates.
- Existing `modeOverride` (`null`, `'standard'`, `'d4tw'`, `'maverickD3'`) → unchanged.
- Existing `daily-state-*.json`, `weekly-fuel-state.json` schemas → unchanged.
- Existing CLIs (`farmRunner.ts`, `farmOne.ts`, `showFarmableBattles.ts`) → unchanged
  (they are `standard`-only by construction).

## 15. Out of scope

- Reordering existing `d4tw` to invader-first / defender-fallback (separate future task).
- Standalone CLI for `d4tw-air` (`farm-one-air` etc.).
- Adaptive damage targeting (read top damage, pour just enough) — operator chose
  "skip if side not empty" instead.
- Auto-mode rules for selecting `d4tw-air` — only manual `modeOverride` for now.
- Drag-and-drop `weaponPriority` reorder in UI.
- `.env` seeding for `d4twAir.*` — UI-only configurable.

## 16. Open implementation TODOs

1. **Aircraft rank JSON field** (§5): confirm exact key during implementation by hitting
   `/main/citizen-profile-json-personal/{citizenId}` once and inspecting the response.
   Update `src/browser/session.ts` accordingly.
2. **`skinForDivision(11)`** (§9): confirm the skin map already includes D11 → 18 (per
   `CLAUDE.md` it does, but verify in `src/tools/farm.ts`).
3. **`battleZoneId` for D11**: confirm `listMyCountryActiveBattles` returns the D11
   battle entry with a `battleZoneId` that lands the deep-link URL on the D11 zone.
