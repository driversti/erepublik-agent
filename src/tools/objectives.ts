import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';

interface RawObjectiveStatus {
  status?: {
    progress?: number;
    claimedObjectives?: Record<string, boolean>;
  };
  data?: Record<string, unknown>;
}

export interface ObjectiveStatus {
  progress: number;
  available: number[];
  claimed: number[];
}

export async function getObjectiveStatus(ctx: BrowserContext, csrf: string): Promise<ObjectiveStatus> {
  const { body } = await apiCall<RawObjectiveStatus>(ctx, {
    method: 'POST',
    path: '/en/main/objective-status',
    csrf,
  });

  const progress = body.status?.progress ?? 0;
  const claimedMap = body.status?.claimedObjectives ?? {};
  const thresholds = Object.keys(body.data ?? {}).map((c) => Number(c)).filter((n) => Number.isFinite(n));

  const claimed: number[] = [];
  const available: number[] = [];
  for (const cost of thresholds) {
    if (claimedMap[String(cost)]) claimed.push(cost);
    else if (cost <= progress) available.push(cost);
  }

  return { progress, available, claimed };
}

export interface ClaimObjectiveResult {
  cost: number;
  success: boolean;
  status: number;
  body: unknown;
}

export async function claimObjective(
  ctx: BrowserContext,
  csrf: string,
  cost: number,
): Promise<ClaimObjectiveResult> {
  const { status, body } = await apiCall(ctx, {
    method: 'POST',
    path: '/en/main/objective-claim-reward',
    csrf,
    form: { objectiveCost: cost },
  });
  return { cost, success: status === 200, status, body };
}

export interface CollectObjectivesResult {
  claimed: number[];
  failed: { cost: number; status: number }[];
}

export async function collectObjectiveRewards(
  ctx: BrowserContext,
  csrf: string,
  alreadyClaimed: number[],
): Promise<CollectObjectivesResult> {
  const s = await getObjectiveStatus(ctx, csrf);
  const candidates = s.available.filter((c) => !alreadyClaimed.includes(c));

  const result: CollectObjectivesResult = { claimed: [], failed: [] };
  for (const cost of candidates) {
    const r = await claimObjective(ctx, csrf, cost);
    if (r.success) result.claimed.push(cost);
    else result.failed.push({ cost, status: r.status });
  }
  return result;
}
