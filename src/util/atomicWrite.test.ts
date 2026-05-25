import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteFileSync, quarantineCorruptedFile } from './atomicWrite.js';

describe('atomicWriteFileSync', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'erp-atomic-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the content to the target path', () => {
    const target = join(dir, 'state.json');
    atomicWriteFileSync(target, '{"ok":1}');
    expect(readFileSync(target, 'utf8')).toBe('{"ok":1}');
  });

  it('does not leave behind the tmp file on success', () => {
    const target = join(dir, 'state.json');
    atomicWriteFileSync(target, '{"ok":1}');
    expect(existsSync(target + '.tmp')).toBe(false);
  });

  it('overwrites an existing file', () => {
    const target = join(dir, 'state.json');
    writeFileSync(target, '{"old":true}');
    atomicWriteFileSync(target, '{"new":true}');
    expect(readFileSync(target, 'utf8')).toBe('{"new":true}');
  });
});

describe('quarantineCorruptedFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'erp-quarantine-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('renames the target out of the way with a corrupted-<ts> suffix and preserves contents', () => {
    const target = join(dir, 'state.json');
    writeFileSync(target, '\0\0\0');
    const fixed = new Date('2026-05-25T19:00:00.000Z');
    const quarantined = quarantineCorruptedFile(target, fixed);

    expect(quarantined).toBe(target + '.corrupted-2026-05-25T19-00-00-000Z');
    expect(existsSync(target)).toBe(false);
    expect(existsSync(quarantined!)).toBe(true);
    expect(readFileSync(quarantined!, 'utf8')).toBe('\0\0\0');
  });

  it('returns null when the source does not exist', () => {
    const target = join(dir, 'missing.json');
    const result = quarantineCorruptedFile(target);
    expect(result).toBeNull();
    // No quarantine artifacts left in the dir.
    expect(readdirSync(dir)).toEqual([]);
  });
});
