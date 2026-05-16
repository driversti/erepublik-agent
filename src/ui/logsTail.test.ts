import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tailLog } from './logsTail.js';

describe('tailLog', () => {
  let tmpRoot: string;
  let originalRoot: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'erp-logs-'));
    originalRoot = process.env.ERP_ROOT;
    process.env.ERP_ROOT = tmpRoot;
    mkdirSync(join(tmpRoot, 'logs'), { recursive: true });
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.ERP_ROOT;
    else process.env.ERP_ROOT = originalRoot;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns empty array when no log file', () => {
    expect(tailLog(50)).toEqual([]);
  });

  it('returns last N lines when file exists', () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const path = join(tmpRoot, 'logs', `agent-${stamp}.log`);
    writeFileSync(path, ['a', 'b', 'c', 'd', 'e'].join('\n'));
    expect(tailLog(3)).toEqual(['c', 'd', 'e']);
  });

  it('returns all lines when N exceeds total', () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const path = join(tmpRoot, 'logs', `agent-${stamp}.log`);
    writeFileSync(path, ['x', 'y'].join('\n'));
    expect(tailLog(100)).toEqual(['x', 'y']);
  });
});
