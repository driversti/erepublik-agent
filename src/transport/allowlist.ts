export type HttpMethod = 'GET' | 'POST';

interface AllowEntry {
  method: HttpMethod;
  path: string;
}

const PHASE_1_ALLOWLIST: readonly AllowEntry[] = [
  { method: 'GET', path: '/en/main' },
  { method: 'POST', path: '/en/login' },
  { method: 'GET', path: '/en/main/messages-paginated' },
  { method: 'POST', path: '/en/main/daily-missions-data' },
  { method: 'POST', path: '/en/main/objective-status' },
  { method: 'GET', path: '/en/citizen/profile/' },
  { method: 'POST', path: '/en/economy/marketplaceAjax' },
  { method: 'POST', path: '/en/economy/marketplaceActions' },
  { method: 'POST', path: '/en/economy/work' },
  { method: 'GET', path: '/en/main/job-data' },
  { method: 'POST', path: '/en/economy/workOvertime' },
  { method: 'GET', path: '/en/economy/job-market-json/' },
  { method: 'POST', path: '/en/economy/resign' },
  { method: 'POST', path: '/en/economy/job-market-apply' },
  { method: 'GET', path: '/en/main/training-grounds-json' },
  { method: 'POST', path: '/en/economy/train' },
  { method: 'POST', path: '/en/main/vip-claim' },
  { method: 'POST', path: '/en/main/mission-solve' },
  { method: 'POST', path: '/en/main/objective-claim-reward' },
  { method: 'GET', path: '/en/main/weekly-challenge-data' },
  { method: 'POST', path: '/en/main/weekly-challenge-collect-all' },
  { method: 'GET', path: '/en/military/campaignsJson/list' },
  { method: 'GET', path: '/en/military/campaignsJson/citizen' },
  { method: 'GET', path: '/en/military/battle-stats/' },
  { method: 'POST', path: '/en/main/travelData' },
  { method: 'POST', path: '/en/main/travel' },
  { method: 'POST', path: '/en/main/battlefieldTravel' },
  { method: 'POST', path: '/en/military/fightDeploy-getInventory' },
  { method: 'POST', path: '/en/military/fightDeploy-startDeploy' },
  { method: 'POST', path: '/en/military/fightDeploy-cancelDeploy' },
  { method: 'POST', path: '/en/military/battle-console' },
  { method: 'GET', path: '/en/main/citizen-profile-json-personal/' },
  { method: 'GET', path: '/en/economy/inventory-json' },
];

export function isAllowed(method: HttpMethod, path: string): boolean {
  return PHASE_1_ALLOWLIST.some((e) => e.method === method && (e.path.endsWith('/') ? path.startsWith(e.path) : path === e.path));
}

export function assertAllowed(method: HttpMethod, path: string): void {
  if (!isAllowed(method, path)) {
    throw new Error(`Transport: path "${method} ${path}" not in Phase 1 allow-list`);
  }
}
