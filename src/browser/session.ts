import { launchPersistentContext } from 'cloakbrowser';
import type { BrowserContext } from 'playwright-core';
import { profileDir as resolveProfileDir } from '../paths.js';
import { apiCall } from '../transport/apiCall.js';

export interface SessionOptions {
  accountSlug: string;
  headed: boolean;
}

export async function openSession(opts: SessionOptions): Promise<BrowserContext> {
  const profileDir = resolveProfileDir(opts.accountSlug);
  return launchPersistentContext({
    userDataDir: profileDir,
    headless: !opts.headed,
    viewport: { width: 1366, height: 800 },
  });
}

export async function extractCsrf(ctx: BrowserContext): Promise<string> {
  const { csrf } = await extractCitizenContext(ctx);
  return csrf;
}

export interface DailyOrder {
  battleId: number;
  sideCountryId: number;
  regionId: number;
  title: string;
}

export interface CitizenContext {
  csrf: string;
  countryId: number | null;
  citizenId: number | null;
  division: number | null;
  residenceRegionId: number | null;
  residenceCountryId: number | null;
  // Current physical location of the citizen (where battlefieldTravel / travel
  // last left them). Different from `residenceRegionId` when abroad. Read from
  // `erepublik.citizen.regionLocationId` / `countryLocationId` — the same
  // fields ePlus' returnHome plugin uses.
  currentRegionId: number | null;
  currentCountryId: number | null;
  // Live state (populated when `refresh: true`; nullable for legacy callers
  // that don't force a reload).
  energy: number | null;
  energyPoolLimit: number | null;
  recoverableEnergy: number | null;
  energyPerInterval: number | null;
  hasFoodInInventory: boolean | null;
  userLevel: number | null;
  canWorkTrainAgainIn: number | null;
  dailyOrders: DailyOrder[] | null;
  fuelLeft: number | null;
  maxFuel: number | null;
  strength: number | null;
  rankNumber: number | null;
  airRankNumber: number | null;
  hasMaverick: boolean | null;
  /** In-game nickname from `erepublik.citizen.name`. Useful for telling
   *  multi-account installs apart in logs/UI. Null if the global was missing. */
  name: string | null;
}

export interface ExtractOptions {
  /**
   * Force a full page navigation before reading globals. Required when the
   * page has been idle long enough for `erepublik.citizen` to be stale (any
   * cycle that needs fresh energy/fuel). Lands on /en/military/campaigns,
   * which also surfaces the only DOM source of `fuelLeft` we have.
   */
  refresh?: boolean;
}

const CAMPAIGNS_URL = 'https://www.erepublik.com/en/military/campaigns';
const FALLBACK_URL = 'https://www.erepublik.com/en';

export async function extractCitizenContext(
  ctx: BrowserContext,
  opts: ExtractOptions = {},
): Promise<CitizenContext> {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (opts.refresh) {
    await page.goto(CAMPAIGNS_URL, { waitUntil: 'domcontentloaded' });
  } else if (!page.url().startsWith('https://www.erepublik.com/en')) {
    await page.goto(FALLBACK_URL, { waitUntil: 'domcontentloaded' });
  }
  if (page.url().includes('/login')) {
    throw new Error('Session expired — re-run bootstrap');
  }

  const info = await page.evaluate(() => {
    type SD = { csrfToken?: string };
    type RawDailyOrder = {
      battleId?: number;
      sideCountryId?: number;
      regionId?: number;
      title?: string;
    };
    type Citizen = {
      citizenshipCountryId?: number;
      ctCountryId?: number;
      citizenship?: { id?: number };
      country?: { id?: number };
      citizenId?: number;
      id?: number;
      name?: string;
      division?: number;
      residence?: { regionId?: number; countryId?: number };
      regionLocationId?: number;
      countryLocationId?: number;
      energy?: number;
      energyPoolLimit?: number;
      recoverableEnergy?: number;
      energyPerInterval?: number;
      hasFoodInInventory?: boolean;
      userLevel?: number;
      canWorkTrainAgainIn?: number;
      dailyOrders?: RawDailyOrder[];
    };
    const sd = (globalThis as unknown as { SERVER_DATA?: SD }).SERVER_DATA;
    const erp = (globalThis as unknown as { erepublik?: { citizen?: Citizen } }).erepublik;
    const c = erp?.citizen;

    const csrf =
      document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ??
      sd?.csrfToken ??
      null;

    const countryId =
      c?.citizenshipCountryId ??
      c?.ctCountryId ??
      c?.citizenship?.id ??
      c?.country?.id ??
      null;

    const citizenId = c?.citizenId ?? c?.id ?? null;
    const name = typeof c?.name === 'string' && c.name.length > 0 ? c.name : null;
    const division = typeof c?.division === 'number' ? c.division : null;
    const residenceRegionId = typeof c?.residence?.regionId === 'number' ? c.residence.regionId : null;
    const residenceCountryId =
      typeof c?.residence?.countryId === 'number' ? c.residence.countryId : null;
    const currentRegionId = typeof c?.regionLocationId === 'number' ? c.regionLocationId : null;
    const currentCountryId = typeof c?.countryLocationId === 'number' ? c.countryLocationId : null;

    const energy = typeof c?.energy === 'number' ? c.energy : null;
    const energyPoolLimit = typeof c?.energyPoolLimit === 'number' ? c.energyPoolLimit : null;
    const recoverableEnergy = typeof c?.recoverableEnergy === 'number' ? c.recoverableEnergy : null;
    const energyPerInterval = typeof c?.energyPerInterval === 'number' ? c.energyPerInterval : null;
    const hasFoodInInventory = typeof c?.hasFoodInInventory === 'boolean' ? c.hasFoodInInventory : null;
    const userLevel = typeof c?.userLevel === 'number' ? c.userLevel : null;
    const canWorkTrainAgainIn = typeof c?.canWorkTrainAgainIn === 'number' ? c.canWorkTrainAgainIn : null;

    let dailyOrders: DailyOrder[] | null = null;
    if (Array.isArray(c?.dailyOrders)) {
      dailyOrders = [];
      for (const o of c.dailyOrders) {
        if (
          typeof o?.battleId === 'number' &&
          typeof o.sideCountryId === 'number' &&
          typeof o.regionId === 'number' &&
          typeof o.title === 'string'
        ) {
          dailyOrders.push({
            battleId: o.battleId,
            sideCountryId: o.sideCountryId,
            regionId: o.regionId,
            title: o.title,
          });
        }
      }
    }

    // Fuel only lives in the DOM on /en/military/campaigns. Null when the
    // current page doesn't have the markers (e.g. refresh=false on /en).
    let fuelLeft: number | null = null;
    let maxFuel: number | null = null;
    const fuelEl = document.querySelector('q#fuelLeft');
    if (fuelEl) {
      const n = Number(fuelEl.textContent ?? '');
      if (Number.isFinite(n)) fuelLeft = n;
    }
    const maxEl = document.querySelector('q#maxFuel');
    if (maxEl) {
      const n = Number(maxEl.textContent ?? '');
      if (Number.isFinite(n)) maxFuel = n;
    }

    return {
      csrf,
      countryId,
      citizenId,
      name,
      division,
      residenceRegionId,
      residenceCountryId,
      currentRegionId,
      currentCountryId,
      energy,
      energyPoolLimit,
      recoverableEnergy,
      energyPerInterval,
      hasFoodInInventory,
      userLevel,
      canWorkTrainAgainIn,
      dailyOrders,
      fuelLeft,
      maxFuel,
    };
  });

  if (!info.csrf) throw new Error('CSRF token not found');

  let strength: number | null = null;
  let rankNumber: number | null = null;
  let hasMaverick: boolean | null = null;
  const citizenId = info.citizenId ?? null;
  if (citizenId != null) {
    try {
      const { body: profile } = await apiCall(ctx, {
        method: 'GET',
        path: `/en/main/citizen-profile-json-personal/${citizenId}`,
        csrf: info.csrf,
      });
      const p = profile as Record<string, unknown>;
      const milData = (p?.military as Record<string, unknown>)?.militaryData as Record<string, unknown> | undefined;
      strength = typeof milData?.strength === 'number' ? milData.strength : null;
      rankNumber = typeof milData?.rankNumber === 'number' ? milData.rankNumber : null;
      const activePacks = p?.activePacks;
      hasMaverick = activePacks != null && typeof activePacks === 'object'
        ? 'division_switch_pack' in activePacks
        : null;
    } catch (err) {
      console.warn(`[ctx] profile fetch failed: ${(err as Error).message}`);
    }
  }

  return {
    csrf: info.csrf,
    countryId: info.countryId ?? null,
    citizenId,
    name: info.name ?? null,
    division: info.division ?? null,
    residenceRegionId: info.residenceRegionId ?? null,
    residenceCountryId: info.residenceCountryId ?? null,
    currentRegionId: info.currentRegionId ?? null,
    currentCountryId: info.currentCountryId ?? null,
    energy: info.energy ?? null,
    energyPoolLimit: info.energyPoolLimit ?? null,
    recoverableEnergy: info.recoverableEnergy ?? null,
    energyPerInterval: info.energyPerInterval ?? null,
    hasFoodInInventory: info.hasFoodInInventory ?? null,
    userLevel: info.userLevel ?? null,
    canWorkTrainAgainIn: info.canWorkTrainAgainIn ?? null,
    dailyOrders: info.dailyOrders ?? null,
    fuelLeft: info.fuelLeft ?? null,
    maxFuel: info.maxFuel ?? null,
    strength,
    rankNumber,
    airRankNumber: null,   // populated in Task 4
    hasMaverick,
  };
}
