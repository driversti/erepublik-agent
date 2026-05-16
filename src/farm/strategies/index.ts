import { standardStrategy } from './standard.js';
import type { FarmStrategy, StrategyId } from './types.js';

const registry: Partial<Record<StrategyId, FarmStrategy>> = {
  standard: standardStrategy,
  // 'd4tw' and 'maverickD3' will be added in their respective phases.
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
