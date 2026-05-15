import 'dotenv/config';
import { z } from 'zod';
import { openSession, extractCitizenContext } from './browser/session.js';
import { getCitizenEligibility, isBattleDivisionEmpty, listFarmableBattles } from './tools/battles.js';
import {
  battlefieldTravel,
  cancelDeploy,
  deployWeapon,
  findCheapestTravelRegion,
  getDeployInventory,
  skinForDivision,
  verifyHitRegistered,
} from './tools/farm.js';

const Env = z.object({
  ERP_ACCOUNT_SLUG: z.string().default('main'),
  HEADED: z.enum(['true', 'false']).default('false'),
  ERP_FARM_MAX_TRAVEL_CC: z.coerce.number().nonnegative().default(20),
});
const env = Env.parse(process.env);

const args = process.argv.slice(2);
const battleIdArg = args.find((a) => a.startsWith('--battle='))?.split('=')[1];
const sideArg = args.find((a) => a.startsWith('--side='))?.split('=')[1] as 'invader' | 'defender' | 'both' | undefined;
const side: 'invader' | 'defender' | 'both' = sideArg ?? 'both';
const execute = args.includes('--execute');
const skipEmptyCheck = args.includes('--skip-empty-check');

if (!battleIdArg) {
  console.error('Usage: npm run farm-one -- --battle=<battleId> [--execute] [--skip-empty-check] [--side=invader|defender|both]');
  process.exit(1);
}
if (!['invader', 'defender', 'both'].includes(side)) {
  console.error(`Invalid --side=${sideArg} (use invader, defender, or both)`);
  process.exit(1);
}
const battleId = Number(battleIdArg);
if (!Number.isInteger(battleId) || battleId <= 0) {
  console.error(`Invalid --battle=${battleIdArg}`);
  process.exit(1);
}

const WEAPON_QUALITY = -1;
// No-weapon hits cost 33 energy. With Q10 bazookas it drops to 11, but those are
// premium items so we stay on the cheap no-weapon path for medal farming.
const TOTAL_ENERGY = 33;
// Hits aren't always accepted on the first try; retry until verification confirms
// the leaderboard shows our citizen.
const MAX_HIT_ATTEMPTS = 5;
const RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const mode = execute ? '🔥 EXECUTE' : '🧪 DRY-RUN';
console.log(`[farm-one] mode=${mode} battle=${battleId} weapon=Q${WEAPON_QUALITY} energy=${TOTAL_ENERGY}/hit`);

const ctx = await openSession({ accountSlug: env.ERP_ACCOUNT_SLUG, headed: env.HEADED === 'true' });

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`  → ${label} … `);
  try {
    const t0 = Date.now();
    const result = await fn();
    console.log(`ok (${Date.now() - t0}ms)`);
    return result;
  } catch (err) {
    console.log(`FAILED: ${(err as Error).message}`);
    throw err;
  }
}

interface DeployContext {
  csrf: string;
  battleId: number;
  battleZoneId: number;
  zoneId: number;
  division: number;
  citizenId: number;
}

async function deployWithRetry(
  ctxBrowser: import('playwright-core').BrowserContext,
  dctx: DeployContext,
  sideLabel: string,
  sideCountryId: number,
  skinId: number,
): Promise<{ fuelLeft: number | null; deploymentId: number | null; attempts: number; verified: boolean }> {
  for (let attempt = 1; attempt <= MAX_HIT_ATTEMPTS; attempt++) {
    const tag = `deploy @ ${sideLabel} attempt ${attempt}/${MAX_HIT_ATTEMPTS}`;
    const result = await step(tag, () =>
      deployWeapon(
        ctxBrowser,
        dctx.csrf,
        dctx.battleId,
        dctx.battleZoneId,
        sideCountryId,
        WEAPON_QUALITY,
        TOTAL_ENERGY,
        skinId,
      ),
    );
    if (result.success) {
      return { fuelLeft: result.fuelLeft, deploymentId: result.deploymentId, attempts: attempt, verified: false };
    }
    console.log(`    server said: "${result.message}"`);

    // "Forbidden" → IP/account flagged by eRepublik's bot detection. Retrying
    // only makes it worse — abort immediately so the user can swap IP.
    if (/forbidden/i.test(result.message)) {
      throw new Error(
        `eRepublik returned "Forbidden" on attempt ${attempt}. This almost always means the IP/account is flagged ` +
          `("red IP" — bot detection / captcha state). Stop, swap IP/wait for cooldown, then retry. Aborting to ` +
          `avoid further blacklist accrual.`,
      );
    }

    // "Already fighting" → stale deployment from a previous attempt. Cancel and retry.
    if (/already fighting/i.test(result.message)) {
      const c = await cancelDeploy(ctxBrowser, dctx.csrf, dctx.battleId).catch(() => ({ error: true, message: '' }));
      console.log(`    → cancelled stale deploy (${c.error ? 'noop' : 'ok'})`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    const verified = await verifyHitRegistered(
      ctxBrowser,
      dctx.csrf,
      dctx.battleId,
      dctx.zoneId,
      dctx.division,
      dctx.battleZoneId,
      sideCountryId,
      dctx.citizenId,
    );
    if (verified) {
      console.log(`    ✅ hit verified on leaderboard despite error`);
      return { fuelLeft: result.fuelLeft, deploymentId: result.deploymentId, attempts: attempt, verified: true };
    }

    if (attempt < MAX_HIT_ATTEMPTS) {
      console.log(`    retry in ${RETRY_DELAY_MS}ms`);
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(`Failed to register hit on ${sideLabel} after ${MAX_HIT_ATTEMPTS} attempts`);
}

try {
  const info = await extractCitizenContext(ctx);
  if (info.division == null || info.citizenId == null || info.residenceRegionId == null) {
    throw new Error(
      `Missing citizen context: division=${info.division}, citizenId=${info.citizenId}, residenceRegionId=${info.residenceRegionId}`,
    );
  }
  console.log(
    `[farm-one] citizen=${info.citizenId} country=${info.countryId} division=${info.division} residenceRegion=${info.residenceRegionId}`,
  );

  // Find the target battle in the campaign list and pick the entry for our division.
  const list = await listFarmableBattles(ctx, info.csrf, info.division);
  const target = list.candidates.find((c) => c.battleId === battleId);
  if (!target) {
    throw new Error(
      `Battle ${battleId} not found among farmable candidates for division ${info.division} ` +
        `(${list.candidates.length} candidates in ${list.total} active battles). ` +
        `Either the battle does not exist, is not in your division, has wall.dom != 50, or has ended.`,
    );
  }
  console.log(
    `[farm-one] target: ${target.regionName} (Inv ${target.invaderId} vs Def ${target.defenderId}) ` +
      `battleZoneId=${target.battleZoneId} zoneId=${target.zoneId} wallFor=${target.wallFor} dom=${target.wallDom}`,
  );

  // Eligibility check: we need to be able to deploy on BOTH sides.
  // - citizen of one side  → can fight that side natively
  // - isMercenary=true     → can fight either side
  // - isFreedomFighter     → only useful in resistance wars (this isn't one)
  const elig = await getCitizenEligibility(ctx, info.csrf);
  const e = elig[target.battleId];
  const isInvaderCitizen = info.countryId === target.invaderId;
  const isDefenderCitizen = info.countryId === target.defenderId;
  const canFightInvader = isInvaderCitizen || (e?.isMercenary === true) || (e?.isFreedomFighter === true);
  const canFightDefender = isDefenderCitizen || (e?.isMercenary === true) || (e?.isFreedomFighter === true);
  console.log(
    `[farm-one] eligibility: invader=${canFightInvader} defender=${canFightDefender} ` +
      `(citizenOfInv=${isInvaderCitizen}, citizenOfDef=${isDefenderCitizen}, ` +
      `isMercenary=${e?.isMercenary ?? '?'}, isFreedomFighter=${e?.isFreedomFighter ?? '?'})`,
  );
  const farmInvader = side === 'invader' || side === 'both';
  const farmDefender = side === 'defender' || side === 'both';
  if (farmInvader && !canFightInvader) {
    throw new Error(`Cannot deploy on invader side and --side=${side} requires it.`);
  }
  if (farmDefender && !canFightDefender) {
    throw new Error(`Cannot deploy on defender side and --side=${side} requires it.`);
  }
  console.log(`[farm-one] side selector: will farm invader=${farmInvader} defender=${farmDefender}`);

  if (!skipEmptyCheck) {
    const check = await isBattleDivisionEmpty(
      ctx,
      info.csrf,
      target.battleId,
      info.division,
      target.battleZoneId,
      target.zoneId,
    );
    if (!check.isEmpty) {
      throw new Error(
        `Division is NOT empty (zoneFinished=${check.zoneFinished}, domination=${check.domination}). Aborting to avoid hitting a contested battle.`,
      );
    }
    console.log(`[farm-one] empty-check ✅ (domination=${check.domination ?? '?'}, wallFor=${check.wallFor ?? '?'})`);
  } else {
    console.log('[farm-one] empty-check skipped via --skip-empty-check');
  }

  // Get travel costs for both sides.
  const invTravel = await findCheapestTravelRegion(
    ctx,
    info.csrf,
    target.battleId,
    info.residenceRegionId,
    target.invaderId,
  );
  const defTravel = await findCheapestTravelRegion(
    ctx,
    info.csrf,
    target.battleId,
    info.residenceRegionId,
    target.defenderId,
  );
  if (!invTravel) throw new Error(`No travel route to invader country ${target.invaderId}`);
  if (!defTravel) throw new Error(`No travel route to defender country ${target.defenderId}`);
  console.log(
    `[farm-one] travel costs: invader (country=${target.invaderId}, region=${invTravel.toRegionId})=${invTravel.cost}cc, ` +
      `defender (country=${target.defenderId}, region=${defTravel.toRegionId})=${defTravel.cost}cc`,
  );
  if (invTravel.cost > env.ERP_FARM_MAX_TRAVEL_CC || defTravel.cost > env.ERP_FARM_MAX_TRAVEL_CC) {
    throw new Error(
      `Travel cost above ceiling (max=${env.ERP_FARM_MAX_TRAVEL_CC}cc): inv=${invTravel.cost}, def=${defTravel.cost}`,
    );
  }

  // Pre-flight inventory peek (skin + energy hint). Note: the weapons list is
  // not authoritative until we've actually traveled to the side, so we don't
  // validate the no-weapon option here — the deploy-with-retry loop will surface
  // any real error.
  const defaultSkin = skinForDivision(info.division);
  const inv = await getDeployInventory(ctx, info.csrf, target.battleId, target.invaderId, target.battleZoneId);
  const effectiveSkin = inv.skinId ?? defaultSkin;
  const skinSource = inv.skinId != null ? 'active vehicle' : `division-default (${defaultSkin})`;
  if (inv.poolEnergy > 0 && inv.poolEnergy < TOTAL_ENERGY * 2) {
    throw new Error(`Insufficient pool energy: ${inv.poolEnergy} (need ${TOTAL_ENERGY * 2} for two hits)`);
  }
  if (inv.poolEnergy > 0 && inv.poolEnergy < TOTAL_ENERGY * 4) {
    console.log(
      `[farm-one] ⚠️  pool energy ${inv.poolEnergy} below the ${TOTAL_ENERGY * 4} comfortable margin (retries may exhaust energy)`,
    );
  }
  if (inv.poolEnergy === 0) {
    console.log(`[farm-one] note: pool energy reported as 0 — likely because inventory peek is pre-travel`);
  }
  console.log(`[farm-one] inventory peek: skinId=${effectiveSkin} (${skinSource}) poolEnergy=${inv.poolEnergy} hasNoWeapon=${inv.hasNoWeaponOption}`);

  if (!execute) {
    console.log('');
    console.log('🧪 DRY-RUN — would perform the following sequence:');
    console.log(
      `  1. battlefieldTravel → invader side (country=${target.invaderId}, region=${invTravel.toRegionId}, cost=${invTravel.cost}cc)`,
    );
    console.log(
      `  2. deployWeapon → invader side (Q${WEAPON_QUALITY}, ${TOTAL_ENERGY} energy/hit, skin=${effectiveSkin}, up to ${MAX_HIT_ATTEMPTS} attempts until leaderboard verifies)`,
    );
    console.log(
      `  3. battlefieldTravel → defender side (country=${target.defenderId}, region=${defTravel.toRegionId}, cost=${defTravel.cost}cc)`,
    );
    console.log(
      `  4. deployWeapon → defender side (Q${WEAPON_QUALITY}, ${TOTAL_ENERGY} energy/hit, skin=${effectiveSkin}, up to ${MAX_HIT_ATTEMPTS} attempts until leaderboard verifies)`,
    );
    console.log('');
    console.log(
      `Rerun with --execute to actually farm. Expected cost: ${invTravel.cost + defTravel.cost}cc + ` +
        `${TOTAL_ENERGY * 2} energy (best case; retries may consume more if hits don't register).`,
    );
    process.exit(0);
  }

  // ── EXECUTE PATH ──────────────────────────────────────────────────────────
  console.log('');
  console.log('🔥 EXECUTING…');

  // Navigate the open page to the battlefield URL so all subsequent fetch()
  // calls carry Referer = battlefield URL (browser-enforced, not settable
  // programmatically). This matches what a human user's browser sends when
  // clicking "fight" from the battle page.
  const battlePage = ctx.pages()[0] ?? (await ctx.newPage());
  const battleUrl = `https://www.erepublik.com/en/military/battlefield/${target.battleId}`;
  await step(`navigate page → ${battleUrl}`, () => battlePage.goto(battleUrl, { waitUntil: 'domcontentloaded' }));

  // Precautionary cancel: clear any stuck deployment session from a previous
  // run. Idempotent — silently ok if nothing was active.
  const cancelPre = await cancelDeploy(ctx, info.csrf, target.battleId).catch(
    (e) => ({ error: true, message: String(e) }),
  );
  console.log(`  → cancel-deploy (pre-flight): ${cancelPre.error ? `noop (${cancelPre.message})` : 'ok'}`);

  const dctx: DeployContext = {
    csrf: info.csrf,
    battleId: target.battleId,
    battleZoneId: target.battleZoneId,
    zoneId: target.zoneId,
    division: info.division,
    citizenId: info.citizenId,
  };

  let resA: Awaited<ReturnType<typeof deployWithRetry>> | null = null;
  let resB: Awaited<ReturnType<typeof deployWithRetry>> | null = null;

  if (farmInvader) {
    const travelA = await step(`travel → invader country=${target.invaderId} region=${invTravel.toRegionId}`, () =>
      battlefieldTravel(
        ctx,
        info.csrf,
        target.battleId,
        target.battleZoneId,
        target.invaderId,
        invTravel.toCountryId,
        invTravel.toRegionId,
      ),
    );
    if (!travelA.success) throw new Error(`Travel to invader failed: ${travelA.message}`);

    const invA = await step('refresh inventory @ invader', () =>
      getDeployInventory(ctx, info.csrf, target.battleId, target.invaderId, target.battleZoneId),
    );
    const skinA = invA.skinId ?? defaultSkin;
    console.log(
      `    invader-side inventory: poolEnergy=${invA.poolEnergy} skinId=${skinA} hasNoWeapon=${invA.hasNoWeaponOption}`,
    );

    resA = await deployWithRetry(ctx, dctx, 'invader', target.invaderId, skinA);
    console.log(
      `    invader done: attempts=${resA.attempts} verified=${resA.verified} fuelLeft=${resA.fuelLeft ?? '?'} deploymentId=${resA.deploymentId ?? '?'}`,
    );

    if (farmDefender) {
      // Side-handoff: wait for invader's startDeploy to finish processing its
      // queued energy, then verify the hit landed on the leaderboard, then
      // cancel the (now-idle) deployment session so defender's deploy doesn't
      // collide with "already fighting in this battle".
      console.log('  → side-handoff: settle invader deployment before defender travel');
      await sleep(2000);
      const verified = await verifyHitRegistered(
        ctx,
        info.csrf,
        target.battleId,
        target.zoneId,
        info.division,
        target.battleZoneId,
        target.invaderId,
        info.citizenId,
      ).catch(() => false);
      console.log(`    invader hit on leaderboard: ${verified ? '✅ verified' : '⚠️  not seen (deployment may still be queueing)'}`);
      const cancelMid = await cancelDeploy(ctx, info.csrf, target.battleId).catch(
        (e) => ({ error: true, message: String(e) }),
      );
      console.log(`    cancel invader deploy session: ${cancelMid.error ? `noop (${cancelMid.message})` : 'ok'}`);
    }
  }

  if (farmDefender) {
    const travelB = await step(`travel → defender country=${target.defenderId} region=${defTravel.toRegionId}`, () =>
      battlefieldTravel(
        ctx,
        info.csrf,
        target.battleId,
        target.battleZoneId,
        target.defenderId,
        defTravel.toCountryId,
        defTravel.toRegionId,
      ),
    );
    if (!travelB.success) throw new Error(`Travel to defender failed: ${travelB.message}`);

    const invB = await step('refresh inventory @ defender', () =>
      getDeployInventory(ctx, info.csrf, target.battleId, target.defenderId, target.battleZoneId),
    );
    const skinB = invB.skinId ?? defaultSkin;
    console.log(
      `    defender-side inventory: poolEnergy=${invB.poolEnergy} skinId=${skinB} hasNoWeapon=${invB.hasNoWeaponOption}`,
    );

    resB = await deployWithRetry(ctx, dctx, 'defender', target.defenderId, skinB);
    console.log(
      `    defender done: attempts=${resB.attempts} verified=${resB.verified} fuelLeft=${resB.fuelLeft ?? '?'} deploymentId=${resB.deploymentId ?? '?'}`,
    );
  }

  console.log('');
  const summary: string[] = [];
  if (resA) summary.push(`invader: ${resA.attempts} attempt${resA.attempts === 1 ? '' : 's'}`);
  if (resB) summary.push(`defender: ${resB.attempts} attempt${resB.attempts === 1 ? '' : 's'}`);
  console.log(`✅ farmed battle ${target.battleId} (${target.regionName}) — ${summary.join(', ')}`);
} finally {
  await ctx.close();
}
