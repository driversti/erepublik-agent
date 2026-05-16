import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendHistory, tailHistory, type HistoryEvent } from './historyStore.js';

describe('historyStore', () => {
  let tmpRoot: string;
  let originalRoot: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'erp-history-'));
    originalRoot = process.env.ERP_ROOT;
    process.env.ERP_ROOT = tmpRoot;
    mkdirSync(join(tmpRoot, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.ERP_ROOT;
    else process.env.ERP_ROOT = originalRoot;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('tail returns empty when no file', () => {
    expect(tailHistory(50)).toEqual([]);
  });

  it('append + tail roundtrip preserves event order', () => {
    appendHistory({ type: 'cycle', reason: 'short-circuit' });
    appendHistory({ type: 'cycle', reason: 'farmed' });
    const events = tailHistory(50);
    expect(events).toHaveLength(2);
    expect((events[0] as HistoryEvent & { reason?: string }).reason).toBe('short-circuit');
    expect((events[1] as HistoryEvent & { reason?: string }).reason).toBe('farmed');
  });

  it('tail caps at N (returns most recent)', () => {
    for (let i = 0; i < 100; i++) appendHistory({ type: 'cycle', reason: `c${i}` });
    const events = tailHistory(10);
    expect(events).toHaveLength(10);
    expect((events[0] as HistoryEvent & { reason?: string }).reason).toBe('c90');
    expect((events[9] as HistoryEvent & { reason?: string }).reason).toBe('c99');
  });

  it('stamps each event with an ISO timestamp', () => {
    appendHistory({ type: 'cycle', reason: 'x' });
    const events = tailHistory(1);
    expect(events[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('skips malformed JSON lines silently', () => {
    appendHistory({ type: 'cycle', reason: 'ok' });
    const path = join(tmpRoot, 'sessions', 'history.jsonl');
    writeFileSync(path, '{"type":"cycle","reason":"ok","at":"2026-01-01T00:00:00.000Z"}\nnot valid json\n{"type":"cycle","reason":"ok2","at":"2026-01-02T00:00:00.000Z"}\n');
    const events = tailHistory(50);
    expect(events.length).toBe(2);
    expect(events.map((e) => (e as HistoryEvent & { reason?: string }).reason)).toEqual(['ok', 'ok2']);
  });

  it('append is durable across re-loads', () => {
    appendHistory({ type: 'mode', from: 'standard', to: 'd4tw' });
    const reread = tailHistory(50);
    expect(reread[0]).toMatchObject({ type: 'mode', from: 'standard', to: 'd4tw' });
  });
});
