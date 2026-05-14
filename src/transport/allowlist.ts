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
  { method: 'POST', path: '/en/economy/marketplace' },
  { method: 'POST', path: '/en/economy/marketplaceBuy' },
  { method: 'POST', path: '/en/economy/work' },
  { method: 'GET', path: '/en/main/training-grounds-json' },
  { method: 'POST', path: '/en/economy/train' },
  { method: 'POST', path: '/en/main/vip-claim' },
  { method: 'POST', path: '/en/main/mission-solve' },
  { method: 'POST', path: '/en/main/objective-claim-reward' },
  { method: 'GET', path: '/en/main/weekly-challenge-data' },
  { method: 'POST', path: '/en/main/weekly-challenge-collect-all' },
];

export function isAllowed(method: HttpMethod, path: string): boolean {
  return PHASE_1_ALLOWLIST.some((e) => e.method === method && (e.path.endsWith('/') ? path.startsWith(e.path) : path === e.path));
}

export function assertAllowed(method: HttpMethod, path: string): void {
  if (!isAllowed(method, path)) {
    throw new Error(`Transport: path "${method} ${path}" not in Phase 1 allow-list`);
  }
}
