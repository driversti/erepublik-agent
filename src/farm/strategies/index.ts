import { standardStrategy } from './standard.js';
import { d4twStrategy } from './d4tw.js';
import { maverickD3Strategy } from './maverickD3.js';
import { d4twAirStrategy } from './d4twAir.js';
import type { FarmStrategy, StrategyId } from './types.js';

const registry: Partial<Record<StrategyId, FarmStrategy>> = {
  standard: standardStrategy,
  d4tw: d4twStrategy,
  maverickD3: maverickD3Strategy,
  'd4tw-air': d4twAirStrategy,
};

export function getStrategy(id: StrategyId): FarmStrategy {
  const s = registry[id];
  if (!s) {
    throw new Error(
      `farm strategy "${id}" is not registered (registered: ${Object.keys(registry).join(', ')})`,
    );
  }
  return s;
}

export type {
  FarmSessionInfo,
  FarmSessionOptions,
  FarmSessionResult,
  FarmStrategy,
  SideOutcome,
  SkipSummary,
  StopReason,
  StrategyId,
  WinSummary,
} from './types.js';
export {
  EnergyExhaustedError,
  ForbiddenError,
  PartialBattleError,
} from './types.js';
export { standardStrategy } from './standard.js';
export { d4twStrategy } from './d4tw.js';
export { maverickD3Strategy } from './maverickD3.js';
export { d4twAirStrategy } from './d4twAir.js';
