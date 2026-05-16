import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logsDir } from '../paths.js';

/** Path to today's log file (matches the rotation scheme in runner.ts). */
function todayLogPath(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  return join(logsDir(), `agent-${stamp}.log`);
}

/**
 * Read the last `lines` lines of today's log file. Returns an empty array if
 * the file doesn't exist (file logging is off). Caps the read at 256 KB tail
 * so a 100 MB log doesn't blow the response.
 */
export function tailLog(lines: number): string[] {
  const path = todayLogPath();
  if (!existsSync(path)) return [];
  const stats = statSync(path);
  const maxBytes = 256 * 1024;
  const start = Math.max(0, stats.size - maxBytes);
  // Slice as bytes BEFORE decoding — `stats.size` is bytes but a decoded UTF-8
  // string indexes in UTF-16 code units. Emoji in our logs (✅ ⏳ 🏠 ❌) would
  // misalign the slice and chop mid-codepoint if we sliced after decoding.
  const raw = readFileSync(path);
  const tail = start === 0 ? raw : raw.subarray(start);
  const all = tail.toString('utf8').split('\n');
  // Drop the (likely truncated) first line if we sliced mid-file.
  const safe = start === 0 ? all : all.slice(1);
  return safe.slice(-lines);
}
