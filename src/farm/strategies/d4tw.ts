import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../../transport/apiCall.js';
import { deployWeapon, skinForDivision, getDeployInventory } from '../../tools/farm.js';
import { listMyCountryActiveBattles, isSideEmpty, type FarmableBattle } from '../../tools/battles.js';
import { damagePerHit, FIREPOWER } from '../../tools/damageFormula.js';
import { pickWeapon, type InventoryWeapon } from '../../tools/pickWeapon.js';
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

const ENERGY_PER_HIT = 10;
const MIN_DEPLOY_ENERGY = 30; // game minimum for normal weapon / bare hands

interface InventoryCategory {
  id?: string;
  items?: InventoryWeapon[];
}

async function loadInventory(ctx: BrowserContext, csrf: string): Promise<InventoryWeapon[]> {
  const { body } = await apiCall<InventoryCategory[]>(ctx, {
    method: 'GET',
    path: '/en/economy/inventory-json',
    csrf,
  });
  const main = Array.isArray(body) ? body.find((c) => c.id === 'mainStorage') : undefined;
  return main?.items ?? [];
}

interface ResolvedWeapon {
  /** Quality 1-7, or -1 for bare hands. */
  quality: number;
  /** Firepower for the damage formula. */
  firepower: number;
  /** Ammo on hand (Infinity for bare hands). */
  amountOnHand: number;
}

function resolveWeapon(inventory: InventoryWeapon[], priority: readonly number[]): ResolvedWeapon {
  const picked = pickWeapon(inventory, priority);
  if (!picked) {
    return { quality: -1, firepower: FIREPOWER.bare, amountOnHand: Number.POSITIVE_INFINITY };
  }
  const fpKey = `Q${picked.quality}` as keyof typeof FIREPOWER;
  return {
    quality: picked.quality,
    firepower: FIREPOWER[fpKey],
    amountOnHand: picked.amount,
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

async function runD4TW(
  ctx: BrowserContext,
  info: FarmSessionInfo,
  options: FarmSessionOptions,
): Promise<FarmSessionResult> {
  // Re-read settings inside the strategy (vs accepting them via options).
  // Tiny duplication vs the read in runCycle, but keeps the strategy
  // self-contained: callers don't need to know d4tw's config schema.
  // The race window (settings change between runCycle.loadSettings and here)
  // is ~ms and harmless — the next cycle picks up any drift.
  const settings = loadSettings();
  const cfg = settings.d4tw;

  // ── Pre-flight checks ───────────────────────────────────────────────────────
  if (info.strength == null || info.rankNumber == null) {
    const msg = 'D4-TW: strength/rank unavailable (profile fetch failed?) — skipping cycle';
    console.log(`[d4tw] ${msg}`);
    await Promise.resolve(options.notify?.(`⚠️ ${msg}`)).catch(() => undefined);
    return emptyResult(msg, 'no-candidates');
  }
  if (info.currentCountryId !== info.countryId) {
    const msg = `D4-TW: not in native country (current=${info.currentCountryId}, native=${info.countryId}) — skipping`;
    console.log(`[d4tw] ${msg}`);
    return emptyResult(msg, 'no-candidates');
  }

  // ── Discovery ───────────────────────────────────────────────────────────────
  const candidates: FarmableBattle[] = await listMyCountryActiveBattles(ctx, info.csrf, info.countryId);
  const myDivisionCandidates = candidates.filter((c) => c.division === info.division);
  if (myDivisionCandidates.length === 0) {
    const msg = `D4-TW: no active battles for country=${info.countryId} division=${info.division}`;
    console.log(`[d4tw] ${msg}`);
    return emptyResult(msg, 'no-candidates');
  }

  // ── Weapon selection (one inventory read per session) ───────────────────────
  const inventory = await loadInventory(ctx, info.csrf);
  const weapon = resolveWeapon(inventory, cfg.weaponPriority);
  const dmgPerHit = damagePerHit(info.strength, info.rankNumber, weapon.firepower);
  console.log(
    `[d4tw] weapon=Q${weapon.quality === -1 ? 'bare' : weapon.quality} ` +
      `fp=${weapon.firepower} dmg/hit=${Math.floor(dmgPerHit)} ammo=${weapon.amountOnHand === Infinity ? '∞' : weapon.amountOnHand}`,
  );

  // ── Battle loop ─────────────────────────────────────────────────────────────
  const cap = Math.min(cfg.maxBattlesPerSession, myDivisionCandidates.length);
  const wins: WinSummary[] = [];
  const skipped: SkipSummary[] = [];
  let stopReason: StopReason = 'completed';
  let lastFuel: number | null = null;
  let lastPoolEnergy: number | null = null;

  for (let i = 0; i < cap; i++) {
    const battle = myDivisionCandidates[i];
    const mySide: 'invader' | 'defender' =
      battle.invaderId === info.countryId ? 'invader' : 'defender';
    const targetDmg =
      mySide === 'invader' ? cfg.targetDamageAttacker : cfg.targetDamageDefender;

    // Side-empty check
    const empty = await isSideEmpty(
      ctx,
      info.csrf,
      battle.battleId,
      info.division,
      battle.battleZoneId,
      battle.zoneId,
      mySide,
      battle.invaderId,
      battle.defenderId,
    ).catch((err: Error) => {
      console.log(`[d4tw] battle ${battle.battleId}: empty-check failed: ${err.message}`);
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

    // Energy + ammo pre-check
    const hitsNeeded = Math.ceil(targetDmg / dmgPerHit);
    const energyToSpend = Math.max(hitsNeeded * ENERGY_PER_HIT, MIN_DEPLOY_ENERGY);

    // Battlefield page navigation is REQUIRED before any deploy fetch — the
    // deploy endpoints check the browser-enforced Referer header, which only
    // gets set correctly when the page actually navigated there. Skipping
    // this causes 403/error on getDeployInventory and deployWeapon.
    // (See CLAUDE.md "Battlefield deploys need a real page navigation first".)
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`https://www.erepublik.com/en/military/battlefield/${battle.battleId}`, {
      waitUntil: 'domcontentloaded',
    });

    // Get fresh pool energy + skin
    const inv = await getDeployInventory(
      ctx,
      info.csrf,
      battle.battleId,
      info.countryId,
      battle.battleZoneId,
    );
    const poolEnergy = inv.poolEnergy ?? 0;
    lastPoolEnergy = poolEnergy;

    const ammoOk = weapon.amountOnHand === Infinity || weapon.amountOnHand >= hitsNeeded;
    if (poolEnergy < energyToSpend || !ammoOk) {
      const msg =
        `need ${energyToSpend}e + ${hitsNeeded} ammo, have ${poolEnergy}e / ` +
        `${weapon.amountOnHand === Infinity ? '∞' : weapon.amountOnHand} ammo`;
      console.log(`[d4tw] skipped battle ${battle.battleId} (${battle.regionName}) — ${msg}`);
      await Promise.resolve(
        options.notify?.(
          formatBattleFailureMessage(
            {
              battleId: battle.battleId,
              battleZoneId: battle.battleZoneId,
              regionName: battle.regionName,
              invaderCountryId: battle.invaderId,
              defenderCountryId: battle.defenderId,
              division: info.division,
            },
            msg,
          ),
        ),
      ).catch(() => undefined);
      skipped.push({ battleId: battle.battleId, regionName: battle.regionName, reason: msg });
      continue;
    }

    // One big deploy
    console.log(
      `[d4tw] 🎯 #${battle.battleId} ${battle.regionName} (${mySide}) ` +
        `target=${(targetDmg / 1e6).toFixed(0)}M hits=${hitsNeeded} energy=${energyToSpend}`,
    );

    if (options.dryRun) {
      console.log(`[d4tw]    (dry-run — no POST)`);
      const sideCountryId = mySide === 'invader' ? battle.invaderId : battle.defenderId;
      const otherCountryId = mySide === 'invader' ? battle.defenderId : battle.invaderId;
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

    const sideCountryId = mySide === 'invader' ? battle.invaderId : battle.defenderId;
    const otherCountryId = mySide === 'invader' ? battle.defenderId : battle.invaderId;
    const skin = inv.skinId ?? skinForDivision(info.division);
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
      console.log(`[d4tw]    ❌ ${msg}`);
      await Promise.resolve(
        options.notify?.(
          formatBattleFailureMessage(
            {
              battleId: battle.battleId,
              battleZoneId: battle.battleZoneId,
              regionName: battle.regionName,
              invaderCountryId: battle.invaderId,
              defenderCountryId: battle.defenderId,
              division: info.division,
            },
            msg,
          ),
        ),
      ).catch(() => undefined);
      skipped.push({ battleId: battle.battleId, regionName: battle.regionName, reason: msg });
      continue;
    }

    if (result.fuelLeft != null) lastFuel = result.fuelLeft;
    console.log(`[d4tw]    ✅ deployed; fuel=${result.fuelLeft ?? '?'}`);

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
          division: info.division,
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
    sequence: wins.length > 0 ? `d4tw×${wins.length}` : '(no hops)',
  };
}

export const d4twStrategy: FarmStrategy = {
  id: 'd4tw',
  run: runD4TW,
};
