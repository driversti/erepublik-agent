/**
 * Shared transport-layer errors. Lives in `src/transport/` (not in
 * `src/farm/strategies/types.ts` where they originally lived) so `apiCall.ts`
 * can import them without creating a cycle through the strategy layer.
 *
 * Strategies and the runner re-export these from `farm/strategies/types.ts`
 * for source-compatibility with existing imports.
 */

export class ForbiddenError extends Error {
  constructor(public readonly endpoint: string) {
    super(`eRepublik returned "Forbidden" on ${endpoint} — IP/account flagged`);
    this.name = 'ForbiddenError';
  }
}

export class EnergyExhaustedError extends Error {
  constructor(public readonly poolEnergy: number | null, public readonly lastMessage?: string) {
    super(
      `Pool energy exhausted (poolEnergy=${poolEnergy ?? '?'}, last message="${lastMessage ?? ''}") — runner stopping`,
    );
    this.name = 'EnergyExhaustedError';
  }
}

/** Shared side-outcome shape — re-declared here to keep this module free of
 *  any farm-strategy imports (would create a cycle through types.ts). */
export interface PartialBattleSide {
  side: 'invader' | 'defender';
  countryId: number;
  attempts: number;
  verified: boolean;
  fuelLeft: number | null;
  deploymentId: number | null;
}

/**
 * Thrown when side A hit was already committed (deploy returned, fuel barrel
 * spent) but side B failed — travel exhausted retries, deploy threw, or pool
 * went empty. The medal on side B is forfeit; the caller should alert the
 * operator so they can finish the battle manually.
 */
export class PartialBattleError extends Error {
  constructor(
    public readonly battleId: number,
    public readonly regionName: string,
    public readonly sideA: PartialBattleSide,
    public readonly stage: 'travel-b' | 'deploy-b',
    public readonly cause: Error,
  ) {
    super(
      `Partial battle ${battleId} (${regionName}): side A (${sideA.side}) landed ` +
        `(verified=${sideA.verified}), side B failed at ${stage}: ${cause.message}`,
    );
    this.name = 'PartialBattleError';
  }
}
