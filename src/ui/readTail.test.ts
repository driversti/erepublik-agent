import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readTailBytes } from './readTail.js';

describe('readTailBytes', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'erp-tail-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reads the whole file when smaller than maxBytes', () => {
    const path = join(tmpRoot, 'small.txt');
    writeFileSync(path, 'hello world');
    const buf = readTailBytes(path, 1024);
    expect(buf.toString('utf8')).toBe('hello world');
  });

  it('reads only the trailing maxBytes when file is larger', () => {
    const path = join(tmpRoot, 'big.txt');
    // Build a 1 MB file with predictable suffix
    const filler = Buffer.alloc(1024 * 1024 - 11, 0x61); // ascii 'a' repeated
    const tail = Buffer.from('hello world');
    writeFileSync(path, Buffer.concat([filler, tail]));

    const buf = readTailBytes(path, 256 * 1024);
    expect(buf.length).toBe(256 * 1024);
    // Last 11 bytes should be "hello world"
    expect(buf.subarray(buf.length - 11).toString('utf8')).toBe('hello world');
    // The first byte should still be filler ('a'), not anything beyond
    expect(buf[0]).toBe(0x61);
  });

  it('returns empty buffer when maxBytes is 0', () => {
    const path = join(tmpRoot, 'x.txt');
    writeFileSync(path, 'anything');
    const buf = readTailBytes(path, 0);
    expect(buf.length).toBe(0);
  });

  it('handles empty files', () => {
    const path = join(tmpRoot, 'empty.txt');
    writeFileSync(path, '');
    const buf = readTailBytes(path, 1024);
    expect(buf.length).toBe(0);
  });

  it('returns a Buffer (not a string) so callers can byte-slice for UTF-8 safety', () => {
    const path = join(tmpRoot, 'utf8.txt');
    writeFileSync(path, '✅ done\n');
    const buf = readTailBytes(path, 1024);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString('utf8')).toBe('✅ done\n');
  });
});
