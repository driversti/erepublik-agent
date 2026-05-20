import type { BrowserContext } from 'playwright-core';
import { runDoubleSidedCombat } from './doubleSidedEngine.js';
import type {
  FarmStrategy,
  FarmSessionInfo,
  FarmSessionOptions,
  FarmSessionResult,
} from './types.js';

/**
 * Standard ("empty-div") strategy: discover battles where the citizen's own
 * division is empty (`wall.dom === 50` + zero damage), then deploy bare-hands
 * on both sides for two cheap medals per fuel barrel. Native citizens fight
 * directly; mercenaries / freedom fighters travel into and out of the side
 * countries as needed.
 *
 * This file is a thin wrapper around the shared `runDoubleSidedCombat`
 * engine — see `doubleSidedEngine.ts` for the actual pipeline. The engine
 * was extracted to remove the ~90% overlap with `maverickD3.ts`.
 */
async function runStandard(
  ctx: BrowserContext,
  info: FarmSessionInfo,
  options: FarmSessionOptions,
): Promise<FarmSessionResult> {
  return runDoubleSidedCombat(ctx, info, options, {
    strategyId: 'standard',
    division: info.division,
    bomb: null, // standard never deploys bombs
  });
}

export const standardStrategy: FarmStrategy = {
  id: 'standard',
  run: runStandard,
};
