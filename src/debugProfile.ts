/**
 * Scratch debug — dump `military.militaryData` keys from
 * citizen-profile-json-personal so we can confirm the exact JSON key
 * for aircraft rank. See plan §0a in
 * docs/superpowers/plans/2026-05-19-d4tw-air-strategy.md.
 *
 * Run: ERP_ACCOUNT_SLUG=<slug> tsx src/debugProfile.ts
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

console.log(`[debug-profile] using profile slug=${env.ERP_ACCOUNT_SLUG}`);

const ctx = await openSession({ accountSlug: env.ERP_ACCOUNT_SLUG, headed: env.HEADED === 'true' });
const info = await extractCitizenContext(ctx, { refresh: true });

if (!info.csrf || !info.citizenId) {
  console.error('[debug-profile] no csrf/citizenId after extract — session expired?');
  console.error('info =', { csrf: info.csrf?.slice(0, 12), citizenId: info.citizenId });
  await ctx.close();
  process.exit(1);
}

console.log(`[debug-profile] citizenId=${info.citizenId}, name=${info.name ?? '?'}, country=${info.countryId}`);

const res = await ctx.request.get(
  `https://www.erepublik.com/en/main/citizen-profile-json-personal/${info.citizenId}`,
  {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://www.erepublik.com/en',
    },
  },
);

console.log(`[debug-profile] status=${res.status()}`);
const body: Record<string, unknown> = await res.json();

console.log('\n=== top-level keys ===');
console.log(Object.keys(body));

const military = body?.military as Record<string, unknown> | undefined;
if (military) {
  console.log('\n=== military keys ===');
  console.log(Object.keys(military));

  const md = military.militaryData as Record<string, unknown> | undefined;
  if (md) {
    console.log('\n=== military.militaryData keys ===');
    console.log(Object.keys(md));
    console.log('\n=== military.militaryData values matching /rank|air|aircraft|strength/i ===');
    for (const k of Object.keys(md)) {
      if (/rank|air|aircraft|strength/i.test(k)) {
        console.log(`  ${k} = ${JSON.stringify(md[k])}`);
      }
    }
  } else {
    console.log('[debug-profile] no military.militaryData!');
  }

  console.log('\n=== military.* sibling objects with air/aircraft/rank keys ===');
  for (const k of Object.keys(military)) {
    const v = military[k];
    if (v && typeof v === 'object') {
      const inner = Object.keys(v as Record<string, unknown>);
      const hits = inner.filter((kk) => /air|aircraft|rank/i.test(kk));
      if (hits.length > 0) {
        console.log(`  military.${k}: ${hits.join(', ')}`);
      }
    }
  }
} else {
  console.log('[debug-profile] no `military` block on the profile response');
  console.log('Sample (first 800 chars):', JSON.stringify(body, null, 2).slice(0, 800));
}

await ctx.close();
