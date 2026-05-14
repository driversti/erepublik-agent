import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';
import { getMissionState } from './missions.js';

export interface ClaimMissionResult {
  missionId: number;
  success: boolean;
  status: number;
  body: unknown;
}

export async function claimMission(
  ctx: BrowserContext,
  csrf: string,
  missionId: number,
): Promise<ClaimMissionResult> {
  const { status, body } = await apiCall(ctx, {
    method: 'POST',
    path: '/en/main/mission-solve',
    csrf,
    form: { missionId },
  });
  return { missionId, success: status === 200, status, body };
}

export interface CollectResult {
  claimed: number[];
  skipped: number[];
  failed: { missionId: number; status: number }[];
}

/**
 * Sweep all completed-but-unclaimed missions and claim them.
 * `alreadyClaimed` is the local memory cache to skip ids we know are done.
 */
export async function collectMissionRewards(
  ctx: BrowserContext,
  csrf: string,
  alreadyClaimed: number[],
): Promise<CollectResult> {
  const state = await getMissionState(ctx, csrf);
  const candidates = state.missions.filter((m) => m.completed && !alreadyClaimed.includes(m.id));

  const result: CollectResult = { claimed: [], skipped: [], failed: [] };
  for (const m of candidates) {
    const r = await claimMission(ctx, csrf, m.id);
    if (r.success) result.claimed.push(m.id);
    else result.failed.push({ missionId: m.id, status: r.status });
  }
  return result;
}
