import type { TrainingGround, TrainingGroundsResp } from './train.js';

/**
 * Decide which training grounds to POST to `/economy/train` this cycle.
 *
 * Rules:
 *  - Skip grounds that have already been trained today (server tracks via
 *    `trained: true`).
 *  - Train any ground where the server-resolved price is zero. This covers
 *    high-level players (the game makes all 4 grounds free above some level
 *    threshold the wiki doesn't pin down), anniversary events, and full
 *    contract discounts.
 *  - Train paid grounds only if the player holds an active training contract
 *    (top-level `hasTrainingContract`). The contract is the implicit opt-in:
 *    by paying for a contract, the player chose to use it. Without one, we
 *    refuse to burn raw gold and fall back to the free Weights Room only.
 *
 * No options. The API response is the single source of truth.
 */
export function selectGroundsToTrain(resp: TrainingGroundsResp): TrainingGround[] {
  return resp.grounds.filter((g) => {
    if (g.trained) return false;
    if (g.effectiveCost === 0) return true;
    if (resp.hasTrainingContract) return true;
    return false;
  });
}
