import 'dotenv/config';
import { z } from 'zod';
import { openSession, extractCitizenContext } from './browser/session.js';
import { isBattleDivisionEmpty, listFarmableBattles } from './tools/battles.js';

const Env = z.object({
  ERP_ACCOUNT_SLUG: z.string().default('main'),
  ERP_DIVISION: z.coerce.number().int().refine((n) => [1, 2, 3, 4, 11].includes(n)).optional(),
  HEADED: z.enum(['true', 'false']).default('false'),
  FARMABLE_MIN_BATTLE_MINUTES: z.coerce.number().nonnegative().default(0),
});

const env = Env.parse(process.env);

const ctx = await openSession({ accountSlug: env.ERP_ACCOUNT_SLUG, headed: env.HEADED === 'true' });

try {
  const info = await extractCitizenContext(ctx);
  console.log(`[farmable] CSRF ok (length=${info.csrf.length})`);
  console.log(`[farmable] citizen: id=${info.citizenId ?? '?'}, country=${info.countryId ?? '?'}, division=${info.division ?? '?'}`);

  const userDivision = env.ERP_DIVISION ?? info.division;
  if (userDivision == null) {
    throw new Error('Could not detect home division from erepublik.citizen.division — set ERP_DIVISION env (1..4 or 11)');
  }
  console.log(`[farmable] using division=${userDivision}`);

  const list = await listFarmableBattles(ctx, info.csrf, userDivision);
  console.log(`[farmable] ${list.candidates.length} candidate(s) from ${list.total} active battles`);

  if (list.candidates.length === 0) {
    console.log('[farmable] no battles with our division at 50% wall — nothing to verify');
    process.exit(0);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const free: typeof list.candidates = [];

  for (const c of list.candidates) {
    const ageMin = Math.floor((nowSec - c.start) / 60);
    if (ageMin < env.FARMABLE_MIN_BATTLE_MINUTES) {
      console.log(`  ⏭  ${c.battleId} ${c.regionName} (Inv ${c.invaderId} vs Def ${c.defenderId}) — too young (${ageMin}m < ${env.FARMABLE_MIN_BATTLE_MINUTES}m)`);
      continue;
    }

    const check = await isBattleDivisionEmpty(ctx, info.csrf, c.battleId, userDivision, c.battleZoneId, c.zoneId);
    const tag = check.zoneFinished ? '🏁 done' : check.isEmpty ? '✅ empty' : '⚔️  contested';
    const dom = check.domination != null ? check.domination.toFixed(2) : '?';
    const wall = check.wallFor ?? '?';
    console.log(
      `  ${tag} battle=${c.battleId} zone=${c.battleZoneId} ${c.regionName} ` +
      `(Inv ${c.invaderId} vs Def ${c.defenderId}) age=${ageMin}m dom=${dom}% wallFor=${wall} [${c.intensityScale}]`,
    );
    if (check.isEmpty) free.push(c);
  }

  console.log('');
  console.log(`[farmable] verified-empty divisions: ${free.length}`);
  for (const c of free) {
    console.log(
      `  🌾 https://www.erepublik.com/en/military/battlefield/${c.battleId} ` +
      `— ${c.regionName} (Inv ${c.invaderId} vs Def ${c.defenderId}) battleZoneId=${c.battleZoneId}`,
    );
  }
} finally {
  await ctx.close();
}
