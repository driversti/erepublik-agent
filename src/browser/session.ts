import { launchPersistentContext } from 'cloakbrowser';
import type { BrowserContext } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface SessionOptions {
  accountSlug: string;
  headed: boolean;
}

export async function openSession(opts: SessionOptions): Promise<BrowserContext> {
  const profileDir = resolve(`sessions/profile/${opts.accountSlug}`);
  mkdirSync(profileDir, { recursive: true });
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

export interface CitizenContext {
  csrf: string;
  countryId: number | null;
  citizenId: number | null;
  division: number | null;
  residenceRegionId: number | null;
  residenceCountryId: number | null;
}

export async function extractCitizenContext(ctx: BrowserContext): Promise<CitizenContext> {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!page.url().startsWith('https://www.erepublik.com/en')) {
    await page.goto('https://www.erepublik.com/en', { waitUntil: 'domcontentloaded' });
  }
  if (page.url().includes('/login')) {
    throw new Error('Session expired — re-run bootstrap');
  }

  const info = await page.evaluate(() => {
    type SD = { csrfToken?: string };
    type Citizen = {
      citizenshipCountryId?: number;
      ctCountryId?: number;
      citizenship?: { id?: number };
      country?: { id?: number };
      citizenId?: number;
      id?: number;
      division?: number;
      residence?: { regionId?: number; countryId?: number };
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
    const division = typeof c?.division === 'number' ? c.division : null;
    const residenceRegionId = typeof c?.residence?.regionId === 'number' ? c.residence.regionId : null;
    const residenceCountryId =
      typeof c?.residence?.countryId === 'number' ? c.residence.countryId : null;

    return { csrf, countryId, citizenId, division, residenceRegionId, residenceCountryId };
  });

  if (!info.csrf) throw new Error('CSRF token not found on /en');
  return {
    csrf: info.csrf,
    countryId: info.countryId ?? null,
    citizenId: info.citizenId ?? null,
    division: info.division ?? null,
    residenceRegionId: info.residenceRegionId ?? null,
    residenceCountryId: info.residenceCountryId ?? null,
  };
}
