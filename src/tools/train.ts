import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';
import { selectGroundsToTrain } from './train.policy.js';

export interface TrainingGround {
  id: number;
  trained: boolean;
  /** Static gold price for the building (informational only). */
  cost: number;
  /**
   * Server-resolved price after level bonuses, training contract, anniversary
   * events, etc. Source of truth for "is this free for me right now?".
   */
  effectiveCost: number;
}

export interface TrainingGroundsResp {
  grounds: TrainingGround[];
  /** Top-level flag — `true` while the player holds an active training contract. */
  hasTrainingContract: boolean;
}

export interface TrainResult {
  success: boolean;
  alreadyTrained: boolean;
  count: number;
  status?: number;
  body?: unknown;
}

export async function train(ctx: BrowserContext, csrf: string): Promise<TrainResult> {
  const { body: resp } = await apiCall<TrainingGroundsResp>(ctx, {
    method: 'GET',
    path: '/en/main/training-grounds-json',
    csrf,
  });

  const trainable = selectGroundsToTrain(resp);

  if (trainable.length === 0) {
    return { success: true, alreadyTrained: true, count: 0 };
  }

  const form: Record<string, string> = {};
  trainable.forEach((g, i) => {
    form[`grounds[${i}][id]`] = String(g.id);
    form[`grounds[${i}][train]`] = '1';
  });

  const { status, body } = await apiCall(ctx, {
    method: 'POST',
    path: '/en/economy/train',
    csrf,
    form,
  });

  return { success: status === 200, alreadyTrained: false, count: trainable.length, status, body };
}
