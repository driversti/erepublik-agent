import { createWriteStream, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logsDir } from '../paths.js';

/**
 * One-time process-level setup for the long-running daily runner:
 *
 *   - Write `logs/agent.pid` so operators / supervisor scripts can find this
 *     instance, and clean it up on `process.on('exit')`.
 *   - Optionally tee `console.log` / `console.error` to a daily-rotated log
 *     file in `logsDir()` when `ERP_FILE_LOGGING=true`.
 *
 * Extracted from `runner.ts` so the cycle module is free of side effects
 * that run at module load time. Call once from the entry point.
 */
export interface AppInitOptions {
  fileLoggingEnabled: boolean;
}

export function initAppEnvironment(opts: AppInitOptions): void {
  writePidFile();
  if (opts.fileLoggingEnabled) {
    enableFileLogging();
  }
}

function writePidFile(): void {
  const pidPath = join(logsDir(), 'agent.pid');
  writeFileSync(pidPath, String(process.pid));

  const cleanupPid = (): void => {
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore — pid file may already be gone (concurrent rm, etc.) */
    }
  };
  // SIGINT/SIGTERM are handled by the runner's graceful-stop controller and
  // exit cleanly; the `exit` listener fires `cleanupPid()` after that.
  process.on('exit', cleanupPid);
}

function enableFileLogging(): void {
  // Daily rotation matches the eRepublik day boundary the agent already uses.
  // We stamp by calendar day because operators reading logs think in calendar
  // days, not game days.
  const stamp = new Date().toISOString().slice(0, 10);
  const stream = createWriteStream(join(logsDir(), `agent-${stamp}.log`), { flags: 'a' });

  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...args: unknown[]) => {
    origLog(...args);
    stream.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  };
  console.error = (...args: unknown[]) => {
    origErr(...args);
    stream.write(
      '[ERR] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n',
    );
  };
}
