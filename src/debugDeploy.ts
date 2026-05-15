import 'dotenv/config';
import { z } from 'zod';
import { openSession, extractCitizenContext } from './browser/session.js';
import { apiCall } from './transport/apiCall.js';
import { listFarmableBattles } from './tools/battles.js';

const Env = z.object({
  ERP_ACCOUNT_SLUG: z.string().default('main'),
  HEADED: z.enum(['true', 'false']).default('false'),
});
const env = Env.parse(process.env);

const args = process.argv.slice(2);
const battleIdArg = args.find((a) => a.startsWith('--battle='))?.split('=')[1];
const sideArg = args.find((a) => a.startsWith('--side='))?.split('=')[1];
if (!battleIdArg) {
  console.error('Usage: npm run debug-deploy -- --battle=<id> [--side=invader|defender]');
  process.exit(1);
}
const battleId = Number(battleIdArg);
const sideTag = sideArg ?? 'invader';

const ctx = await openSession({ accountSlug: env.ERP_ACCOUNT_SLUG, headed: env.HEADED === 'true' });

function pretty(label: string, body: unknown) {
  console.log(`\n── ${label} ──`);
  console.log(JSON.stringify(body, null, 2));
}

try {
  const info = await extractCitizenContext(ctx);
  console.log(`[debug] citizen=${info.citizenId} country=${info.countryId} division=${info.division} residenceRegion=${info.residenceRegionId}`);

  const list = await listFarmableBattles(ctx, info.csrf, info.division ?? 1);
  const target = list.candidates.find((c) => c.battleId === battleId);
  if (!target) throw new Error(`Battle ${battleId} not in farmable list`);
  console.log(
    `[debug] battle=${battleId} ${target.regionName} (Inv ${target.invaderId} vs Def ${target.defenderId}) ` +
      `battleZoneId=${target.battleZoneId} zoneId=${target.zoneId}`,
  );
  const sideCountryId = sideTag === 'defender' ? target.defenderId : target.invaderId;
  console.log(`[debug] testing side: ${sideTag} (country=${sideCountryId})`);

  // 1. Inventory PRE-travel
  const invPre = await apiCall(ctx, {
    method: 'POST',
    path: '/en/military/fightDeploy-getInventory',
    csrf: info.csrf,
    form: { battleId, sideCountryId, battleZoneId: target.battleZoneId },
  });
  pretty('inventory (PRE-travel)', invPre.body);

  // 2. travelData
  const tdata = await apiCall(ctx, {
    method: 'POST',
    path: '/en/main/travelData',
    csrf: info.csrf,
    form: { holdingId: 0, battleId, regionId: info.residenceRegionId ?? 0 },
  });
  pretty('travelData', tdata.body);

  // 3. battlefieldTravel (with default inRegionId from travelData)
  const t = tdata.body as {
    countries?: Record<string, { regions?: number[] }>;
    regions?: Record<string, { id: number; cost: number }>;
  };
  const country = t.countries?.[String(sideCountryId)];
  const firstRegionId = country?.regions?.[0];
  if (!firstRegionId) throw new Error(`No regions in travelData for country ${sideCountryId}`);
  console.log(`\n[debug] traveling to country=${sideCountryId} region=${firstRegionId}`);

  const travel = await apiCall(ctx, {
    method: 'POST',
    path: '/en/main/battlefieldTravel',
    csrf: info.csrf,
    form: {
      battleId,
      battleZoneId: target.battleZoneId,
      sideCountryId,
      toCountryId: sideCountryId,
      inRegionId: firstRegionId,
    },
  });
  pretty('battlefieldTravel response', travel.body);

  // 4. Inventory POST-travel
  const invPost = await apiCall(ctx, {
    method: 'POST',
    path: '/en/military/fightDeploy-getInventory',
    csrf: info.csrf,
    form: { battleId, sideCountryId, battleZoneId: target.battleZoneId },
  });
  pretty('inventory (POST-travel)', invPost.body);

  // 5. cancel-deploy
  const cancel = await apiCall(ctx, {
    method: 'POST',
    path: '/en/military/fightDeploy-cancelDeploy',
    csrf: info.csrf,
    form: { battleId },
  });
  pretty('cancel-deploy', cancel.body);

  // 6. Try one deploy attempt with energySources
  const deploy = await apiCall(ctx, {
    method: 'POST',
    path: '/en/military/fightDeploy-startDeploy',
    csrf: info.csrf,
    form: {
      battleId,
      battleZoneId: target.battleZoneId,
      sideCountryId,
      weaponQuality: -1,
      totalEnergy: 33,
      skinId: 14,
      'energySources[0][quality]': 1,
      'energySources[0][amount]': 0,
    },
  });
  pretty('deploy attempt response', deploy.body);
} finally {
  await ctx.close();
}
