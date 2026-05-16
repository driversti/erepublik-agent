import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSettings, saveSettings, Settings } from './settingsStore.js';
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

const MAX_BODY_BYTES = 64 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const ct = (req.headers['content-type'] ?? '').split(';')[0].trim();
  if (ct !== 'application/json') {
    throw Object.assign(new Error('Content-Type must be application/json'), { httpStatus: 415 });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw Object.assign(new Error('Request body exceeds 64 KB'), { httpStatus: 413 });
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw Object.assign(new Error('Malformed JSON: ' + (err as Error).message), { httpStatus: 400 });
  }
}

async function handlePutSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const raw = await readJsonBody(req);
    const validated = Settings.parse(raw);
    saveSettings(validated);
    sendJson(res, 200, validated);
  } catch (err) {
    const status = (err as { httpStatus?: number }).httpStatus ?? 400;
    sendJson(res, status, { error: (err as Error).message });
  }
}

function handle(req: IncomingMessage, res: ServerResponse, opts: StartOptions): void {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // Strip query string for path-matching.
  const path = url.split('?')[0];

  if (method === 'PUT' && path === '/api/settings') {
    return void handlePutSettings(req, res);
  }
  if (method !== 'GET') {
    res.writeHead(405).end('Method not allowed');
    return;
  }

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
    // When port is 0, Node.js auto-assigns a free port; fetch the actual port from server.address()
    const addr = server.address();
    chosenPort = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
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
