import { createHash } from 'node:crypto';
import type { DailyState } from '../memory/schema.js';
import type { WeeklyState } from '../memory/weeklyState.js';
import type { WeeklyFuelState } from '../memory/weeklyFuelState.js';

/**
 * SHA-256 of an opinionated subset of cycle state used to decide whether a
 * Telegram digest is worth sending. We exclude diagnostic fields that flap
 * on every cycle (`lastDigestHash` is self-referential; `nextEligibleAt` and
 * `cyclesSkipped` change on every idle tick) — those would spam the chat
 * with no useful change.
 */
export function snapshotHash(
  state: DailyState,
  weekly: WeeklyState,
  fuel: WeeklyFuelState,
): string {
  const { lastDigestHash: _ignored, ...stateForHash } = state;
  const { nextEligibleAt: _ignored2, cyclesSkipped: _ignored3, ...fuelForHash } = fuel;
  const data = JSON.stringify({ state: stateForHash, weekly, fuel: fuelForHash });
  return createHash('sha256').update(data).digest('hex').slice(0, 12);
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
