import type { BrowserContext } from 'playwright-core';
import {
  isSideEmpty,
  listMyCountryActiveBattles,
  type FarmableBattle,
} from '../../tools/battles.js';
import { deployWeapon, getDeployInventory, skinForDivision } from '../../tools/farm.js';
import { damagePerHit, FIREPOWER } from '../../tools/damageFormula.js';
import { loadInventory, resolveWeapon } from './inventory.js';
import {
  formatBattleFailureMessage,
  formatBattleSuccessMessage,
} from '../../util/battleNotification.js';
import { escapeMdV2 } from '../../telegram/mdV2.js';
import type {
  FarmSessionInfo,
  FarmSessionOptions,
  FarmSessionResult,
  SideOutcome,
  SkipSummary,
  StopReason,
  WinSummary,
} from './types.js';

/**
 * Shared "fight one side per battle" engine. Backs the D4-TW (ground) and
 * D4-TW-Air strategies. Each strategy supplies a `CombatConfig` and the engine
 * runs the identical loop — pre-flight, discovery, weapon resolve, per-battle
 * empty-check + deploy + notify — without duplicating ~280 lines per strategy.
 *
 * Why a single function (vs an OO hierarchy): the variation points are pure
 * data (division, rank field, weapon type) plus three small policy callbacks.
 * A config object reads cleaner than an inheritance tree, and keeps the engine
 * easy to follow top-to-bottom.
 */

const ENERGY_PER_HIT = 10;

export interface CombatConfig {
  /** Strategy identifier (for logs / sequence tag). */
  strategyId: 'd4tw' | 'd4tw-air';
  /** Inline log prefix, e.g. `[d4tw]` or `[d4tw-air]`. */
  logPrefix: string;
  /** Suffix for the `result.sequence` field, e.g. `d4tw` or `d4tw-air`. */
  sequenceTag: string;

  /**
   * Division to filter battles + check empty + lookup skin. For ground D4-TW
   * this is `info.division`; for D4-TW-Air it's always `11` regardless of the
   * citizen's native division (Maverick descends, etc.).
   */
  division: number;
  /**
   * Rank value used as a pre-flight gate — `info.rankNumber` for ground,
   * `info.airRankNumber` for air. When null the engine logs and skips with
   * `no-candidates`.
   */
  rank: number | null;

  /** Optional weapon type filter passed to {@link resolveWeapon}. */
  weaponType?: 'groundWeapon' | 'airWeapon' | 'groundBomb';
  weaponPriority: readonly number[];
  /**
   * When `false`, the engine always fights with bare hands (Q-1) regardless
   * of inventory. D4-TW (ground) always wants useWeapon=true; D4-TW-Air
   * exposes it as a setting.
   */
  useWeapon: boolean;

  targetDamageAttacker: number;
  targetDamageDefender: number;
  maxBattlesPerSession: number;
  /** Energy floor (game minimum). Used by {@link computeDeployPlan}. */
  minDeployEnergy: number;

  /**
   * Optional re-ordering hook. Defaults to identity (input order from
   * `listMyCountryActiveBattles`). D4-TW-Air supplies `orderByPreferredSide`
   * so native=invader (cheaper losing side) plays first.
   */
  orderBattles?: (battles: FarmableBattle[], nativeCountryId: number) => FarmableBattle[];

  /**
   * Optional target-damage formatter for the per-battle log line. D4-TW
   * shows "130M" (millions); D4-TW-Air shows raw thousands.
   */
  formatTargetDamage?: (n: number) => string;
}

/**
 * Pure: compute the deploy plan for one side. Extracted so the energy/ammo
 * math is unit-testable without spinning up Playwright.
 */
export interface DeployPlanInput {
  targetDamage: number;
  damagePerHit: number;
  energyPerHit: number;
  minDeployEnergy: number;
  ammoOnHand: number; // Infinity for bare hands / unlimited
  /**
   * Hits delivered per inventory unit (a.k.a. durability).
   * 1 unit of Q5 ground = 5 hits; Q7 ground = 10 hits; Q5 air = 5 hits; bomb = 1.
   * Defaults to 1 for backward compatibility with callers that pre-date the
   * durability fix.
   */
  usesPerUnit?: number;
}

export interface DeployPlan {
  hitsNeeded: number;
  /** Inventory units we'd actually consume (ceil(hitsNeeded / usesPerUnit)). */
  unitsNeeded: number;
  energyToSpend: number;
  ammoOk: boolean;
}

export function computeDeployPlan(input: DeployPlanInput): DeployPlan {
  const usesPerUnit = input.usesPerUnit ?? 1;
  const hitsNeeded = Math.ceil(input.targetDamage / input.damagePerHit);
  const unitsNeeded = Math.ceil(hitsNeeded / usesPerUnit);
  const energyToSpend = Math.max(hitsNeeded * input.energyPerHit, input.minDeployEnergy);
  const hitsAvailable =
    input.ammoOnHand === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : input.ammoOnHand * usesPerUnit;
  const ammoOk = hitsAvailable >= hitsNeeded;
  return { hitsNeeded, unitsNeeded, energyToSpend, ammoOk };
}

/**
 * Pure: build a {@link WinSummary} from a one-sided combat outcome. The other
 * side is always synthetic (we didn't fight it), so its `verified=false` and
 * `attempts=0`.
 */
export function buildOneSidedWin(
  battle: { battleId: number; regionName: string },
  mySide: 'invader' | 'defender',
  myCountryId: number,
  otherCountryId: number,
  fighting: SideOutcome,
): WinSummary {
  const other: SideOutcome = {
    side: mySide === 'invader' ? 'defender' : 'invader',
    countryId: otherCountryId,
    attempts: 0,
    verified: false,
    fuelLeft: null,
    deploymentId: null,
  };
  return {
    battleId: battle.battleId,
    regionName: battle.regionName,
    inv: mySide === 'invader' ? fighting : other,
    def: mySide === 'defender' ? fighting : other,
  };
}

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

/**
 * Run the "fight one side per battle" combat loop. Caller (strategy) supplies
 * the `config` resolved from its slice of settings. Returns a standard
 * {@link FarmSessionResult} so the runner can reconcile fuel/hits and emit
 * digests uniformly across strategies.
 */
export async function runOneSidedCombat(
  ctx: BrowserContext,
  info: FarmSessionInfo,
  options: FarmSessionOptions,
  config: CombatConfig,
): Promise<FarmSessionResult> {
  // ── Pre-flight ──────────────────────────────────────────────────────────
  if (info.strength == null || config.rank == null) {
    const msg = `${config.strategyId}: strength/rank unavailable — skipping cycle`;
    console.log(`${config.logPrefix} ${msg}`);
    await Promise.resolve(options.notify?.(escapeMdV2(`⚠️ ${msg}`))).catch(() => undefined);
    return emptyResult(msg, 'no-candidates');
  }
  if (info.currentCountryId !== info.countryId) {
    const msg = `${config.strategyId}: not in native country (current=${info.currentCountryId}, native=${info.countryId}) — skipping`;
    console.log(`${config.logPrefix} ${msg}`);
    return emptyResult(msg, 'no-candidates');
  }

  // ── Discovery ───────────────────────────────────────────────────────────
  const all: FarmableBattle[] = await listMyCountryActiveBattles(ctx, info.csrf, info.countryId);
  const inDivision = all.filter((c) => c.division === config.division);
  if (inDivision.length === 0) {
    const msg = `${config.strategyId}: no active battles for country=${info.countryId} division=${config.division}`;
    console.log(`${config.logPrefix} ${msg}`);
    return emptyResult(msg, 'no-candidates');
  }
  const ordered = config.orderBattles ? config.orderBattles(inDivision, info.countryId) : inDivision;

  // ── Weapon (reuse preloaded inventory when available) ───────────────────
  const inventory = options.preloadedInventory ?? (await loadInventory(ctx, info.csrf));
  const weapon = config.useWeapon
    ? resolveWeapon(inventory, config.weaponPriority, config.weaponType)
    : {
        quality: -1,
        firepower: FIREPOWER.bare,
        amountOnHand: Number.POSITIVE_INFINITY,
        usesPerUnit: 1,
      };

  // Formula-based damage estimate — used only for startup logging AND as a
  // graceful fallback when the server response is missing this weapon quality.
  // The authoritative per-hit damage comes from getDeployInventory in the loop
  // (server includes NE bonus, terrain, booster effects, division-specific
  // scaling — none of which the local formula models).
  const dmgPerHitFallback = damagePerHit(info.strength, config.rank, weapon.firepower);
  console.log(
    `${config.logPrefix} weapon=${weapon.quality === -1 ? 'bare' : `Q${weapon.quality}`} ` +
      `fp=${weapon.firepower} dmg/hit≈${Math.floor(dmgPerHitFallback)} (formula estimate) ` +
      `ammo=${weapon.amountOnHand === Number.POSITIVE_INFINITY ? '∞' : weapon.amountOnHand}`,
  );

  // ── Battle loop ─────────────────────────────────────────────────────────
  const cap = Math.min(config.maxBattlesPerSession, ordered.length);
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
      mySide === 'invader' ? config.targetDamageAttacker : config.targetDamageDefender;

    // Empty-side check
    const empty = await isSideEmpty(
      ctx,
      info.csrf,
      battle.battleId,
      config.division,
      battle.battleZoneId,
      battle.zoneId,
      mySide,
      battle.invaderId,
      battle.defenderId,
    ).catch((err: Error) => {
      console.log(`${config.logPrefix} battle ${battle.battleId}: empty-check failed: ${err.message}`);
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

    // Battlefield page navigation is REQUIRED before deploy fetch — the
    // deploy endpoints check the browser-enforced Referer header, which only
    // gets set correctly when the page actually navigated there.
    // (See CLAUDE.md "Battlefield deploys need a real page navigation first".)
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

    const serverDmg = inv.damagePerHitByQuality[weapon.quality];
    const effectiveDmgPerHit = serverDmg ?? dmgPerHitFallback;
    const energyPerHit = inv.minEnergy || ENERGY_PER_HIT;
    const plan = computeDeployPlan({
      targetDamage: targetDmg,
      damagePerHit: effectiveDmgPerHit,
      energyPerHit,
      minDeployEnergy: config.minDeployEnergy,
      ammoOnHand: weapon.amountOnHand,
      usesPerUnit: weapon.usesPerUnit,
    });

    if (poolEnergy < plan.energyToSpend || !plan.ammoOk) {
      const weaponTag = weapon.quality === -1 ? 'bare hands' : `Q${weapon.quality}`;
      const needPart =
        weapon.quality === -1
          ? `need ${plan.energyToSpend}e + ${plan.hitsNeeded} hits (${weaponTag})`
          : `need ${plan.energyToSpend}e + ${plan.hitsNeeded} hits (${plan.unitsNeeded} units of ${weaponTag})`;
      const havePart =
        weapon.amountOnHand === Number.POSITIVE_INFINITY
          ? `have ${poolEnergy}e / ∞ hits`
          : `have ${poolEnergy}e / ${weapon.amountOnHand} units (≈${weapon.amountOnHand * weapon.usesPerUnit} hits)`;
      const msg = `${needPart}, ${havePart}`;
      // Insufficient energy/ammo is a normal operating state, not an error —
      // log it and record the skip locally, but do NOT push a Telegram notice
      // (the operator doesn't want noise for routine resource shortfalls).
      console.log(`${config.logPrefix} skipped battle ${battle.battleId} (${battle.regionName}) — ${msg}`);
      skipped.push({ battleId: battle.battleId, regionName: battle.regionName, reason: msg });
      continue;
    }

    const formatTarget = config.formatTargetDamage ?? ((n) => String(n));
    console.log(
      `${config.logPrefix} 🎯 #${battle.battleId} ${battle.regionName} (${mySide}) ` +
        `target=${formatTarget(targetDmg)} hits=${plan.hitsNeeded} energy=${plan.energyToSpend} ` +
        `dmg/hit=${Math.floor(effectiveDmgPerHit)}${serverDmg != null ? ' (server)' : ' (formula)'}`,
    );

    const sideCountryId = mySide === 'invader' ? battle.invaderId : battle.defenderId;
    const otherCountryId = mySide === 'invader' ? battle.defenderId : battle.invaderId;
    const skin = inv.skinId ?? skinForDivision(config.division);

    if (options.dryRun) {
      console.log(`${config.logPrefix}    (dry-run — no POST)`);
      const outcome: SideOutcome = {
        side: mySide,
        countryId: sideCountryId,
        attempts: 0,
        verified: false,
        fuelLeft: null,
        deploymentId: null,
      };
      wins.push(buildOneSidedWin(battle, mySide, sideCountryId, otherCountryId, outcome));
      continue;
    }

    const result = await deployWeapon(
      ctx,
      info.csrf,
      battle.battleId,
      battle.battleZoneId,
      sideCountryId,
      weapon.quality,
      plan.energyToSpend,
      skin,
    );

    if (!result.success) {
      const msg = `deploy failed: ${result.message}`;
      console.log(`${config.logPrefix}    ❌ ${msg}`);
      await Promise.resolve(
        options.notify?.(
          formatBattleFailureMessage(
            {
              battleId: battle.battleId,
              battleZoneId: battle.battleZoneId,
              regionName: battle.regionName,
              invaderCountryId: battle.invaderId,
              defenderCountryId: battle.defenderId,
              division: config.division,
            },
            msg,
          ),
        ),
      ).catch(() => undefined);
      skipped.push({ battleId: battle.battleId, regionName: battle.regionName, reason: msg });
      continue;
    }

    if (result.fuelLeft != null) lastFuel = result.fuelLeft;
    console.log(`${config.logPrefix}    ✅ deployed; fuel=${result.fuelLeft ?? '?'}`);

    const outcome: SideOutcome = {
      side: mySide,
      countryId: sideCountryId,
      attempts: 1,
      verified: true,
      fuelLeft: result.fuelLeft,
      deploymentId: result.deploymentId,
    };
    wins.push(buildOneSidedWin(battle, mySide, sideCountryId, otherCountryId, outcome));
    await Promise.resolve(
      options.notify?.(
        formatBattleSuccessMessage({
          battleId: battle.battleId,
          battleZoneId: battle.battleZoneId,
          regionName: battle.regionName,
          invaderCountryId: battle.invaderId,
          defenderCountryId: battle.defenderId,
          division: config.division,
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
    sequence: wins.length > 0 ? `${config.sequenceTag}×${wins.length}` : '(no hops)',
  };
}
