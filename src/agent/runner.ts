import 'dotenv/config';
import { z } from 'zod';
import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';
import { openSession, extractCsrf } from '../browser/session.js';
import { buildTools } from './tools.js';
import { eRepublikDay } from '../erepublik/day.js';
import { loadOrInit, save } from '../memory/dailyState.js';
import { allSafeDailyDone, pendingActions } from '../memory/schema.js';
import { reconcile } from './cycle.js';
import { getMissionState } from '../tools/missions.js';

const Env = z.object({
  ERP_ACCOUNT_SLUG: z.string().default('main'),
  HEADED: z.enum(['true', 'false']).default('false'),
  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().default('claude-haiku-4-5'),
  MAX_AGENT_ITERATIONS: z.coerce.number().int().positive().default(8),
});

const env = Env.parse(process.env);
process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;

function systemPrompt(pending: string[], claimedIds: number[]): string {
  return `You are erepublik-agent.

Today's pending safe-daily actions: [${pending.join(', ')}].
Already-claimed mission IDs: [${claimedIds.join(', ') || 'none'}].

Step 1 — For each item in the pending list, call the matching tool exactly once:
- "work" → call the work tool
- "train" → call the train tool

Step 2 — After ALL action tools have returned (even if pending was empty), call collectMissionRewards exactly once to sweep up any unclaimed mission rewards.

Rules:
- Skip any action NOT in the pending list.
- One call per item. Do NOT retry on success. Do NOT call the same tool twice.
- collectMissionRewards is called at most once per cycle, after the actions.
- After all tools return, reply in <40 words summarising what you did.
- No emoji. No tables. No invented tools.`;
}

const day = eRepublikDay();
const { state, rolledOver } = loadOrInit(day);
console.log(`[cycle] day=${day}${rolledOver ? ' (rolled over)' : ''}`);

const ctx = await openSession({ accountSlug: env.ERP_ACCOUNT_SLUG, headed: env.HEADED === 'true' });

try {
  const csrf = await extractCsrf(ctx);

  const missions = await getMissionState(ctx, csrf);
  console.log(`[cycle] api: ${missions.total} missions, pendingSafeDaily=[${missions.pendingSafeDaily.join(', ')}]`);

  const mutated = reconcile(state, missions);
  if (mutated) {
    console.log('[cycle] memory reconciled from API state');
    save(state);
  }

  // Only short-circuit if nothing pending AND nothing left to claim.
  const completedMissionIds = missions.missions.filter((m) => m.completed).map((m) => m.id);
  const unclaimed = completedMissionIds.filter((id) => !state.claimedMissionIds.includes(id));
  if (allSafeDailyDone(state) && unclaimed.length === 0) {
    console.log('[cycle] ✅ all safe-daily flags set and no unclaimed rewards — short-circuit, no LLM call');
    process.exit(0);
  }

  const pending = pendingActions(state);
  console.log(`[cycle] pending: [${pending.join(', ')}], unclaimed: [${unclaimed.join(', ')}] → invoking ${env.CLAUDE_MODEL}`);

  const tools = buildTools({ ctx, csrf, state });
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
} finally {
  save(state);
  await ctx.close();
}
