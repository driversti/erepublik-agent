import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { BrowserContext } from 'playwright-core';
import { getMissionState } from '../tools/missions.js';
import { work } from '../tools/work.js';
import { train } from '../tools/train.js';
import { collectMissionRewards } from '../tools/claim.js';
import { claimVip } from '../tools/vip.js';
import { collectObjectiveRewards } from '../tools/objectives.js';
import { collectWeeklyChallenge } from '../tools/weekly.js';
import type { DailyState } from '../memory/schema.js';
import type { WeeklyState } from '../memory/weeklyState.js';

export interface ToolDeps {
  ctx: BrowserContext;
  csrf: string;
  state: DailyState;
  weekly: WeeklyState;
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
      'vipClaim',
      'Claim the daily VIP gift (POST /en/main/vip-claim). Idempotent — calling twice returns the same already-claimed result. One use per eRepublik day.',
      z.object({}).shape,
      async () => {
        const result = await claimVip(deps.ctx, deps.csrf);
        if (result.success) {
          deps.state.completedActions.vipClaim = { at: now(), source: 'agent' };
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
    tool(
      'collectWeeklyChallengeRewards',
      'Sweep the Weekly Challenge: if any reward tier has been completed past the last-claimed one, claim everything up to the new max. Returns { claimed, maxRewardId, reason? }. Idempotent — calling repeatedly does nothing once up to date.',
      z.object({}).shape,
      async () => {
        const result = await collectWeeklyChallenge(deps.ctx, deps.csrf, deps.weekly.lastClaimedRewardId);
        if (result.claimed && result.maxRewardId != null) {
          deps.weekly.lastClaimedRewardId = result.maxRewardId;
        }
        return ok(result);
      },
    ),
    tool(
      'collectObjectiveRewards',
      'Sweep all unlocked Daily Objective chests (AP thresholds 20/40/60/80/100) and claim them. Call this once per cycle, after collectMissionRewards. Returns { claimed: number[], failed: [...] } where claimed is the list of AP cost thresholds just collected.',
      z.object({}).shape,
      async () => {
        const result = await collectObjectiveRewards(deps.ctx, deps.csrf, deps.state.claimedChestThresholds);
        for (const cost of result.claimed) {
          if (!deps.state.claimedChestThresholds.includes(cost)) deps.state.claimedChestThresholds.push(cost);
        }
        return ok(result);
      },
    ),
  ];
}
