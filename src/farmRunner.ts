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
  ERP_FARM_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
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
  invTravel: TravelOption,
  defTravel: TravelOption,
): Promise<{ invader: SideOutcome; defender: SideOutcome; poolEnergyAfter: number | null }> {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const battleUrl = `https://www.erepublik.com/en/military/battlefield/${target.battleId}`;
  await page.goto(battleUrl, { waitUntil: 'domcontentloaded' });

  // Pre-flight: clear any stale deployment session that might collide.
  await cancelDeploy(ctx, info.csrf, target.battleId).catch(() => null);

  const defaultSkin = skinForDivision(info.division);

  // ── invader ───────────────────────────────────────────────────────────────
  const travelA = await battlefieldTravel(
    ctx,
    info.csrf,
    target.battleId,
    target.battleZoneId,
    target.invaderId,
    invTravel.toCountryId,
    invTravel.toRegionId,
  );
  if (!travelA.success) throw new Error(`travel→invader: ${travelA.message}`);

  const invA = await getDeployInventory(ctx, info.csrf, target.battleId, target.invaderId, target.battleZoneId);
  const skinA = invA.skinId ?? defaultSkin;
  const resA = await deployWithRetryRunner(ctx, info.csrf, info.citizenId, info.division, target, 'invader', target.invaderId, skinA);

  // ── handoff ──────────────────────────────────────────────────────────────
  await sleep(env.ERP_FARM_HANDOFF_SLEEP_MS);
  resA.verified = await verifyHitRegistered(
    ctx,
    info.csrf,
    target.battleId,
    target.zoneId,
    info.division,
    target.battleZoneId,
    target.invaderId,
    info.citizenId,
  ).catch(() => resA.verified);
  await cancelDeploy(ctx, info.csrf, target.battleId).catch(() => null);

  // ── defender ──────────────────────────────────────────────────────────────
  const travelB = await battlefieldTravel(
    ctx,
    info.csrf,
    target.battleId,
    target.battleZoneId,
    target.defenderId,
    defTravel.toCountryId,
    defTravel.toRegionId,
  );
  if (!travelB.success) throw new Error(`travel→defender: ${travelB.message}`);

  const invB = await getDeployInventory(ctx, info.csrf, target.battleId, target.defenderId, target.battleZoneId);
  const skinB = invB.skinId ?? defaultSkin;
  const resB = await deployWithRetryRunner(ctx, info.csrf, info.citizenId, info.division, target, 'defender', target.defenderId, skinB);

  // After both deploys, peek inventory once more to get the freshest pool
  // reading. Used by the outer loop to stop before starting an unfundable
  // next battle.
  const invAfter = await getDeployInventory(ctx, info.csrf, target.battleId, target.defenderId, target.battleZoneId).catch(
    () => null,
  );

  return { invader: resA, defender: resB, poolEnergyAfter: invAfter?.poolEnergy ?? null };
}

// ── main ────────────────────────────────────────────────────────────────────

const ctx = await openSession({ accountSlug: env.ERP_ACCOUNT_SLUG, headed: env.HEADED === 'true' });
const t0 = Date.now();

try {
  const raw = await extractCitizenContext(ctx);
  if (raw.division == null || raw.citizenId == null || raw.countryId == null || raw.residenceRegionId == null) {
    throw new Error(
      `Missing citizen context: division=${raw.division}, citizenId=${raw.citizenId}, countryId=${raw.countryId}, residenceRegionId=${raw.residenceRegionId}`,
    );
  }
  const info = {
    csrf: raw.csrf,
    citizenId: raw.citizenId,
    countryId: raw.countryId,
    division: raw.division,
    residenceRegionId: raw.residenceRegionId,
  };
  console.log(`[farm-runner] citizen=${info.citizenId} country=${info.countryId} division=${info.division}`);

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

  let farmedCount = 0;
  let lastFuel: number | null = null;
  let lastPoolEnergy: number | null = null;
  const minEnergyPerBattle = env.ERP_FARM_TOTAL_ENERGY * 2; // two hits per battle
  const wins: Array<{ battleId: number; regionName: string; inv: SideOutcome; def: SideOutcome }> = [];
  const skipped: Array<{ battleId: number; regionName: string; reason: string }> = [];

  for (const c of candidates) {
    if (farmedCount >= env.ERP_FARM_MAX_BATTLES) {
      console.log(`[farm-runner] reached max-battles cap (${env.ERP_FARM_MAX_BATTLES}) — stopping`);
      break;
    }
    if (lastFuel != null && lastFuel < env.ERP_FARM_MIN_FUEL) {
      console.log(`[farm-runner] fuel ${lastFuel} below ${env.ERP_FARM_MIN_FUEL} — stopping`);
      break;
    }
    if (lastPoolEnergy != null && lastPoolEnergy < minEnergyPerBattle) {
      console.log(`[farm-runner] pool energy ${lastPoolEnergy} below ${minEnergyPerBattle} (=${env.ERP_FARM_TOTAL_ENERGY}×2) — stopping`);
      break;
    }

    // Verify empty
    const check = await isBattleDivisionEmpty(ctx, info.csrf, c.battleId, info.division, c.battleZoneId, c.zoneId).catch(
      () => null,
    );
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

    // Travel costs (both sides)
    const invTravel = await findCheapestTravelRegion(ctx, info.csrf, c.battleId, info.residenceRegionId, c.invaderId);
    const defTravel = await findCheapestTravelRegion(ctx, info.csrf, c.battleId, info.residenceRegionId, c.defenderId);
    if (!invTravel || !defTravel) {
      skipped.push({ battleId: c.battleId, regionName: c.regionName, reason: 'no travel route' });
      continue;
    }
    if (invTravel.cost > env.ERP_FARM_MAX_TRAVEL_CC || defTravel.cost > env.ERP_FARM_MAX_TRAVEL_CC) {
      skipped.push({
        battleId: c.battleId,
        regionName: c.regionName,
        reason: `travel too expensive (inv=${invTravel.cost}cc, def=${defTravel.cost}cc)`,
      });
      continue;
    }

    const header = `🎯 battle ${c.battleId} ${c.regionName} (Inv ${c.invaderId} vs Def ${c.defenderId}) | travel inv=${invTravel.cost}cc def=${defTravel.cost}cc`;
    if (!execute) {
      console.log(`${header} | (dry-run)`);
      farmedCount++; // Count toward cap so dry-run shows the same N candidates that would be farmed
      continue;
    }

    console.log(header);
    try {
      const out = await farmBattleBothSides(ctx, info, c, invTravel, defTravel);
      const fuelLine = out.defender.fuelLeft ?? out.invader.fuelLeft;
      if (fuelLine != null) lastFuel = fuelLine;
      if (out.poolEnergyAfter != null) lastPoolEnergy = out.poolEnergyAfter;
      console.log(
        `   ✅ inv: ${out.invader.attempts}att/verified=${out.invader.verified}/fuel=${out.invader.fuelLeft ?? '?'} | ` +
          `def: ${out.defender.attempts}att/verified=${out.defender.verified}/fuel=${out.defender.fuelLeft ?? '?'} | ` +
          `pool=${out.poolEnergyAfter ?? '?'}`,
      );
      farmedCount++;
      wins.push({ battleId: c.battleId, regionName: c.regionName, inv: out.invader, def: out.defender });
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
