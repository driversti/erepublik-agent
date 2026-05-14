import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';

export interface MissionSlim {
  id: number;
  title: string;
  progress: string;
  completed: boolean;
  claimable: boolean;
}

export interface MissionStateSlim {
  total: number;
  pendingSafeDaily: number[];
  missions: MissionSlim[];
}

interface RawMission {
  id: number;
  title?: string;
  finished_at?: string | null;
  completed?: boolean;
  claimable?: boolean;
  progress?: { current?: number; threshold?: number } | number;
  hints?: Record<string, { requirement?: string }>;
}

interface RawResponse {
  missions: RawMission[];
}

const SAFE_DAILY_IDS = [100001, 100003, 100011];

function slim(m: RawMission): MissionSlim {
  const current = typeof m.progress === 'object' ? (m.progress?.current ?? 0) : (m.progress ?? 0);
  const threshold = typeof m.progress === 'object' ? (m.progress?.threshold ?? 1) : 1;
  return {
    id: m.id,
    title: m.title ?? `mission-${m.id}`,
    progress: `${current}/${threshold}`,
    completed: m.completed === true || m.finished_at != null,
    claimable: m.claimable === true,
  };
}

export async function getMissionState(ctx: BrowserContext, csrf: string): Promise<MissionStateSlim> {
  const { body } = await apiCall<RawResponse>(ctx, {
    method: 'POST',
    path: '/en/main/daily-missions-data',
    csrf,
  });
  const missions = body.missions.map(slim);
  const pendingSafeDaily = SAFE_DAILY_IDS.filter((id) => {
    const m = missions.find((x) => x.id === id);
    return m != null && !m.completed && !m.claimable;
  });
  return { total: missions.length, pendingSafeDaily, missions };
}
