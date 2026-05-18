import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectLegacyInstall } from './importLegacy.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-test-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('detectLegacyInstall', () => {
  it('returns null for an empty directory', () => {
    expect(detectLegacyInstall(tmp)).toBeNull();
  });

  it('detects a directory with app/ + sessions/ + config/.env', () => {
    fs.mkdirSync(path.join(tmp, 'app'));
    fs.mkdirSync(path.join(tmp, 'sessions'));
    fs.mkdirSync(path.join(tmp, 'config'));
    fs.writeFileSync(path.join(tmp, 'config', '.env'), 'X=1');
    const out = detectLegacyInstall(tmp);
    expect(out).not.toBeNull();
    expect(out?.hasSessions).toBe(true);
    expect(out?.hasEnv).toBe(true);
    expect(out?.hasChromiumCache).toBe(false);
  });

  it('detects chromium-cache when present', () => {
    fs.mkdirSync(path.join(tmp, 'app'));
    fs.mkdirSync(path.join(tmp, 'sessions'));
    fs.mkdirSync(path.join(tmp, 'chromium-cache'));
    fs.writeFileSync(path.join(tmp, 'chromium-cache', 'placeholder'), '');
    const out = detectLegacyInstall(tmp);
    expect(out?.hasChromiumCache).toBe(true);
  });

  it('returns null when fewer than 2 marker dirs present', () => {
    fs.mkdirSync(path.join(tmp, 'app'));
    expect(detectLegacyInstall(tmp)).toBeNull();
  });
});
