import { describe, it, expect } from 'vitest';
import { selectGroundsToTrain } from './train.policy.js';
import type { TrainingGround, TrainingGroundsResp } from './train.js';

function ground(overrides: Partial<TrainingGround>): TrainingGround {
  return { id: 1, trained: false, cost: 0, effectiveCost: 0, ...overrides };
}

function resp(grounds: TrainingGround[], hasTrainingContract = false): TrainingGroundsResp {
  return { grounds, hasTrainingContract };
}

describe('selectGroundsToTrain', () => {
  it('returns [] when all grounds are already trained, no contract', () => {
    const r = resp([
      ground({ id: 1, trained: true, effectiveCost: 0 }),
      ground({ id: 2, trained: true, effectiveCost: 0 }),
      ground({ id: 3, trained: true, effectiveCost: 0 }),
      ground({ id: 4, trained: true, effectiveCost: 0 }),
    ]);
    expect(selectGroundsToTrain(r)).toEqual([]);
  });

  it('returns [] when all grounds are already trained, with contract', () => {
    const r = resp(
      [
        ground({ id: 1, trained: true, effectiveCost: 0 }),
        ground({ id: 2, trained: true, effectiveCost: 0.19 }),
        ground({ id: 3, trained: true, effectiveCost: 0.89 }),
        ground({ id: 4, trained: true, effectiveCost: 1.79 }),
      ],
      true,
    );
    expect(selectGroundsToTrain(r)).toEqual([]);
  });

  it('returns all 4 when effectiveCost is 0 for every ground (level-200+ case)', () => {
    const r = resp([
      ground({ id: 1, cost: 0, effectiveCost: 0 }),
      ground({ id: 2, cost: 0.19, effectiveCost: 0 }),
      ground({ id: 3, cost: 0.89, effectiveCost: 0 }),
      ground({ id: 4, cost: 1.79, effectiveCost: 0 }),
    ]);
    const picked = selectGroundsToTrain(r);
    expect(picked.map((g) => g.id)).toEqual([1, 2, 3, 4]);
  });

  it('returns all 4 when level-200+ AND contract holder (both branches satisfied)', () => {
    const r = resp(
      [
        ground({ id: 1, cost: 0, effectiveCost: 0 }),
        ground({ id: 2, cost: 0.19, effectiveCost: 0 }),
        ground({ id: 3, cost: 0.89, effectiveCost: 0 }),
        ground({ id: 4, cost: 1.79, effectiveCost: 0 }),
      ],
      true,
    );
    expect(selectGroundsToTrain(r)).toHaveLength(4);
  });

  it('returns only Weights Room when low level, no contract', () => {
    const r = resp([
      ground({ id: 1, cost: 0, effectiveCost: 0 }),
      ground({ id: 2, cost: 0.19, effectiveCost: 0.19 }),
      ground({ id: 3, cost: 0.89, effectiveCost: 0.89 }),
      ground({ id: 4, cost: 1.79, effectiveCost: 1.79 }),
    ]);
    expect(selectGroundsToTrain(r).map((g) => g.id)).toEqual([1]);
  });

  it('returns all 4 when low level WITH contract (paying reduced rate)', () => {
    const r = resp(
      [
        ground({ id: 1, cost: 0, effectiveCost: 0 }),
        ground({ id: 2, cost: 0.19, effectiveCost: 0.1 }),
        ground({ id: 3, cost: 0.89, effectiveCost: 0.4 }),
        ground({ id: 4, cost: 1.79, effectiveCost: 0.8 }),
      ],
      true,
    );
    expect(selectGroundsToTrain(r).map((g) => g.id)).toEqual([1, 2, 3, 4]);
  });

  it('returns only the not-trained paid grounds when Weights already done (idempotent within day)', () => {
    const r = resp(
      [
        ground({ id: 1, trained: true, cost: 0, effectiveCost: 0 }),
        ground({ id: 2, trained: false, cost: 0.19, effectiveCost: 0.1 }),
        ground({ id: 3, trained: false, cost: 0.89, effectiveCost: 0.4 }),
        ground({ id: 4, trained: false, cost: 1.79, effectiveCost: 0.8 }),
      ],
      true,
    );
    expect(selectGroundsToTrain(r).map((g) => g.id)).toEqual([2, 3, 4]);
  });

  it('returns [] when grounds array is empty', () => {
    expect(selectGroundsToTrain(resp([], false))).toEqual([]);
    expect(selectGroundsToTrain(resp([], true))).toEqual([]);
  });

  it('returns [] when Weights already done and no contract (paid grounds stay locked)', () => {
    const r = resp([
      ground({ id: 1, trained: true, cost: 0, effectiveCost: 0 }),
      ground({ id: 2, trained: false, cost: 0.19, effectiveCost: 0.19 }),
      ground({ id: 3, trained: false, cost: 0.89, effectiveCost: 0.89 }),
      ground({ id: 4, trained: false, cost: 1.79, effectiveCost: 1.79 }),
    ]);
    expect(selectGroundsToTrain(r)).toEqual([]);
  });
});
