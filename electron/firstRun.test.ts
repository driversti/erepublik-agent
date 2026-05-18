import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkFirstRun } from './firstRun.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'firstrun-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('checkFirstRun', () => {
  it('returns no-settings when config/settings.json is absent', () => {
    expect(checkFirstRun(tmp)).toEqual({ needsWizard: true, reason: 'no-settings' });
  });

  it('returns no-profile when settings exists but profile dir is missing', () => {
    mkdirSync(join(tmp, 'config'));
    writeFileSync(join(tmp, 'config', 'settings.json'), '{}');
    expect(checkFirstRun(tmp)).toEqual({ needsWizard: true, reason: 'no-profile' });
  });

  it('returns no-profile when profile dir is empty', () => {
    mkdirSync(join(tmp, 'config'));
    writeFileSync(join(tmp, 'config', 'settings.json'), '{}');
    mkdirSync(join(tmp, 'sessions', 'profile'), { recursive: true });
    expect(checkFirstRun(tmp)).toEqual({ needsWizard: true, reason: 'no-profile' });
  });

  it('returns ok when settings and at least one profile exist', () => {
    mkdirSync(join(tmp, 'config'));
    writeFileSync(join(tmp, 'config', 'settings.json'), '{}');
    mkdirSync(join(tmp, 'sessions', 'profile', 'main'), { recursive: true });
    expect(checkFirstRun(tmp)).toEqual({ needsWizard: false, reason: 'ok' });
  });
});
