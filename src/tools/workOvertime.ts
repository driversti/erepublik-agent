import type { BrowserContext } from 'playwright-core';
import { apiCall } from '../transport/apiCall.js';
import type { OvertimeData } from './workOvertime.policy.js';

/** Slim shape of `/en/main/job-data` — only the fields the agent reads. */
export interface JobDataResponse {
  isEmployee: boolean;
  alreadyWorked?: boolean;
  /** Absent when isEmployee is false. */
  overTime?: OvertimeData & { salary?: number };
}

export interface WorkOvertimeResultBody {
  netSalary?: number;
  grossSalary?: number;
  tax?: number;
  currency?: string;
  days_in_a_row?: number;
  xp?: number;
  health?: number;
}

/**
 * Response shape we care about. `status: true` + `result` on success;
 * `status: false` + `message: string` on failure.
 */
export interface WorkOvertimeResponse {
  status: boolean;
  message?: boolean | string;
  result?: WorkOvertimeResultBody;
}

export async function getJobData(ctx: BrowserContext, csrf: string): Promise<JobDataResponse> {
  const { body } = await apiCall<JobDataResponse>(ctx, {
    method: 'GET',
    path: '/en/main/job-data',
    csrf,
  });
  return body;
}

export interface OvertimePostResult {
  /** True iff response.status === true (server-confirmed success). */
  success: boolean;
  /** HTTP status code from the POST. */
  httpStatus: number;
  /** Server message — string on failure, boolean `true` on success. */
  message: string | null;
  result: WorkOvertimeResultBody | null;
}

/**
 * POST /en/economy/workOvertime. Caller is responsible for gating on cooldown —
 * the spec marks this as critical (100-energy anti-spam penalty if posted
 * inside the 1-hour cooldown). This function does NOT add a fallback check
 * because the gate already lives in `decideOvertime`, and double-checking
 * inside the transport would dilute the single source of truth.
 *
 * Never sends `useEnergyBar=yes` — we don't burn bars on OT.
 */
export async function workOvertime(ctx: BrowserContext, csrf: string): Promise<OvertimePostResult> {
  const { status, body } = await apiCall<WorkOvertimeResponse>(ctx, {
    method: 'POST',
    path: '/en/economy/workOvertime',
    csrf,
    form: { action_type: 'workOvertime' },
  });
  const success = body.status === true;
  const message =
    typeof body.message === 'string' ? body.message : success ? null : 'unknown';
  return {
    success,
    httpStatus: status,
    message,
    result: body.result ?? null,
  };
}
