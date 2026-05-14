import type { MissionStateSlim } from '../tools/missions.js';
import type { DailyState } from '../memory/schema.js';

const SAFE_DAILY_MAP: Record<number, keyof DailyState['completedActions']> = {
  100001: 'work',
  100003: 'train',
  100011: 'buyFood',
};

// VIP claim is not exposed via daily-missions-data; reconcile is a no-op for it.
// (kept in sync via the tool's own idempotent calls)

/**
 * Reconcile API mission state into local memory. If a safe-daily mission
 * is reported as completed by the API but the local flag is unset, mark it
 * with source='external' — meaning the player (or another bot) did it.
 *
 * Returns true if memory was mutated.
 */
export function reconcile(state: DailyState, missions: MissionStateSlim): boolean {
  let changed = false;
  const now = new Date().toISOString();

  for (const m of missions.missions) {
    const key = SAFE_DAILY_MAP[m.id];
    if (!key) continue;
    if (state.completedActions[key]) continue; // already known
    if (!m.completed && !m.claimable) continue;

    if (key === 'buyFood') {
      state.completedActions.buyFood = { at: now, source: 'external' };
    } else {
      state.completedActions[key] = { at: now, source: 'external' };
    }
    changed = true;
  }

  // Note: vipClaim is not in daily-missions; reconciliation for it will be
  // added when we have a dedicated probe (Phase 1 next step).

  return changed;
}
