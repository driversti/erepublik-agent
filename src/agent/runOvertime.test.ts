import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DailyState } from '../memory/schema.js';
import type { Settings } from '../ui/settingsStore.js';
import { emptyState } from '../memory/schema.js';

const getJobData = vi.fn();
const workOvertime = vi.fn();

vi.mock('../tools/workOvertime.js', () => ({
  getJobData: (...a: unknown[]) => getJobData(...a),
  workOvertime: (...a: unknown[]) => workOvertime(...a),
}));

// Import AFTER vi.mock so the orchestrator picks up the mocked transport.
const { runOvertimeIfEligible } = await import('./runOvertime.js');

const FIXED_NOW = new Date('2026-05-20T12:00:00.000Z');
const FIXED_NOW_SEC = Math.floor(FIXED_NOW.getTime() / 1000);
const fixedNow = () => FIXED_NOW;

function settings(overrides: Partial<Settings['workOvertime']> = {}): Settings {
  // Only the `workOvertime` block matters here; the orchestrator never reads
  // anything else, so we cast a minimal stub through unknown.
  return {
    workOvertime: { enabled: true, mode: 'once-per-day', ...overrides },
  } as unknown as Settings;
}

function notifyCaptor() {
  const calls: string[] = [];
  return {
    notify: async (m: string) => { calls.push(m); },
    calls,
  };
}

beforeEach(() => {
  getJobData.mockReset();
  workOvertime.mockReset();
});

describe('runOvertimeIfEligible', () => {
  it('short-circuits when settings disabled (no API call)', async () => {
    const s = emptyState(6755);
    const cap = notifyCaptor();
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings({ enabled: false }), { notify: cap.notify, now: fixedNow },
    );
    expect(out.decision).toEqual({ kind: 'skip-disabled' });
    expect(getJobData).not.toHaveBeenCalled();
    expect(workOvertime).not.toHaveBeenCalled();
    expect(cap.calls).toEqual([]);
  });

  it('short-circuits when cap reached (no API call)', async () => {
    const s: DailyState = { ...emptyState(6755), overtimeCapReachedAt: '2026-05-20T11:00:00Z' };
    const cap = notifyCaptor();
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings(), { notify: cap.notify, now: fixedNow },
    );
    expect(out.decision).toEqual({ kind: 'skip-cap' });
    expect(getJobData).not.toHaveBeenCalled();
  });

  it('reconcile-external: cooldown active + flag unset → mark external, no POST', async () => {
    const s = emptyState(6755);
    getJobData.mockResolvedValue({
      isEmployee: true,
      overTime: { points: 1000, usableEnergy: 500, nextOverTime: FIXED_NOW_SEC + 600 },
    });
    const cap = notifyCaptor();
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings(), { notify: cap.notify, now: fixedNow },
    );
    expect(out.decision).toEqual({ kind: 'reconcile-external' });
    expect(workOvertime).not.toHaveBeenCalled();
    expect(s.completedActions.workOvertime).toEqual({
      at: FIXED_NOW.toISOString(),
      source: 'external',
    });
    expect(cap.calls).toEqual([]); // silent reconciliation
  });

  it('go: marks completedActions agent and is silent (digest emits the OT line)', async () => {
    const s = emptyState(6755);
    getJobData.mockResolvedValue({
      isEmployee: true,
      overTime: { points: 1000, usableEnergy: 500, nextOverTime: 0 },
    });
    workOvertime.mockResolvedValue({
      success: true,
      httpStatus: 200,
      message: null,
      result: { netSalary: 7425, currency: 'LTL' },
    });
    const cap = notifyCaptor();
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings(), { notify: cap.notify, now: fixedNow },
    );
    expect(out.decision).toEqual({ kind: 'go' });
    expect(out.netSalary).toBe(7425);
    expect(out.currency).toBe('LTL');
    expect(s.completedActions.workOvertime).toEqual({
      at: FIXED_NOW.toISOString(),
      source: 'agent',
    });
    // Success path no longer fires a standalone Telegram message — the
    // runner aggregates it into the end-of-cycle batch digest so we don't
    // double-notify the operator. The decision/netSalary/currency in `out`
    // is what the runner reads to compose the OT digest line.
    expect(cap.calls).toEqual([]);
  });

  it('go but clean-precondition failure → mark cap + alert', async () => {
    const s = emptyState(6755);
    getJobData.mockResolvedValue({
      isEmployee: true,
      overTime: { points: 1000, usableEnergy: 500, nextOverTime: 0 },
    });
    workOvertime.mockResolvedValue({
      success: false,
      httpStatus: 200,
      message: 'something else the server returned',
      result: null,
    });
    const cap = notifyCaptor();
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings(), { notify: cap.notify, now: fixedNow },
    );
    expect(out.decision).toEqual({ kind: 'go' });
    expect(s.overtimeCapReachedAt).toBe(FIXED_NOW.toISOString());
    // Telegram text is MDv2-escaped + surfaces the literal server message
    // so operators can tell variants apart (e.g. "lock" vs others) without
    // a code change. The literal `=` and `"` are reserved in MDv2.
    expect(cap.calls).toEqual([
      '⛔ overtime rejected by server \\(msg\\="something else the server returned"\\) — paused until day rollover',
    ]);
  });

  it('skip-cooldown when flag already set (does not double-reconcile)', async () => {
    const s: DailyState = {
      ...emptyState(6755),
      completedActions: {
        workOvertime: { at: '2026-05-20T11:00:00Z', source: 'agent' },
      },
    };
    getJobData.mockResolvedValue({
      isEmployee: true,
      overTime: { points: 1000, usableEnergy: 500, nextOverTime: FIXED_NOW_SEC + 600 },
    });
    const cap = notifyCaptor();
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings({ mode: 'when-available' }), { notify: cap.notify, now: fixedNow },
    );
    expect(out.decision.kind).toBe('skip-cooldown');
    expect(s.completedActions.workOvertime?.source).toBe('agent'); // unchanged
    expect(workOvertime).not.toHaveBeenCalled();
  });

  it('failure in transport returns failed decision, leaves state untouched', async () => {
    const s = emptyState(6755);
    const original = JSON.parse(JSON.stringify(s));
    getJobData.mockRejectedValue(new Error('network ded'));
    const cap = notifyCaptor();
    const out = await runOvertimeIfEligible(
      {} as any, 'csrf', s, settings(), { notify: cap.notify, now: fixedNow },
    );
    expect(out.decision).toEqual({ kind: 'failed', error: 'network ded' });
    expect(s).toEqual(original);
  });
});
