/**
 * Scratch debug — dump inventory item categories and the unique `type`
 * strings inside mainStorage. Verifies the constant
 * `AIR_WEAPON_TYPE = 'airWeapon'` in `src/farm/strategies/d4twAir.ts`
 * matches the live API. See plan §0b in
 * docs/superpowers/plans/2026-05-19-d4tw-air-strategy.md.
 *
 * Run: ERP_ACCOUNT_SLUG=<slug> tsx src/debugInventory.ts
 */
import { config as loadDotenv } from 'dotenv';
import { join } from 'node:path';
import { z } from 'zod';
import { openSession, extractCitizenContext } from './browser/session.js';
import { configDir } from './paths.js';

loadDotenv({ path: join(configDir(), '.env') });
loadDotenv();

const Env = z.object({
  ERP_ACCOUNT_SLUG: z.string().default('main'),
  HEADED: z.enum(['true', 'false']).default('false'),
});
const env = Env.parse(process.env);

console.log(`[debug-inventory] using profile slug=${env.ERP_ACCOUNT_SLUG}`);

const ctx = await openSession({ accountSlug: env.ERP_ACCOUNT_SLUG, headed: env.HEADED === 'true' });
const info = await extractCitizenContext(ctx, { refresh: true });

if (!info.csrf) {
  console.error('[debug-inventory] no csrf — session expired?');
  await ctx.close();
  process.exit(1);
}

console.log(`[debug-inventory] citizen=${info.name ?? '?'} (${info.citizenId})`);

const res = await ctx.request.get('https://www.erepublik.com/en/economy/inventory-json', {
  headers: {
    'X-Requested-With': 'XMLHttpRequest',
    Referer: 'https://www.erepublik.com/en',
  },
});

console.log(`[debug-inventory] status=${res.status()}`);
const body: unknown = await res.json();

if (!Array.isArray(body)) {
  console.log('[debug-inventory] body is not an array! shape:');
  console.log(JSON.stringify(body, null, 2).slice(0, 500));
  await ctx.close();
  process.exit(1);
}

console.log('\n=== inventory categories ===');
for (const cat of body as Array<Record<string, unknown>>) {
  const id = cat.id;
  const items = cat.items;
  const count = Array.isArray(items) ? items.length : 0;
  console.log(`  id=${JSON.stringify(id)}, items=${count}`);
}

const main = (body as Array<Record<string, unknown>>).find((c) => c.id === 'mainStorage');
if (!main || !Array.isArray(main.items)) {
  console.log('\n[debug-inventory] no mainStorage category!');
  await ctx.close();
  process.exit(1);
}

const items = main.items as Array<Record<string, unknown>>;
console.log(`\n=== mainStorage: ${items.length} items ===`);

const types = new Set<string>();
const byType = new Map<string, Array<{ quality: number; amount: number }>>();
for (const item of items) {
  const t = typeof item.type === 'string' ? item.type : '(no type)';
  types.add(t);
  if (!byType.has(t)) byType.set(t, []);
  byType.get(t)!.push({
    quality: typeof item.quality === 'number' ? item.quality : -1,
    amount: typeof item.amount === 'number' ? item.amount : -1,
  });
}

console.log('\n=== unique mainStorage types ===');
for (const t of [...types].sort()) {
  console.log(`  "${t}"`);
}

console.log('\n=== items per type (quality × amount) ===');
for (const [t, rows] of byType) {
  if (/weapon|aircraft|bomb|air/i.test(t)) {
    console.log(`  "${t}":`);
    for (const r of rows.sort((a, b) => b.quality - a.quality)) {
      console.log(`     Q${r.quality} × ${r.amount}`);
    }
  }
}

await ctx.close();
