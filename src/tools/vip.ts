import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';

export interface VipClaimResult {
  success: boolean;
  status: number;
  body: unknown;
}

export async function claimVip(ctx: BrowserContext, csrf: string): Promise<VipClaimResult> {
  const { status, body } = await apiCall(ctx, {
    method: 'POST',
    path: '/en/main/vip-claim',
    csrf,
  });
  return { success: status === 200, status, body };
}
