import { createHash } from 'node:crypto';
import type { DailyState } from '../memory/schema.js';
import type { WeeklyState } from '../memory/weeklyState.js';
import type { WeeklyFuelState } from '../memory/weeklyFuelState.js';

/**
 * Hash the *formatted digest text* so we can detect "this looks identical to
 * the last one we sent" without leaking hidden state into the decision.
 *
 * Previous design hashed an opinionated subset of the raw state — but it was
 * still too inclusive: `fuel.lastFarmedAt` (re-stamped on every farm cycle,
 * even zero-hit ones), `state.awaySince`, and the per-action `at` ISO strings
 * all flapped without changing what the user sees in Telegram, which spammed
 * the chat with the same digest over and over. Hashing the rendered text
 * makes the contract self-evident: same message → no resend.
 */
export function digestHash(digestText: string): string {
  return createHash('sha256').update(digestText).digest('hex').slice(0, 12);
}

/**
 * Format a one-shot Telegram digest summarising the cycle outcome. Kept
 * deliberately compact — operators receive this in a chat, not a log file.
 */
export function formatDigest(
  day: number,
  state: DailyState,
  weekly: WeeklyState,
  fuel: WeeklyFuelState,
  weeklyFuelBudget: number,
): string {
  const a = state.completedActions;
  const flag = (v: unknown) => (v ? '✅' : '⏳');
  // Body fields are number/comma/em-dash only — none are MarkdownV2-reserved.
  // The header dash and the literal "/" inside "23/140" need escaping (only
  // the dash; "/" isn't reserved in MarkdownV2). The literal "*" pair is the
  // bold delimiter and stays unescaped.
  return [
    `*erepublik\\-agent* — day ${day}`,
    `Work ${flag(a.work)}  Train ${flag(a.train)}  OT ${flag(a.workOvertime)}  VIP ${flag(a.vipClaim)}  Food ${flag(a.buyFood)}`,
    `Missions claimed: ${state.claimedMissionIds.join(', ') || '—'}`,
    `Chests claimed: ${state.claimedChestThresholds.join(', ') || '—'}`,
    `Weekly maxRewardId: ${weekly.lastClaimedRewardId ?? '—'}`,
    `Fuel week ${fuel.week}: spent ${fuel.spent}/${weeklyFuelBudget}, hits ${fuel.hitsLanded}`,
  ].join('\n');
}
