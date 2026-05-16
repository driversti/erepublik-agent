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

  describe('PUT /api/settings', () => {
    it('persists a valid payload and returns the parsed result', async () => {
      const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
      try {
        // Seed defaults via GET so the file exists.
        await fetch(`http://127.0.0.1:${handle.port}/api/settings`);

        const payload = {
          paused: true,
          farmEnabled: false,
          modeOverride: null,
          maverickManual: null,
          d4tw: {
            targetDamageAttacker: 150_000_000,
            targetDamageDefender: 250_000_000,
            maxBattlesPerSession: 2,
            weaponPriority: [7, 6, 5],
          },
          emptyDiv: {
            maxBattlesPerSession: 3,
            nativeWeaponPriority: [7, 6, 5, 4, 3, 2, 1],
            foreignWeaponPolicy: 'bomb-then-bazooka' as const,
          },
          travel: {
            maxTravelCC: 100,
            returnHomeAfterMinutes: 15,
            returnHomeMaxCC: 500,
          },
          detected: {
            division: null,
            hasMaverick: null,
            citizenId: null,
            countryId: null,
            lastUpdated: null,
          },
        };
        const put = await fetch(`http://127.0.0.1:${handle.port}/api/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        expect(put.status).toBe(200);
        const echoed = await put.json();
        expect(echoed.paused).toBe(true);
        expect(echoed.d4tw.targetDamageAttacker).toBe(150_000_000);

        // Subsequent GET should reflect the change.
        const get = await fetch(`http://127.0.0.1:${handle.port}/api/settings`);
        const reread = await get.json();
        expect(reread.paused).toBe(true);
        expect(reread.d4tw.maxBattlesPerSession).toBe(2);
      } finally {
        await handle.close();
      }
    });

    it('rejects payload that fails schema validation with 400', async () => {
      const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
      try {
        const res = await fetch(`http://127.0.0.1:${handle.port}/api/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused: 'not a boolean' }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBeDefined();
      } finally {
        await handle.close();
      }
    });

    it('rejects non-JSON content-type with 415', async () => {
      const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
      try {
        const res = await fetch(`http://127.0.0.1:${handle.port}/api/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: 'plain text',
        });
        expect(res.status).toBe(415);
      } finally {
        await handle.close();
      }
    });

    it('rejects malformed JSON with 400', async () => {
      const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
      try {
        const res = await fetch(`http://127.0.0.1:${handle.port}/api/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: '{ not valid json',
        });
        expect(res.status).toBe(400);
      } finally {
        await handle.close();
      }
    });

    it('rejects oversize body (>64 KB) with 413', async () => {
      const handle = await startUiServer({ getSnapshot: () => createSnapshot(), port: 0 });
      try {
        const big = 'x'.repeat(70 * 1024);
        const res = await fetch(`http://127.0.0.1:${handle.port}/api/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ junk: big }),
        });
        expect(res.status).toBe(413);
      } finally {
        await handle.close();
      }
    });
  });
});
