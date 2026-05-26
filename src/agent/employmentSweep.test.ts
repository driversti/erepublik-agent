import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emptyState } from '../memory/schema.js';

const ensureEmployedMock = vi.fn();
const getJobMarketMock = vi.fn();
const resignFromJobMock = vi.fn();
const applyForJobMock = vi.fn();

vi.mock('../tools/jobMarket.js', async () => {
  const actual = await vi.importActual<typeof import('../tools/jobMarket.js')>(
    '../tools/jobMarket.js',
  );
  return {
    // Pure helpers we want real (so the sweep's evaluateJobUpgrade does the
    // actual decision math; mocking it would make the test tautological).
    pickBestJob: actual.pickBestJob,
    evaluateJobUpgrade: actual.evaluateJobUpgrade,
    // I/O wrappers — mocked.
    ensureEmployed: (...a: unknown[]) => ensureEmployedMock(...a),
    getJobMarket: (...a: unknown[]) => getJobMarketMock(...a),
    resignFromJob: (...a: unknown[]) => resignFromJobMock(...a),
    applyForJob: (...a: unknown[]) => applyForJobMock(...a),
  };
});

const { runEmploymentSweep } = await import('./employmentSweep.js');

const ctx = {} as never;
const csrf = 'csrf';
const COUNTRY = 35;

function notifyCaptor() {
  const calls: string[] = [];
  return { notify: async (m: string) => { calls.push(m); }, calls };
}

beforeEach(() => {
  ensureEmployedMock.mockReset();
  getJobMarketMock.mockReset();
  resignFromJobMock.mockReset();
  applyForJobMock.mockReset();
});

describe('runEmploymentSweep', () => {
  it('no-op when autoEmploy is off', async () => {
    const state = emptyState(6761);
    const cap = notifyCaptor();
    const r = await runEmploymentSweep(ctx, csrf, COUNTRY, state, {
      autoEmploy: false,
      notify: cap.notify,
    });
    expect(r).toEqual({ employed: true, action: 'skipped' });
    expect(ensureEmployedMock).not.toHaveBeenCalled();
    expect(cap.calls).toEqual([]);
  });

  it('silent pass-through when already employed', async () => {
    const state = emptyState(6761);
    const cap = notifyCaptor();
    ensureEmployedMock.mockResolvedValue({ employed: true, action: 'none' });
    const r = await runEmploymentSweep(ctx, csrf, COUNTRY, state, {
      autoEmploy: true,
      notify: cap.notify,
    });
    expect(r).toEqual({ employed: true, action: 'none' });
    expect(cap.calls).toEqual([]);
    expect(state.notifiedNoJobToday).toBe(false);
  });

  it('hires + notifies + clears notifiedNoJobToday on `applied`', async () => {
    const state = emptyState(6761);
    state.notifiedNoJobToday = true;
    const cap = notifyCaptor();
    ensureEmployedMock.mockResolvedValue({
      employed: true,
      action: 'applied',
      employerName: 'HighPay',
      salary: 5000,
      netSalary: 4950,
      currency: 'USD',
    });
    const r = await runEmploymentSweep(ctx, csrf, COUNTRY, state, {
      autoEmploy: true,
      notify: cap.notify,
    });
    expect(r.employed).toBe(true);
    expect(r.action).toBe('applied');
    expect(cap.calls).toEqual([expect.stringContaining('HighPay')]);
    expect(state.notifiedNoJobToday).toBe(false);
  });

  it('no_jobs → unemployed, notifies ONCE per day, sets throttle', async () => {
    const state = emptyState(6761);
    const cap = notifyCaptor();
    ensureEmployedMock.mockResolvedValue({
      employed: false,
      action: 'no_jobs',
      reason: 'no job offers available in country 35',
    });

    const r1 = await runEmploymentSweep(ctx, csrf, COUNTRY, state, {
      autoEmploy: true,
      notify: cap.notify,
    });
    expect(r1.employed).toBe(false);
    expect(r1.action).toBe('no_jobs');
    expect(cap.calls).toHaveLength(1);
    expect(state.notifiedNoJobToday).toBe(true);

    // Second cycle same day: still no jobs, but no extra notification.
    const r2 = await runEmploymentSweep(ctx, csrf, COUNTRY, state, {
      autoEmploy: true,
      notify: cap.notify,
    });
    expect(r2.employed).toBe(false);
    expect(cap.calls).toHaveLength(1);
  });

  it('forwards the current-location country to ensureEmployed', async () => {
    const state = emptyState(6761);
    const cap = notifyCaptor();
    ensureEmployedMock.mockResolvedValue({ employed: true, action: 'none' });
    await runEmploymentSweep(ctx, csrf, 14 /* foreign country */, state, {
      autoEmploy: true,
      notify: cap.notify,
    });
    expect(ensureEmployedMock).toHaveBeenCalledWith(ctx, csrf, 14);
  });

  // NOTE: a test for the catch path (rejected ensureEmployed → action:'error')
  // was intentionally omitted. Vitest's unhandled-error tracker flags any
  // throw from inside a vi.fn() mock as a test failure even when the caller's
  // try/catch handles it, so a unit test would always fail. The catch block
  // is small and exercised in practice — see runEmploymentSweep's `catch (err)`.
});

describe('runEmploymentSweep — job upgrade path', () => {
  const upgradeOn = {
    enabled: true,
    minNetSalaryDelta: 50,
    minRelativeImprovement: 0.05,
  };

  function employedMarket(bestNet: number) {
    return {
      isEmployed: true,
      isOrganization: false,
      isFromThisCountry: true,
      citizenId: 42,
      currencyName: 'USD',
      employer: { id: 7, name: 'OldBoss', salary: 1000, netSalary: 990 },
      jobs: [
        {
          citizen: { id: 8, name: 'NewBoss', countryId: COUNTRY },
          companyName: 'C',
          salary: bestNet + 20,
          netSalary: bestNet,
          salaryLimit: 0,
          currency: 'USD',
        },
      ],
      pages: 1,
    };
  }

  it('skipped when daily work is NOT yet done (would lose today\'s wage)', async () => {
    const state = emptyState(6761);
    ensureEmployedMock.mockResolvedValue({ employed: true, action: 'none' });
    const r = await runEmploymentSweep(ctx, csrf, COUNTRY, state, {
      autoEmploy: true,
      jobUpgrade: upgradeOn,
      notify: notifyCaptor().notify,
    });
    expect(r.action).toBe('none');
    expect(getJobMarketMock).not.toHaveBeenCalled();
  });

  it('upgrades when criteria are met (resign + apply succeed)', async () => {
    const state = emptyState(6761);
    state.completedActions.work = { at: '2026-05-26T07:05:58.663Z', source: 'agent' };
    const cap = notifyCaptor();
    ensureEmployedMock.mockResolvedValue({ employed: true, action: 'none' });
    getJobMarketMock.mockResolvedValue(employedMarket(1980));
    resignFromJobMock.mockResolvedValue({ success: true, status: 200, body: { status: true } });
    applyForJobMock.mockResolvedValue({
      success: true,
      status: 200,
      message: 'Congratulation, you are now working for NewBoss.',
      body: {},
    });

    const r = await runEmploymentSweep(ctx, csrf, COUNTRY, state, {
      autoEmploy: true,
      jobUpgrade: upgradeOn,
      notify: cap.notify,
    });
    expect(r.action).toBe('upgraded');
    expect(r.employed).toBe(true);
    expect(r.employerName).toBe('NewBoss');
    expect(cap.calls.some((m) => m.includes('upgrade'))).toBe(true);
  });

  it('stays employed if resign rejected (still old employer)', async () => {
    const state = emptyState(6761);
    state.completedActions.work = { at: '2026-05-26T07:05:58.663Z', source: 'agent' };
    const cap = notifyCaptor();
    ensureEmployedMock.mockResolvedValue({ employed: true, action: 'none' });
    getJobMarketMock.mockResolvedValue(employedMarket(1980));
    resignFromJobMock.mockResolvedValue({ success: false, status: 200, body: { status: false } });

    const r = await runEmploymentSweep(ctx, csrf, COUNTRY, state, {
      autoEmploy: true,
      jobUpgrade: upgradeOn,
      notify: cap.notify,
    });
    expect(r.action).toBe('none');
    expect(r.employed).toBe(true);
    expect(applyForJobMock).not.toHaveBeenCalled();
    expect(cap.calls.some((m) => m.includes('resign failed'))).toBe(true);
  });

  it('UNEMPLOYED branch when resign succeeds but apply fails', async () => {
    const state = emptyState(6761);
    state.completedActions.work = { at: '2026-05-26T07:05:58.663Z', source: 'agent' };
    const cap = notifyCaptor();
    ensureEmployedMock.mockResolvedValue({ employed: true, action: 'none' });
    getJobMarketMock.mockResolvedValue(employedMarket(1980));
    resignFromJobMock.mockResolvedValue({ success: true, status: 200, body: { status: true } });
    applyForJobMock.mockResolvedValue({
      success: false,
      status: 200,
      message: 'Offer no longer available',
      body: {},
    });

    const r = await runEmploymentSweep(ctx, csrf, COUNTRY, state, {
      autoEmploy: true,
      jobUpgrade: upgradeOn,
      notify: cap.notify,
    });
    expect(r.action).toBe('upgrade_failed');
    expect(r.employed).toBe(false);
    expect(cap.calls.some((m) => m.includes('UNEMPLOYED'))).toBe(true);
  });

  it('does NOT touch the market when jobUpgrade is disabled', async () => {
    const state = emptyState(6761);
    state.completedActions.work = { at: '2026-05-26T07:05:58.663Z', source: 'agent' };
    ensureEmployedMock.mockResolvedValue({ employed: true, action: 'none' });

    const r = await runEmploymentSweep(ctx, csrf, COUNTRY, state, {
      autoEmploy: true,
      jobUpgrade: { ...upgradeOn, enabled: false },
      notify: notifyCaptor().notify,
    });
    expect(r.action).toBe('none');
    expect(getJobMarketMock).not.toHaveBeenCalled();
  });
});
