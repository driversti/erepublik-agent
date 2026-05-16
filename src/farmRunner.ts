import 'dotenv/config';
import { z } from 'zod';
import { openSession, extractCitizenContext } from './browser/session.js';
import { getStrategy } from './farm/strategies/index.js';

const Env = z.object({
  ERP_ACCOUNT_SLUG: z.string().default('main'),
  HEADED: z.enum(['true', 'false']).default('false'),
  ERP_FARM_MAX_BATTLES: z.coerce.number().int().nonnegative().default(5),
});
const env = Env.parse(process.env);

const args = process.argv.slice(2);
const execute = args.includes('--execute');

const mode = execute ? '🔥 EXECUTE' : '🧪 DRY-RUN';
console.log(`[farm-runner] mode=${mode} maxBattles=${env.ERP_FARM_MAX_BATTLES}`);

const ctx = await openSession({ accountSlug: env.ERP_ACCOUNT_SLUG, headed: env.HEADED === 'true' });
const t0 = Date.now();

try {
  const raw = await extractCitizenContext(ctx, { refresh: true });
  if (
    raw.division == null ||
    raw.citizenId == null ||
    raw.countryId == null ||
    raw.residenceRegionId == null
  ) {
    throw new Error(
      `Missing citizen context: division=${raw.division}, citizenId=${raw.citizenId}, countryId=${raw.countryId}, residenceRegionId=${raw.residenceRegionId}`,
    );
  }
  const residenceCountryId = raw.residenceCountryId ?? raw.countryId;
  if (raw.residenceCountryId == null) {
    console.log(
      `[farm-runner] ⚠ residenceCountryId not in page context — falling back to citizenship country ${raw.countryId}`,
    );
  }
  console.log(
    `[farm-runner] citizen=${raw.citizenId} country=${raw.countryId} division=${raw.division} ` +
      `residence=region${raw.residenceRegionId}/country${residenceCountryId} ` +
      `energy=${raw.energy}/${raw.energyPoolLimit} fuel=${raw.fuelLeft}/${raw.maxFuel}`,
  );

  const result = await getStrategy('standard').run(
    ctx,
    {
      csrf: raw.csrf,
      citizenId: raw.citizenId,
      countryId: raw.countryId,
      division: raw.division,
      residenceRegionId: raw.residenceRegionId,
      residenceCountryId,
      strength: raw.strength,
      rankNumber: raw.rankNumber,
      hasMaverick: raw.hasMaverick,
      currentCountryId: raw.currentCountryId,
    },
    {
      maxBattles: env.ERP_FARM_MAX_BATTLES,
      dryRun: !execute,
    },
  );

  console.log('');
  console.log(`── summary (${((Date.now() - t0) / 1000).toFixed(1)}s) — stop=${result.stopReason} ──`);
  console.log(`  farmed: ${result.wins.length}/${env.ERP_FARM_MAX_BATTLES}`);
  for (const w of result.wins) {
    console.log(`    • ${w.battleId} ${w.regionName}: inv ${w.inv.attempts}att, def ${w.def.attempts}att`);
  }
  if (result.skipped.length) {
    console.log(`  skipped: ${result.skipped.length}`);
    for (const s of result.skipped.slice(0, 10)) {
      console.log(`    – ${s.battleId} ${s.regionName}: ${s.reason}`);
    }
    if (result.skipped.length > 10) console.log(`    … +${result.skipped.length - 10} more`);
  }
  if (result.fuelLeftAtEnd != null) console.log(`  last fuelLeft: ${result.fuelLeftAtEnd}`);
  console.log(`  hops: ${result.hops} (total travel: ${result.totalTravelCC}cc)`);
  console.log(`  sequence: ${result.sequence}`);
} finally {
  await ctx.close();
}
