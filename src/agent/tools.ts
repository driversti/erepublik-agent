import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { BrowserContext } from 'playwright-core';
import { getMissionState } from '../tools/missions.js';
import { work } from '../tools/work.js';
import { train } from '../tools/train.js';
import { collectMissionRewards } from '../tools/claim.js';
import type { DailyState } from '../memory/schema.js';

export interface ToolDeps {
  ctx: BrowserContext;
  csrf: string;
  state: DailyState;
}

const ok = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

const now = () => new Date().toISOString();

export function buildTools(deps: ToolDeps) {
  return [
    tool(
      'getMissionState',
      'Read player current daily missions. Returns { total, pendingSafeDaily, missions: [{id,title,progress,completed,claimable}] }.',
      z.object({}).shape,
      async () => ok(await getMissionState(deps.ctx, deps.csrf)),
    ),
    tool(
      'work',
      'Perform the daily Work action (mission 100001). One use per eRepublik day. Returns { success, status, body }. On success, the agent should not call this again.',
      z.object({}).shape,
      async () => {
        const result = await work(deps.ctx, deps.csrf);
        if (result.success) {
          deps.state.completedActions.work = { at: now(), source: 'agent' };
        }
        return ok(result);
      },
    ),
    tool(
      'train',
      'Perform the daily Train action (mission 100003). One use per eRepublik day. Returns { success, status, body }. On success, the agent should not call this again.',
      z.object({}).shape,
      async () => {
        const result = await train(deps.ctx, deps.csrf);
        if (result.success) {
          deps.state.completedActions.train = { at: now(), source: 'agent' };
        }
        return ok(result);
      },
    ),
    tool(
      'collectMissionRewards',
      'Sweep all completed daily missions and claim their rewards in one go. Call this AFTER any action tool (work/train) succeeds. Returns { claimed: number[], skipped: number[], failed: [...] }. Safe to call even if nothing is claimable — returns empty arrays.',
      z.object({}).shape,
      async () => {
        const result = await collectMissionRewards(deps.ctx, deps.csrf, deps.state.claimedMissionIds);
        for (const id of result.claimed) {
          if (!deps.state.claimedMissionIds.includes(id)) deps.state.claimedMissionIds.push(id);
        }
        return ok(result);
      },
    ),
  ];
}
