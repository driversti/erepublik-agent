import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface FirstRunStatus {
  needsWizard: boolean;
  reason: 'no-settings' | 'no-profile' | 'ok';
}

export function checkFirstRun(userDataDir: string): FirstRunStatus {
  const settingsPath = path.join(userDataDir, 'config', 'settings.json');
  if (!existsSync(settingsPath)) {
    return { needsWizard: true, reason: 'no-settings' };
  }
  const profilesRoot = path.join(userDataDir, 'sessions', 'profile');
  if (!existsSync(profilesRoot) || readdirSync(profilesRoot).length === 0) {
    return { needsWizard: true, reason: 'no-profile' };
  }
  return { needsWizard: false, reason: 'ok' };
}
