import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';

export interface JobListing {
  citizen: { id: number; name: string; img?: string; countryId: number };
  companyName: string;
  salary: number;
  netSalary: number;
  salaryLimit: number;
  currency: string;
}

export interface JobMarketResponse {
  isEmployed: boolean;
  isOrganization: boolean;
  isFromThisCountry: boolean;
  citizenId: number;
  currencyName: string;
  employer?: {
    id: number;
    name: string;
    salary: number;
    netSalary: number;
    message?: string;
  };
  jobs: JobListing[];
  pages: number;
}

export type SortOrder = 'asc' | 'desc';

export async function getJobMarket(
  ctx: BrowserContext,
  csrf: string,
  countryId: number,
  page = 1,
  sortOrder: SortOrder = 'desc',
): Promise<JobMarketResponse> {
  const { body } = await apiCall<JobMarketResponse>(ctx, {
    method: 'GET',
    path: `/en/economy/job-market-json/${countryId}/${page}/${sortOrder}`,
    csrf,
  });
  return body;
}

/**
 * Pick the best job from a listing page. "Best" = highest net salary, with
 * ties broken by lowest employer citizenId for determinism. Returns null if
 * the list is empty or no entry has a positive salary.
 */
export function pickBestJob(jobs: readonly JobListing[]): JobListing | null {
  if (jobs.length === 0) return null;
  let best: JobListing | null = null;
  for (const j of jobs) {
    if (j.salary <= 0) continue;
    if (best == null) {
      best = j;
      continue;
    }
    if (j.netSalary > best.netSalary) best = j;
    else if (j.netSalary === best.netSalary && j.citizen.id < best.citizen.id) best = j;
  }
  return best;
}

export interface ApplyResult {
  success: boolean;
  status: number;
  message?: string;
  body: unknown;
}

interface ApplyResponseBody {
  message?: string;
  error?: boolean;
}

export async function applyForJob(
  ctx: BrowserContext,
  csrf: string,
  employerCitizenId: number,
  salary: number,
): Promise<ApplyResult> {
  const { status, body } = await apiCall<ApplyResponseBody>(ctx, {
    method: 'POST',
    path: '/en/economy/job-market-apply',
    csrf,
    form: { citizenId: employerCitizenId, salary },
  });
  const msg = body?.message ?? '';
  // Success message contains "now working for"; failure messages include
  // "You already have a job" or similar. body.error is not always set.
  const success = status === 200 && body?.error !== true && /now working for/i.test(msg);
  return { success, status, message: msg, body };
}

export async function resignFromJob(
  ctx: BrowserContext,
  csrf: string,
): Promise<{ success: boolean; status: number; body: unknown }> {
  const { status, body } = await apiCall<{ status?: boolean; message?: unknown; error?: boolean }>(ctx, {
    method: 'POST',
    path: '/en/economy/resign',
    csrf,
    form: { action_type: 'resign' },
  });
  return { success: status === 200 && body?.status === true, status, body };
}

export type EnsureEmployedAction = 'none' | 'applied' | 'no_jobs' | 'foreign_country';

export interface EnsureEmployedResult {
  employed: boolean;
  action: EnsureEmployedAction;
  employerName?: string;
  salary?: number;
  netSalary?: number;
  currency?: string;
  reason?: string;
}

/**
 * Verify the citizen is employed; if not, apply for the highest-salary job
 * available in the given country. Does NOT resign from an existing job — if
 * already employed, returns `{employed:true, action:'none'}` unconditionally.
 */
export async function ensureEmployed(
  ctx: BrowserContext,
  csrf: string,
  countryId: number,
): Promise<EnsureEmployedResult> {
  const market = await getJobMarket(ctx, csrf, countryId, 1, 'desc');
  if (market.isEmployed) {
    return { employed: true, action: 'none' };
  }
  if (!market.isFromThisCountry) {
    // Job market only employs citizens of the country. If we somehow ended up
    // querying a foreign market, surface that — the runner shouldn't normally
    // hit this since it uses ctxInfo.countryId (citizenship).
    return {
      employed: false,
      action: 'foreign_country',
      reason: `citizen is not from country ${countryId}`,
    };
  }
  const best = pickBestJob(market.jobs);
  if (best == null) {
    return {
      employed: false,
      action: 'no_jobs',
      reason: `no job offers available in country ${countryId}`,
    };
  }
  const result = await applyForJob(ctx, csrf, best.citizen.id, best.salary);
  if (!result.success) {
    return {
      employed: false,
      action: 'no_jobs',
      reason: `apply failed: ${result.message ?? `status=${result.status}`}`,
    };
  }
  return {
    employed: true,
    action: 'applied',
    employerName: best.citizen.name,
    salary: best.salary,
    netSalary: best.netSalary,
    currency: best.currency,
  };
}
