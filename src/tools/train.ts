import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';

interface TrainingGround {
  id: number;
  trained?: boolean;
  cost?: number;
  hasContract?: boolean;
}

interface TrainingGroundsResp {
  grounds?: TrainingGround[];
}

export interface TrainResult {
  success: boolean;
  alreadyTrained: boolean;
  count: number;
  status?: number;
  body?: unknown;
}

export async function train(ctx: BrowserContext, csrf: string): Promise<TrainResult> {
  const { body: groundsData } = await apiCall<TrainingGroundsResp>(ctx, {
    method: 'GET',
    path: '/en/main/training-grounds-json',
    csrf,
  });

  const trainable = (groundsData.grounds ?? []).filter(
    (g) => !g.trained && (g.cost === 0 || g.hasContract === true),
  );

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
