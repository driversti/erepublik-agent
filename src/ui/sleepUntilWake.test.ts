import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sleepUntilWake } from './sleepUntilWake.js';

describe('sleepUntilWake', () => {
  let tmpRoot: string;
  let watchPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'erp-sleep-'));
    watchPath = join(tmpRoot, 'settings.json');
    writeFileSync(watchPath, '{}');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('resolves after the timeout when no file change', async () => {
    const t0 = Date.now();
    const reason = await sleepUntilWake(150, watchPath);
    const elapsed = Date.now() - t0;
    expect(reason).toBe('timeout');
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(500);
  });

  it('resolves early when the watched file changes', async () => {
    const t0 = Date.now();
    // Schedule a write 60ms in.
    setTimeout(() => writeFileSync(watchPath, '{"paused":true}'), 60);
    const reason = await sleepUntilWake(2000, watchPath);
    const elapsed = Date.now() - t0;
    expect(reason).toBe('file-changed');
    expect(elapsed).toBeLessThan(500);
  });

  it('does not throw if the watch path does not exist (resolves on timeout)', async () => {
    const missing = join(tmpRoot, 'never-existed.json');
    expect(existsSync(missing)).toBe(false);
    const reason = await sleepUntilWake(150, missing);
    expect(reason).toBe('timeout');
  });
});
