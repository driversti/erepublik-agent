import { appendFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sessionsDir } from '../paths.js';
import { readTailBytes } from './readTail.js';

export type HistoryEvent =
  | { type: 'cycle'; reason: string; at?: string }
  | { type: 'battle'; battleId: number; regionName: string; mode: string; at?: string }
  | { type: 'mode'; from: string; to: string; at?: string }
  | { type: 'pause'; paused: boolean; at?: string }
  | { type: 'error'; message: string; at?: string };

function filePath(): string {
  return join(sessionsDir(), 'history.jsonl');
}

export function appendHistory(event: HistoryEvent): void {
  const stamped: HistoryEvent = { ...event, at: event.at ?? new Date().toISOString() };
  appendFileSync(filePath(), JSON.stringify(stamped) + '\n', 'utf8');
}

const MAX_TAIL_BYTES = 256 * 1024;

export function tailHistory(n: number): HistoryEvent[] {
  const path = filePath();
  if (!existsSync(path)) return [];
  const stats = statSync(path);
  const slicedMidFile = stats.size > MAX_TAIL_BYTES;
  // Byte-slice before decoding for emoji-safety (same lesson as logsTail).
  // Uses a positioned read so a multi-GB history doesn't slurp into memory.
  const tail = readTailBytes(path, MAX_TAIL_BYTES);
  const lines = tail.toString('utf8').split('\n');
  const safe = slicedMidFile ? lines.slice(1) : lines; // drop possibly truncated first line
  const parsed: HistoryEvent[] = [];
  for (const line of safe) {
    if (line.trim() === '') continue;
    try {
      parsed.push(JSON.parse(line) as HistoryEvent);
    } catch {
      /* skip malformed line */
    }
  }
  return parsed.slice(-n);
}
