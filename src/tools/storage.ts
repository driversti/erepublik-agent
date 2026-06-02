import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';

/** `mainStorage.status` from `/economy/inventory-json` — main-storage capacity. */
export interface StorageStatus {
  usedStorage: number;
  totalStorage: number;
  availableStorage: number;
  /** e.g. "100%". Present in the live response; optional defensively. */
  storagePercentage?: string;
}

interface InventorySection {
  id?: string;
  status?: StorageStatus;
}

/**
 * GET /economy/inventory-json → `mainStorage.status`. Returns null when the
 * section or status block is missing (defensive — don't block the buy on a
 * shape we can't read). Mirrors ePlus' `extractStorageStatus`.
 */
export async function getStorageStatus(
  ctx: BrowserContext,
  csrf: string,
): Promise<StorageStatus | null> {
  const { body } = await apiCall<InventorySection[]>(ctx, {
    method: 'GET',
    path: '/en/economy/inventory-json',
    csrf,
  });
  const main = Array.isArray(body) ? body.find((c) => c.id === 'mainStorage') : undefined;
  return main?.status ?? null;
}
