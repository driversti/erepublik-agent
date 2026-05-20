import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logsDir } from '../paths.js';
import { readTailBytes } from './readTail.js';

/** Path to today's log file (matches the rotation scheme in runner.ts). */
function todayLogPath(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  return join(logsDir(), `agent-${stamp}.log`);
}

const MAX_TAIL_BYTES = 256 * 1024;

/**
 * Read the last `lines` lines of today's log file. Returns an empty array if
 * the file doesn't exist (file logging is off). Caps the read at 256 KB tail
 * via a positioned read so a 100 MB+ log doesn't blow the response.
 *
 * The 256 KB cap is applied at the *disk read* layer (see `readTailBytes`),
 * not after slurping the file into memory.
 */
export function tailLog(lines: number): string[] {
  const path = todayLogPath();
  if (!existsSync(path)) return [];
  const stats = statSync(path);
  const slicedMidFile = stats.size > MAX_TAIL_BYTES;
  // Slice as bytes BEFORE decoding — `stats.size` is bytes but a decoded UTF-8
  // string indexes in UTF-16 code units. Emoji in our logs (✅ ⏳ 🏠 ❌) would
  // misalign the slice and chop mid-codepoint if we sliced after decoding.
  const tail = readTailBytes(path, MAX_TAIL_BYTES);
  const all = tail.toString('utf8').split('\n');
  // Drop the (likely truncated) first line if we sliced mid-file.
  const safe = slicedMidFile ? all.slice(1) : all;
  return safe.slice(-lines);
}
