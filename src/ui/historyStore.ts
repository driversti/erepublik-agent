import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sessionsDir } from '../paths.js';

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
  const start = Math.max(0, stats.size - MAX_TAIL_BYTES);
  // Byte-slice before decoding for emoji-safety (same lesson as logsTail).
  const raw = readFileSync(path);
  const tail = start === 0 ? raw : raw.subarray(start);
  const lines = tail.toString('utf8').split('\n');
  const safe = start === 0 ? lines : lines.slice(1); // drop possibly truncated first line
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
