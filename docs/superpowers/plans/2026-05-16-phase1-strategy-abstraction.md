# Phase 1 — Farm Strategy Abstraction (Refactor)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the existing `runFarmSession` in a `FarmStrategy` interface and route all callers through a dispatcher, so Phases 5 and 6 can plug D4-TW and Maverick-D3 strategies without touching the runner.

**Architecture:** No behavior change. Extract the body of `src/farm/session.ts` into `src/farm/strategies/standard.ts` behind a minimal `FarmStrategy` shape (`{ id, run() }`). Shared types (FarmSessionInfo, FarmSessionResult, the three error classes) move to `src/farm/strategies/types.ts`. A `getStrategy(id)` dispatcher in `src/farm/strategies/index.ts` returns the chosen strategy. Both callers (`src/agent/runner.ts`, `src/farmRunner.ts`) switch to `getStrategy('standard').run(...)`. Old `src/farm/session.ts` is deleted at the end.

**Tech Stack:** Node 22, TypeScript via `tsx` (no build step). Vitest is installed but no farm tests exist; this refactor doesn't add any (per project convention — manual `npm run typecheck` + dry-run validation per [[CLAUDE.md]]).

**Spec:** `docs/superpowers/specs/2026-05-16-flexible-farming-config-design.md` (§1.3)

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/farm/strategies/types.ts` | **create** | Shared types: `FarmStrategy` interface, `FarmSessionInfo`, `FarmSessionOptions`, `FarmSessionResult`, `SideOutcome`, `WinSummary`, `SkipSummary`, `StopReason`, error classes. |
| `src/farm/strategies/standard.ts` | **create** | Implements `FarmStrategy` with `id: 'standard'`. Contains the current `runFarmSession` body plus its private helpers (`resolveOpts`, `deployWithRetry`, `farmBothSides`, `sleep`, `parseCsvIds`, `DEFAULTS`, `envNum`). |
| `src/farm/strategies/index.ts` | **create** | `getStrategy(id): FarmStrategy` dispatcher. Currently only knows `'standard'`. Throws on unknown id. Re-exports the interface and `standardStrategy` for direct testing. |
| `src/agent/runner.ts` | modify | Swap `runFarmSession(ctx, info, opts)` for `getStrategy('standard').run(ctx, info, opts)`. Update import. |
| `src/farmRunner.ts` | modify | Same swap as runner. |
| `src/farm/session.ts` | **delete** | All contents moved. No callers remain. |

The split mirrors the spec's §1.2 layout. The "strategy interface" surface stays intentionally minimal in this phase (single `run()` method) — we'll only know whether to split it into `discover()` + `fight()` after D4-TW lands and we see what the strategies actually share.

---

## Task 1: Create the shared types module

**Files:**
- Create: `src/farm/strategies/types.ts`

Move every exported type and error class from `src/farm/session.ts` into a new file. This is a copy-paste; nothing changes behaviorally.

- [ ] **Step 1: Create `src/farm/strategies/types.ts` with the full body**

```ts
import type { BrowserContext } from 'playwright-core';

// ── Shared types ────────────────────────────────────────────────────────────

export interface FarmSessionInfo {
  csrf: string;
  citizenId: number;
  countryId: number;
  division: number;
  residenceRegionId: number;
  residenceCountryId: number;
}

export interface FarmSessionOptions {
  /** Cap on battles to fight this session (gate-supplied). Hard cap. */
  maxBattles: number;
  /** When true, plan but never deploy. */
  dryRun?: boolean;
  maxTravelCC?: number;
  minFuel?: number;
  minBattleMinutes?: number;
  blockedCountries?: number[];
  whitelistCountries?: number[];
  weaponQuality?: number;
  totalEnergy?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  handoffSleepMs?: number;
  /** Retry budget for the side-B travel hop (medal-critical). */
  travelBRetryAttempts?: number;
  travelBRetryDelayMs?: number;
  /** Optional notifier — invoked on partial-battle (side A landed, side B failed). */
  notify?: (msg: string) => void | Promise<void>;
}

export interface SideOutcome {
  side: 'invader' | 'defender';
  countryId: number;
  attempts: number;
  verified: boolean;
  fuelLeft: number | null;
  deploymentId: number | null;
}

export interface WinSummary {
  battleId: number;
  regionName: string;
  inv: SideOutcome;
  def: SideOutcome;
}

export interface SkipSummary {
  battleId: number;
  regionName: string;
  reason: string;
}

export type StopReason =
  | 'completed'
  | 'max-battles'
  | 'low-fuel'
  | 'low-energy'
  | 'forbidden'
  | 'energy-exhausted'
  | 'no-reachable'
  | 'no-candidates';

export interface FarmSessionResult {
  farmedCount: number;
  wins: WinSummary[];
  skipped: SkipSummary[];
  stopReason: StopReason;
  fuelLeftAtEnd: number | null;
  poolEnergyAtEnd: number | null;
  totalTravelCC: number;
  hops: number;
  sequence: string;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class ForbiddenError extends Error {
  constructor(public readonly endpoint: string) {
    super(`eRepublik returned "Forbidden" on ${endpoint} — IP/account flagged`);
    this.name = 'ForbiddenError';
  }
}

export class EnergyExhaustedError extends Error {
  constructor(public readonly poolEnergy: number | null, public readonly lastMessage?: string) {
    super(
      `Pool energy exhausted (poolEnergy=${poolEnergy ?? '?'}, last message="${lastMessage ?? ''}") — runner stopping`,
    );
    this.name = 'EnergyExhaustedError';
  }
}

/**
 * Thrown when side A hit was already committed (deploy returned, fuel barrel
 * spent) but side B failed — travel exhausted retries, deploy threw, or pool
 * went empty. The medal on side B is forfeit; the caller should alert the
 * operator so they can finish the battle manually.
 */
export class PartialBattleError extends Error {
  constructor(
    public readonly battleId: number,
    public readonly regionName: string,
    public readonly sideA: SideOutcome,
    public readonly stage: 'travel-b' | 'deploy-b',
    public readonly cause: Error,
  ) {
    super(
      `Partial battle ${battleId} (${regionName}): side A (${sideA.side}) landed ` +
        `(verified=${sideA.verified}), side B failed at ${stage}: ${cause.message}`,
    );
    this.name = 'PartialBattleError';
  }
}

// ── Strategy interface ──────────────────────────────────────────────────────

export type StrategyId = 'standard' | 'd4tw' | 'maverickD3';

export interface FarmStrategy {
  readonly id: StrategyId;
  run(
    ctx: BrowserContext,
    info: FarmSessionInfo,
    options: FarmSessionOptions,
  ): Promise<FarmSessionResult>;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS. The new file has no consumers yet, but it must parse cleanly.

- [ ] **Step 3: Commit**

```bash
git add src/farm/strategies/types.ts
git commit -m "refactor: extract farm strategy types into strategies/types"
```

---

## Task 2: Create the Standard strategy

**Files:**
- Create: `src/farm/strategies/standard.ts`

Move the body of `src/farm/session.ts` (everything except the type declarations and error classes already in `types.ts`) into a new file. Wrap the entry point as `standardStrategy: FarmStrategy`.

- [ ] **Step 1: Create `src/farm/strategies/standard.ts`**

The file paste below is a verbatim move of the runtime code from `src/farm/session.ts` (lines 140-569 of the original file as of HEAD), reorganised under a single exported `standardStrategy` constant. All types come from `./types.js`. The routing helpers continue to live in `../routing.js`.

```ts
import type { BrowserContext } from 'playwright-core';
import {
  getCitizenEligibility,
  isBattleDivisionEmpty,
  listFarmableBattles,
  type FarmableBattle,
} from '../../tools/battles.js';
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
  advanceRouting,
  formatSequence,
  initRoutingState,
  orderSides,
  pickNext,
  type RoutingState,
} from '../routing.js';
import {
  EnergyExhaustedError,
  ForbiddenError,
  PartialBattleError,
  type FarmSessionInfo,
  type FarmSessionOptions,
  type FarmSessionResult,
  type FarmStrategy,
  type SideOutcome,
  type SkipSummary,
  type StopReason,
  type WinSummary,
} from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseCsvIds(s: string | undefined): number[] {
  if (!s) return [];
  return s
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

const DEFAULTS = {
  maxTravelCC: 400,
  minFuel: 10,
  minBattleMinutes: 5,
  weaponQuality: -1,
  totalEnergy: 33,
  maxAttempts: 10,
  retryDelayMs: 500,
  handoffSleepMs: 2000,
  travelBRetryAttempts: 3,
  travelBRetryDelayMs: 1500,
};

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function resolveOpts(opts: FarmSessionOptions) {
  const env = process.env;
  return {
    maxBattles: opts.maxBattles,
    dryRun: opts.dryRun ?? false,
    maxTravelCC: opts.maxTravelCC ?? envNum('ERP_FARM_MAX_TRAVEL_CC', DEFAULTS.maxTravelCC),
    minFuel: opts.minFuel ?? envNum('ERP_FARM_MIN_FUEL', DEFAULTS.minFuel),
    minBattleMinutes:
      opts.minBattleMinutes ?? envNum('ERP_FARM_MIN_BATTLE_MINUTES', DEFAULTS.minBattleMinutes),
    blockedCountries: opts.blockedCountries ?? parseCsvIds(env.ERP_FARM_BLOCKED_COUNTRIES),
    whitelistCountries: opts.whitelistCountries ?? parseCsvIds(env.ERP_FARM_WHITELIST_COUNTRIES),
    weaponQuality: opts.weaponQuality ?? envNum('ERP_FARM_WEAPON_QUALITY', DEFAULTS.weaponQuality),
    totalEnergy: opts.totalEnergy ?? envNum('ERP_FARM_TOTAL_ENERGY', DEFAULTS.totalEnergy),
    maxAttempts: opts.maxAttempts ?? envNum('ERP_FARM_MAX_ATTEMPTS', DEFAULTS.maxAttempts),
    retryDelayMs: opts.retryDelayMs ?? envNum('ERP_FARM_RETRY_DELAY_MS', DEFAULTS.retryDelayMs),
    handoffSleepMs:
      opts.handoffSleepMs ?? envNum('ERP_FARM_HANDOFF_SLEEP_MS', DEFAULTS.handoffSleepMs),
    travelBRetryAttempts:
      opts.travelBRetryAttempts ??
      envNum('ERP_FARM_TRAVEL_B_RETRY_ATTEMPTS', DEFAULTS.travelBRetryAttempts),
    travelBRetryDelayMs:
      opts.travelBRetryDelayMs ??
      envNum('ERP_FARM_TRAVEL_B_RETRY_DELAY_MS', DEFAULTS.travelBRetryDelayMs),
    notify: opts.notify,
  };
}

async function deployWithRetry(
  ctx: BrowserContext,
  info: FarmSessionInfo,
  target: FarmableBattle,
  sideLabel: 'invader' | 'defender',
  sideCountryId: number,
  skinId: number,
  cfg: ReturnType<typeof resolveOpts>,
): Promise<SideOutcome> {
  let lastMessage = '';
  let energyFailures = 0;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    const result = await deployWeapon(
      ctx,
      info.csrf,
      target.battleId,
      target.battleZoneId,
      sideCountryId,
      cfg.weaponQuality,
      cfg.totalEnergy,
      skinId,
    );
    if (result.success) {
      return {
        side: sideLabel,
        countryId: sideCountryId,
        attempts: attempt,
        verified: false,
        fuelLeft: result.fuelLeft,
        deploymentId: result.deploymentId,
      };
    }
    lastMessage = result.message;
    if (/forbidden/i.test(result.message)) throw new ForbiddenError(`deploy@${sideLabel}`);
    if (/already fighting/i.test(result.message)) {
      await cancelDeploy(ctx, info.csrf, target.battleId).catch(() => null);
      await sleep(cfg.retryDelayMs);
      continue;
    }
    if (/not enough energy/i.test(result.message)) energyFailures++;
    const verified = await verifyHitRegistered(
      ctx,
      info.csrf,
      target.battleId,
      target.zoneId,
      info.division,
      target.battleZoneId,
      sideCountryId,
      info.citizenId,
    ).catch(() => false);
    if (verified) {
      return {
        side: sideLabel,
        countryId: sideCountryId,
        attempts: attempt,
        verified: true,
        fuelLeft: result.fuelLeft,
        deploymentId: result.deploymentId,
      };
    }
    if (attempt < cfg.maxAttempts) await sleep(cfg.retryDelayMs);
  }
  if (energyFailures >= Math.ceil(cfg.maxAttempts / 2)) {
    throw new EnergyExhaustedError(null, lastMessage);
  }
  throw new Error(`exhausted ${cfg.maxAttempts} attempts on ${sideLabel} (last="${lastMessage}")`);
}

async function farmBothSides(
  ctx: BrowserContext,
  info: FarmSessionInfo,
  target: FarmableBattle,
  ordered: ReturnType<typeof orderSides>,
  firstTravel: TravelOption,
  secondTravel: TravelOption,
  cfg: ReturnType<typeof resolveOpts>,
): Promise<{ first: SideOutcome; second: SideOutcome; poolEnergyAfter: number | null }> {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`https://www.erepublik.com/en/military/battlefield/${target.battleId}`, {
    waitUntil: 'domcontentloaded',
  });
  await cancelDeploy(ctx, info.csrf, target.battleId).catch(() => null);

  const defaultSkin = skinForDivision(info.division);

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

  const invA = await getDeployInventory(
    ctx,
    info.csrf,
    target.battleId,
    ordered.first.countryId,
    target.battleZoneId,
  );
  const skinA = invA.skinId ?? defaultSkin;
  const resA = await deployWithRetry(
    ctx,
    info,
    target,
    ordered.first.side,
    ordered.first.countryId,
    skinA,
    cfg,
  );

  await sleep(cfg.handoffSleepMs);
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

  let travelBLastMessage = '';
  let travelBSucceeded = false;
  for (let attempt = 1; attempt <= cfg.travelBRetryAttempts; attempt++) {
    const travelB = await battlefieldTravel(
      ctx,
      info.csrf,
      target.battleId,
      target.battleZoneId,
      ordered.second.countryId,
      secondTravel.toCountryId,
      secondTravel.toRegionId,
    );
    if (travelB.success) {
      travelBSucceeded = true;
      break;
    }
    travelBLastMessage = travelB.message;
    if (attempt < cfg.travelBRetryAttempts) {
      await cancelDeploy(ctx, info.csrf, target.battleId).catch(() => null);
      await sleep(cfg.travelBRetryDelayMs);
    }
  }
  if (!travelBSucceeded) {
    throw new PartialBattleError(
      target.battleId,
      target.regionName,
      resA,
      'travel-b',
      new Error(
        `travel→${ordered.second.side} failed after ${cfg.travelBRetryAttempts} attempts: ${travelBLastMessage}`,
      ),
    );
  }

  const invB = await getDeployInventory(
    ctx,
    info.csrf,
    target.battleId,
    ordered.second.countryId,
    target.battleZoneId,
  );
  const skinB = invB.skinId ?? defaultSkin;
  let resB: SideOutcome;
  try {
    resB = await deployWithRetry(
      ctx,
      info,
      target,
      ordered.second.side,
      ordered.second.countryId,
      skinB,
      cfg,
    );
  } catch (err) {
    throw new PartialBattleError(target.battleId, target.regionName, resA, 'deploy-b', err as Error);
  }

  const invAfter = await getDeployInventory(
    ctx,
    info.csrf,
    target.battleId,
    ordered.second.countryId,
    target.battleZoneId,
  ).catch(() => null);

  return { first: resA, second: resB, poolEnergyAfter: invAfter?.poolEnergy ?? null };
}

async function runStandard(
  ctx: BrowserContext,
  info: FarmSessionInfo,
  options: FarmSessionOptions,
): Promise<FarmSessionResult> {
  const cfg = resolveOpts(options);

  const list = await listFarmableBattles(ctx, info.csrf, info.division);
  const elig = await getCitizenEligibility(ctx, info.csrf);

  const nowSec = Math.floor(Date.now() / 1000);
  const candidates = list.candidates.filter((c) => {
    if (c.invaderId === c.defenderId) return false;
    if (cfg.blockedCountries.includes(c.invaderId) || cfg.blockedCountries.includes(c.defenderId))
      return false;
    const ageMin = (nowSec - c.start) / 60;
    if (ageMin < cfg.minBattleMinutes) return false;
    const e = elig[c.battleId];
    const isInvCitizen = info.countryId === c.invaderId;
    const isDefCitizen = info.countryId === c.defenderId;
    const canFightInv = isInvCitizen || e?.isMercenary === true || e?.isFreedomFighter === true;
    const canFightDef = isDefCitizen || e?.isMercenary === true || e?.isFreedomFighter === true;
    return canFightInv && canFightDef;
  });

  candidates.sort((a, b) => {
    const aw =
      cfg.whitelistCountries.includes(a.invaderId) || cfg.whitelistCountries.includes(a.defenderId);
    const bw =
      cfg.whitelistCountries.includes(b.invaderId) || cfg.whitelistCountries.includes(b.defenderId);
    if (aw !== bw) return aw ? -1 : 1;
    return a.start - b.start;
  });

  const wins: WinSummary[] = [];
  const skipped: SkipSummary[] = [];
  const routing: RoutingState = initRoutingState(info.residenceRegionId, info.residenceCountryId);
  const remaining = [...candidates];

  let farmedCount = 0;
  let lastFuel: number | null = null;
  let lastPoolEnergy: number | null = null;
  const minEnergyPerBattle = cfg.totalEnergy * 2;
  let stopReason: StopReason = 'completed';

  if (candidates.length === 0) {
    return {
      farmedCount: 0,
      wins,
      skipped,
      stopReason: 'no-candidates',
      fuelLeftAtEnd: null,
      poolEnergyAtEnd: null,
      totalTravelCC: 0,
      hops: 0,
      sequence: '(no hops)',
    };
  }

  while (remaining.length > 0) {
    if (farmedCount >= cfg.maxBattles) {
      stopReason = 'max-battles';
      break;
    }
    if (lastFuel != null && lastFuel < cfg.minFuel) {
      stopReason = 'low-fuel';
      break;
    }
    if (lastPoolEnergy != null && lastPoolEnergy < minEnergyPerBattle) {
      stopReason = 'low-energy';
      break;
    }

    const picked = await pickNext(routing, remaining, {
      getTravel: (battleId, fromRegionId, toCountryId) =>
        findCheapestTravelRegion(ctx, info.csrf, battleId, fromRegionId, toCountryId),
      maxTravelCC: cfg.maxTravelCC,
    });
    if (!picked) {
      stopReason = 'no-reachable';
      break;
    }

    const c = picked.battle;
    const idx = remaining.indexOf(c);
    if (idx !== -1) remaining.splice(idx, 1);

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
    const firstTravel: TravelOption = {
      toCountryId: picked.firstHopCountryId,
      toRegionId: picked.firstHopRegionId,
      cost: picked.firstHopCost,
    };
    const secondTravel: TravelOption = {
      toCountryId: picked.secondHopCountryId,
      toRegionId: picked.secondHopRegionId,
      cost: picked.secondHopCost,
    };

    const header =
      `🎯 #${c.battleId} ${c.regionName} ` +
      `(Inv ${c.invaderId} vs Def ${c.defenderId}) | location=c${routing.countryId} → ` +
      `fight ${ordered.first.side} c${ordered.first.countryId} (${firstTravel.cost}cc) → ` +
      `fight ${ordered.second.side} c${ordered.second.countryId} (${secondTravel.cost}cc)`;

    if (cfg.dryRun) {
      console.log(`${header} | (dry-run)`);
      farmedCount++;
      advanceRouting(routing, c, ordered, firstTravel, secondTravel);
      continue;
    }

    console.log(header);
    try {
      const out = await farmBothSides(ctx, info, c, ordered, firstTravel, secondTravel, cfg);
      const fuelLine = out.second.fuelLeft ?? out.first.fuelLeft;
      if (fuelLine != null) lastFuel = fuelLine;
      if (out.poolEnergyAfter != null) lastPoolEnergy = out.poolEnergyAfter;

      advanceRouting(routing, c, ordered, firstTravel, secondTravel);

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
      if (e instanceof PartialBattleError) {
        const sideAVerified = e.sideA.verified ? '✅verified' : '⚠unverified';
        const alert =
          `⚠️ *Partial battle* #${e.battleId} (${e.regionName})\n` +
          `Side *${e.sideA.side}* landed (${sideAVerified}), but *${e.stage}* failed:\n` +
          `\`${e.cause.message.slice(0, 200)}\`\n` +
          `Fuel barrel spent; the other side's medal is at risk — finish manually on battlefield.`;
        await Promise.resolve(cfg.notify?.(alert)).catch(() => undefined);
        skipped.push({
          battleId: c.battleId,
          regionName: c.regionName,
          reason: `partial: ${e.stage} (${e.cause.message})`,
        });
        if (e.sideA.fuelLeft != null) lastFuel = e.sideA.fuelLeft;
        continue;
      }
      if (e instanceof ForbiddenError) {
        stopReason = 'forbidden';
        break;
      }
      if (e instanceof EnergyExhaustedError) {
        stopReason = 'energy-exhausted';
        break;
      }
      skipped.push({ battleId: c.battleId, regionName: c.regionName, reason: msg });
    }
  }

  return {
    farmedCount,
    wins,
    skipped,
    stopReason,
    fuelLeftAtEnd: lastFuel,
    poolEnergyAtEnd: lastPoolEnergy,
    totalTravelCC: routing.totalTravelCC,
    hops: routing.hops.length,
    sequence: formatSequence(routing.hops),
  };
}

export const standardStrategy: FarmStrategy = {
  id: 'standard',
  run: runStandard,
};
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS. The new file compiles; `src/farm/session.ts` still exports the same symbols and is the one actually used, so nothing is wired up yet.

- [ ] **Step 3: Commit**

```bash
git add src/farm/strategies/standard.ts
git commit -m "refactor: move runFarmSession body into strategies/standard"
```

---

## Task 3: Create the dispatcher

**Files:**
- Create: `src/farm/strategies/index.ts`

A trivial registry. Currently only `'standard'` resolves. The other two ids are accepted by the type system but throw a clear error at runtime (so Phase 5/6 work fails loudly until their strategies are wired).

- [ ] **Step 1: Create `src/farm/strategies/index.ts`**

```ts
import { standardStrategy } from './standard.js';
import type { FarmStrategy, StrategyId } from './types.js';

const registry: Partial<Record<StrategyId, FarmStrategy>> = {
  standard: standardStrategy,
  // 'd4tw' and 'maverickD3' will be added in their respective phases.
};

export function getStrategy(id: StrategyId): FarmStrategy {
  const s = registry[id];
  if (!s) {
    throw new Error(
      `farm strategy "${id}" is not registered (registered: ${Object.keys(registry).join(', ')})`,
    );
  }
  return s;
}

export type {
  FarmSessionInfo,
  FarmSessionOptions,
  FarmSessionResult,
  FarmStrategy,
  SideOutcome,
  SkipSummary,
  StopReason,
  StrategyId,
  WinSummary,
} from './types.js';
export {
  EnergyExhaustedError,
  ForbiddenError,
  PartialBattleError,
} from './types.js';
export { standardStrategy } from './standard.js';
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/farm/strategies/index.ts
git commit -m "refactor: add strategy dispatcher (only 'standard' for now)"
```

---

## Task 4: Wire `agent/runner.ts` through the dispatcher

**Files:**
- Modify: `src/agent/runner.ts:31` (import line) and `src/agent/runner.ts:323-340` (the `runFarmSession` call site)

- [ ] **Step 1: Swap the import**

Open `src/agent/runner.ts`. Find the line:

```ts
import { runFarmSession } from '../farm/session.js';
```

Replace with:

```ts
import { getStrategy } from '../farm/strategies/index.js';
```

- [ ] **Step 2: Swap the call site**

Around `src/agent/runner.ts:329`, find:

```ts
        const result = await runFarmSession(
          ctx,
          {
            csrf,
            citizenId: ctxInfo.citizenId,
            countryId,
            division: ctxInfo.division,
            residenceRegionId: ctxInfo.residenceRegionId,
            residenceCountryId,
          },
          { maxBattles: decision.battlesThisSession, notify: (m) => notifier.send(m) },
        );
```

Replace with:

```ts
        const result = await getStrategy('standard').run(
          ctx,
          {
            csrf,
            citizenId: ctxInfo.citizenId,
            countryId,
            division: ctxInfo.division,
            residenceRegionId: ctxInfo.residenceRegionId,
            residenceCountryId,
          },
          { maxBattles: decision.battlesThisSession, notify: (m) => notifier.send(m) },
        );
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/runner.ts
git commit -m "refactor: route agent runner through strategy dispatcher"
```

---

## Task 5: Wire `farmRunner.ts` through the dispatcher

**Files:**
- Modify: `src/farmRunner.ts:4` (import) and `src/farmRunner.ts:46-62` (the call)

- [ ] **Step 1: Swap the import**

Open `src/farmRunner.ts`. Find:

```ts
import { runFarmSession } from './farm/session.js';
```

Replace with:

```ts
import { getStrategy } from './farm/strategies/index.js';
```

- [ ] **Step 2: Swap the call site**

Around `src/farmRunner.ts:46`, find:

```ts
  const result = await runFarmSession(
    ctx,
    {
      csrf: raw.csrf,
      citizenId: raw.citizenId,
      countryId: raw.countryId,
      division: raw.division,
      residenceRegionId: raw.residenceRegionId,
      residenceCountryId,
    },
    {
      maxBattles: env.ERP_FARM_MAX_BATTLES,
      dryRun: !execute,
    },
  );
```

Replace with:

```ts
  const result = await getStrategy('standard').run(
    ctx,
    {
      csrf: raw.csrf,
      citizenId: raw.citizenId,
      countryId: raw.countryId,
      division: raw.division,
      residenceRegionId: raw.residenceRegionId,
      residenceCountryId,
    },
    {
      maxBattles: env.ERP_FARM_MAX_BATTLES,
      dryRun: !execute,
    },
  );
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/farmRunner.ts
git commit -m "refactor: route farmRunner through strategy dispatcher"
```

---

## Task 6: Delete the old `session.ts`

After Tasks 4 and 5, nothing imports from `src/farm/session.ts` anymore. Verify, then delete.

**Files:**
- Delete: `src/farm/session.ts`

- [ ] **Step 1: Verify no consumers remain**

Run:

```bash
grep -rn "farm/session" src/ 2>/dev/null
```

Expected: no matches.

- [ ] **Step 2: Delete the file**

```bash
git rm src/farm/session.ts
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: drop superseded farm/session.ts"
```

---

## Task 7: Smoke-test the refactor

The refactor is pure code motion, but we verify both entry points still work end-to-end on the real session profile.

**Files:** none modified — verification only.

- [ ] **Step 1: Dry-run the farm pipeline**

Run (substitute your actual account slug):

```bash
ERP_ACCOUNT_SLUG=baryga2026 npm run farmer
```

Expected log lines (no `--execute` ⇒ dry-run): the runner discovers candidates, picks battles, prints the `🎯 #...` line for each with `(dry-run)` appended, then a summary block. No exceptions. The "stop reason" should be `completed`, `max-battles`, or `no-candidates` — never anything alarming.

- [ ] **Step 2: One-shot agent cycle**

Run:

```bash
ERP_ACCOUNT_SLUG=baryga2026 npm run agent
```

Expected: a single cycle log including `[cycle] farm: ⏭ <reason>` or `[cycle] farm session: stop=<reason>, ...`. The line format must be identical to pre-refactor — if anything changed, that's a regression.

- [ ] **Step 3: No commit**

This task is verification only. If anything misbehaves, fix in a new commit (don't amend prior tasks).

---

## Self-Review Notes (for the implementer)

- Each task is independent and ends with a green typecheck. Reverting any single commit leaves the tree compiling.
- The strategy interface defined in Task 1 is intentionally narrow (`run()` only). Don't pre-emptively add `discover()` / `fight()` — wait until Phase 5 (D4-TW) shows whether they help.
- `StrategyId` includes `'d4tw'` and `'maverickD3'` as a hint to future phases, but the dispatcher throws for those today. That's the intended "fail loud" signal.
- Filesystem note: `src/farm/strategies/` is a new directory — `git add` of the files inside creates it implicitly. No `.gitkeep` needed.
- Commit prefixes match repo style (`refactor:`, `chore:`). Examine `git log --oneline -10` if unsure.
