import { standardStrategy } from './standard.js';
import { d4twStrategy } from './d4tw.js';
import type { FarmStrategy, StrategyId } from './types.js';

const registry: Partial<Record<StrategyId, FarmStrategy>> = {
  standard: standardStrategy,
  d4tw: d4twStrategy,
  // 'maverickD3' will be added in a later phase.
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
