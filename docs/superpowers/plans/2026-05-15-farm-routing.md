# Farm Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the always-from-residence travel-cost ranking in `src/farmRunner.ts` with cluster-by-country sequencing driven by the live current location, and bump retry default from 5 to 10.

**Architecture:** Pure routing helpers in a new `src/farm/routing.ts` module (`RoutingState`, `pickNext`, `orderSides`, `formatSequence`). `farmRunner.ts` swaps its `for (const c of candidates)` loop for a `while`-loop that drives those helpers, threading the live region/country between iterations. No allow-list changes, no MCP tool changes, LLM stays out.

**Tech Stack:** Node 22, TypeScript via `tsx` (no build step). No test framework wired up in this repo (per `CLAUDE.md`). **Validation is manual / dry-run-driven** — this plan deviates from TDD on that point because the spec explicitly approved manual validation. Each task ends with `npm run typecheck`; the integration tasks add temporary `console.log` probes that get removed before commit.

**Spec:** `docs/superpowers/specs/2026-05-15-farm-routing-design.md`

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/browser/session.ts` | modify | Extend `extractCitizenContext` with `residenceCountryId` (page global lookup + fallback to citizenship country). |
| `src/farm/routing.ts` | **create** | Pure routing logic: `RoutingState` type, `pickNext` (intra-country preference + bridge fallback), `orderSides` (which side first), `formatSequence` (log helper). No HTTP — takes a travel-cost callback. |
| `src/farmRunner.ts` | modify | Replace linear `for` loop with `while` loop driven by `RoutingState` + routing helpers. Update battle log line. Add end-of-run sequence summary. Bump `ERP_FARM_MAX_ATTEMPTS` default 5 → 10. |
| `src/farmOne.ts` | unchanged | Single-battle mode has no routing decisions. |
| `src/tools/farm.ts` | unchanged | `findCheapestTravelRegion` already accepts `fromRegionId`; only the call site changes. |

`routing.ts` is its own file (not inline in `farmRunner.ts`) because it contains the only pure logic worth reasoning about in isolation, and the run loop is mostly orchestration / I/O.

---

## Task 1: Add `residenceCountryId` to citizen context

**Files:**
- Modify: `src/browser/session.ts:26-86`

The page global `erepublik.citizen.residence` already exposes `regionId`. Verify whether `countryId` lives there too (very likely — eRepublik typically nests both); if not, fall back to `citizenshipCountryId` which is already extracted.

- [ ] **Step 1: Extend the `CitizenContext` interface**

In `src/browser/session.ts:26-32`, add `residenceCountryId: number | null;`:

```ts
export interface CitizenContext {
  csrf: string;
  countryId: number | null;
  citizenId: number | null;
  division: number | null;
  residenceRegionId: number | null;
  residenceCountryId: number | null;
}
```

- [ ] **Step 2: Read residence countryId from the page global**

In the `page.evaluate(() => { ... })` block in `src/browser/session.ts:43-76`:

1. Extend the `Citizen` type alias (line 45-54) to add `residence?: { regionId?: number; countryId?: number };` (replaces the existing `residence?: { regionId?: number }` line).
2. Add this line right after `const residenceRegionId = ...` (line 73):

```ts
const residenceCountryId =
  typeof c?.residence?.countryId === 'number' ? c.residence.countryId : null;
```

3. Update the `return { ... }` (line 75) to include `residenceCountryId`.
4. Update the outer `return { ... }` (lines 79-85) to include:

```ts
residenceCountryId: info.residenceCountryId ?? null,
```

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/browser/session.ts
git commit -m "$(cat <<'EOF'
add residenceCountryId to citizen context

Required by the upcoming farm-routing logic so we can detect when a
candidate battle has at least one side in the country we are currently
standing in.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Bump retry default 5 → 10

**Files:**
- Modify: `src/farmRunner.ts:33`

Per spec §5.3. Standalone commit so it's easy to revert if the longer retry loop turns out to mask a real problem.

- [ ] **Step 1: Change the default**

In `src/farmRunner.ts:33`:

```diff
-  ERP_FARM_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
+  ERP_FARM_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/farmRunner.ts
git commit -m "$(cat <<'EOF'
bump ERP_FARM_MAX_ATTEMPTS default 5 → 10

5 attempts is tight in practice — transient "Not enough energy" cooldowns
and deploy contention often eat 3-4 attempts before the hit lands, and we
were losing battles to that. Worst-case extra wall-clock per battle is
~2.5s (5 × ERP_FARM_RETRY_DELAY_MS=500).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Create routing module with `RoutingState` and `orderSides`

**Files:**
- Create: `src/farm/routing.ts`

Pure logic only — no `BrowserContext`, no `apiCall`. The function signatures take primitives so the loop in `farmRunner.ts` can stay in charge of HTTP.

- [ ] **Step 1: Create the directory**

```bash
mkdir -p src/farm
```

- [ ] **Step 2: Write the file with types + orderSides**

Create `src/farm/routing.ts` with this exact content:

```ts
import type { FarmableBattle } from '../tools/battles.js';

export interface RoutingHop {
  battleId: number;
  side: 'invader' | 'defender';
  fromRegionId: number;
  toRegionId: number;
  toCountryId: number;
  cost: number;
}

export interface RoutingState {
  regionId: number;
  countryId: number;
  totalTravelCC: number;
  hops: RoutingHop[];
}

export function initRoutingState(residenceRegionId: number, residenceCountryId: number): RoutingState {
  return {
    regionId: residenceRegionId,
    countryId: residenceCountryId,
    totalTravelCC: 0,
    hops: [],
  };
}

export interface OrderedSides {
  first: { side: 'invader' | 'defender'; countryId: number };
  second: { side: 'invader' | 'defender'; countryId: number };
}

/**
 * Decide which side to fight first.
 *
 * - If the player is already standing in one of the combatant countries → fight
 *   that side first (zero/cheap entry hop), then jump to the other side.
 * - If the player is in a third country (bridging case) → caller must use the
 *   `bridgingFirstSide` argument (already determined from comparing travel
 *   costs). This function just packages the result.
 */
export function orderSides(
  battle: Pick<FarmableBattle, 'invaderId' | 'defenderId'>,
  currentCountryId: number,
  bridgingFirstSide: 'invader' | 'defender' = 'invader',
): OrderedSides {
  if (currentCountryId === battle.invaderId) {
    return {
      first: { side: 'invader', countryId: battle.invaderId },
      second: { side: 'defender', countryId: battle.defenderId },
    };
  }
  if (currentCountryId === battle.defenderId) {
    return {
      first: { side: 'defender', countryId: battle.defenderId },
      second: { side: 'invader', countryId: battle.invaderId },
    };
  }
  // Bridging — caller picked which side is cheaper to reach first.
  if (bridgingFirstSide === 'defender') {
    return {
      first: { side: 'defender', countryId: battle.defenderId },
      second: { side: 'invader', countryId: battle.invaderId },
    };
  }
  return {
    first: { side: 'invader', countryId: battle.invaderId },
    second: { side: 'defender', countryId: battle.defenderId },
  };
}

/** Format the end-of-run sequence string from RoutingState.hops. */
export function formatSequence(hops: RoutingHop[]): string {
  if (hops.length === 0) return '(no hops)';
  const parts = hops.map((h) => `c${h.toCountryId}`);
  return parts.join(' → ');
}
```

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/farm/routing.ts
git commit -m "$(cat <<'EOF'
add farm/routing module: RoutingState + orderSides

Pure logic that decides which side of a battle to fight first based on
where the player is currently standing. Zero I/O — the run loop in
farmRunner.ts will own all HTTP calls and feed the helpers primitives.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add `pickNext` to routing module

**Files:**
- Modify: `src/farm/routing.ts`

`pickNext` is async because it must query travel costs. To keep it pure-ish and decoupled from `apiCall`, it takes a `getTravel` callback. The caller wires that callback to the real `findCheapestTravelRegion`.

- [ ] **Step 1: Append `pickNext` to `src/farm/routing.ts`**

Append (do not replace existing content):

```ts
import type { TravelOption } from '../tools/farm.js';

export interface PickedBattle {
  battle: FarmableBattle;
  /** Travel that gets us into the FIRST side's country. May be 0 if we are already there. */
  firstHopCost: number;
  firstHopRegionId: number;
  firstHopCountryId: number;
  /** Travel from the first side's region to the second side's region. */
  secondHopCost: number;
  secondHopRegionId: number;
  secondHopCountryId: number;
  /** Set when the bridging branch was used. orderSides() needs this. */
  bridgingFirstSide: 'invader' | 'defender';
}

export interface PickNextDeps {
  /**
   * Fetch the cheapest travel option from `fromRegionId` into `toCountryId`
   * for the given battle. Returns null if the route is blocked.
   */
  getTravel: (
    battleId: number,
    fromRegionId: number,
    toCountryId: number,
  ) => Promise<TravelOption | null>;
  /** Per-hop ceiling — battles requiring a single hop above this are excluded. */
  maxTravelCC: number;
}

interface SidedBattleCost {
  battle: FarmableBattle;
  side: 'invader' | 'defender';
  region: TravelOption;
}

/**
 * Pick the next battle to farm.
 *
 * Plain English: "is there a battle in the country I'm already standing in?
 * If yes, pick the one whose OTHER side is cheapest to fly to next.
 * If no, just fly to the cheapest reachable battle anywhere."
 *
 * Returns null if nothing is reachable within `maxTravelCC`.
 */
export async function pickNext(
  state: RoutingState,
  remaining: FarmableBattle[],
  deps: PickNextDeps,
): Promise<PickedBattle | null> {
  // ── Tier 1: intra-country preference ──────────────────────────────────────
  const intra = remaining.filter(
    (b) => b.invaderId === state.countryId || b.defenderId === state.countryId,
  );

  if (intra.length > 0) {
    let best: PickedBattle | null = null;
    for (const battle of intra) {
      const firstSide: 'invader' | 'defender' =
        battle.invaderId === state.countryId ? 'invader' : 'defender';
      const firstCountryId = firstSide === 'invader' ? battle.invaderId : battle.defenderId;
      const secondCountryId = firstSide === 'invader' ? battle.defenderId : battle.invaderId;

      const firstHop = await deps.getTravel(battle.battleId, state.regionId, firstCountryId);
      if (!firstHop || firstHop.cost > deps.maxTravelCC) continue;

      const secondHop = await deps.getTravel(battle.battleId, firstHop.toRegionId, secondCountryId);
      if (!secondHop || secondHop.cost > deps.maxTravelCC) continue;

      const candidate: PickedBattle = {
        battle,
        firstHopCost: firstHop.cost,
        firstHopRegionId: firstHop.toRegionId,
        firstHopCountryId: firstHop.toCountryId,
        secondHopCost: secondHop.cost,
        secondHopRegionId: secondHop.toRegionId,
        secondHopCountryId: secondHop.toCountryId,
        bridgingFirstSide: firstSide,
      };
      // Lookahead tiebreaker: minimize the SECOND hop (we are paying near zero
      // for the first hop because we are already in that country).
      if (!best || candidate.secondHopCost < best.secondHopCost) {
        best = candidate;
      }
    }
    if (best) return best;
    // Fall through to bridging if every intra candidate exceeded the cap.
  }

  // ── Tier 2: bridge to next cluster ────────────────────────────────────────
  let best: PickedBattle | null = null;
  for (const battle of remaining) {
    const sides: SidedBattleCost[] = [];
    const inv = await deps.getTravel(battle.battleId, state.regionId, battle.invaderId);
    if (inv && inv.cost <= deps.maxTravelCC) {
      sides.push({ battle, side: 'invader', region: inv });
    }
    const def = await deps.getTravel(battle.battleId, state.regionId, battle.defenderId);
    if (def && def.cost <= deps.maxTravelCC) {
      sides.push({ battle, side: 'defender', region: def });
    }
    if (sides.length === 0) continue;

    sides.sort((a, b) => a.region.cost - b.region.cost);
    const cheapest = sides[0];
    const secondCountryId =
      cheapest.side === 'invader' ? battle.defenderId : battle.invaderId;

    const secondHop = await deps.getTravel(
      battle.battleId,
      cheapest.region.toRegionId,
      secondCountryId,
    );
    if (!secondHop || secondHop.cost > deps.maxTravelCC) continue;

    const candidate: PickedBattle = {
      battle,
      firstHopCost: cheapest.region.cost,
      firstHopRegionId: cheapest.region.toRegionId,
      firstHopCountryId: cheapest.region.toCountryId,
      secondHopCost: secondHop.cost,
      secondHopRegionId: secondHop.toRegionId,
      secondHopCountryId: secondHop.toCountryId,
      bridgingFirstSide: cheapest.side,
    };
    if (!best || candidate.firstHopCost < best.firstHopCost) {
      best = candidate;
    }
  }
  return best;
}
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/farm/routing.ts
git commit -m "$(cat <<'EOF'
add pickNext to farm/routing: cluster-by-country with 1-step lookahead

Tier 1: prefer battles where one side is current country; tiebreak by
cheapest SECOND hop. Tier 2 (bridge): pick whichever battle has the
cheapest single hop from current location. Per-hop cap (maxTravelCC)
excludes any candidate whose required first or second hop exceeds it.

Async because travel costs come from the live travelData endpoint;
caller injects that lookup via the getTravel callback so this module
stays HTTP-free.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Refactor `farmRunner.ts` main loop

**Files:**
- Modify: `src/farmRunner.ts:236-389` (the main block + `farmBattleBothSides`)

This is the biggest task. Read the spec §5.4 carefully — most of `farmBattleBothSides` stays identical. Only the **call sites** for travel/deploy change to use the routing-state values instead of always going via residence.

- [ ] **Step 1: Add imports**

Near the top of `src/farmRunner.ts` (with the other imports), add:

```ts
import { initRoutingState, orderSides, pickNext, formatSequence, type RoutingState } from './farm/routing.js';
```

- [ ] **Step 2: Replace the main block — extract residence + init RoutingState**

In `src/farmRunner.ts` find the block starting at the current line that reads `const raw = await extractCitizenContext(ctx);` (around line 240). Update the validation right after to also require `residenceCountryId`:

```ts
const raw = await extractCitizenContext(ctx);
if (
  raw.division == null ||
  raw.citizenId == null ||
  raw.countryId == null ||
  raw.residenceRegionId == null
) {
  throw new Error(
    `Missing citizen context: division=${raw.division}, citizenId=${raw.citizenId}, countryId=${raw.countryId}, residenceRegionId=${raw.residenceRegionId}`,
  );
}
const residenceCountryId = raw.residenceCountryId ?? raw.countryId;
if (raw.residenceCountryId == null) {
  console.log(
    `[farm-runner] ⚠ residenceCountryId not in page context — falling back to citizenship country ${raw.countryId}`,
  );
}
const info = {
  csrf: raw.csrf,
  citizenId: raw.citizenId,
  countryId: raw.countryId,
  division: raw.division,
  residenceRegionId: raw.residenceRegionId,
  residenceCountryId,
};
console.log(
  `[farm-runner] citizen=${info.citizenId} country=${info.countryId} division=${info.division} residence=region${info.residenceRegionId}/country${info.residenceCountryId}`,
);
```

- [ ] **Step 3: Replace the `for (const c of candidates)` loop with a `while` loop**

Locate the block starting at the current line `for (const c of candidates) {` (around line 291) and ending at the line before the `console.log('')` summary block (around line 372). Replace the **entire `for` block** with this:

```ts
const routing: RoutingState = initRoutingState(info.residenceRegionId, info.residenceCountryId);
const remaining = [...candidates];
let farmedCount = 0;
let lastFuel: number | null = null;
let lastPoolEnergy: number | null = null;
const minEnergyPerBattle = env.ERP_FARM_TOTAL_ENERGY * 2;
const wins: Array<{ battleId: number; regionName: string; inv: SideOutcome; def: SideOutcome }> = [];
const skipped: Array<{ battleId: number; regionName: string; reason: string }> = [];

while (remaining.length > 0) {
  if (farmedCount >= env.ERP_FARM_MAX_BATTLES) {
    console.log(`[farm-runner] reached max-battles cap (${env.ERP_FARM_MAX_BATTLES}) — stopping`);
    break;
  }
  if (lastFuel != null && lastFuel < env.ERP_FARM_MIN_FUEL) {
    console.log(`[farm-runner] fuel ${lastFuel} below ${env.ERP_FARM_MIN_FUEL} — stopping`);
    break;
  }
  if (lastPoolEnergy != null && lastPoolEnergy < minEnergyPerBattle) {
    console.log(
      `[farm-runner] pool energy ${lastPoolEnergy} below ${minEnergyPerBattle} (=${env.ERP_FARM_TOTAL_ENERGY}×2) — stopping`,
    );
    break;
  }

  const picked = await pickNext(routing, remaining, {
    getTravel: (battleId, fromRegionId, toCountryId) =>
      findCheapestTravelRegion(ctx, info.csrf, battleId, fromRegionId, toCountryId),
    maxTravelCC: env.ERP_FARM_MAX_TRAVEL_CC,
  });
  if (!picked) {
    console.log(
      `[farm-runner] no reachable battle within ${env.ERP_FARM_MAX_TRAVEL_CC}cc per hop — stopping (${remaining.length} candidates left unreached)`,
    );
    break;
  }

  const c = picked.battle;
  remaining.splice(remaining.indexOf(c), 1);

  // Verify empty (preserved — same call as today)
  const check = await isBattleDivisionEmpty(
    ctx,
    info.csrf,
    c.battleId,
    info.division,
    c.battleZoneId,
    c.zoneId,
  ).catch(() => null);
  if (!check) {
    skipped.push({ battleId: c.battleId, regionName: c.regionName, reason: 'empty-check failed' });
    continue;
  }
  if (!check.isEmpty) {
    skipped.push({
      battleId: c.battleId,
      regionName: c.regionName,
      reason: `not empty (zoneFinished=${check.zoneFinished}, dom=${check.domination})`,
    });
    continue;
  }

  const ordered = orderSides(c, routing.countryId, picked.bridgingFirstSide);
  const firstTravel = {
    toCountryId: picked.firstHopCountryId,
    toRegionId: picked.firstHopRegionId,
    cost: picked.firstHopCost,
  };
  const secondTravel = {
    toCountryId: picked.secondHopCountryId,
    toRegionId: picked.secondHopRegionId,
    cost: picked.secondHopCost,
  };

  const header =
    `🎯 #${c.battleId} ${c.regionName} ` +
    `(Inv ${c.invaderId} vs Def ${c.defenderId}) | location=c${routing.countryId} → ` +
    `fight ${ordered.first.side} c${ordered.first.countryId} (${firstTravel.cost}cc) → ` +
    `fight ${ordered.second.side} c${ordered.second.countryId} (${secondTravel.cost}cc)`;

  if (!execute) {
    console.log(`${header} | (dry-run)`);
    farmedCount++;
    // In dry-run, advance routing state as if we had fought, so subsequent
    // pickNext() calls reflect the post-battle location.
    routing.totalTravelCC += firstTravel.cost + secondTravel.cost;
    routing.hops.push(
      {
        battleId: c.battleId,
        side: ordered.first.side,
        fromRegionId: routing.regionId,
        toRegionId: firstTravel.toRegionId,
        toCountryId: firstTravel.toCountryId,
        cost: firstTravel.cost,
      },
      {
        battleId: c.battleId,
        side: ordered.second.side,
        fromRegionId: firstTravel.toRegionId,
        toRegionId: secondTravel.toRegionId,
        toCountryId: secondTravel.toCountryId,
        cost: secondTravel.cost,
      },
    );
    routing.regionId = secondTravel.toRegionId;
    routing.countryId = secondTravel.toCountryId;
    continue;
  }

  console.log(header);
  try {
    const out = await farmBattleBothSides(ctx, info, c, ordered, firstTravel, secondTravel);
    const fuelLine = out.second.fuelLeft ?? out.first.fuelLeft;
    if (fuelLine != null) lastFuel = fuelLine;
    if (out.poolEnergyAfter != null) lastPoolEnergy = out.poolEnergyAfter;

    routing.totalTravelCC += firstTravel.cost + secondTravel.cost;
    routing.hops.push(
      {
        battleId: c.battleId,
        side: ordered.first.side,
        fromRegionId: routing.regionId,
        toRegionId: firstTravel.toRegionId,
        toCountryId: firstTravel.toCountryId,
        cost: firstTravel.cost,
      },
      {
        battleId: c.battleId,
        side: ordered.second.side,
        fromRegionId: firstTravel.toRegionId,
        toRegionId: secondTravel.toRegionId,
        toCountryId: secondTravel.toCountryId,
        cost: secondTravel.cost,
      },
    );
    routing.regionId = secondTravel.toRegionId;
    routing.countryId = secondTravel.toCountryId;

    const inv = ordered.first.side === 'invader' ? out.first : out.second;
    const def = ordered.first.side === 'invader' ? out.second : out.first;
    console.log(
      `   ✅ inv: ${inv.attempts}att/verified=${inv.verified}/fuel=${inv.fuelLeft ?? '?'} | ` +
        `def: ${def.attempts}att/verified=${def.verified}/fuel=${def.fuelLeft ?? '?'} | ` +
        `pool=${out.poolEnergyAfter ?? '?'}`,
    );
    farmedCount++;
    wins.push({ battleId: c.battleId, regionName: c.regionName, inv, def });
  } catch (e) {
    const msg = (e as Error).message;
    console.log(`   ❌ ${msg}`);
    if (e instanceof ForbiddenError) {
      console.log('[farm-runner] aborting run — IP/account flagged');
      break;
    }
    if (e instanceof EnergyExhaustedError) {
      console.log('[farm-runner] aborting run — pool energy exhausted');
      break;
    }
    skipped.push({ battleId: c.battleId, regionName: c.regionName, reason: msg });
  }
}
```

- [ ] **Step 4: Refactor `farmBattleBothSides` to take ordered sides**

The current `farmBattleBothSides` (around `src/farmRunner.ts:162-232`) hardcodes invader-first then defender. Change its signature to accept the ordered sides + their resolved travel options and run them in that order.

Replace the **entire `farmBattleBothSides` function** (find it starting `async function farmBattleBothSides(`) with:

```ts
async function farmBattleBothSides(
  ctx: BrowserContext,
  info: { csrf: string; citizenId: number; division: number },
  target: FarmableBattle,
  ordered: { first: { side: 'invader' | 'defender'; countryId: number }; second: { side: 'invader' | 'defender'; countryId: number } },
  firstTravel: TravelOption,
  secondTravel: TravelOption,
): Promise<{ first: SideOutcome; second: SideOutcome; poolEnergyAfter: number | null }> {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const battleUrl = `https://www.erepublik.com/en/military/battlefield/${target.battleId}`;
  await page.goto(battleUrl, { waitUntil: 'domcontentloaded' });

  // Pre-flight: clear any stale deployment session that might collide.
  await cancelDeploy(ctx, info.csrf, target.battleId).catch(() => null);

  const defaultSkin = skinForDivision(info.division);

  // ── first side ────────────────────────────────────────────────────────────
  const travelA = await battlefieldTravel(
    ctx,
    info.csrf,
    target.battleId,
    target.battleZoneId,
    ordered.first.countryId,
    firstTravel.toCountryId,
    firstTravel.toRegionId,
  );
  if (!travelA.success) throw new Error(`travel→${ordered.first.side}: ${travelA.message}`);

  const invA = await getDeployInventory(ctx, info.csrf, target.battleId, ordered.first.countryId, target.battleZoneId);
  const skinA = invA.skinId ?? defaultSkin;
  const resA = await deployWithRetryRunner(
    ctx,
    info.csrf,
    info.citizenId,
    info.division,
    target,
    ordered.first.side,
    ordered.first.countryId,
    skinA,
  );

  // ── handoff ───────────────────────────────────────────────────────────────
  await sleep(env.ERP_FARM_HANDOFF_SLEEP_MS);
  resA.verified = await verifyHitRegistered(
    ctx,
    info.csrf,
    target.battleId,
    target.zoneId,
    info.division,
    target.battleZoneId,
    ordered.first.countryId,
    info.citizenId,
  ).catch(() => resA.verified);
  await cancelDeploy(ctx, info.csrf, target.battleId).catch(() => null);

  // ── second side ───────────────────────────────────────────────────────────
  const travelB = await battlefieldTravel(
    ctx,
    info.csrf,
    target.battleId,
    target.battleZoneId,
    ordered.second.countryId,
    secondTravel.toCountryId,
    secondTravel.toRegionId,
  );
  if (!travelB.success) throw new Error(`travel→${ordered.second.side}: ${travelB.message}`);

  const invB = await getDeployInventory(ctx, info.csrf, target.battleId, ordered.second.countryId, target.battleZoneId);
  const skinB = invB.skinId ?? defaultSkin;
  const resB = await deployWithRetryRunner(
    ctx,
    info.csrf,
    info.citizenId,
    info.division,
    target,
    ordered.second.side,
    ordered.second.countryId,
    skinB,
  );

  const invAfter = await getDeployInventory(
    ctx,
    info.csrf,
    target.battleId,
    ordered.second.countryId,
    target.battleZoneId,
  ).catch(() => null);

  return { first: resA, second: resB, poolEnergyAfter: invAfter?.poolEnergy ?? null };
}
```

- [ ] **Step 5: Update the `SideOutcome` interface to use the new `side` values**

The existing `SideOutcome` interface (`src/farmRunner.ts:62-69`) already has `side: 'invader' | 'defender'`. No change needed.

- [ ] **Step 6: Type-check**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add src/farmRunner.ts
git commit -m "$(cat <<'EOF'
refactor farmRunner main loop to use cluster-by-country routing

Replaces the linear for-loop (which used residenceRegionId for every
travel-cost lookup) with a while-loop driven by RoutingState. Each
iteration: pickNext() selects the cheapest in-current-country battle,
or bridges to the cheapest reachable cluster if none. orderSides()
ensures we fight the side adjacent to current location first, saving
the redundant home → invader → defender round-trip the old code paid
whenever the player started in the defender's country.

farmBattleBothSides now takes the ordered sides + their resolved
travel options instead of hardcoding invader-first.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Add end-of-run sequence summary

**Files:**
- Modify: `src/farmRunner.ts` (the summary block at the end of the `try { ... }` in main)

- [ ] **Step 1: Update the summary block**

Locate the existing summary block (`console.log('')` followed by `console.log('── summary ...')`) at the end of the main `try` in `src/farmRunner.ts`. Replace the **whole summary block** (from `console.log('')` to `if (lastFuel != null) console.log(...)`) with:

```ts
console.log('');
console.log(`── summary (${((Date.now() - t0) / 1000).toFixed(1)}s) ──`);
console.log(`  farmed: ${wins.length}/${env.ERP_FARM_MAX_BATTLES}`);
for (const w of wins) {
  console.log(`    • ${w.battleId} ${w.regionName}: inv ${w.inv.attempts}att, def ${w.def.attempts}att`);
}
if (skipped.length) {
  console.log(`  skipped: ${skipped.length}`);
  for (const s of skipped.slice(0, 10)) {
    console.log(`    – ${s.battleId} ${s.regionName}: ${s.reason}`);
  }
  if (skipped.length > 10) console.log(`    … +${skipped.length - 10} more`);
}
if (lastFuel != null) console.log(`  last fuelLeft: ${lastFuel}`);
console.log(`  hops: ${routing.hops.length} (total travel: ${routing.totalTravelCC}cc)`);
console.log(`  sequence: ${formatSequence(routing.hops)}`);
```

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/farmRunner.ts
git commit -m "$(cat <<'EOF'
log end-of-run sequence summary (hops + total travel + path)

Surfaces the routing decisions the new algorithm made so the operator
can verify behavior at a glance — total CC spent, number of hops, and
the country-by-country path taken.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manual smoke test (dry-run)

**Files:** none (validation step)

This is the only validation gate per the spec. No code changes — observe behavior, decide whether to ship or iterate.

- [ ] **Step 1: Run the discovery command**

```bash
npm run farmable
```

Expected: prints a list of candidate battles. Note the count and which countries appear. If `0 candidates`, retry later — there's nothing to validate against.

- [ ] **Step 2: Run the farmer in dry-run**

```bash
npm run farmer
```

(no `--execute` flag → dry-run mode)

- [ ] **Step 3: Inspect the log output**

Verify each of these:

- The `[farm-runner] citizen=...` line shows `residence=regionXXX/countryYYY` (i.e. the new `residenceCountryId` is populated, not falling back).
- Each battle line is in the new format: `🎯 #ID region (Inv X vs Def Y) | location=cZ → fight ... cZ (Ncc) → fight ... cW (Mcc) | (dry-run)`.
- The first battle's `location=` matches `residence=country...` from step 3a.
- Each subsequent battle's `location=` matches the previous battle's second-side country.
- The summary at the end includes `hops: N (total travel: Mcc)` and `sequence: cA → cA → cB → cB → ...`.
- For at least one battle, the first hop cost should be `0cc` (intra-country case where we are already in invader/defender country).

- [ ] **Step 4: Verify edge cases (where possible)**

Edge cases that might or might not be reproducible on the day you run this:

- **No reachable battle within cap:** if the run logs `no reachable battle within ... cc per hop — stopping`, the cap-exclusion logic is working. If everything is reachable today, this is untestable until a remote cluster appears.
- **Bridging case:** if the residence country has no candidate battles, the first battle's first-hop cost will be > 0 and `location=` will switch immediately. Good signal.
- **No regression in existing stop conditions:** `--max-battles` still caps; manually setting `ERP_FARM_MAX_BATTLES=1` should farm exactly one battle.

- [ ] **Step 5: If anything is broken — DO NOT PROCEED. Report findings.**

Common failure modes to look for:

| Symptom | Likely cause |
|---------|--------------|
| `residenceCountryId` warning in logs | `c.residence.countryId` doesn't exist on the page global. Inspect the page in DevTools and adjust Task 1's lookup. |
| All battles show `firstHopCost > 0` even when standing in a combatant country | `pickNext`'s intra filter or `orderSides` is misfiring. Check `state.countryId` evolution in the loop. |
| `location=` doesn't change between battles | The post-fight `routing.regionId = secondTravel.toRegionId` line is missing or running before the loop continues. |
| Same battle picked twice | `remaining.splice` is missing. |

If any of those appear, fix and re-run before declaring done.

- [ ] **Step 6: If everything looks right — declare done**

No commit needed (no code changes in this task). Optionally write up findings in your terminal scratchpad.

---

## Self-Review (executed)

**Spec coverage check:**

- §1 goal (cluster-by-country routing) → Tasks 3-5 ✓
- §2 bug analysis (residence vs current location) → Task 5 (passes `routing.regionId` instead of `info.residenceRegionId`) ✓
- §3.2 `pickNext` → Task 4 ✓
- §3.3 `orderSides` → Task 3 ✓
- §3.4 1-step lookahead → Task 4 (intra branch sorts by `secondHopCost`) ✓
- §4 `RoutingState` model → Task 3 ✓
- §5.1 file table → matches the file structure header ✓
- §5.3 retry bump → Task 2 ✓
- §6 logging changes → Tasks 5 (battle line) + 6 (summary) ✓
- §7 validation → Task 7 ✓
- §10 acceptance criteria → all covered by Task 7's inspection list ✓
- §11 open questions → resolved inline (own file ✓; `c.residence.countryId` with citizenship fallback ✓; whitelist remains as today's secondary sort, no change required for MVP)

**Placeholder scan:** no TBDs or "implement later" — every code block is complete.

**Type consistency:** `RoutingState`, `RoutingHop`, `PickedBattle`, `OrderedSides`, `PickNextDeps` are referenced consistently across Tasks 3-6. `getTravel` callback signature in Task 4 matches `findCheapestTravelRegion`'s parameter order in Task 5.

**Note on whitelist behavior:** the existing `candidates.sort((a, b) => { whitelisted first })` block stays — `pickNext` reads `remaining` in whatever order it arrives, so whitelisted battles get preference at tier-1 lookup if they appear first AND have similar cost. This is the "tiebreaker" interpretation from spec §11. Revisit if the operator wants stronger whitelist behavior.
