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
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!page.url().startsWith('https://www.erepublik.com/en')) {
    await page.goto('https://www.erepublik.com/en', { waitUntil: 'domcontentloaded' });
  }
  if (page.url().includes('/login')) {
    throw new Error('Session expired — re-run bootstrap');
  }
  const csrf = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
    const fromGlobal = (globalThis as unknown as { SERVER_DATA?: { csrfToken?: string } }).SERVER_DATA?.csrfToken;
    return meta ?? fromGlobal ?? null;
  });
  if (!csrf) throw new Error('CSRF token not found on /en');
  return csrf;
}
