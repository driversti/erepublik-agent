import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';

export interface WorkResult {
  success: boolean;
  status: number;
  body: unknown;
}

export async function work(ctx: BrowserContext, csrf: string): Promise<WorkResult> {
  const { status, body } = await apiCall(ctx, {
    method: 'POST',
    path: '/en/economy/work',
    csrf,
    form: { action_type: 'work' },
  });
  return { success: status === 200, status, body };
}
