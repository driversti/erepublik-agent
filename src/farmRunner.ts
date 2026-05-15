import 'dotenv/config';
import { z } from 'zod';
import type { BrowserContext } from 'playwright-core';
import { openSession, extractCitizenContext } from './browser/session.js';
import {
  getCitizenEligibility,
  isBattleDivisionEmpty,
  listFarmableBattles,
  type FarmableBattle,
} from './tools/battles.js';
import {
  battlefieldTravel,
  cancelDeploy,
  deployWeapon,
  findCheapestTravelRegion,
  getDeployInventory,
  skinForDivision,
  verifyHitRegistered,
  type TravelOption,
} from './tools/farm.js';
import { advanceRouting, initRoutingState, orderSides, pickNext, type RoutingState } from './farm/routing.js';

const Env = z.object({
  ERP_ACCOUNT_SLUG: z.string().default('main'),
  HEADED: z.enum(['true', 'false']).default('false'),
  ERP_FARM_MAX_BATTLES: z.coerce.number().int().nonnegative().default(5),
  ERP_FARM_MAX_TRAVEL_CC: z.coerce.number().nonnegative().default(400),
  ERP_FARM_MIN_FUEL: z.coerce.number().int().nonnegative().default(10),
  ERP_FARM_MIN_BATTLE_MINUTES: z.coerce.number().int().nonnegative().default(5),
  ERP_FARM_BLOCKED_COUNTRIES: z.string().default(''),
  ERP_FARM_WHITELIST_COUNTRIES: z.string().default(''),
  ERP_FARM_WEAPON_QUALITY: z.coerce.number().int().default(-1),
  ERP_FARM_TOTAL_ENERGY: z.coerce.number().int().default(33),
  ERP_FARM_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
  ERP_FARM_RETRY_DELAY_MS: z.coerce.number().int().nonnegative().default(500),
  ERP_FARM_HANDOFF_SLEEP_MS: z.coerce.number().int().nonnegative().default(2000),
});
const env = Env.parse(process.env);

const args = process.argv.slice(2);
const execute = args.includes('--execute');

function parseCsvIds(s: string): number[] {
  return s
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

const blocked = parseCsvIds(env.ERP_FARM_BLOCKED_COUNTRIES);
const whitelist = parseCsvIds(env.ERP_FARM_WHITELIST_COUNTRIES);

const mode = execute ? '🔥 EXECUTE' : '🧪 DRY-RUN';
console.log(`[farm-runner] mode=${mode} max=${env.ERP_FARM_MAX_BATTLES} maxTravel=${env.ERP_FARM_MAX_TRAVEL_CC}cc minFuel=${env.ERP_FARM_MIN_FUEL}`);
console.log(`[farm-runner] weapon=Q${env.ERP_FARM_WEAPON_QUALITY} energy=${env.ERP_FARM_TOTAL_ENERGY}/hit attempts=${env.ERP_FARM_MAX_ATTEMPTS}`);
if (blocked.length) console.log(`[farm-runner] blocked countries: [${blocked.join(', ')}]`);
if (whitelist.length) console.log(`[farm-runner] whitelisted countries: [${whitelist.join(', ')}]`);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface SideOutcome {
  side: 'invader' | 'defender';
  countryId: number;
  attempts: number;
  verified: boolean;
  fuelLeft: number | null;
  deploymentId: number | null;
}

class ForbiddenError extends Error {
  constructor(public readonly endpoint: string) {
    super(`eRepublik returned "Forbidden" on ${endpoint} — IP/account flagged`);
    this.name = 'ForbiddenError';
  }
}

class EnergyExhaustedError extends Error {
  constructor(public readonly poolEnergy: number | null, public readonly lastMessage?: string) {
    super(
      `Pool energy exhausted (poolEnergy=${poolEnergy ?? '?'}, last message="${lastMessage ?? ''}") — runner stopping`,
    );
    this.name = 'EnergyExhaustedError';
  }
}

async function deployWithRetryRunner(
  ctx: BrowserContext,
  csrf: string,
  citizenId: number,
  division: number,
  target: FarmableBattle,
  sideLabel: 'invader' | 'defender',
  sideCountryId: number,
  skinId: number,
): Promise<SideOutcome> {
  let lastMessage = '';
  let energyFailures = 0;
  for (let attempt = 1; attempt <= env.ERP_FARM_MAX_ATTEMPTS; attempt++) {
    const result = await deployWeapon(
      ctx,
      csrf,
      target.battleId,
      target.battleZoneId,
      sideCountryId,
      env.ERP_FARM_WEAPON_QUALITY,
      env.ERP_FARM_TOTAL_ENERGY,
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
    if (/forbidden/i.test(result.message)) {
      throw new ForbiddenError(`deploy@${sideLabel}`);
    }
    if (/already fighting/i.test(result.message)) {
      await cancelDeploy(ctx, csrf, target.battleId).catch(() => null);
      await sleep(env.ERP_FARM_RETRY_DELAY_MS);
      continue;
    }
    if (/not enough energy/i.test(result.message)) energyFailures++;
    // For "Not enough energy" and similar transient/cooldown errors, verify
    // whether the hit slipped through anyway, otherwise retry after delay.
    const verified = await verifyHitRegistered(
      ctx,
      csrf,
      target.battleId,
      target.zoneId,
      division,
      target.battleZoneId,
      sideCountryId,
      citizenId,
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
    if (attempt < env.ERP_FARM_MAX_ATTEMPTS) await sleep(env.ERP_FARM_RETRY_DELAY_MS);
  }
  // If we exhausted all attempts AND most of them were "not enough energy",
  // the pool is dry — escalate so the runner can abort the entire run.
  if (energyFailures >= Math.ceil(env.ERP_FARM_MAX_ATTEMPTS / 2)) {
    throw new EnergyExhaustedError(null, lastMessage);
  }
  throw new Error(`exhausted ${env.ERP_FARM_MAX_ATTEMPTS} attempts on ${sideLabel} (last="${lastMessage}")`);
}

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

// ── main ────────────────────────────────────────────────────────────────────

const ctx = await openSession({ accountSlug: env.ERP_ACCOUNT_SLUG, headed: env.HEADED === 'true' });
const t0 = Date.now();

try {
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

  const list = await listFarmableBattles(ctx, info.csrf, info.division);
  const elig = await getCitizenEligibility(ctx, info.csrf);
  console.log(`[farm-runner] ${list.candidates.length}/${list.total} battles match division ${info.division} + wall.dom=50`);

  // Filter
  const nowSec = Math.floor(Date.now() / 1000);
  const candidates = list.candidates.filter((c) => {
    if (c.invaderId === c.defenderId) return false;
    if (blocked.includes(c.invaderId) || blocked.includes(c.defenderId)) return false;
    const ageMin = (nowSec - c.start) / 60;
    if (ageMin < env.ERP_FARM_MIN_BATTLE_MINUTES) return false;
    const e = elig[c.battleId];
    const isInvCitizen = info.countryId === c.invaderId;
    const isDefCitizen = info.countryId === c.defenderId;
    const canFightInv = isInvCitizen || e?.isMercenary === true || e?.isFreedomFighter === true;
    const canFightDef = isDefCitizen || e?.isMercenary === true || e?.isFreedomFighter === true;
    return canFightInv && canFightDef;
  });

  // Sort: whitelisted first, then oldest battles first (more stable)
  candidates.sort((a, b) => {
    const aw = whitelist.includes(a.invaderId) || whitelist.includes(a.defenderId);
    const bw = whitelist.includes(b.invaderId) || whitelist.includes(b.defenderId);
    if (aw !== bw) return aw ? -1 : 1;
    return a.start - b.start;
  });

  console.log(`[farm-runner] ${candidates.length} fightable after filters (blocked/eligibility/age)`);

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
    const idx = remaining.indexOf(c);
    if (idx !== -1) remaining.splice(idx, 1);

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
      advanceRouting(routing, c, ordered, firstTravel, secondTravel);
      continue;
    }

    console.log(header);
    try {
      const out = await farmBattleBothSides(ctx, info, c, ordered, firstTravel, secondTravel);
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
} finally {
  await ctx.close();
}
