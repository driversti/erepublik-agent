import { config as loadDotenv } from 'dotenv';
import { join } from 'node:path';
import { z } from 'zod';
import { launchPersistentContext } from 'cloakbrowser';
import { configDir, profileDir } from './paths.js';

loadDotenv({ path: join(configDir(), '.env') });
// Fall back to default .env in cwd if config/.env wasn't found
// (developer workflow). Dotenv silently ignores missing files.
loadDotenv();

const Env = z.object({
  ERP_LOGIN: z.string().email(),
  ERP_PASSWORD: z.string().min(1),
  ERP_ACCOUNT_SLUG: z.string().default('main'),
  HEADED: z.enum(['true', 'false']).default('true'),
});

const env = Env.parse(process.env);

const resolvedProfileDir = profileDir(env.ERP_ACCOUNT_SLUG);

console.log(`[bootstrap] profile dir: ${resolvedProfileDir}`);
console.log(`[bootstrap] launching CloakBrowser (headed=${env.HEADED})`);

const ctx = await launchPersistentContext({
  userDataDir: resolvedProfileDir,
  headless: env.HEADED === 'false',
  viewport: { width: 1366, height: 800 },
});

const page = ctx.pages()[0] ?? (await ctx.newPage());

console.log('[bootstrap] navigating to /en/login');
await page.goto('https://www.erepublik.com/en/login', { waitUntil: 'domcontentloaded' });

const emailField = page.locator('input[name="citizen_email"]');
try {
  await emailField.waitFor({ state: 'visible', timeout: 10_000 });
} catch {
  // No login form appeared within 10s. If the persisted session is valid,
  // eRepublik redirects /en/login → /en after domcontentloaded, so the form
  // never renders. Treat that as "already authenticated".
  if (!page.url().includes('/login')) {
    console.log(`[bootstrap] already authenticated (url=${page.url()})`);
    await ctx.close();
    process.exit(0);
  }
  throw new Error(`[bootstrap] login form not found at ${page.url()}`);
}

console.log('[bootstrap] filling credentials');
await emailField.fill(env.ERP_LOGIN);
await page.locator('input[name="citizen_password"]').fill(env.ERP_PASSWORD);

await Promise.all([
  page.waitForURL(/erepublik\.com\/en(\/?|\/.*)/, { timeout: 30_000 }),
  page.locator('button[type="submit"]').click(),
]);

const finalUrl = page.url();
console.log(`[bootstrap] post-login url: ${finalUrl}`);

const cookies = await ctx.cookies();
const erpk = cookies.find((c) => c.name === 'erpk');
if (!erpk) {
  console.error('[bootstrap] FAILED: no erpk cookie set. Check credentials or solve captcha manually.');
  process.exit(1);
}

console.log(`[bootstrap] ✅ logged in; erpk cookie present (length=${erpk.value.length})`);
console.log('[bootstrap] session persisted in profile dir; safe to close');

await ctx.close();
