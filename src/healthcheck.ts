import { config as loadDotenv } from 'dotenv';
import { join } from 'node:path';
import { z } from 'zod';
import { launchPersistentContext } from 'cloakbrowser';
import { configDir, profileDir } from './paths.js';

loadDotenv({ path: join(configDir(), '.env') });
loadDotenv();

const Env = z.object({
  ERP_ACCOUNT_SLUG: z.string().default('main'),
  HEADED: z.enum(['true', 'false']).default('false'),
});

const env = Env.parse(process.env);
const resolvedProfileDir = profileDir(env.ERP_ACCOUNT_SLUG);

console.log(`[healthcheck] profile dir: ${resolvedProfileDir}`);

const ctx = await launchPersistentContext({
  userDataDir: resolvedProfileDir,
  headless: env.HEADED === 'false',
  viewport: { width: 1366, height: 800 },
});

const page = ctx.pages()[0] ?? (await ctx.newPage());

console.log('[healthcheck] navigating to /en to extract CSRF');
await page.goto('https://www.erepublik.com/en', { waitUntil: 'domcontentloaded' });

if (page.url().includes('/login')) {
  console.error('[healthcheck] FAILED: redirected to /login — session expired, re-run bootstrap');
  await ctx.close();
  process.exit(1);
}

const csrf = await page.evaluate(() => {
  const meta = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
  const fromGlobal = (globalThis as unknown as { SERVER_DATA?: { csrfToken?: string } }).SERVER_DATA?.csrfToken;
  return meta ?? fromGlobal ?? null;
});

if (!csrf) {
  console.error('[healthcheck] FAILED: no CSRF token found on /en');
  await ctx.close();
  process.exit(1);
}
console.log(`[healthcheck] CSRF: ${csrf.slice(0, 12)}... (length=${csrf.length})`);

console.log('[healthcheck] POST /en/main/daily-missions-data via context.request');
const res = await ctx.request.post('https://www.erepublik.com/en/main/daily-missions-data', {
  headers: {
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: 'https://www.erepublik.com',
    Referer: 'https://www.erepublik.com/en',
  },
  form: { _token: csrf },
});

console.log(`[healthcheck] status: ${res.status()}`);
const contentType = res.headers()['content-type'] ?? '';
console.log(`[healthcheck] content-type: ${contentType}`);

if (!contentType.includes('json')) {
  const text = await res.text();
  console.error('[healthcheck] FAILED: non-JSON response (first 300 chars):');
  console.error(text.slice(0, 300));
  await ctx.close();
  process.exit(1);
}

const body = await res.json();
console.log('[healthcheck] ✅ JSON received. Top-level keys:', Object.keys(body));
console.log('[healthcheck] sample:', JSON.stringify(body, null, 2).slice(0, 600));

await ctx.close();
