import type { BrowserContext, Page } from 'playwright-core';

export const BASE = 'https://www.erepublik.com';

/**
 * Returns a long-lived page bound to www.erepublik.com. Reused as the host for
 * all `fetch()` calls so requests carry the full browser fingerprint
 * (sec-ch-ua-*, sec-fetch-*, navigator UA, cookies, TLS profile) instead of
 * Playwright's bare-bones `ctx.request` profile that bot-detection can spot.
 */
export async function getOrCreateErepublikPage(ctx: BrowserContext): Promise<Page> {
  for (const p of ctx.pages()) {
    if (p.url().startsWith(BASE)) return p;
  }
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!page.url().startsWith(BASE)) {
    await page.goto(`${BASE}/en`, { waitUntil: 'domcontentloaded' });
  }
  return page;
}
