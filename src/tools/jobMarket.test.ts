import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../transport/apiCall.js', () => ({
  apiCall: vi.fn(),
}));

import {
  pickBestJob,
  ensureEmployed,
  applyForJob,
  getJobMarket,
  evaluateJobUpgrade,
  type JobListing,
  type JobMarketResponse,
} from './jobMarket.js';
import { apiCall } from '../transport/apiCall.js';

const apiCallMock = vi.mocked(apiCall);
const ctx = {} as never;
const csrf = 'test-csrf';

function job(over: Partial<JobListing> = {}): JobListing {
  return {
    citizen: { id: 1, name: 'Boss', countryId: 72 },
    companyName: 'Acme',
    salary: 1000,
    netSalary: 990,
    salaryLimit: 0,
    currency: 'LTL',
    ...over,
  };
}

describe('pickBestJob', () => {
  it('returns null on empty list', () => {
    expect(pickBestJob([])).toBeNull();
  });

  it('picks the highest netSalary', () => {
    const winner = job({ citizen: { id: 2, name: 'B', countryId: 72 }, salary: 7111, netSalary: 7039.89 });
    const result = pickBestJob([
      job({ citizen: { id: 1, name: 'A', countryId: 72 }, salary: 7040, netSalary: 6969.6 }),
      winner,
      job({ citizen: { id: 3, name: 'C', countryId: 72 }, salary: 5000, netSalary: 4950 }),
    ]);
    expect(result).toBe(winner);
  });

  it('breaks ties by lower citizenId (deterministic)', () => {
    const lowId = job({ citizen: { id: 5, name: 'L', countryId: 72 }, salary: 1000, netSalary: 990 });
    const highId = job({ citizen: { id: 99, name: 'H', countryId: 72 }, salary: 1000, netSalary: 990 });
    expect(pickBestJob([highId, lowId])).toBe(lowId);
    expect(pickBestJob([lowId, highId])).toBe(lowId);
  });

  it('skips entries with non-positive salary', () => {
    expect(pickBestJob([job({ salary: 0, netSalary: 0 })])).toBeNull();
  });
});

describe('getJobMarket', () => {
  beforeEach(() => apiCallMock.mockReset());

  it('hits the correct path with countryId, page, sortOrder', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      body: {
        isEmployed: false,
        isOrganization: false,
        isFromThisCountry: true,
        citizenId: 42,
        currencyName: 'LTL',
        jobs: [],
        pages: 0,
      },
    } as never);
    await getJobMarket(ctx, csrf, 72, 1, 'desc');
    expect(apiCallMock).toHaveBeenCalledWith(ctx, expect.objectContaining({
      method: 'GET',
      path: '/en/economy/job-market-json/72/1/desc',
      csrf,
    }));
  });
});

describe('applyForJob', () => {
  beforeEach(() => apiCallMock.mockReset());

  it('returns success when message contains "now working for"', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      body: {
        message:
          "Congratulation, you are now working for <a href='/en/citizen/profile/9699126'>Jozsika90</a>.",
      },
    } as never);
    const r = await applyForJob(ctx, csrf, 9699126, 7902.03);
    expect(r.success).toBe(true);
    expect(apiCallMock).toHaveBeenCalledWith(ctx, expect.objectContaining({
      method: 'POST',
      path: '/en/economy/job-market-apply',
      form: { citizenId: 9699126, salary: 7902.03 },
    }));
  });

  it('returns failure when already employed', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      body: { message: 'You already have a job. You must resign first.' },
    } as never);
    const r = await applyForJob(ctx, csrf, 9699126, 7902.03);
    expect(r.success).toBe(false);
  });
});

describe('ensureEmployed', () => {
  beforeEach(() => apiCallMock.mockReset());

  it('returns {employed:true, action:none} when already employed', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      body: {
        isEmployed: true,
        isOrganization: false,
        isFromThisCountry: true,
        citizenId: 42,
        currencyName: 'LTL',
        employer: { id: 7, name: 'Boss', salary: 1000, netSalary: 990 },
        jobs: [],
        pages: 0,
      },
    } as never);
    const r = await ensureEmployed(ctx, csrf, 72);
    expect(r).toEqual({ employed: true, action: 'none' });
    expect(apiCallMock).toHaveBeenCalledTimes(1);
  });

  it('applies for the highest-salary job when unemployed', async () => {
    apiCallMock
      .mockResolvedValueOnce({
        status: 200,
        body: {
          isEmployed: false,
          isOrganization: false,
          isFromThisCountry: true,
          citizenId: 42,
          currencyName: 'LTL',
          jobs: [
            {
              citizen: { id: 1, name: 'LowPay', countryId: 72 },
              companyName: 'A',
              salary: 1000,
              netSalary: 990,
              salaryLimit: 0,
              currency: 'LTL',
            },
            {
              citizen: { id: 2, name: 'HighPay', countryId: 72 },
              companyName: 'B',
              salary: 5000,
              netSalary: 4950,
              salaryLimit: 0,
              currency: 'LTL',
            },
          ],
          pages: 1,
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        body: { message: 'Congratulation, you are now working for HighPay.' },
      } as never);

    const r = await ensureEmployed(ctx, csrf, 72);
    expect(r.employed).toBe(true);
    expect(r.action).toBe('applied');
    expect(r.employerName).toBe('HighPay');
    expect(r.salary).toBe(5000);
    expect(apiCallMock).toHaveBeenNthCalledWith(2, ctx, expect.objectContaining({
      path: '/en/economy/job-market-apply',
      form: { citizenId: 2, salary: 5000 },
    }));
  });

  it('returns no_jobs when listing is empty', async () => {
    apiCallMock.mockResolvedValueOnce({
      status: 200,
      body: {
        isEmployed: false,
        isOrganization: false,
        isFromThisCountry: true,
        citizenId: 42,
        currencyName: 'LTL',
        jobs: [],
        pages: 0,
      },
    } as never);
    const r = await ensureEmployed(ctx, csrf, 72);
    expect(r.employed).toBe(false);
    expect(r.action).toBe('no_jobs');
    expect(apiCallMock).toHaveBeenCalledTimes(1);
  });

  it('applies as a foreigner when located abroad (isFromThisCountry=false but jobs exist)', async () => {
    // eRepublik lets you hire on the job market of the country you are
    // physically in, even if you're not a citizen. The previous early-bail
    // on `isFromThisCountry: false` was wrong — see kb/Employment_Country.md.
    apiCallMock
      .mockResolvedValueOnce({
        status: 200,
        body: {
          isEmployed: false,
          isOrganization: false,
          isFromThisCountry: false,
          citizenId: 42,
          currencyName: 'USD',
          jobs: [
            {
              citizen: { id: 1, name: 'ForeignBoss', countryId: 99 },
              companyName: 'A',
              salary: 5000,
              netSalary: 4950,
              salaryLimit: 0,
              currency: 'USD',
            },
          ],
          pages: 1,
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        body: { message: 'Congratulation, you are now working for ForeignBoss.' },
      } as never);
    const r = await ensureEmployed(ctx, csrf, 99);
    expect(r.employed).toBe(true);
    expect(r.action).toBe('applied');
    expect(r.employerName).toBe('ForeignBoss');
  });

  it('returns no_jobs when apply call fails', async () => {
    apiCallMock
      .mockResolvedValueOnce({
        status: 200,
        body: {
          isEmployed: false,
          isOrganization: false,
          isFromThisCountry: true,
          citizenId: 42,
          currencyName: 'LTL',
          jobs: [
            {
              citizen: { id: 1, name: 'A', countryId: 72 },
              companyName: 'A',
              salary: 5000,
              netSalary: 4950,
              salaryLimit: 0,
              currency: 'LTL',
            },
          ],
          pages: 1,
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        body: { message: 'You already have a job. You must resign first.' },
      } as never);
    const r = await ensureEmployed(ctx, csrf, 72);
    expect(r.employed).toBe(false);
    expect(r.action).toBe('no_jobs');
    expect(r.reason).toContain('apply failed');
  });
});

describe('evaluateJobUpgrade', () => {
  function market(
    over: Partial<JobMarketResponse> = {},
    jobs: JobListing[] = [],
  ): JobMarketResponse {
    return {
      isEmployed: true,
      isOrganization: false,
      isFromThisCountry: true,
      citizenId: 42,
      currencyName: 'USD',
      employer: { id: 7, name: 'OldBoss', salary: 1000, netSalary: 990 },
      jobs,
      pages: jobs.length > 0 ? 1 : 0,
      ...over,
    };
  }
  function offer(over: Partial<JobListing> = {}): JobListing {
    return {
      citizen: { id: 8, name: 'NewBoss', countryId: 35 },
      companyName: 'C',
      salary: 2000,
      netSalary: 1980,
      salaryLimit: 0,
      currency: 'USD',
      ...over,
    };
  }
  const opts = { minNetSalaryDelta: 50, minRelativeImprovement: 0.05 };

  it('skips when not employed', () => {
    const r = evaluateJobUpgrade(market({ employer: undefined }, [offer()]), opts);
    expect(r.shouldUpgrade).toBe(false);
    expect(r.reason).toMatch(/not currently employed/);
  });

  it('skips when listing is empty', () => {
    const r = evaluateJobUpgrade(market({}, []), opts);
    expect(r.shouldUpgrade).toBe(false);
    expect(r.reason).toMatch(/no offers/);
  });

  it('skips when best offer is current employer', () => {
    const r = evaluateJobUpgrade(
      market({}, [offer({ citizen: { id: 7, name: 'OldBoss', countryId: 35 }, netSalary: 5000 })]),
      opts,
    );
    expect(r.shouldUpgrade).toBe(false);
    expect(r.reason).toMatch(/current employer/);
  });

  it('skips when absolute delta below threshold', () => {
    const r = evaluateJobUpgrade(market({}, [offer({ netSalary: 1020 })]), opts);
    expect(r.shouldUpgrade).toBe(false);
    expect(r.reason).toMatch(/absolute delta/);
  });

  it('skips when relative delta below threshold', () => {
    // current 990, offer 1050 → +60 absolute (>=50) but +6% which IS above 5%.
    // Bump threshold to 10% to force a relative-only skip.
    const r = evaluateJobUpgrade(
      market({}, [offer({ netSalary: 1050 })]),
      { ...opts, minRelativeImprovement: 0.1 },
    );
    expect(r.shouldUpgrade).toBe(false);
    expect(r.reason).toMatch(/relative delta/);
  });

  it('upgrades when both thresholds satisfied', () => {
    const r = evaluateJobUpgrade(market({}, [offer({ netSalary: 1980 })]), opts);
    expect(r.shouldUpgrade).toBe(true);
    expect(r.best?.netSalary).toBe(1980);
    expect(r.currentNetSalary).toBe(990);
  });
});
