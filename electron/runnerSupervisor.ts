import { app, utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type RunnerState =
  | { status: 'idle' | 'cycling' | 'paused' }
  | { status: 'error'; reason: string };

type IpcFromRunner =
  | { type: 'ready'; port: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'state'; status: 'idle' | 'cycling' | 'paused' | 'error'; reason?: string };

type IpcToRunner =
  | { type: 'shutdown' }
  | { type: 'pauseToggle'; paused: boolean };

const BACKOFF_DELAYS_MS = [1_000, 5_000, 30_000];

export interface RunnerSupervisor {
  start(): void;
  stop(): Promise<void>;
  togglePause(paused: boolean): void;
  onReady(cb: (port: number) => void): void;
  onLog(cb: (level: 'info' | 'warn' | 'error', text: string) => void): void;
  onState(cb: (state: RunnerState) => void): void;
  onPermanentFailure(cb: () => void): void;
  isRunning(): boolean;
  getLastKnownPort(): number | undefined;
}

export function createRunnerSupervisor(): RunnerSupervisor {
  const userDataDir = app.getPath('userData');
  mkdirSync(userDataDir, { recursive: true });

  // Locate the compiled runner. In dev (running from electron-dist/),
  // it's at ../dist/agent/runner.js. In a packaged app, both live under
  // resources/app.asar — same relative path.
  const runnerPath = path.resolve(__dirname, '../dist/agent/runner.js');

  let child: UtilityProcess | undefined;
  let lastPort: number | undefined;
  let crashCount = 0;
  let stopping = false;
  const readyCbs: Array<(port: number) => void> = [];
  const logCbs: Array<(level: 'info' | 'warn' | 'error', text: string) => void> = [];
  const stateCbs: Array<(state: RunnerState) => void> = [];
  const failureCbs: Array<() => void> = [];

  function spawn() {
    child = utilityProcess.fork(runnerPath, [], {
      env: {
        ...process.env,
        ERP_ROOT: userDataDir,
        ERP_FILE_LOGGING: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      serviceName: 'erepublik-agent-runner',
    });

    child.on('message', (raw: unknown) => {
      const msg = raw as IpcFromRunner;
      switch (msg?.type) {
        case 'ready':
          lastPort = msg.port;
          crashCount = 0; // healthy startup resets the backoff
          for (const cb of readyCbs) cb(msg.port);
          break;
        case 'log':
          for (const cb of logCbs) cb(msg.level, msg.text);
          break;
        case 'state':
          {
            const state: RunnerState =
              msg.status === 'error'
                ? { status: 'error', reason: msg.reason ?? 'unknown' }
                : { status: msg.status };
            for (const cb of stateCbs) cb(state);
          }
          break;
      }
    });

    child.stdout?.on('data', (buf: unknown) => {
      const text = buf instanceof Buffer ? buf.toString() : String(buf);
      for (const cb of logCbs) cb('info', text.trimEnd());
    });
    child.stderr?.on('data', (buf: unknown) => {
      const text = buf instanceof Buffer ? buf.toString() : String(buf);
      for (const cb of logCbs) cb('error', text.trimEnd());
    });

    child.on('exit', (code) => {
      child = undefined;
      if (stopping || code === 0) return;
      crashCount += 1;
      const reason = `runner exited with code ${code}`;
      for (const cb of stateCbs) cb({ status: 'error', reason });
      if (crashCount > BACKOFF_DELAYS_MS.length) {
        for (const cb of failureCbs) cb();
        return;
      }
      const delay = BACKOFF_DELAYS_MS[crashCount - 1];
      for (const cb of logCbs) cb('warn', `[supervisor] restarting runner in ${delay}ms (attempt ${crashCount})`);
      setTimeout(() => {
        if (!stopping) spawn();
      }, delay);
    });
  }

  function send(msg: IpcToRunner) {
    child?.postMessage(msg);
  }

  return {
    start() {
      stopping = false;
      crashCount = 0;
      if (!child) spawn();
    },
    async stop() {
      stopping = true;
      if (!child) return;
      send({ type: 'shutdown' });
      // 12s for graceful IPC shutdown, then kill; 3s more if it still hangs.
      await new Promise<void>((resolve) => {
        const c = child;
        if (!c) return resolve();
        const cleanTimer = setTimeout(() => {
          c.kill(); // first attempt
          setTimeout(() => {
            if (child) child.kill(); // force again if still alive
            resolve();
          }, 3_000);
        }, 12_000);
        c.once('exit', () => {
          clearTimeout(cleanTimer);
          resolve();
        });
      });
    },
    togglePause(paused: boolean) {
      send({ type: 'pauseToggle', paused });
    },
    onReady: (cb) => void readyCbs.push(cb),
    onLog: (cb) => void logCbs.push(cb),
    onState: (cb) => void stateCbs.push(cb),
    onPermanentFailure: (cb) => void failureCbs.push(cb),
    isRunning: () => child !== undefined,
    getLastKnownPort: () => lastPort,
  };
}
