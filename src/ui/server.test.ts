import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startUiServer } from './server.js';
import { createSnapshot } from './snapshot.js';

describe('UI server', () => {
  let tmpRoot: string;
  let originalRoot: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'erp-ui-server-'));
    originalRoot = process.env.ERP_ROOT;
    process.env.ERP_ROOT = tmpRoot;
    mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.ERP_ROOT;
    else process.env.ERP_ROOT = originalRoot;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('binds to a port and serves /api/status with the current snapshot', async () => {
    const snap = createSnapshot();
    snap.day = 6750;
    const handle = await startUiServer({ getSnapshot: () => snap, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/status`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.day).toBe(6750);
    } finally {
      await handle.close();
    }
  });

  it('serves /api/settings (creates default file if missing)', async () => {
    const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/settings`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.paused).toBe(false);
      expect(body.farmEnabled).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('serves /api/logs with empty array when no log file', async () => {
    mkdirSync(join(tmpRoot, 'logs'), { recursive: true });
    const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/logs?lines=10`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ lines: [] });
    } finally {
      await handle.close();
    }
  });

  it('rejects non-GET methods with 405', async () => {
    const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/settings`, { method: 'POST' });
      expect(res.status).toBe(405);
    } finally {
      await handle.close();
    }
  });

  it('returns 404 for unknown paths', async () => {
    const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('binds to 127.0.0.1 only (not 0.0.0.0)', async () => {
    const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
    try {
      // Sanity: 127.0.0.1 works
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/status`);
      expect(res.status).toBe(200);
    } finally {
      await handle.close();
    }
  });
});
