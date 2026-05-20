import { config as loadDotenv } from 'dotenv';
import { join } from 'node:path';
import { configDir } from '../paths.js';

loadDotenv({ path: join(configDir(), '.env') });
// Fall back to default .env in cwd if config/.env wasn't found
// (developer workflow). Dotenv silently ignores missing files.
loadDotenv();

import { z } from 'zod';
import type { BrowserContext } from 'playwright-core';
import { openSession, extractCitizenContext } from '../browser/session.js';
import { effectiveMode } from './modeSelector.js';
import { eRepublikDay } from '../erepublik/day.js';
import { allSafeDailyDone, pendingActions } from '../memory/schema.js';
import { reconcile } from './cycle.js';
import { getMissionState } from '../tools/missions.js';
import { getObjectiveStatus, collectObjectiveRewards } from '../tools/objectives.js';
import { getWeeklyChallenge, collectWeeklyChallenge } from '../tools/weekly.js';
import { TelegramNotifier } from '../telegram/notifier.js';
import { collectMissionRewards } from '../tools/claim.js';
import { runAction } from './actions.js';
import { snapshotHash, formatDigest } from './digests.js';
import { initAppEnvironment } from './appInit.js';
import { defaultStateProviders, type StateProviders } from './stateProviders.js';
import { reconcileSpentWithInventory } from '../memory/weeklyFuelState.js';
import { decideFarming, rollNextEligibleAt } from './fuelBudget.js';
import { getStrategy } from '../farm/strategies/index.js';
import { loadSettings, saveSettings } from '../ui/settingsStore.js';
import { handleCaptchaIfPresent, type CaptchaConfig } from '../tools/captcha.js';
import { travelHome, travelToCountry } from '../tools/travel.js';
import { listMyCountryActiveBattles } from '../tools/battles.js';
import { loadInventory, resolveWeapon } from '../farm/strategies/inventory.js';
import { estimateMinEnergy, AIR_WEAPON_TYPE, AIR_DIVISION } from '../farm/strategies/d4twAir.js';
import type { InventoryWeapon } from '../tools/pickWeapon.js';
import { startUiServer } from '../ui/server.js';
import { createSnapshot, type UiSnapshot } from '../ui/snapshot.js';
import { sleepUntilWake } from '../ui/sleepUntilWake.js';
import { appendHistory } from '../ui/historyStore.js';
import { createStopController } from './stopController.js';
import { attachElectronBridge, type IpcPort } from './electronBridge.js';

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
  // ERP_RETURN_HOME_AFTER_MINUTES and ERP_RETURN_HOME_MAX_CC are seed-only:
  // they populate `settings.travel.*` on first run (see `settingsStore.ts`).
  // The runner reads from settings.json at runtime so UI edits take effect.
  ERP_FILE_LOGGING: z.enum(['true', 'false']).default('false'),
});
type Env = z.infer<typeof Env>;

const env = Env.parse(process.env);

initAppEnvironment({ fileLoggingEnabled: env.ERP_FILE_LOGGING === 'true' });

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');


/**
 * Run one daily cycle. Uses the module-level `bridge` (electronBridge)
 * for IPC emits; callers must ensure `bridge` is initialized before
 * invoking this function (which is true for the standard runner flow,
 * since the cycle loop runs after the top-level `await` chain that
 * initializes the bridge).
 */
async function runCycle(
  ctx: BrowserContext,
  notifier: TelegramNotifier,
  captchaCfg: CaptchaConfig,
  uiSnapshot: UiSnapshot,
  providers: StateProviders = defaultStateProviders,
): Promise<void> {
  const day = eRepublikDay();
  uiSnapshot.lastCycleStartedAt = new Date().toISOString();
  uiSnapshot.day = day;
  let lastDecisionReason: string | null = null;
  let lastWeekFuelTarget = 0;
  const { state, rolledOver } = providers.loadDaily(day);
  const weekly = providers.loadWeekly();
  const { state: fuel, rolledOver: fuelRolled } = providers.loadFuel();
  console.log(
    `[cycle] day=${day}${rolledOver ? ' (rolled over)' : ''}` +
      `, fuel-week=${fuel.week}${fuelRolled ? ' (rolled over)' : ''}`,
  );

  const settings = loadSettings();
  if (settings.paused) {
    uiSnapshot.lastUpdatedAt = Date.now();
    uiSnapshot.settings = settings;
    uiSnapshot.lastFarmReason = 'paused';
    // Skip BEFORE extractCitizenContext to avoid hammering the page every
    // LOOP_INTERVAL_MS while paused. Trade-off: if a captcha appears during
    // the paused window, it won't be detected until the operator unpauses
    // and the first post-unpause cycle fails (captcha-corrupted CSRF). The
    // runner self-heals on the next cycle. If captcha-while-paused becomes a
    // real-world problem, move extractCitizenContext + handleCaptchaIfPresent
    // above this check.
    console.log('[cycle] paused — skipping (toggle in config/settings.json or UI)');
    appendHistory({ type: 'cycle', reason: 'paused' });
    return;
  }

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

  let { csrf } = ctxInfo;
  const countryId = ctxInfo.countryId ?? env.ERP_COUNTRY_ID ?? null;
  if (countryId == null) {
    throw new Error('countryId not found in browser context and ERP_COUNTRY_ID env not set');
  }
  const nameTag = ctxInfo.name ? `${ctxInfo.name} (${env.ERP_ACCOUNT_SLUG})` : env.ERP_ACCOUNT_SLUG;
  console.log(
    `[cycle] citizen: ${nameTag}, id=${ctxInfo.citizenId ?? '?'}, country=${countryId}${ctxInfo.countryId == null ? ' (from env)' : ''}` +
      `, div=${ctxInfo.division ?? '?'}, level=${ctxInfo.userLevel ?? '?'}` +
      `, energy=${ctxInfo.energy ?? '?'}/${ctxInfo.energyPoolLimit ?? '?'}` +
      `, fuel=${ctxInfo.fuelLeft ?? '?'}/${ctxInfo.maxFuel ?? '?'}` +
      `, loc=${ctxInfo.currentRegionId ?? '?'}/${ctxInfo.residenceRegionId ?? '?'} (curr/home)`,
  );

  // Mirror current detected state into settings.detected so the UI can show it.
  // (Schema in settingsStore.ts; runner is the only writer.)
  settings.detected = {
    division: ctxInfo.division,
    hasMaverick: ctxInfo.hasMaverick,
    airRankNumber: ctxInfo.airRankNumber,
    citizenId: ctxInfo.citizenId,
    countryId: ctxInfo.countryId,
    lastUpdated: new Date().toISOString(),
  };
  try {
    saveSettings(settings);
  } catch (err) {
    console.warn(`[cycle] saveSettings(detected) failed: ${(err as Error).message}`);
  }

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
          await runAction(action, ctx, csrf, countryId, state, {
            autoEmploy: settings.autoEmploy,
            maxFoodPrice: env.ERP_MAX_FOOD_PRICE,
            notify: (m) => notifier.send(m),
          });
        } catch (err) {
          const msg = `[cycle] ${action} threw: ${(err as Error).message}`;
          console.error(msg);
          bridge.emitLog('error', msg);
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
        const msg = `[cycle] collectMissionRewards threw: ${(err as Error).message}`;
        console.error(msg);
        bridge.emitLog('error', msg);
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
        const msg = `[cycle] collectObjectiveRewards threw: ${(err as Error).message}`;
        console.error(msg);
        bridge.emitLog('error', msg);
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
        const msg = `[cycle] collectWeeklyChallenge threw: ${(err as Error).message}`;
        console.error(msg);
        bridge.emitLog('error', msg);
      }
    }

    // ── Farm gate ─────────────────────────────────────────────────────────────
    const fuelAtCycleStart = ctxInfo.fuelLeft ?? 0;
    // Reconcile spent counter against live inventory before the gate runs.
    // Catches manual fuel usage from another browser/device that the agent
    // didn't account for. See `reconcileSpentWithInventory` doc for the model.
    const reconcile = reconcileSpentWithInventory(fuel, fuelAtCycleStart);
    Object.assign(fuel, reconcile.state);
    if (reconcile.baselineSet) {
      console.log(`[cycle] fuel baseline locked: weekStartInventory=${fuelAtCycleStart}`);
    }
    if (reconcile.externalBurnDetected > 0) {
      const msg =
        `[cycle] reconciled spent: detected +${reconcile.externalBurnDetected} ` +
        `out-of-band fuel usage (spent now ${fuel.spent}/70)`;
      console.log(msg);
      bridge.emitLog('info', msg);
    }
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
        const allNative = await listMyCountryActiveBattles(ctx, csrf, countryId).catch(
          () => [] as Awaited<ReturnType<typeof listMyCountryActiveBattles>>,
        );
        const d11native = allNative.filter((b) => b.division === AIR_DIVISION);
        const cfg = settings.d4twAir;

        const hasEnergy =
          minEnergyPerBattle != null && (ctxInfo.energy ?? 0) >= minEnergyPerBattle;
        const hasAmmo =
          !cfg.useWeapon ||
          resolveWeapon(preloadedInventory, cfg.weaponPriority, AIR_WEAPON_TYPE).amountOnHand > 0;

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
            await notifier.send(`🛫 d4tw-air: traveled to native country (${t.costCC}cc) for D11 battle`);
            // Refresh context — currentCountryId/region/CSRF changed
            ctxInfo = await extractCitizenContext(ctx, { refresh: true });
            csrf = ctxInfo.csrf;
            state.awaySince =
              ctxInfo.currentRegionId != null &&
              ctxInfo.residenceRegionId != null &&
              ctxInfo.currentRegionId !== ctxInfo.residenceRegionId
                ? new Date().toISOString()
                : null;
          } else if (!t.attempted) {
            console.log(`[cycle] d4tw-air: travel skipped: ${t.message}`);
            await notifier.send(`⚠️ d4tw-air: travel skipped — ${t.message}`);
          } else {
            console.log(`[cycle] d4tw-air: travel failed: ${t.message}`);
            await notifier.send(`❌ d4tw-air: travel failed — ${t.message}`);
          }
        }
      } catch (err) {
        console.warn(`[cycle] d4tw-air abroad pre-flight threw: ${(err as Error).message}`);
      }
    }

    const maxBattlesForGate =
      mode === 'd4tw-air' ? settings.d4twAir.maxBattlesPerSession :
      mode === 'd4tw' ? settings.d4tw.maxBattlesPerSession :
      settings.emptyDiv.maxBattlesPerSession;

    const decision = settings.farmEnabled
      ? decideFarming({
          weekly: fuel,
          poolEnergy: ctxInfo.energy ?? 0,
          fuelInInventory: fuelAtCycleStart,
          maxBattlesPerSession: maxBattlesForGate,
          minEnergyPerBattle: minEnergyPerBattle ?? settings.energyPerBattleStandard,
          weeklyBudget: settings.weeklyFuelBudget,
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
    lastWeekFuelTarget = decision.diagnostics.target;
    console.log(
      `[cycle] farm: ${decision.shouldFarm ? '✅' : '⏭'} ${decision.reason} ` +
        `(week=${decision.diagnostics.weekFraction.toFixed(3)})`,
    );

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
            maxTravelCC: settings.travel.maxTravelCC,
            notify: (m) => notifier.send(m),
            preloadedInventory,
          },
        );
        for (const w of result.wins) {
          appendHistory({ type: 'battle', battleId: w.battleId, regionName: w.regionName, mode });
        }
        const fuelAfter = result.fuelLeftAtEnd ?? fuelAtCycleStart;
        const consumed = Math.max(0, fuelAtCycleStart - fuelAfter);
        fuel.spent += consumed;
        const verifiedHits = result.wins.reduce(
          (acc, w) => acc + (w.inv.verified ? 1 : 0) + (w.def.verified ? 1 : 0),
          0,
        );
        fuel.hitsLanded += verifiedHits;
        fuel.lastFarmedAt = new Date().toISOString();
        fuel.nextEligibleAt = rollNextEligibleAt(new Date(), Math.random, {
          minMinutes: settings.farmSession.cooldownMinMinutes,
          maxMinutes: settings.farmSession.cooldownMaxMinutes,
        });
        console.log(
          `[cycle] farm session: stop=${result.stopReason}, wins=${result.wins.length}, ` +
            `consumed=${consumed} fuel (${fuelAtCycleStart}→${fuelAfter}), hits=${verifiedHits}, ` +
            `weekly=${fuel.spent}/${settings.weeklyFuelBudget}`,
        );
      } catch (err) {
        const msg = `[cycle] farm session threw: ${(err as Error).message}`;
        console.error(msg);
        bridge.emitLog('error', msg);
      }
    } else if (!decision.shouldFarm) {
      fuel.cyclesSkipped++;

      // Idle cycle — good moment to head home if we've been abroad past the
      // threshold. Skipping when shouldFarm=true avoids paying for a round-trip
      // we'd immediately undo with the next farm session.
      // Settings (UI-editable + .env-seedable on first run) drive this; the
      // env vars are only consulted for the initial settings.json seed.
      const returnHomeAfterMinutes = settings.travel.returnHomeAfterMinutes;
      const returnHomeMaxCC = settings.travel.returnHomeMaxCC;
      if (
        returnHomeAfterMinutes > 0 &&
        state.awaySince != null &&
        ctxInfo.residenceRegionId != null
      ) {
        const elapsedMin = (Date.now() - new Date(state.awaySince).getTime()) / 60_000;
        if (elapsedMin >= returnHomeAfterMinutes) {
          const residenceCountryIdForHome = ctxInfo.residenceCountryId ?? countryId;
          try {
            const r = await travelHome(
              ctx,
              csrf,
              ctxInfo.residenceRegionId,
              residenceCountryIdForHome,
              { maxCostCC: returnHomeMaxCC },
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
            const msg = `[cycle] travelHome threw: ${(err as Error).message}`;
            console.error(msg);
            bridge.emitLog('error', msg);
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
    providers.saveDaily(state);
    providers.saveWeekly(weekly);
    providers.saveFuel(fuel);
  }

  uiSnapshot.lastUpdatedAt = Date.now();
  uiSnapshot.settings = settings;
  uiSnapshot.dailyActions = {
    work: !!state.completedActions.work,
    train: !!state.completedActions.train,
    buyFood: !!state.completedActions.buyFood,
    vipClaim: !!state.completedActions.vipClaim,
  };
  uiSnapshot.weeklyFuel = {
    week: fuel.week,
    spent: fuel.spent,
    target: lastWeekFuelTarget,
    hitsLanded: fuel.hitsLanded,
    cyclesSkipped: fuel.cyclesSkipped,
  };
  uiSnapshot.accountSlug = env.ERP_ACCOUNT_SLUG;
  uiSnapshot.citizen = {
    id: ctxInfo.citizenId,
    name: ctxInfo.name,
    countryId: ctxInfo.countryId,
    division: ctxInfo.division,
    energy: ctxInfo.energy,
    energyPoolLimit: ctxInfo.energyPoolLimit,
    fuelLeft: ctxInfo.fuelLeft,
    maxFuel: ctxInfo.maxFuel,
    currentRegionId: ctxInfo.currentRegionId,
    residenceRegionId: ctxInfo.residenceRegionId,
    atHome:
      ctxInfo.currentRegionId != null && ctxInfo.residenceRegionId != null
        ? ctxInfo.currentRegionId === ctxInfo.residenceRegionId
        : null,
  };
  uiSnapshot.lastFarmReason = lastDecisionReason;
  uiSnapshot.lastError = null;

  const hash = snapshotHash(state, weekly, fuel);
  if (hash !== state.lastDigestHash) {
    const digest = formatDigest(day, state, weekly, fuel, settings.weeklyFuelBudget);
    console.log('[cycle] digest:\n' + digest);
    await notifier.send(digest);
    state.lastDigestHash = hash;
    providers.saveDaily(state);
  }

  appendHistory({
    type: 'cycle',
    reason: lastDecisionReason ?? (shortCircuit ? 'short-circuit' : 'completed'),
  });
}

const uiSnapshot = createSnapshot();
uiSnapshot.accountSlug = env.ERP_ACCOUNT_SLUG;
const uiServer = await startUiServer({ getSnapshot: () => uiSnapshot });
console.log(`[runner] account=${env.ERP_ACCOUNT_SLUG}, UI at http://localhost:${uiServer.port}`);

const ctx = await openSession({ accountSlug: env.ERP_ACCOUNT_SLUG, headed: env.HEADED === 'true' });
const notifier = new TelegramNotifier({
  token: env.TELEGRAM_BOT_TOKEN,
  chatId: env.TELEGRAM_CHAT_ID,
  accountTag: env.ERP_ACCOUNT_SLUG,
});

const stopCtrl = createStopController();
let lastMode: string | null = null;
function handleStopSignal(name: string) {
  if (!stopCtrl.requestStop()) {
    // Second Ctrl-C / SIGTERM → hard-exit.
    process.exit(1);
  }
  console.log(`\n[runner] ${name} received — finishing current cycle then exiting`);
}
process.on('SIGINT', () => handleStopSignal('SIGINT'));
process.on('SIGTERM', () => handleStopSignal('SIGTERM'));

// ── Electron IPC bridge ────────────────────────────────────────────────────
// No-op when running as a plain Node process; only active when Electron
// spawns this module via utilityProcess.fork() and process.parentPort exists.
// process.parentPort is a Node 22 utility-process API; @types/node may not
// declare it on older type definitions, so we access it defensively.
const bridge = attachElectronBridge(
  (process as unknown as { parentPort?: IpcPort | null }).parentPort ?? undefined,
);
bridge.onShutdown(() => handleStopSignal('IPC shutdown'));
bridge.onPauseToggle((paused) => {
  console.log(`[bridge] paused toggled to ${paused} via IPC`);
  // Forward to settings.json so the dashboard stays in sync.
  const cur = loadSettings();
  saveSettings({ ...cur, paused });
});
bridge.emitReady(uiServer.port);

if (env.ERP_CAPTCHA_PROVIDER !== 'none' && !env.ERP_CAPTCHA_API_KEY) {
  const warnMsg = `[runner] ERP_CAPTCHA_PROVIDER=${env.ERP_CAPTCHA_PROVIDER} but ERP_CAPTCHA_API_KEY is unset — captchas will not be auto-solved`;
  console.warn(warnMsg);
  bridge.emitLog('warn', warnMsg);
}
const captchaCfg: CaptchaConfig = {
  provider: env.ERP_CAPTCHA_PROVIDER,
  apiKey: env.ERP_CAPTCHA_API_KEY,
  maxAttempts: env.ERP_CAPTCHA_MAX_ATTEMPTS,
  notify: (m) => notifier.send(m),
};

try {
  do {
    bridge.emitLog('info', '[runner] cycle started');
    bridge.emitState('cycling');
    try {
      await runCycle(ctx, notifier, captchaCfg, uiSnapshot);
      bridge.emitState('idle');
    } catch (err) {
      const message = (err as Error).message;
      bridge.emitState('error', message);
      const msg = `[cycle] failed: ${message}`;
      console.error(msg);
      bridge.emitLog('error', msg);
      await notifier.sendError(message);
      appendHistory({ type: 'error', message });
      uiSnapshot.lastError = message;
    }
    if (ONCE || stopCtrl.isStopping()) break;
    console.log(`[runner] sleeping ${env.LOOP_INTERVAL_MS / 1000}s (wake on settings change)`);
    const reason = await sleepUntilWake(env.LOOP_INTERVAL_MS, join(configDir(), 'settings.json'));
    if (reason === 'file-changed') console.log('[runner] woken early — settings.json changed');
  } while (!stopCtrl.isStopping());
} finally {
  await uiServer.close();
  await ctx.close();
  console.log('[runner] stopped');
}
