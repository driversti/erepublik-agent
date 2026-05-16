import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Root directory anchor for on-disk state. Defaults to process.cwd() so the
 * developer workflow keeps using paths relative to the repo root. The Windows
 * .bat files set ERP_ROOT to the ZIP install folder so the agent finds
 * sessions/, config/, logs/, and data/ there.
 */
function root(): string {
  return resolve(process.env.ERP_ROOT ?? process.cwd());
}

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionsDir(): string {
  return ensure(resolve(root(), 'sessions'));
}

export function configDir(): string {
  return ensure(resolve(root(), 'config'));
}

export function logsDir(): string {
  return ensure(resolve(root(), 'logs'));
}

export function dataDir(): string {
  // No ensure() — data/ is read-only and shipped in the artifact.
  return resolve(root(), 'data');
}

export function profileDir(accountSlug: string): string {
  return ensure(resolve(sessionsDir(), 'profile', accountSlug));
}
