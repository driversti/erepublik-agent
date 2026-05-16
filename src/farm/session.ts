import type { BrowserContext } from 'playwright-core';
import {
  getCitizenEligibility,
  isBattleDivisionEmpty,
  listFarmableBattles,
  type FarmableBattle,
} from '../tools/battles.js';
import {
  battlefieldTravel,
  cancelDeploy,
  deployWeapon,
  findCheapestTravelRegion,
  getDeployInventory,
  skinForDivision,
  verifyHitRegistered,
  type TravelOption,
} from '../tools/farm.js';
import {
  advanceRouting,
  formatSequence,
  initRoutingState,
  orderSides,
  pickNext,
  type RoutingState,
} from './routing.js';

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
    minBattleMinutes: opts.minBattleMinutes ?? envNum('ERP_FARM_MIN_BATTLE_MINUTES', DEFAULTS.minBattleMinutes),
    blockedCountries: opts.blockedCountries ?? parseCsvIds(env.ERP_FARM_BLOCKED_COUNTRIES),
    whitelistCountries: opts.whitelistCountries ?? parseCsvIds(env.ERP_FARM_WHITELIST_COUNTRIES),
    weaponQuality: opts.weaponQuality ?? envNum('ERP_FARM_WEAPON_QUALITY', DEFAULTS.weaponQuality),
    totalEnergy: opts.totalEnergy ?? envNum('ERP_FARM_TOTAL_ENERGY', DEFAULTS.totalEnergy),
    maxAttempts: opts.maxAttempts ?? envNum('ERP_FARM_MAX_ATTEMPTS', DEFAULTS.maxAttempts),
    retryDelayMs: opts.retryDelayMs ?? envNum('ERP_FARM_RETRY_DELAY_MS', DEFAULTS.retryDelayMs),
    handoffSleepMs: opts.handoffSleepMs ?? envNum('ERP_FARM_HANDOFF_SLEEP_MS', DEFAULTS.handoffSleepMs),
    travelBRetryAttempts:
      opts.travelBRetryAttempts ?? envNum('ERP_FARM_TRAVEL_B_RETRY_ATTEMPTS', DEFAULTS.travelBRetryAttempts),
    travelBRetryDelayMs:
      opts.travelBRetryDelayMs ?? envNum('ERP_FARM_TRAVEL_B_RETRY_DELAY_MS', DEFAULTS.travelBRetryDelayMs),
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

  const invA = await getDeployInventory(ctx, info.csrf, target.battleId, ordered.first.countryId, target.battleZoneId);
  const skinA = invA.skinId ?? defaultSkin;
  const resA = await deployWithRetry(ctx, info, target, ordered.first.side, ordered.first.countryId, skinA, cfg);

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
      new Error(`travel→${ordered.second.side} failed after ${cfg.travelBRetryAttempts} attempts: ${travelBLastMessage}`),
    );
  }

  const invB = await getDeployInventory(ctx, info.csrf, target.battleId, ordered.second.countryId, target.battleZoneId);
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

/**
 * Run a single farm session: discover candidates, route through them, deploy
 * both sides per battle until a stop condition fires. Returns a summary;
 * the caller is responsible for persisting fuel/medal accounting.
 *
 * Stop conditions: `maxBattles` reached, fuel < `minFuel`, pool < 2× per-hit,
 * Forbidden response, energy exhausted, or no battle reachable within the
 * per-hop travel ceiling.
 */
export async function runFarmSession(
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
    if (cfg.blockedCountries.includes(c.invaderId) || cfg.blockedCountries.includes(c.defenderId)) return false;
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
    const aw = cfg.whitelistCountries.includes(a.invaderId) || cfg.whitelistCountries.includes(a.defenderId);
    const bw = cfg.whitelistCountries.includes(b.invaderId) || cfg.whitelistCountries.includes(b.defenderId);
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
        // Side A's fuel barrel is already spent — keep tracking by reading the
        // most recent fuelLeft from sideA before continuing.
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
