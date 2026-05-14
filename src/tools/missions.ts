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

interface RawProgress {
  current?: number;
  threshold?: number;
  completed?: boolean;
}

interface RawMission {
  id: number;
  title?: string;
  finished_at?: string | null;
  completed?: boolean;
  claimable?: boolean;
  progress?: RawProgress[] | RawProgress | number;
  hints?: Record<string, { requirement?: string }>;
}

interface RawResponse {
  missions: RawMission[];
}

const SAFE_DAILY_IDS = [100001, 100003, 100011];

function firstProgress(m: RawMission): RawProgress | null {
  if (Array.isArray(m.progress)) return m.progress[0] ?? null;
  if (m.progress != null && typeof m.progress === 'object') return m.progress;
  return null;
}

function slim(m: RawMission): MissionSlim {
  const p = firstProgress(m);
  const current = p?.current ?? 0;
  const threshold = p?.threshold ?? 1;
  const completed = p?.completed === true || m.completed === true || m.finished_at != null;
  return {
    id: m.id,
    title: m.title ?? `mission-${m.id}`,
    progress: `${current}/${threshold}`,
    completed,
    claimable: completed && m.claimable !== false,
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
