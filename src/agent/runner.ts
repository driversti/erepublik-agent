import 'dotenv/config';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BrowserContext } from 'playwright-core';
import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';
import { openSession, extractCsrf } from '../browser/session.js';
import { buildTools } from './tools.js';
import { eRepublikDay } from '../erepublik/day.js';
import { loadOrInit, save } from '../memory/dailyState.js';
import { allSafeDailyDone, pendingActions, type DailyState } from '../memory/schema.js';
import { reconcile } from './cycle.js';
import { getMissionState } from '../tools/missions.js';
import { getObjectiveStatus } from '../tools/objectives.js';
import { getWeeklyChallenge } from '../tools/weekly.js';
import { loadWeekly, saveWeekly, type WeeklyState } from '../memory/weeklyState.js';
import { TelegramNotifier } from '../telegram/notifier.js';

const Env = z.object({
  ERP_ACCOUNT_SLUG: z.string().default('main'),
  HEADED: z.enum(['true', 'false']).default('false'),
  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().default('claude-haiku-4-5'),
  MAX_AGENT_ITERATIONS: z.coerce.number().int().positive().default(8),
  LOOP_INTERVAL_MS: z.coerce.number().int().positive().default(600_000),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
});
type Env = z.infer<typeof Env>;

const env = Env.parse(process.env);
process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');

function systemPrompt(pending: string[], claimedIds: number[]): string {
  return `You are erepublik-agent.

Today's pending safe-daily actions: [${pending.join(', ')}].
Already-claimed mission IDs: [${claimedIds.join(', ') || 'none'}].

Step 1 — For each item in the pending list, call the matching tool exactly once:
- "work" → call the work tool
- "train" → call the train tool
- "vipClaim" → call the vipClaim tool

Step 2 — After ALL action tools have returned (even if pending was empty), call collectMissionRewards exactly once.

Step 3 — Then call collectObjectiveRewards exactly once to claim any unlocked AP chests.

Step 4 — Then call collectWeeklyChallengeRewards exactly once to claim any new weekly tiers.

Rules:
- Skip any action NOT in the pending list.
- One call per item. Do NOT retry on success. Do NOT call the same tool twice.
- collectMissionRewards, collectObjectiveRewards, and collectWeeklyChallengeRewards are each called at most once per cycle, in that order, after the actions.
- After all tools return, reply in <40 words summarising what you did.
- No emoji. No tables. No invented tools.`;
}

function snapshotHash(state: DailyState, weekly: WeeklyState): string {
  const data = JSON.stringify({ state, weekly });
  return createHash('sha256').update(data).digest('hex').slice(0, 12);
}

function formatDigest(day: number, state: DailyState, weekly: WeeklyState): string {
  const a = state.completedActions;
  const flag = (v: unknown) => (v ? '✅' : '⏳');
  return [
    `*erepublik-agent* — day ${day}`,
    `Work ${flag(a.work)}  Train ${flag(a.train)}  VIP ${flag(a.vipClaim)}`,
    `Missions claimed: ${state.claimedMissionIds.join(', ') || '—'}`,
    `Chests claimed: ${state.claimedChestThresholds.join(', ') || '—'}`,
    `Weekly maxRewardId: ${weekly.lastClaimedRewardId ?? '—'}`,
  ].join('\n');
}

async function runCycle(
  ctx: BrowserContext,
  notifier: TelegramNotifier,
): Promise<void> {
  const day = eRepublikDay();
  const { state, rolledOver } = loadOrInit(day);
  const weekly = loadWeekly();
  console.log(`[cycle] day=${day}${rolledOver ? ' (rolled over)' : ''}`);

  const csrf = await extractCsrf(ctx);

  const missions = await getMissionState(ctx, csrf);
  console.log(`[cycle] api: ${missions.total} missions, pendingSafeDaily=[${missions.pendingSafeDaily.join(', ')}]`);

  const mutated = reconcile(state, missions);
  if (mutated) console.log('[cycle] memory reconciled from API state');

  const objectives = await getObjectiveStatus(ctx, csrf);
  for (const cost of objectives.claimed) {
    if (!state.claimedChestThresholds.includes(cost)) state.claimedChestThresholds.push(cost);
  }
  console.log(`[cycle] objectives: progress=${objectives.progress}, claimed=[${objectives.claimed.join(', ')}], available=[${objectives.available.join(', ')}]`);

  const weeklyStatus = await getWeeklyChallenge(ctx, csrf);
  if (
    weeklyStatus.maxCompleted != null &&
    weekly.lastClaimedRewardId != null &&
    weeklyStatus.maxCompleted < weekly.lastClaimedRewardId
  ) {
    console.log(`[cycle] weekly: reset detected (api=${weeklyStatus.maxCompleted} < memory=${weekly.lastClaimedRewardId})`);
    weekly.lastClaimedRewardId = null;
  }
  const weeklyUnclaimed =
    weeklyStatus.maxCompleted != null && weeklyStatus.maxCompleted > (weekly.lastClaimedRewardId ?? 0);
  console.log(`[cycle] weekly: maxCompleted=${weeklyStatus.maxCompleted ?? 'none'}, lastClaimed=${weekly.lastClaimedRewardId ?? 'none'}, unclaimed=${weeklyUnclaimed}`);

  const completedMissionIds = missions.missions.filter((m) => m.completed).map((m) => m.id);
  const unclaimedMissions = completedMissionIds.filter((id) => !state.claimedMissionIds.includes(id));
  const unclaimedObjectives = objectives.available.filter((c) => !state.claimedChestThresholds.includes(c));
  const shortCircuit =
    allSafeDailyDone(state) &&
    unclaimedMissions.length === 0 &&
    unclaimedObjectives.length === 0 &&
    !weeklyUnclaimed;

  try {
    if (shortCircuit) {
      console.log('[cycle] ✅ all safe-daily flags set and no unclaimed rewards — short-circuit, no LLM call');
    } else {
      const pending = pendingActions(state);
      console.log(
        `[cycle] pending: [${pending.join(', ')}], unclaimedMissions: [${unclaimedMissions.join(', ')}], unclaimedObjectives: [${unclaimedObjectives.join(', ')}] → invoking ${env.CLAUDE_MODEL}`,
      );

      const tools = buildTools({ ctx, csrf, state, weekly });
      const mcpServer = createSdkMcpServer({ name: 'erepublik-agent-tools', tools });

      const stream = query({
        prompt: 'Run the cycle now.',
        options: {
          systemPrompt: systemPrompt(pending, state.claimedMissionIds),
          model: env.CLAUDE_MODEL,
          maxTurns: env.MAX_AGENT_ITERATIONS,
          tools: [],
          allowedTools: ['mcp__erepublik-agent-tools__*'],
          mcpServers: { 'erepublik-agent-tools': mcpServer },
          permissionMode: 'bypassPermissions',
        },
      });

      for await (const msg of stream) {
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              process.stdout.write(block.text);
            } else if (block.type === 'tool_use') {
              console.log(`\n[agent] → tool ${block.name}(${JSON.stringify(block.input).slice(0, 120)})`);
            }
          }
        } else if (msg.type === 'result') {
          console.log('\n[agent] ── result ──');
          console.log(`  duration_ms: ${msg.duration_ms}, turns: ${msg.num_turns}, cost_usd: ${msg.total_cost_usd}`);
        }
      }
    }
  } finally {
    save(state);
    saveWeekly(weekly);
  }

  const hash = snapshotHash(state, weekly);
  if (hash !== state.lastDigestHash) {
    const digest = formatDigest(day, state, weekly);
    console.log('[cycle] digest:\n' + digest);
    await notifier.send(digest);
    state.lastDigestHash = hash;
    save(state);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const ctx = await openSession({ accountSlug: env.ERP_ACCOUNT_SLUG, headed: env.HEADED === 'true' });
const notifier = new TelegramNotifier({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID });

let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.log('\n[runner] SIGINT received — finishing current cycle then exiting');
});

try {
  do {
    try {
      await runCycle(ctx, notifier);
    } catch (err) {
      const message = (err as Error).message;
      console.error('[cycle] failed:', message);
      await notifier.sendError(message);
    }
    if (ONCE || stopping) break;
    console.log(`[runner] sleeping ${env.LOOP_INTERVAL_MS / 1000}s`);
    await sleep(env.LOOP_INTERVAL_MS);
  } while (!stopping);
} finally {
  await ctx.close();
  console.log('[runner] stopped');
}
