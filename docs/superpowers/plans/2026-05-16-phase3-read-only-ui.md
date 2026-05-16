# Phase 3 — Read-Only Local Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a minimal local-only dashboard from inside the runner process at `http://localhost:3737`. Read-only — Phase 4 adds writes. Operator opens it in their browser to see status, settings, mission progress, and live log tail without touching the terminal.

**Architecture:** New `src/ui/server.ts` exposes `startUiServer({ getSnapshot, logsDir })`. The runner creates a mutable `UiSnapshot` object at startup, mutates it at the end of each cycle, and passes a `() => snapshot` accessor. The HTTP server (Node native `http`, no Express) registers handlers for `GET /` (static `index.html`), `GET /app.js`, `GET /styles.css`, `GET /api/settings` (current `settings.json`), `GET /api/status` (latest snapshot), and `GET /api/logs?lines=N` (tail of today's log file). Frontend: single `index.html` with vanilla JS polling every 3 s + Tailwind via CDN. No bundle, no React. Port discovery tries 3737..3747 then fails loud. Server binds to `127.0.0.1` only.

**Tech Stack:** Node 22 native `http`, vanilla HTML/JS, Tailwind via CDN. Vitest for server tests. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-05-16-flexible-farming-config-design.md` §5 (Web UI). §5.1 server layout, §5.2 frontend, §5.3 launch, §5.4 security.

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/ui/server.ts` | **create** | `startUiServer(opts)` — port discovery, route registration, static serving, JSON handlers. Returns `{ port, close() }`. |
| `src/ui/snapshot.ts` | **create** | `UiSnapshot` type + `createSnapshot()` factory. Mutable object the runner updates each cycle; the server reads it on every request. |
| `src/ui/logsTail.ts` | **create** | `tailLog(lines: number)` — read last N lines from `logs/agent-YYYY-MM-DD.log`. Bounded read, no streaming. |
| `src/ui/public/index.html` | **create** | Dashboard layout: status card, daily-actions card, settings card, history card, logs card. Tailwind via CDN. |
| `src/ui/public/app.js` | **create** | Vanilla JS: polls `/api/status` + `/api/settings` every 3 s, re-renders cards. |
| `src/ui/server.test.ts` | **create** | Vitest: port discovery, static serving, JSON endpoints, error handling. |
| `src/agent/runner.ts` | modify | Create snapshot, start server before cycle loop, update snapshot at end of each cycle, gracefully `await server.close()` on shutdown. |
| `windows/panel.bat` | **create** | One-liner: opens `http://localhost:3737` in default browser. |
| `windows/start.bat` | modify | After starting `npm start`, auto-open browser (small `start http://...` line — Windows-only). |
| `windows/README.txt` | modify | Add "Open the panel" line under Quick start, mention `panel.bat`. |

`src/ui/snapshot.ts` separation: the snapshot object is the bridge between runner (writer) and server (reader). Putting the type and factory in its own file keeps `server.ts` focused on HTTP and `runner.ts` focused on cycle logic.

---

## Task 1: Snapshot type + factory

**Files:**
- Create: `src/ui/snapshot.ts`

The snapshot mirrors what `runCycle` already knows (citizen context, daily state, weekly fuel, last decision reason). One mutable object that the runner updates and the server reads.

- [ ] **Step 1: Create the file**

```ts
import type { Settings } from './settingsStore.js';

export interface UiSnapshot {
  /** Unix ms of last successful cycle update (server uses for "last seen" UI label). */
  lastUpdatedAt: number | null;
  /** ISO of last cycle start, written even on paused / errored cycles. */
  lastCycleStartedAt: string | null;
  /** Reason string from the last farm-gate decision (or 'paused' / 'cycle-error'). */
  lastFarmReason: string | null;
  /** Game day at last update. */
  day: number | null;
  /** Citizen context from extractCitizenContext (subset to avoid leaking csrf, page state). */
  citizen: {
    id: number | null;
    countryId: number | null;
    division: number | null;
    energy: number | null;
    energyPoolLimit: number | null;
    fuelLeft: number | null;
    maxFuel: number | null;
    currentRegionId: number | null;
    residenceRegionId: number | null;
    atHome: boolean | null;
  };
  /** Daily action flags mirrored from DailyState.completedActions. */
  dailyActions: {
    work: boolean;
    train: boolean;
    buyFood: boolean;
    vipClaim: boolean;
  };
  /** From WeeklyFuelState — week-to-date pace numbers. */
  weeklyFuel: {
    week: number | null;
    spent: number;
    target: number;
    hitsLanded: number;
    cyclesSkipped: number;
  };
  /** Snapshot of the live `Settings` object (so the UI doesn't have to re-fetch). */
  settings: Settings | null;
  /** Last cycle's exception message, cleared on next successful cycle. */
  lastError: string | null;
}

export function createSnapshot(): UiSnapshot {
  return {
    lastUpdatedAt: null,
    lastCycleStartedAt: null,
    lastFarmReason: null,
    day: null,
    citizen: {
      id: null,
      countryId: null,
      division: null,
      energy: null,
      energyPoolLimit: null,
      fuelLeft: null,
      maxFuel: null,
      currentRegionId: null,
      residenceRegionId: null,
      atHome: null,
    },
    dailyActions: { work: false, train: false, buyFood: false, vipClaim: false },
    weeklyFuel: { week: null, spent: 0, target: 0, hitsLanded: 0, cyclesSkipped: 0 },
    settings: null,
    lastError: null,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/ui/snapshot.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(ui): UiSnapshot type + factory for runner→server bridge"
```

---

## Task 2: Logs tail helper

**Files:**
- Create: `src/ui/logsTail.ts`

A simple bounded read of the last N lines of today's log file. Don't stream — for a 1 MB log, a single `readFileSync` + `split` is fine.

- [ ] **Step 1: Create the file**

```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logsDir } from '../paths.js';

/** Path to today's log file (matches the rotation scheme in runner.ts). */
function todayLogPath(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  return join(logsDir(), `agent-${stamp}.log`);
}

/**
 * Read the last `lines` lines of today's log file. Returns an empty array if
 * the file doesn't exist (file logging is off). Caps the read at 256 KB tail
 * so a 100 MB log doesn't blow the response.
 */
export function tailLog(lines: number): string[] {
  const path = todayLogPath();
  if (!existsSync(path)) return [];
  const stats = statSync(path);
  const maxBytes = 256 * 1024;
  const start = Math.max(0, stats.size - maxBytes);
  const buf = readFileSync(path, { encoding: 'utf8' });
  const tail = start === 0 ? buf : buf.slice(start);
  const all = tail.split('\n');
  // Drop the (likely truncated) first line if we sliced mid-file.
  const safe = start === 0 ? all : all.slice(1);
  return safe.slice(-lines);
}
```

- [ ] **Step 2: Add a tiny test**

Create `src/ui/logsTail.test.ts`:

```ts
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
```

- [ ] **Step 3: Run tests**

Run: `npm test --silent -- logsTail`
Expected: 3/3 pass.

- [ ] **Step 4: Typecheck + full test**

Run: `npm run typecheck && npm test --silent`
Expected: PASS, total tests now 27 (24 + 3 new).

- [ ] **Step 5: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/ui/logsTail.ts src/ui/logsTail.test.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(ui): tailLog helper for the /api/logs endpoint"
```

---

## Task 3: HTTP server + port discovery + routes

**Files:**
- Create: `src/ui/server.ts`

Native `http.createServer`. Port discovery tries 3737, 3738, …, 3747 then fails. Routes are mounted manually (no Express) — 4 routes total: `/`, `/app.js`, `/styles.css`, `/api/*`.

- [ ] **Step 1: Create `src/ui/server.ts`**

```ts
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSettings } from './settingsStore.js';
import { tailLog } from './logsTail.js';
import type { UiSnapshot } from './snapshot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const PORT_RANGE = { start: 3737, end: 3747 };

interface StartOptions {
  getSnapshot: () => UiSnapshot;
  /** Override port for tests; production uses port discovery. */
  port?: number;
}

interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendStatic(res: ServerResponse, filename: string, contentType: string): void {
  try {
    const body = readFileSync(join(PUBLIC_DIR, filename));
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      // Force no-cache so reloads after frontend edits show immediately.
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(404).end(`Not found: ${filename}`);
  }
}

function parseLinesParam(url: string | undefined): number {
  if (!url) return 100;
  const u = new URL(url, 'http://localhost');
  const n = Number(u.searchParams.get('lines') ?? '100');
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(Math.floor(n), 1000);
}

function handle(req: IncomingMessage, res: ServerResponse, opts: StartOptions): void {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  if (method !== 'GET') {
    res.writeHead(405).end('Method not allowed');
    return;
  }

  // Strip query string for path-matching.
  const path = url.split('?')[0];

  if (path === '/') return sendStatic(res, 'index.html', 'text/html; charset=utf-8');
  if (path === '/app.js') return sendStatic(res, 'app.js', 'application/javascript; charset=utf-8');
  if (path === '/styles.css') return sendStatic(res, 'styles.css', 'text/css; charset=utf-8');

  if (path === '/api/status') return sendJson(res, 200, opts.getSnapshot());
  if (path === '/api/settings') {
    try {
      return sendJson(res, 200, loadSettings());
    } catch (err) {
      return sendJson(res, 500, { error: (err as Error).message });
    }
  }
  if (path === '/api/logs') {
    const lines = parseLinesParam(url);
    return sendJson(res, 200, { lines: tailLog(lines) });
  }
  // History is added in Phase 7; return empty so the UI doesn't break today.
  if (path === '/api/history') return sendJson(res, 200, { events: [] });

  res.writeHead(404).end('Not found');
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Start the UI server bound to 127.0.0.1. If `port` is omitted, tries ports
 * 3737..3747 until one is free; throws if all are busy.
 */
export async function startUiServer(opts: StartOptions): Promise<ServerHandle> {
  const host = '127.0.0.1';
  const server = createServer((req, res) => handle(req, res, opts));

  let chosenPort: number | null = null;
  if (opts.port != null) {
    await listen(server, opts.port, host);
    chosenPort = opts.port;
  } else {
    let lastError: unknown = null;
    for (let p = PORT_RANGE.start; p <= PORT_RANGE.end; p++) {
      try {
        await listen(server, p, host);
        chosenPort = p;
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EADDRINUSE') {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    if (chosenPort == null) {
      throw new Error(
        `UI server: all ports ${PORT_RANGE.start}..${PORT_RANGE.end} are in use (${(lastError as Error)?.message ?? ''})`,
      );
    }
  }

  return {
    port: chosenPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (No public dir yet — `sendStatic` will 404 at runtime for `/`, that's fine for this task.)

- [ ] **Step 3: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/ui/server.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(ui): http server with port discovery + GET routes"
```

---

## Task 4: Server integration tests

**Files:**
- Create: `src/ui/server.test.ts`

Spin up the server on port 0 (OS picks free port) so tests are parallel-safe.

- [ ] **Step 1: Create test file**

```ts
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
```

- [ ] **Step 2: Run server tests**

Run: `npm test --silent -- server`
Expected: 6/6 pass.

- [ ] **Step 3: Run full suite**

Run: `npm test --silent`
Expected: 33 tests total (27 + 6 new).

- [ ] **Step 4: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/ui/server.test.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "test(ui): server endpoint tests with random-port isolation"
```

---

## Task 5: Frontend (HTML + JS)

**Files:**
- Create: `src/ui/public/index.html`
- Create: `src/ui/public/app.js`

Minimal dashboard: status card, daily-actions card, settings card, logs card. Tailwind via CDN. JS polls `/api/status` and `/api/settings` every 3 s.

- [ ] **Step 1: Create `src/ui/public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>erepublik-agent</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 text-gray-900 font-sans">
  <header class="bg-gray-900 text-white px-4 py-3 flex items-center gap-3">
    <span class="font-semibold text-lg">erepublik-agent</span>
    <span id="status-pill" class="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-700">loading…</span>
    <span class="ml-auto text-xs opacity-70" id="last-updated">—</span>
  </header>

  <main class="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
    <section class="bg-white rounded shadow p-4">
      <h2 class="font-semibold mb-2">Live status</h2>
      <dl id="status-grid" class="text-sm grid grid-cols-2 gap-x-4 gap-y-1"></dl>
      <div class="mt-3">
        <div class="flex justify-between text-xs text-gray-500"><span>Energy</span><span id="energy-text">—</span></div>
        <div class="h-1.5 bg-gray-200 rounded"><div id="energy-bar" class="h-full bg-blue-500 rounded" style="width: 0%"></div></div>
      </div>
      <div class="mt-2">
        <div class="flex justify-between text-xs text-gray-500"><span>Fuel barrels</span><span id="fuel-text">—</span></div>
        <div class="h-1.5 bg-gray-200 rounded"><div id="fuel-bar" class="h-full bg-amber-500 rounded" style="width: 0%"></div></div>
      </div>
    </section>

    <section class="bg-white rounded shadow p-4">
      <h2 class="font-semibold mb-2">Today's actions</h2>
      <ul id="daily-actions" class="text-sm space-y-1"></ul>
    </section>

    <section class="bg-white rounded shadow p-4 md:col-span-2">
      <h2 class="font-semibold mb-2">Settings (read-only in this phase)</h2>
      <pre id="settings-json" class="text-xs bg-gray-50 p-3 rounded overflow-x-auto">loading…</pre>
    </section>

    <section class="bg-white rounded shadow p-4 md:col-span-2">
      <h2 class="font-semibold mb-2">Live logs (last 100 lines)</h2>
      <pre id="logs" class="text-xs bg-gray-50 p-3 rounded h-48 overflow-y-auto font-mono">—</pre>
    </section>
  </main>

  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `src/ui/public/app.js`**

```js
const POLL_MS = 3000;

async function fetchJson(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setBar(textId, barId, current, max) {
  if (current == null || max == null || max <= 0) {
    setText(textId, '—');
    document.getElementById(barId).style.width = '0%';
    return;
  }
  setText(textId, `${current} / ${max}`);
  document.getElementById(barId).style.width = `${Math.min(100, (current / max) * 100)}%`;
}

function renderStatus(s) {
  const pill = document.getElementById('status-pill');
  if (s.settings?.paused) {
    pill.textContent = '⏸ PAUSED';
    pill.className = 'px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500 text-white';
  } else {
    pill.textContent = '● RUNNING';
    pill.className = 'px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500 text-white';
  }
  if (s.lastUpdatedAt) {
    const ago = Math.floor((Date.now() - s.lastUpdatedAt) / 1000);
    setText('last-updated', `last cycle ${ago}s ago`);
  } else {
    setText('last-updated', 'no cycle yet');
  }

  const grid = document.getElementById('status-grid');
  const rows = [
    ['Day', s.day ?? '—'],
    ['Mode', s.settings?.modeOverride ?? 'auto'],
    ['Citizen', s.citizen.id ?? '—'],
    ['Country', s.citizen.countryId ?? '—'],
    ['Division', s.citizen.division ?? '—'],
    ['Location', s.citizen.atHome === true ? 'home' : s.citizen.atHome === false ? 'abroad' : '—'],
    ['Last farm reason', s.lastFarmReason ?? '—'],
    ['Last error', s.lastError ?? '—'],
  ];
  grid.innerHTML = rows
    .map(([k, v]) => `<dt class="text-gray-500">${k}</dt><dd>${v}</dd>`)
    .join('');

  setBar('energy-text', 'energy-bar', s.citizen.energy, s.citizen.energyPoolLimit);
  setBar('fuel-text', 'fuel-bar', s.citizen.fuelLeft, s.citizen.maxFuel);

  const da = s.dailyActions;
  document.getElementById('daily-actions').innerHTML = [
    ['Work', da.work],
    ['Train', da.train],
    ['Buy food', da.buyFood],
    ['VIP claim', da.vipClaim],
  ]
    .map(([k, v]) => `<li>${v ? '✅' : '⏳'} ${k}</li>`)
    .join('');
}

async function refresh() {
  try {
    const [status, settings, logs] = await Promise.all([
      fetchJson('/api/status'),
      fetchJson('/api/settings'),
      fetchJson('/api/logs?lines=100'),
    ]);
    // Settings already lives in status.settings, but /api/settings is the
    // source of truth — let the latter win.
    status.settings = settings;
    renderStatus(status);
    document.getElementById('settings-json').textContent = JSON.stringify(settings, null, 2);
    document.getElementById('logs').textContent = (logs.lines ?? []).join('\n') || '(no log file yet)';
  } catch (err) {
    document.getElementById('last-updated').textContent = `error: ${err.message}`;
  }
}

refresh();
setInterval(refresh, POLL_MS);
```

- [ ] **Step 3: Open in a browser to eyeball it (optional but recommended)**

Without runner integration, you can preview the static HTML by serving it locally:

```bash
cd /Users/driversti/Projects/erepublik/erepublik-agent/src/ui/public && python3 -m http.server 8000
```

Open `http://localhost:8000`. The page renders but XHR calls fail (no API). That's expected — only checking the layout/CSS works.

Stop the python server (`Ctrl-C`) when done.

- [ ] **Step 4: Typecheck (HTML/JS aren't checked, but make sure nothing else broke)**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/ui/public/
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(ui): minimal dashboard frontend (vanilla JS + Tailwind CDN)"
```

---

## Task 6: Wire server into runner lifecycle

**Files:**
- Modify: `src/agent/runner.ts`

Server starts before the cycle loop, gets the shared snapshot, gracefully closes on SIGINT/SIGTERM.

- [ ] **Step 1: Add imports**

In `src/agent/runner.ts`, after the existing imports (around line 30-33), add:

```ts
import { startUiServer } from '../ui/server.js';
import { createSnapshot } from '../ui/snapshot.js';
```

- [ ] **Step 2: Create the snapshot before the loop**

Find the section near the bottom of the file where `const ctx = await openSession({...})` is called. Just before that line (so before any cycle starts), add:

```ts
const uiSnapshot = createSnapshot();
const uiServer = await startUiServer({ getSnapshot: () => uiSnapshot });
console.log(`[runner] UI available at http://localhost:${uiServer.port}`);
```

- [ ] **Step 3: Pass the snapshot into `runCycle`**

This is the most-touch step. Add a `uiSnapshot` parameter to `runCycle` and update it at the END of the function (after `save(...)` calls succeed, before the digest check). Concretely:

Change the signature:

```ts
async function runCycle(
  ctx: BrowserContext,
  notifier: TelegramNotifier,
  captchaCfg: CaptchaConfig,
): Promise<void>
```

to:

```ts
async function runCycle(
  ctx: BrowserContext,
  notifier: TelegramNotifier,
  captchaCfg: CaptchaConfig,
  uiSnapshot: UiSnapshot,
): Promise<void>
```

Add the import at top: `import type { UiSnapshot } from '../ui/snapshot.js';`

Inside `runCycle`, at the very start (right after `const day = eRepublikDay();`), set `uiSnapshot.lastCycleStartedAt = new Date().toISOString();` and `uiSnapshot.day = day;`.

Right before the function returns (i.e. after the `finally { save(...); saveWeekly(...); saveFuel(...); }` block), write the rest of the snapshot fields:

```ts
  uiSnapshot.lastUpdatedAt = Date.now();
  uiSnapshot.settings = settings;
  uiSnapshot.dailyActions = {
    work: !!state.completedActions.work,
    train: !!state.completedActions.train,
    buyFood: !!state.completedActions.buyFood,
    vipClaim: !!state.completedActions.vipClaim,
  };
  uiSnapshot.weeklyFuel = {
    week: fuel.week,
    spent: fuel.spent,
    target: Math.floor(70 * (typeof decision !== 'undefined' ? decision.diagnostics.weekFraction : 0)),
    hitsLanded: fuel.hitsLanded,
    cyclesSkipped: fuel.cyclesSkipped,
  };
  uiSnapshot.citizen = {
    id: ctxInfo.citizenId,
    countryId: ctxInfo.countryId,
    division: ctxInfo.division,
    energy: ctxInfo.energy,
    energyPoolLimit: ctxInfo.energyPoolLimit,
    fuelLeft: ctxInfo.fuelLeft,
    maxFuel: ctxInfo.maxFuel,
    currentRegionId: ctxInfo.currentRegionId,
    residenceRegionId: ctxInfo.residenceRegionId,
    atHome: ctxInfo.currentRegionId != null && ctxInfo.residenceRegionId != null
      ? ctxInfo.currentRegionId === ctxInfo.residenceRegionId
      : null,
  };
  uiSnapshot.lastFarmReason = typeof decision !== 'undefined' ? decision.reason : null;
  uiSnapshot.lastError = null;
```

**Important:** the `decision` variable is currently declared inside the `try` block. Move its declaration up: change `const decision = ...` to `let decision: ReturnType<typeof decideFarming> | { shouldFarm: false; reason: string; battlesThisSession: number; diagnostics: ... } | null = null;` declared at runCycle scope, then assign inside the try block. The snapshot update at the bottom then uses `decision?.reason ?? null` and `decision?.diagnostics.weekFraction ?? 0`.

If you find the type juggling for `decision` awkward, simpler alternative: capture `lastDecisionReason: string | null = null` at runCycle scope and assign it inside the try block — drop the whole `decision` reference from the snapshot update.

The `paused: true` short-circuit (added in Phase 2) returns early. Update the snapshot there too:

```ts
  if (settings.paused) {
    uiSnapshot.lastUpdatedAt = Date.now();
    uiSnapshot.settings = settings;
    uiSnapshot.lastFarmReason = 'paused';
    console.log('[cycle] paused — ...');
    return;
  }
```

- [ ] **Step 4: Update the cycle-error catch to record into the snapshot**

In the outer `do { try { await runCycle(...) } catch (err) { ... } } while (...)` block, add `uiSnapshot.lastError = (err as Error).message;` right after `await notifier.sendError(message);`.

- [ ] **Step 5: Pass the snapshot into the `runCycle(...)` call**

Find both call sites — `await runCycle(ctx, notifier, captchaCfg)` — and append `, uiSnapshot)`.

- [ ] **Step 6: Graceful shutdown**

In the existing `finally { await ctx.close(); console.log('[runner] stopped'); }` block at the end of the file, add `await uiServer.close();` before `await ctx.close();`. This keeps the process from holding a stray socket open after SIGINT.

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

If TypeScript complains about `decision` being possibly undefined where you reference it in the snapshot update, the simple-fix path is to use the `lastDecisionReason: string | null` capture variable approach (see Step 3 note).

- [ ] **Step 8: Run tests**

Run: `npm test --silent`
Expected: 33 pass.

- [ ] **Step 9: Manual smoke**

```bash
cd /Users/driversti/Projects/erepublik/erepublik-agent
rm -f config/settings.json
timeout 90 env ERP_ACCOUNT_SLUG=baryga2026 npm run agent 2>&1 | head -30
```

In another terminal (or just from your laptop browser) while the cycle is running:

```bash
curl -s http://localhost:3737/api/status | head -c 400
curl -s http://localhost:3737/api/settings | head -c 400
```

Both should return JSON. The first run won't have full snapshot data populated until after the first cycle finishes; that's OK.

- [ ] **Step 10: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add src/agent/runner.ts
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(runner): start UI server alongside cycle loop, update snapshot per cycle"
```

---

## Task 7: panel.bat + auto-open + README

**Files:**
- Create: `windows/panel.bat`
- Modify: `windows/start.bat`
- Modify: `windows/README.txt`

The runner already logs the chosen port (`[runner] UI available at http://localhost:3737`). `start.bat` should auto-open the browser after a short delay so the server is up. `panel.bat` is a standalone opener for users who close the tab.

- [ ] **Step 1: Create `windows/panel.bat`**

```bat
@echo off
REM Opens the erepublik-agent dashboard in the default browser.
REM The runner must already be running (start.bat).
start "" "http://localhost:3737"
```

- [ ] **Step 2: Read `windows/start.bat` and find where it launches the agent**

Run `cat windows/start.bat`. Find the line that runs `npm start` (or whatever the actual command is). Add immediately AFTER that line:

```bat
REM Give the UI server a moment to bind, then open the dashboard.
timeout /t 4 /nobreak >nul
start "" "http://localhost:3737"
```

Don't change anything else.

- [ ] **Step 3: Update `windows/README.txt`**

Read the current file. Find the "Quick start" section. Add a new step 5 (or append to the existing list):

```
5. Optional — to reopen the dashboard later:
   Double-click panel.bat. The browser opens http://localhost:3737.
```

- [ ] **Step 4: Commit**

```bash
git -C /Users/driversti/Projects/erepublik/erepublik-agent add windows/
git -C /Users/driversti/Projects/erepublik/erepublik-agent commit -m "feat(windows): panel.bat + auto-open dashboard from start.bat"
```

---

## Task 8: Smoke test

**Files:** none modified — verification only.

- [ ] **Step 1: Fresh state**

```bash
rm -f /Users/driversti/Projects/erepublik/erepublik-agent/config/settings.json
```

- [ ] **Step 2: Start runner in background**

```bash
cd /Users/driversti/Projects/erepublik/erepublik-agent
ERP_ACCOUNT_SLUG=baryga2026 npm run agent > /tmp/p3-runner.log 2>&1 &
RUNNER_PID=$!
sleep 6   # let the cycle + UI server start
```

- [ ] **Step 3: Hit every endpoint**

```bash
echo "--- /api/status ---"
curl -s http://localhost:3737/api/status | python3 -m json.tool | head -25

echo "--- /api/settings ---"
curl -s http://localhost:3737/api/settings | python3 -m json.tool | head -25

echo "--- /api/logs?lines=5 ---"
curl -s 'http://localhost:3737/api/logs?lines=5' | head -c 500

echo "--- /api/history ---"
curl -s http://localhost:3737/api/history

echo "--- / (HTML) ---"
curl -s -o /dev/null -w 'http_code=%{http_code} bytes=%{size_download}\n' http://localhost:3737/

echo "--- /app.js ---"
curl -s -o /dev/null -w 'http_code=%{http_code} bytes=%{size_download}\n' http://localhost:3737/app.js
```

Expected:
- `/api/status` returns JSON with `day`, `citizen.*`, `dailyActions.*` populated.
- `/api/settings` returns the schema with `paused: false, farmEnabled: true`.
- `/api/logs` returns `{ "lines": [...] }` (may be empty if file logging is off).
- `/api/history` returns `{ "events": [] }`.
- `/` returns http 200, ~2-3 KB HTML.
- `/app.js` returns http 200, ~2-3 KB JS.

- [ ] **Step 4: Verify rejections**

```bash
echo "--- POST /api/settings (should 405) ---"
curl -s -o /dev/null -w 'http_code=%{http_code}\n' -X POST http://localhost:3737/api/settings

echo "--- GET /unknown (should 404) ---"
curl -s -o /dev/null -w 'http_code=%{http_code}\n' http://localhost:3737/unknown
```

Expected: 405 and 404 respectively.

- [ ] **Step 5: Shut down runner**

```bash
kill -INT $RUNNER_PID
wait $RUNNER_PID 2>/dev/null
```

Verify the runner log shows graceful shutdown:

```bash
tail -10 /tmp/p3-runner.log
```

Expected: `[runner] stopped` (and no orphaned "EADDRINUSE" errors on a second start).

- [ ] **Step 6: Restart and confirm port is reusable**

```bash
ERP_ACCOUNT_SLUG=baryga2026 timeout 10 npm run agent > /tmp/p3-runner2.log 2>&1 &
sleep 4
curl -s http://localhost:3737/api/status > /dev/null && echo "second start ok" || echo "second start FAILED"
kill -INT %1 2>/dev/null
wait 2>/dev/null
```

Expected: `second start ok`.

- [ ] **Step 7: Full vitest**

```bash
npm test --silent
```

Expected: 33 tests pass.

- [ ] **Step 8: No commit**

Verification only.

---

## Self-Review Notes (for the implementer)

- The runner's snapshot update at the end of `runCycle` requires `decision` to be in-scope. The plan's Step 3 of Task 6 suggests two approaches; pick the simpler one based on how the code currently reads after Phase 2.
- `/api/history` returning `{ events: [] }` is intentional — Phase 7 will populate it. Don't leave a TODO comment; the empty response is the contract today.
- Auto-open in `start.bat` uses a 4-second `timeout` to wait for the server. If you find that's flaky (server takes longer because cloakbrowser is slow on cold start), bump to 8s.
- Tests bind to `port: 0` (OS-assigned). Production calls `startUiServer({ getSnapshot })` with no port, triggering the 3737..3747 discovery.
- The frontend has zero build step — open `src/ui/public/index.html` in any text editor to edit. Tailwind CDN reads classes from the loaded HTML and computes styles at runtime; this is officially "for production builds, use the CLI" but for a local-only dashboard it's fine.
- If you find the server-test cleanup flaky on slow machines (port-bind race), add a short sleep between `handle.close()` and the next test's `startUiServer`. Unlikely on macOS / Linux but possible on Windows.
