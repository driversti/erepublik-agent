import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';

export interface WorkResult {
  success: boolean;
  status: number;
  body: unknown;
}

/**
 * eRepublik action endpoints answer HTTP 200 for both "did the thing" and
 * "could not do the thing" (e.g. unemployed citizen). Without parsing the body
 * we used to falsely flip the daily `work` flag on no-op responses, after which
 * `pendingActions` no longer included `work` and the auto-employ sweep stayed
 * dormant until the next 00:00 PST rollover. Reject obvious failure markers.
 */
export function isWorkSuccess(status: number, body: unknown): boolean {
  if (status !== 200) return false;
  if (body == null || typeof body !== 'object') return true;
  const b = body as Record<string, unknown>;
  if (b.status === false) return false;
  if (b.error === true) return false;
  return true;
}

export async function work(ctx: BrowserContext, csrf: string): Promise<WorkResult> {
  const { status, body } = await apiCall(ctx, {
    method: 'POST',
    path: '/en/economy/work',
    csrf,
    form: { action_type: 'work' },
  });
  return { success: isWorkSuccess(status, body), status, body };
}
