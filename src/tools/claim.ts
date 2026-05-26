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

/**
 * Identity of a freshly-claimed mission. Carries the human-readable title so
 * downstream notifications can render `Vote a Newspaper Article` instead of
 * the opaque numeric id `100007`. Titles come straight from the API's own
 * mission catalog (see [[mission_ids_reference]]).
 */
export interface ClaimedMission {
  id: number;
  title: string;
}

export interface CollectResult {
  claimed: ClaimedMission[];
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
    if (r.success) result.claimed.push({ id: m.id, title: m.title });
    else result.failed.push({ missionId: m.id, status: r.status });
  }
  return result;
}
