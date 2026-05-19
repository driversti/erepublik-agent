import { z } from 'zod';

/**
 * Runtime schemas for the eRepublik fight-deploy endpoints. We hold a defensive
 * line here because the bot trusts these payloads to drive real spend
 * (fuel barrels, pool energy). A breaking change on eRepublik's side used to
 * surface as a bare `TypeError: Cannot read properties of undefined` deep in
 * the strategy loop — now we throw a clear `eRepublik API format changed`
 * diagnostic that the operator can act on.
 *
 * Design notes:
 *  - All shape fields stay **optional** because the original raw types treated
 *    them so (the production code already handles missing data gracefully).
 *  - `.passthrough()` keeps the door open for new fields eRepublik adds without
 *    warning — only mismatched types break parsing.
 *  - The "format changed" error message includes the Zod issue path so a quick
 *    grep in logs tells the operator which field drifted.
 */

const RawWeaponSchema = z
  .object({
    quality: z.number().optional(),
    amount: z.number().nullable().optional(),
    damageperHit: z.number().optional(),
  })
  .passthrough();

const RawVehicleSchema = z
  .object({
    id: z.number(),
    isActive: z.boolean(),
  })
  .passthrough();

export const RawDeployInventorySchema = z
  .object({
    weapons: z.array(RawWeaponSchema).optional(),
    vehicles: z.array(RawVehicleSchema).optional(),
    poolEnergy: z.number().optional(),
    minEnergy: z.number().optional(),
  })
  .passthrough();

export type RawDeployInventory = z.infer<typeof RawDeployInventorySchema>;

export const RawDeployResponseSchema = z
  .object({
    error: z.boolean(),
    message: z.string().optional(),
    deploymentId: z.number().optional(),
    data: z
      .object({
        fuelLeft: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type RawDeployResponse = z.infer<typeof RawDeployResponseSchema>;

function summarizeIssue(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return err.message;
  const path = issue.path.length ? issue.path.join('.') : '<root>';
  return `${path}: ${issue.message}`;
}

export function parseDeployInventory(body: unknown): RawDeployInventory {
  const parsed = RawDeployInventorySchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `eRepublik API format changed: fightDeploy-getInventory — ${summarizeIssue(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function parseDeployResponse(body: unknown): RawDeployResponse {
  const parsed = RawDeployResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `eRepublik API format changed: fightDeploy-startDeploy — ${summarizeIssue(parsed.error)}`,
    );
  }
  return parsed.data;
}
