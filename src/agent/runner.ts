import { config as loadDotenv } from 'dotenv';
import { join } from 'node:path';
import { configDir } from '../paths.js';

loadDotenv({ path: join(configDir(), '.env') });
// Fall back to default .env in cwd if config/.env wasn't found
// (developer workflow). Dotenv silently ignores missing files.
loadDotenv();

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BrowserContext } from 'playwright-core';
import { openSession, extractCitizenContext } from '../browser/session.js';
import { eRepublikDay } from '../erepublik/day.js';
import { loadOrInit, save } from '../memory/dailyState.js';
import { allSafeDailyDone, pendingActions, type DailyState } from '../memory/schema.js';
import { reconcile } from './cycle.js';
import { getMissionState } from '../tools/missions.js';
import { getObjectiveStatus, collectObjectiveRewards } from '../tools/objectives.js';
import { getWeeklyChallenge, collectWeeklyChallenge } from '../tools/weekly.js';
import { loadWeekly, saveWeekly, type WeeklyState } from '../memory/weeklyState.js';
import { TelegramNotifier } from '../telegram/notifier.js';
import { work } from '../tools/work.js';
import { train } from '../tools/train.js';
import { claimVip } from '../tools/vip.js';
import { buyOneCheapestFood } from '../tools/market.js';
import { collectMissionRewards } from '../tools/claim.js';
import { loadFuel, saveFuel, type WeeklyFuelState } from '../memory/weeklyFuelState.js';
import { decideFarming, rollNextEligibleAt } from './fuelBudget.js';
import { runFarmSession } from '../farm/session.js';
import { handleCaptchaIfPresent, type CaptchaConfig } from '../tools/captcha.js';
import { travelHome } from '../tools/travel.js';

const Env = z.object({
  ERP_ACCOUNT_SLUG: z.string().default('main'),
  ERP_COUNTRY_ID: z.coerce.number().int().positive().optional(),
  ERP_MAX_FOOD_PRICE: z.coerce.number().positive(),
  HEADED: z.enum(['true', 'false']).default('false'),
  LOOP_INTERVAL_MS: z.coerce.number().int().positive().default(600_000),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  ERP_CAPTCHA_PROVIDER: z.enum(['none', '2captcha']).default('none'),
  ERP_CAPTCHA_API_KEY: z.string().optional(),
  ERP_CAPTCHA_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  // Auto return-home (ePlus returnHome parity). Travels back to residence
  // once we've been observed outside it for at least N minutes (default 15,
  // matching ePlus). 0 disables the feature.
  ERP_RETURN_HOME_AFTER_MINUTES: z.coerce.number().int().min(0).default(15),
  // Hard ceiling on the residence-trip cost (local CC). Travel is skipped +
  // alerted when the pre-check returns a higher cost.
  ERP_RETURN_HOME_MAX_CC: z.coerce.number().int().positive().default(500),
});
type Env = z.infer<typeof Env>;

const env = Env.parse(process.env);

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');

function snapshotHash(state: DailyState, weekly: WeeklyState, fuel: WeeklyFuelState): string {
  const { lastDigestHash: _ignored, ...stateForHash } = state;
  // nextEligibleAt jitters every session and cyclesSkipped increments every
  // idle tick — both are diagnostics, not user-actionable state, so exclude
  // them from the hash to avoid spamming Telegram every 10 minutes.
  const { nextEligibleAt: _ignored2, cyclesSkipped: _ignored3, ...fuelForHash } = fuel;
  const data = JSON.stringify({ state: stateForHash, weekly, fuel: fuelForHash });
  return createHash('sha256').update(data).digest('hex').slice(0, 12);
}

function formatDigest(day: number, state: DailyState, weekly: WeeklyState, fuel: WeeklyFuelState): string {
  const a = state.completedActions;
  const flag = (v: unknown) => (v ? '✅' : '⏳');
  return [
    `*erepublik-agent* — day ${day}`,
    `Work ${flag(a.work)}  Train ${flag(a.train)}  VIP ${flag(a.vipClaim)}  Food ${flag(a.buyFood)}`,
    `Missions claimed: ${state.claimedMissionIds.join(', ') || '—'}`,
    `Chests claimed: ${state.claimedChestThresholds.join(', ') || '—'}`,
    `Weekly maxRewardId: ${weekly.lastClaimedRewardId ?? '—'}`,
    `Fuel week ${fuel.week}: spent ${fuel.spent}/70, hits ${fuel.hitsLanded}, skipped ${fuel.cyclesSkipped}`,
  ].join('\n');
}

async function runAction(
  action: 'work' | 'train' | 'vipClaim' | 'buyFood',
  ctx: BrowserContext,
  csrf: string,
  countryId: number,
  state: DailyState,
): Promise<void> {
  const at = new Date().toISOString();
  if (action === 'work') {
    const r = await work(ctx, csrf);
    if (r.success) state.completedActions.work = { at, source: 'agent' };
    console.log(`[cycle] work: ${r.success ? '✅' : '❌'} status=${r.status}`);
    return;
  }
  if (action === 'train') {
    const r = await train(ctx, csrf);
    if (r.success) state.completedActions.train = { at, source: 'agent' };
    console.log(`[cycle] train: ${r.success ? '✅' : '❌'} status=${r.status}`);
    return;
  }
  if (action === 'vipClaim') {
    const r = await claimVip(ctx, csrf);
    if (r.success) state.completedActions.vipClaim = { at, source: 'agent' };
    console.log(`[cycle] vipClaim: ${r.success ? '✅' : '❌'}`);
    return;
  }
  if (action === 'buyFood') {
    const r = await buyOneCheapestFood(ctx, csrf, countryId, env.ERP_MAX_FOOD_PRICE);
    if (r.success && r.offerId != null) {
      state.completedActions.buyFood = { at, source: 'agent', offerId: r.offerId };
    }
    const tag = r.success ? `✅ @ ${r.price}` : `⏭  ${r.reason ?? 'failed'}`;
    console.log(`[cycle] buyFood: ${tag}`);
    return;
  }
}

async function runCycle(
  ctx: BrowserContext,
  notifier: TelegramNotifier,
  captchaCfg: CaptchaConfig,
): Promise<void> {
  const day = eRepublikDay();
  const { state, rolledOver } = loadOrInit(day);
  const weekly = loadWeekly();
  const { state: fuel, rolledOver: fuelRolled } = loadFuel();
  console.log(
    `[cycle] day=${day}${rolledOver ? ' (rolled over)' : ''}` +
      `, fuel-week=${fuel.week}${fuelRolled ? ' (rolled over)' : ''}`,
  );

  // refresh: true → page.goto('/en/military/campaigns'), re-populates
  // erepublik.citizen globals and surfaces fuelLeft in the DOM.
  let ctxInfo = await extractCitizenContext(ctx, { refresh: true });

  // If eRepublik flagged the session, the captcha overlay sits on top of the page.
  // Solve it here — before any API call — and re-read context (CSRF/state may shift).
  const captcha = await handleCaptchaIfPresent(ctx, captchaCfg);
  if (captcha.detected && !captcha.solved) {
    throw new Error(`captcha blocking the session: ${captcha.reason ?? 'unsolved'}`);
  }
  if (captcha.solved) {
    console.log('[cycle] captcha solved — re-extracting citizen context');
    ctxInfo = await extractCitizenContext(ctx, { refresh: true });
  }

  const { csrf } = ctxInfo;
  const countryId = ctxInfo.countryId ?? env.ERP_COUNTRY_ID ?? null;
  if (countryId == null) {
    throw new Error('countryId not found in browser context and ERP_COUNTRY_ID env not set');
  }
  console.log(
    `[cycle] citizen: id=${ctxInfo.citizenId ?? '?'}, country=${countryId}${ctxInfo.countryId == null ? ' (from env)' : ''}` +
      `, div=${ctxInfo.division ?? '?'}, level=${ctxInfo.userLevel ?? '?'}` +
      `, energy=${ctxInfo.energy ?? '?'}/${ctxInfo.energyPoolLimit ?? '?'}` +
      `, fuel=${ctxInfo.fuelLeft ?? '?'}/${ctxInfo.maxFuel ?? '?'}` +
      `, loc=${ctxInfo.currentRegionId ?? '?'}/${ctxInfo.residenceRegionId ?? '?'} (curr/home)`,
  );

  // Track time-away-from-home (mirrors ePlus' startTimeAbroad). Update the
  // timer based on observed location every cycle; the return-home trip is
  // triggered later in the idle branch, so we don't waste it before a farm.
  if (ctxInfo.currentRegionId != null && ctxInfo.residenceRegionId != null) {
    if (ctxInfo.currentRegionId === ctxInfo.residenceRegionId) {
      if (state.awaySince != null) console.log('[cycle] at home — clearing awaySince');
      state.awaySince = null;
    } else if (state.awaySince == null) {
      state.awaySince = new Date().toISOString();
      console.log(`[cycle] abroad detected — awaySince=${state.awaySince}`);
    } else {
      const minutes = Math.round((Date.now() - new Date(state.awaySince).getTime()) / 60_000);
      console.log(`[cycle] still abroad: ${minutes}m since ${state.awaySince}`);
    }
  }

  const missions = await getMissionState(ctx, csrf);
  console.log(`[cycle] api: ${missions.total} missions, pendingSafeDaily=[${missions.pendingSafeDaily.join(', ')}]`);

  const mutated = reconcile(state, missions);
  if (mutated) console.log('[cycle] memory reconciled from API state');

  const objectives = await getObjectiveStatus(ctx, csrf);
  for (const cost of objectives.claimed) {
    if (!state.claimedChestThresholds.includes(cost)) state.claimedChestThresholds.push(cost);
  }
  console.log(`[cycle] objectives: progress=${objectives.progress}, claimed=[${objectives.claimed.join(', ')}], available=[${objectives.available.join(', ')}]`);

  const weeklyStatus = await getWeeklyChallenge(ctx, csrf);
  if (
    weeklyStatus.maxCompleted != null &&
    weekly.lastClaimedRewardId != null &&
    weeklyStatus.maxCompleted < weekly.lastClaimedRewardId
  ) {
    console.log(`[cycle] weekly: reset detected (api=${weeklyStatus.maxCompleted} < memory=${weekly.lastClaimedRewardId})`);
    weekly.lastClaimedRewardId = null;
  }
  const weeklyUnclaimed =
    weeklyStatus.maxCompleted != null && weeklyStatus.maxCompleted > (weekly.lastClaimedRewardId ?? 0);
  console.log(`[cycle] weekly: maxCompleted=${weeklyStatus.maxCompleted ?? 'none'}, lastClaimed=${weekly.lastClaimedRewardId ?? 'none'}, unclaimed=${weeklyUnclaimed}`);

  const completedMissionIds = missions.missions.filter((m) => m.completed).map((m) => m.id);
  const unclaimedMissions = completedMissionIds.filter((id) => !state.claimedMissionIds.includes(id));
  const unclaimedObjectives = objectives.available.filter((c) => !state.claimedChestThresholds.includes(c));
  const shortCircuit =
    allSafeDailyDone(state) &&
    unclaimedMissions.length === 0 &&
    unclaimedObjectives.length === 0 &&
    !weeklyUnclaimed;

  try {
    if (shortCircuit) {
      console.log('[cycle] ✅ all safe-daily flags set and no unclaimed rewards — nothing to do');
    } else {
      const pending = pendingActions(state);
      console.log(
        `[cycle] pending: [${pending.join(', ')}], unclaimedMissions: [${unclaimedMissions.join(', ')}], unclaimedObjectives: [${unclaimedObjectives.join(', ')}]`,
      );

      // 1. Run pending safe-daily actions in a fixed order.
      for (const action of pending) {
        try {
          await runAction(action, ctx, csrf, countryId, state);
        } catch (err) {
          console.error(`[cycle] ${action} threw: ${(err as Error).message}`);
        }
      }

      // 2. Idempotent sweeps — safe to call even when nothing is claimable.
      try {
        const m = await collectMissionRewards(ctx, csrf, state.claimedMissionIds);
        for (const id of m.claimed) {
          if (!state.claimedMissionIds.includes(id)) state.claimedMissionIds.push(id);
        }
        if (m.claimed.length || m.failed.length) {
          console.log(`[cycle] missions sweep: claimed=[${m.claimed.join(', ')}] failed=${m.failed.length}`);
        }
      } catch (err) {
        console.error(`[cycle] collectMissionRewards threw: ${(err as Error).message}`);
      }

      try {
        const o = await collectObjectiveRewards(ctx, csrf, state.claimedChestThresholds);
        for (const cost of o.claimed) {
          if (!state.claimedChestThresholds.includes(cost)) state.claimedChestThresholds.push(cost);
        }
        if (o.claimed.length || o.failed.length) {
          console.log(`[cycle] objectives sweep: claimed=[${o.claimed.join(', ')}] failed=${o.failed.length}`);
        }
      } catch (err) {
        console.error(`[cycle] collectObjectiveRewards threw: ${(err as Error).message}`);
      }

      try {
        const w = await collectWeeklyChallenge(ctx, csrf, weekly.lastClaimedRewardId);
        if (w.claimed && w.maxRewardId != null) {
          weekly.lastClaimedRewardId = w.maxRewardId;
          console.log(`[cycle] weekly sweep: claimed up to ${w.maxRewardId}`);
        } else if (w.reason) {
          console.log(`[cycle] weekly sweep: noop (${w.reason})`);
        }
      } catch (err) {
        console.error(`[cycle] collectWeeklyChallenge threw: ${(err as Error).message}`);
      }
    }

    // ── Farm gate ─────────────────────────────────────────────────────────────
    const fuelAtCycleStart = ctxInfo.fuelLeft ?? 0;
    const decision = decideFarming({
      weekly: fuel,
      poolEnergy: ctxInfo.energy ?? 0,
      fuelInInventory: fuelAtCycleStart,
    });
    console.log(
      `[cycle] farm: ${decision.shouldFarm ? '✅' : '⏭'} ${decision.reason} ` +
        `(week=${decision.diagnostics.weekFraction.toFixed(3)})`,
    );

    if (
      decision.shouldFarm &&
      ctxInfo.division != null &&
      ctxInfo.citizenId != null &&
      ctxInfo.residenceRegionId != null
    ) {
      const residenceCountryId = ctxInfo.residenceCountryId ?? countryId;
      try {
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
        const fuelAfter = result.fuelLeftAtEnd ?? fuelAtCycleStart;
        const consumed = Math.max(0, fuelAtCycleStart - fuelAfter);
        fuel.spent += consumed;
        const verifiedHits = result.wins.reduce(
          (acc, w) => acc + (w.inv.verified ? 1 : 0) + (w.def.verified ? 1 : 0),
          0,
        );
        fuel.hitsLanded += verifiedHits;
        fuel.lastFarmedAt = new Date().toISOString();
        fuel.nextEligibleAt = rollNextEligibleAt();
        console.log(
          `[cycle] farm session: stop=${result.stopReason}, wins=${result.wins.length}, ` +
            `consumed=${consumed} fuel (${fuelAtCycleStart}→${fuelAfter}), hits=${verifiedHits}, ` +
            `weekly=${fuel.spent}/70`,
        );
      } catch (err) {
        console.error(`[cycle] farm session threw: ${(err as Error).message}`);
      }
    } else if (!decision.shouldFarm) {
      fuel.cyclesSkipped++;

      // Idle cycle — good moment to head home if we've been abroad past the
      // threshold. Skipping when shouldFarm=true avoids paying for a round-trip
      // we'd immediately undo with the next farm session.
      if (
        env.ERP_RETURN_HOME_AFTER_MINUTES > 0 &&
        state.awaySince != null &&
        ctxInfo.residenceRegionId != null
      ) {
        const elapsedMin = (Date.now() - new Date(state.awaySince).getTime()) / 60_000;
        if (elapsedMin >= env.ERP_RETURN_HOME_AFTER_MINUTES) {
          const residenceCountryIdForHome = ctxInfo.residenceCountryId ?? countryId;
          try {
            const r = await travelHome(
              ctx,
              csrf,
              ctxInfo.residenceRegionId,
              residenceCountryIdForHome,
              { maxCostCC: env.ERP_RETURN_HOME_MAX_CC },
            );
            if (r.success) {
              state.awaySince = null;
              const costStr = r.costCC != null ? `${r.costCC}cc` : '?cc';
              console.log(
                `[cycle] returned home after ${elapsedMin.toFixed(0)}m abroad (cost=${costStr})`,
              );
              await notifier.send(
                `🏠 returned home after ${elapsedMin.toFixed(0)}m abroad (cost=${costStr})`,
              );
            } else if (!r.attempted) {
              console.log(`[cycle] return-home skipped: ${r.message}`);
              await notifier.send(`⚠️ return-home skipped: ${r.message}`);
            } else {
              console.log(`[cycle] return-home failed: ${r.message}`);
              await notifier.send(`❌ return-home failed: ${r.message}`);
            }
          } catch (err) {
            console.error(`[cycle] travelHome threw: ${(err as Error).message}`);
          }
        }
      }
    } else {
      console.log(
        `[cycle] farm gate said yes but citizen context incomplete ` +
          `(division=${ctxInfo.division}, citizenId=${ctxInfo.citizenId}, residenceRegionId=${ctxInfo.residenceRegionId}) — skipping`,
      );
    }
  } finally {
    save(state);
    saveWeekly(weekly);
    saveFuel(fuel);
  }

  const hash = snapshotHash(state, weekly, fuel);
  if (hash !== state.lastDigestHash) {
    const digest = formatDigest(day, state, weekly, fuel);
    console.log('[cycle] digest:\n' + digest);
    await notifier.send(digest);
    state.lastDigestHash = hash;
    save(state);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const ctx = await openSession({ accountSlug: env.ERP_ACCOUNT_SLUG, headed: env.HEADED === 'true' });
const notifier = new TelegramNotifier({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID });

if (env.ERP_CAPTCHA_PROVIDER !== 'none' && !env.ERP_CAPTCHA_API_KEY) {
  console.warn(
    `[runner] ERP_CAPTCHA_PROVIDER=${env.ERP_CAPTCHA_PROVIDER} but ERP_CAPTCHA_API_KEY is unset — captchas will not be auto-solved`,
  );
}
const captchaCfg: CaptchaConfig = {
  provider: env.ERP_CAPTCHA_PROVIDER,
  apiKey: env.ERP_CAPTCHA_API_KEY,
  maxAttempts: env.ERP_CAPTCHA_MAX_ATTEMPTS,
  notify: (m) => notifier.send(m),
};

let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.log('\n[runner] SIGINT received — finishing current cycle then exiting');
});

try {
  do {
    try {
      await runCycle(ctx, notifier, captchaCfg);
    } catch (err) {
      const message = (err as Error).message;
      console.error('[cycle] failed:', message);
      await notifier.sendError(message);
    }
    if (ONCE || stopping) break;
    console.log(`[runner] sleeping ${env.LOOP_INTERVAL_MS / 1000}s`);
    await sleep(env.LOOP_INTERVAL_MS);
  } while (!stopping);
} finally {
  await ctx.close();
  console.log('[runner] stopped');
}
