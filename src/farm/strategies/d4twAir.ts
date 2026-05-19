import type { BrowserContext } from 'playwright-core';
import { deployWeapon, skinForDivision, getDeployInventory } from '../../tools/farm.js';
import { listMyCountryActiveBattles, isSideEmpty, type FarmableBattle } from '../../tools/battles.js';
import { damagePerHit, FIREPOWER } from '../../tools/damageFormula.js';
import { loadInventory, resolveWeapon, type InventoryWeapon } from './inventory.js';
import { loadSettings } from '../../ui/settingsStore.js';
import {
  type FarmStrategy,
  type FarmSessionInfo,
  type FarmSessionOptions,
  type FarmSessionResult,
  type SideOutcome,
  type WinSummary,
  type SkipSummary,
  type StopReason,
} from './types.js';
import {
  formatBattleFailureMessage,
  formatBattleSuccessMessage,
} from '../../util/battleNotification.js';

export const ENERGY_PER_HIT = 10;
/** Game-default minimum energy floor for a deploy. Operators may override via
 *  `settings.d4twAir.minDeployEnergy` (and the matching D4TW field). */
export const DEFAULT_MIN_DEPLOY_ENERGY = 30;
export const AIR_WEAPON_TYPE = 'airWeapon'; // verified against live /economy/inventory-json (Q1-Q5 air-to-air missiles)
export const AIR_DIVISION = 11;

export interface MinEnergyInfo {
  strength: number | null;
  airRankNumber: number | null;
}

export interface MinEnergyCfg {
  targetDamageAttacker: number;
  useWeapon: boolean;
  weaponPriority: readonly number[];
  /** Optional override of {@link DEFAULT_MIN_DEPLOY_ENERGY}. */
  minDeployEnergy?: number;
}

/**
 * Estimate the minimum energy required to land a single d4tw-air medal on the
 * OPTIMISTIC (invader / losing) side. Used by the runner to compute the
 * `minEnergyPerBattle` hint for `decideFarming`. The strategy itself re-checks
 * with the real per-battle side and fresh pool energy before deploying.
 */
export function estimateMinEnergy(
  info: MinEnergyInfo,
  cfg: MinEnergyCfg,
  inventory: readonly InventoryWeapon[],
): number {
  const floor = cfg.minDeployEnergy ?? DEFAULT_MIN_DEPLOY_ENERGY;
  if (info.strength == null || info.airRankNumber == null) return floor;

  const fp = cfg.useWeapon
    ? resolveWeapon(inventory, cfg.weaponPriority, AIR_WEAPON_TYPE).firepower
    : FIREPOWER.bare;

  const dmg = damagePerHit(info.strength, info.airRankNumber, fp);

  const hits = Math.ceil(cfg.targetDamageAttacker / dmg);
  return Math.max(hits * ENERGY_PER_HIT, floor);
}

/**
 * Order battles for the d4tw-air strategy: native=invader (losing side) first,
 * native=defender (fallback, higher damage target) second. Stable order
 * within each bucket — preserves input order for deterministic behavior.
 */
export function orderByPreferredSide(
  battles: readonly FarmableBattle[],
  nativeCountryId: number,
): FarmableBattle[] {
  const invaders: FarmableBattle[] = [];
  const defenders: FarmableBattle[] = [];
  for (const b of battles) {
    if (b.invaderId === nativeCountryId) invaders.push(b);
    else if (b.defenderId === nativeCountryId) defenders.push(b);
  }
  return [...invaders, ...defenders];
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

async function runD4twAir(
  ctx: BrowserContext,
  info: FarmSessionInfo,
  options: FarmSessionOptions,
): Promise<FarmSessionResult> {
  const settings = loadSettings();
  const cfg = settings.d4twAir;

  // ── Pre-flight ──────────────────────────────────────────────────────────
  if (info.strength == null || info.airRankNumber == null) {
    const msg = 'd4tw-air: strength/airRank unavailable — skipping cycle';
    console.log(`[d4tw-air] ${msg}`);
    await Promise.resolve(options.notify?.(`⚠️ ${msg}`)).catch(() => undefined);
    return emptyResult(msg, 'no-candidates');
  }
  if (info.currentCountryId !== info.countryId) {
    const msg = `d4tw-air: not in native country (current=${info.currentCountryId}, native=${info.countryId}) — skipping`;
    console.log(`[d4tw-air] ${msg}`);
    return emptyResult(msg, 'no-candidates');
  }

  // ── Discovery ───────────────────────────────────────────────────────────
  const all: FarmableBattle[] = await listMyCountryActiveBattles(ctx, info.csrf, info.countryId);
  const d11 = all.filter((c) => c.division === AIR_DIVISION);
  if (d11.length === 0) {
    const msg = `d4tw-air: no D11 native battles (country=${info.countryId})`;
    console.log(`[d4tw-air] ${msg}`);
    return emptyResult(msg, 'no-candidates');
  }
  const ordered = orderByPreferredSide(d11, info.countryId);

  // ── Weapon (reuse preloaded inventory when available) ───────────────────
  const inventory = options.preloadedInventory ?? (await loadInventory(ctx, info.csrf));
  const weapon = cfg.useWeapon
    ? resolveWeapon(inventory, cfg.weaponPriority, AIR_WEAPON_TYPE)
    : { quality: -1, firepower: FIREPOWER.bare, amountOnHand: Number.POSITIVE_INFINITY };

  // Formula-based damage estimate — used only for startup logging AND as a
  // graceful fallback when the server response is missing this weapon quality.
  // The authoritative per-hit damage comes from getDeployInventory below
  // (server includes air-specific scaling, natural-enemy bonus, terrain,
  // booster effects — none of which the local formula models).
  const dmgPerHitFallback = damagePerHit(info.strength, info.airRankNumber, weapon.firepower);
  console.log(
    `[d4tw-air] weapon=${weapon.quality === -1 ? 'bare' : `Q${weapon.quality}`} ` +
      `fp=${weapon.firepower} dmg/hit≈${Math.floor(dmgPerHitFallback)} (formula estimate) ` +
      `ammo=${weapon.amountOnHand === Number.POSITIVE_INFINITY ? '∞' : weapon.amountOnHand}`,
  );

  // ── Battle loop ─────────────────────────────────────────────────────────
  const cap = Math.min(cfg.maxBattlesPerSession, ordered.length);
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
      mySide === 'invader' ? cfg.targetDamageAttacker : cfg.targetDamageDefender;

    // Empty side check (D11)
    const empty = await isSideEmpty(
      ctx,
      info.csrf,
      battle.battleId,
      AIR_DIVISION,
      battle.battleZoneId,
      battle.zoneId,
      mySide,
      battle.invaderId,
      battle.defenderId,
    ).catch((err: Error) => {
      console.log(`[d4tw-air] battle ${battle.battleId}: empty-check failed: ${err.message}`);
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

    // Battlefield page navigation is REQUIRED before deploy fetch — see d4tw.ts comment.
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

    // Prefer server-reported damage (true source of truth — includes
    // air-specific scaling, NE bonus, boosters, terrain). Fall back to the
    // formula estimate only when the requested quality isn't in the response.
    const serverDmg = inv.damagePerHitByQuality[weapon.quality];
    const effectiveDmgPerHit = serverDmg ?? dmgPerHitFallback;
    const energyPerHit = inv.minEnergy || ENERGY_PER_HIT;
    const hitsNeeded = Math.ceil(targetDmg / effectiveDmgPerHit);
    const energyFloor = cfg.minDeployEnergy ?? DEFAULT_MIN_DEPLOY_ENERGY;
    const energyToSpend = Math.max(hitsNeeded * energyPerHit, energyFloor);

    const ammoOk = weapon.amountOnHand === Number.POSITIVE_INFINITY || weapon.amountOnHand >= hitsNeeded;
    if (poolEnergy < energyToSpend || !ammoOk) {
      const msg =
        `need ${energyToSpend}e + ${hitsNeeded} ammo, have ${poolEnergy}e / ` +
        `${weapon.amountOnHand === Number.POSITIVE_INFINITY ? '∞' : weapon.amountOnHand} ammo`;
      console.log(`[d4tw-air] skipped battle ${battle.battleId} (${battle.regionName}) — ${msg}`);
      await Promise.resolve(
        options.notify?.(
          formatBattleFailureMessage(
            {
              battleId: battle.battleId,
              battleZoneId: battle.battleZoneId,
              regionName: battle.regionName,
              invaderCountryId: battle.invaderId,
              defenderCountryId: battle.defenderId,
              division: AIR_DIVISION,
            },
            msg,
          ),
        ),
      ).catch(() => undefined);
      skipped.push({ battleId: battle.battleId, regionName: battle.regionName, reason: msg });
      continue;
    }

    console.log(
      `[d4tw-air] 🎯 #${battle.battleId} ${battle.regionName} (${mySide}) ` +
        `target=${targetDmg} hits=${hitsNeeded} energy=${energyToSpend} ` +
        `dmg/hit=${Math.floor(effectiveDmgPerHit)}${serverDmg != null ? ' (server)' : ' (formula)'}`,
    );

    const sideCountryId = mySide === 'invader' ? battle.invaderId : battle.defenderId;
    const otherCountryId = mySide === 'invader' ? battle.defenderId : battle.invaderId;
    const skin = inv.skinId ?? skinForDivision(AIR_DIVISION);

    if (options.dryRun) {
      console.log('[d4tw-air]    (dry-run — no POST)');
      const outcome: SideOutcome = {
        side: mySide,
        countryId: sideCountryId,
        attempts: 0,
        verified: false,
        fuelLeft: null,
        deploymentId: null,
      };
      const otherOutcome: SideOutcome = {
        side: mySide === 'invader' ? 'defender' : 'invader',
        countryId: otherCountryId,
        attempts: 0,
        verified: false,
        fuelLeft: null,
        deploymentId: null,
      };
      wins.push({
        battleId: battle.battleId,
        regionName: battle.regionName,
        inv: mySide === 'invader' ? outcome : otherOutcome,
        def: mySide === 'defender' ? outcome : otherOutcome,
      });
      continue;
    }

    const result = await deployWeapon(
      ctx,
      info.csrf,
      battle.battleId,
      battle.battleZoneId,
      sideCountryId,
      weapon.quality,
      energyToSpend,
      skin,
    );

    if (!result.success) {
      const msg = `deploy failed: ${result.message}`;
      console.log(`[d4tw-air]    ❌ ${msg}`);
      await Promise.resolve(
        options.notify?.(
          formatBattleFailureMessage(
            {
              battleId: battle.battleId,
              battleZoneId: battle.battleZoneId,
              regionName: battle.regionName,
              invaderCountryId: battle.invaderId,
              defenderCountryId: battle.defenderId,
              division: AIR_DIVISION,
            },
            msg,
          ),
        ),
      ).catch(() => undefined);
      skipped.push({ battleId: battle.battleId, regionName: battle.regionName, reason: msg });
      continue;
    }

    if (result.fuelLeft != null) lastFuel = result.fuelLeft;
    console.log(`[d4tw-air]    ✅ deployed; fuel=${result.fuelLeft ?? '?'}`);

    const outcome: SideOutcome = {
      side: mySide,
      countryId: sideCountryId,
      attempts: 1,
      verified: true,
      fuelLeft: result.fuelLeft,
      deploymentId: result.deploymentId,
    };
    const otherOutcome: SideOutcome = {
      side: mySide === 'invader' ? 'defender' : 'invader',
      countryId: otherCountryId,
      attempts: 0,
      verified: false,
      fuelLeft: null,
      deploymentId: null,
    };
    wins.push({
      battleId: battle.battleId,
      regionName: battle.regionName,
      inv: mySide === 'invader' ? outcome : otherOutcome,
      def: mySide === 'defender' ? outcome : otherOutcome,
    });
    await Promise.resolve(
      options.notify?.(
        formatBattleSuccessMessage({
          battleId: battle.battleId,
          battleZoneId: battle.battleZoneId,
          regionName: battle.regionName,
          invaderCountryId: battle.invaderId,
          defenderCountryId: battle.defenderId,
          division: AIR_DIVISION,
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
    sequence: wins.length > 0 ? `d4tw-air×${wins.length}` : '(no hops)',
  };
}

export const d4twAirStrategy: FarmStrategy = {
  id: 'd4tw-air',
  run: runD4twAir,
};
