import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../transport/apiCall.js', () => ({
  apiCall: vi.fn(),
}));

import { travelToCountry, travelHome } from './travel.js';
import { apiCall } from '../transport/apiCall.js';

const apiCallMock = vi.mocked(apiCall);

const ctx = {} as never;
const csrf = 'test-csrf';

describe('travelToCountry', () => {
  beforeEach(() => apiCallMock.mockReset());

  it('returns success when cheapest region is within budget and travel succeeds', async () => {
    apiCallMock
      .mockResolvedValueOnce({
        body: {
          countries: { '71': { regions: [501, 502] } },
          regions: {
            '501': { id: 501, cost: 50 },
            '502': { id: 502, cost: 20 },
          },
        },
      } as never)
      .mockResolvedValueOnce({ body: { error: 0, message: 'success' } } as never);

    const r = await travelToCountry(ctx, csrf, 71, 999, 100);

    expect(r.attempted).toBe(true);
    expect(r.success).toBe(true);
    expect(r.costCC).toBe(20);
    expect(r.regionId).toBe(502);
  });

  it('rejects when cheapest cost exceeds maxCC', async () => {
    apiCallMock.mockResolvedValueOnce({
      body: {
        countries: { '71': { regions: [501] } },
        regions: { '501': { id: 501, cost: 600 } },
      },
    } as never);

    const r = await travelToCountry(ctx, csrf, 71, 999, 500);

    expect(r.attempted).toBe(false);
    expect(r.success).toBe(false);
    expect(r.costCC).toBe(600);
    expect(r.message).toMatch(/600.+500/);
    // Travel POST should not have been called
    expect(apiCallMock).toHaveBeenCalledTimes(1);
  });

  it('reports no reachable region when target country has none', async () => {
    apiCallMock.mockResolvedValueOnce({
      body: {
        countries: {},
        regions: {},
      },
    } as never);

    const r = await travelToCountry(ctx, csrf, 71, 999, 500);

    expect(r.attempted).toBe(false);
    expect(r.success).toBe(false);
    expect(r.regionId).toBeNull();
    expect(r.message).toMatch(/no reachable region/);
  });

  it('reports failure when travel POST returns error != 0', async () => {
    apiCallMock
      .mockResolvedValueOnce({
        body: {
          countries: { '71': { regions: [501] } },
          regions: { '501': { id: 501, cost: 30 } },
        },
      } as never)
      .mockResolvedValueOnce({ body: { error: 1, message: 'not enough currency' } } as never);

    const r = await travelToCountry(ctx, csrf, 71, 999, 500);

    expect(r.attempted).toBe(true);
    expect(r.success).toBe(false);
    expect(r.message).toBe('not enough currency');
  });
});

describe('travelHome', () => {
  beforeEach(() => apiCallMock.mockReset());

  it('proceeds with travel when cost is within budget', async () => {
    apiCallMock
      .mockResolvedValueOnce({
        body: {
          regions: { '601': { id: 601, cost: 50 } },
        },
      } as never)
      .mockResolvedValueOnce({ body: { error: 0, message: 'ok' } } as never);

    const r = await travelHome({} as never, csrf, 601, 71, { maxCostCC: 100 });

    expect(r.attempted).toBe(true);
    expect(r.success).toBe(true);
    expect(r.costCC).toBe(50);
  });

  it('refuses travel when reported cost exceeds budget', async () => {
    apiCallMock.mockResolvedValueOnce({
      body: {
        regions: { '601': { id: 601, cost: 600 } },
      },
    } as never);

    const r = await travelHome({} as never, csrf, 601, 71, { maxCostCC: 500 });

    expect(r.attempted).toBe(false);
    expect(r.success).toBe(false);
    expect(r.costCC).toBe(600);
    expect(r.message).toMatch(/600cc exceeds budget 500cc/);
    expect(apiCallMock).toHaveBeenCalledTimes(1);
  });

  it('refuses travel when budget is set but region cost is unknown (cannot verify budget)', async () => {
    // travelData returns no `regions[residenceRegionId]` entry — we cannot
    // know what the trip will cost. Proceeding blindly would silently bypass
    // the operator's budget. Block the trip and surface a clear reason.
    apiCallMock.mockResolvedValueOnce({
      body: {
        regions: { '999': { id: 999, cost: 30 } },
        // No entry for region 601
      },
    } as never);

    const r = await travelHome({} as never, csrf, 601, 71, { maxCostCC: 500 });

    expect(r.attempted).toBe(false);
    expect(r.success).toBe(false);
    expect(r.costCC).toBeNull();
    expect(r.message).toMatch(/could not determine.*cost/i);
    expect(apiCallMock).toHaveBeenCalledTimes(1);
  });

  it('skips travel when already in residence region', async () => {
    apiCallMock.mockResolvedValueOnce({
      body: {
        alreadyInRegion: true,
        regions: {},
      },
    } as never);

    const r = await travelHome({} as never, csrf, 601, 71, { maxCostCC: 500 });

    expect(r.attempted).toBe(false);
    expect(r.success).toBe(true);
    expect(r.costCC).toBe(0);
  });

  it('attempts travel without pre-check when maxCostCC is unset', async () => {
    apiCallMock.mockResolvedValueOnce({
      body: { error: 0, message: 'ok' },
    } as never);

    const r = await travelHome({} as never, csrf, 601, 71);

    expect(r.attempted).toBe(true);
    expect(r.success).toBe(true);
    expect(r.costCC).toBeNull(); // no pre-check happened
    expect(apiCallMock).toHaveBeenCalledTimes(1); // only /main/travel, no /main/travelData
  });
});
