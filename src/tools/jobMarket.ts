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

export interface JobUpgradeOpts {
  /** Minimum absolute netSalary improvement (in the country's currency) over
   *  the current employer required to switch. Filters out one-cent bumps. */
  minNetSalaryDelta: number;
  /** Minimum relative improvement (e.g. 0.05 = +5%). Combined with the absolute
   *  delta so both must be satisfied — the absolute floor protects against
   *  trivial upgrades on low-wage markets where 5% is mere noise. */
  minRelativeImprovement: number;
}

export interface JobUpgradeDecision {
  shouldUpgrade: boolean;
  best: JobListing | null;
  currentNetSalary: number | null;
  reason: string;
}

/**
 * Pure decision function: given a freshly-fetched job market response (the
 * citizen must be employed for this to make sense) and the upgrade thresholds,
 * decide whether resigning + applying for the best listing is justified.
 *
 * Skips the upgrade when:
 *   - We're not currently employed (caller's mistake to invoke this here).
 *   - The listing is empty.
 *   - The best offer is our current employer (a current employer's listing
 *     may show up on the market when they have an open seat).
 *   - The absolute delta is below `minNetSalaryDelta`.
 *   - The relative improvement is below `minRelativeImprovement`.
 */
export function evaluateJobUpgrade(
  market: JobMarketResponse,
  opts: JobUpgradeOpts,
): JobUpgradeDecision {
  const current = market.employer?.netSalary ?? null;
  const best = pickBestJob(market.jobs);
  if (current == null) {
    return { shouldUpgrade: false, best, currentNetSalary: null, reason: 'not currently employed' };
  }
  if (best == null) {
    return { shouldUpgrade: false, best: null, currentNetSalary: current, reason: 'no offers on market' };
  }
  if (best.citizen.id === market.employer?.id) {
    return { shouldUpgrade: false, best, currentNetSalary: current, reason: 'best offer is current employer' };
  }
  const absDelta = best.netSalary - current;
  if (absDelta < opts.minNetSalaryDelta) {
    return {
      shouldUpgrade: false,
      best,
      currentNetSalary: current,
      reason: `absolute delta ${absDelta.toFixed(2)} < ${opts.minNetSalaryDelta}`,
    };
  }
  // Guard against zero/negative current; absDelta check above already passed
  // so current is at least non-zero positive here in practice, but defensive.
  const relDelta = current > 0 ? absDelta / current : Infinity;
  if (relDelta < opts.minRelativeImprovement) {
    return {
      shouldUpgrade: false,
      best,
      currentNetSalary: current,
      reason: `relative delta ${(relDelta * 100).toFixed(1)}% < ${(opts.minRelativeImprovement * 100).toFixed(1)}%`,
    };
  }
  return {
    shouldUpgrade: true,
    best,
    currentNetSalary: current,
    reason: `upgrade ${current} → ${best.netSalary} (+${(relDelta * 100).toFixed(1)}%)`,
  };
}

export type EnsureEmployedAction = 'none' | 'applied' | 'no_jobs';

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
 * available in the given country's market. Does NOT resign from an existing
 * job — if already employed, returns `{employed:true, action:'none'}`.
 *
 * **Country selection is the caller's job.** eRepublik only lets you hire on
 * the market of the country you are *physically in* (your current location,
 * not your citizenship). Pass `marketCountryId = ctxInfo.currentCountryId`.
 * See `kb/Employment_Country.md` for the mechanic.
 *
 * Note: the previous version bailed early when `market.isFromThisCountry` was
 * false (interpreted as "you must be a citizen of this country to work here").
 * That guard was based on a wrong assumption — you can work as a foreigner in
 * your current country — and is intentionally removed.
 */
export async function ensureEmployed(
  ctx: BrowserContext,
  csrf: string,
  marketCountryId: number,
): Promise<EnsureEmployedResult> {
  const market = await getJobMarket(ctx, csrf, marketCountryId, 1, 'desc');
  if (market.isEmployed) {
    return { employed: true, action: 'none' };
  }
  const best = pickBestJob(market.jobs);
  if (best == null) {
    return {
      employed: false,
      action: 'no_jobs',
      reason: `no job offers available in country ${marketCountryId}`,
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
