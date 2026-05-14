import 'dotenv/config';
import { z } from 'zod';
import { openSession, extractCsrf } from './browser/session.js';
import { getMissionState } from './tools/missions.js';

const Env = z.object({
  ERP_ACCOUNT_SLUG: z.string().default('main'),
  HEADED: z.enum(['true', 'false']).default('false'),
});

const env = Env.parse(process.env);

const ctx = await openSession({ accountSlug: env.ERP_ACCOUNT_SLUG, headed: env.HEADED === 'true' });

try {
  const csrf = await extractCsrf(ctx);
  console.log(`[showMissions] CSRF ok (length=${csrf.length})`);

  const state = await getMissionState(ctx, csrf);
  console.log(`[showMissions] ✅ ${state.total} missions, pendingSafeDaily=[${state.pendingSafeDaily.join(', ')}]`);
  for (const m of state.missions) {
    const icon = m.claimable ? '🎁' : m.completed ? '✅' : '⏳';
    console.log(`  ${icon} ${m.id} ${m.progress} — ${m.title}`);
  }
} finally {
  await ctx.close();
}
