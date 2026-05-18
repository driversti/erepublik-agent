import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface LegacyInstall {
  rootPath: string;
  hasApp: boolean;
  hasSessions: boolean;
  hasEnv: boolean;
  hasChromiumCache: boolean;
}

export function detectLegacyInstall(rootPath: string): LegacyInstall | null {
  if (!fs.existsSync(rootPath)) return null;
  const hasApp = fs.existsSync(path.join(rootPath, 'app'));
  const hasSessions = fs.existsSync(path.join(rootPath, 'sessions'));
  const hasEnv = fs.existsSync(path.join(rootPath, 'config', '.env'));
  const hasChromiumCache = fs.existsSync(path.join(rootPath, 'chromium-cache'));
  const markerCount = [hasApp, hasSessions, hasEnv, hasChromiumCache].filter(Boolean).length;
  if (markerCount < 2) return null;
  return { rootPath, hasApp, hasSessions, hasEnv, hasChromiumCache };
}

export interface ImportProgress {
  task: string;
  percent: number;
}

export async function copyLegacyData(
  legacy: LegacyInstall,
  userDataDir: string,
  onProgress: (p: ImportProgress) => void,
): Promise<void> {
  const tasks: Array<{ src: string; dst: string; label: string }> = [];
  if (legacy.hasSessions) {
    tasks.push({ src: path.join(legacy.rootPath, 'sessions'), dst: path.join(userDataDir, 'sessions'), label: 'sessions' });
  }
  if (legacy.hasEnv) {
    tasks.push({ src: path.join(legacy.rootPath, 'config'), dst: path.join(userDataDir, 'config'), label: 'config' });
  }
  if (legacy.hasChromiumCache) {
    tasks.push({ src: path.join(legacy.rootPath, 'chromium-cache'), dst: path.join(userDataDir, 'chromium-cache'), label: 'chromium-cache (~200 MB)' });
  }
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    onProgress({ task: `Copying ${t.label}…`, percent: Math.floor((i / tasks.length) * 100) });
    await fsp.cp(t.src, t.dst, { recursive: true, force: false, errorOnExist: false });
  }
  onProgress({ task: 'Done', percent: 100 });
}

export async function runImportedHealthcheck(userDataDir: string, healthcheckPath: string, execPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(execPath, [healthcheckPath], {
      env: { ...process.env, ERP_ROOT: userDataDir, HEADED: 'false' },
      stdio: 'ignore',
      windowsHide: true,
    });
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 60_000);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
}
