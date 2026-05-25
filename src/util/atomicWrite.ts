import { writeFileSync, renameSync } from 'node:fs';

/**
 * Write a file atomically: serialize to `${target}.tmp` then rename over the
 * target. Rename is atomic on POSIX and Windows NTFS, so a concurrent reader —
 * and, more importantly, a process killed mid-write (power loss, hard reboot,
 * Force Quit) — either sees the previous file intact or the new one. It never
 * observes a truncated/zero-filled file.
 *
 * Plain `writeFileSync(target, …)` truncates `target` to 0 before writing the
 * new payload; if the OS journals the metadata (size, mtime) before flushing
 * the data and the machine then crashes, the file ends up empty or filled
 * with NUL bytes. Loading code that does `JSON.parse(readFileSync(…))` then
 * throws `Unexpected token …`. Use this helper for any JSON state file the
 * agent reads back on startup or every cycle.
 */
export function atomicWriteFileSync(target: string, contents: string): void {
  const tmp = target + '.tmp';
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, target);
}

/**
 * Move a corrupted file aside so the agent can boot from a fresh state without
 * losing forensic evidence. Returns the path the file was renamed to, or
 * `null` if the rename itself failed (the caller should still proceed with
 * empty state — we never block recovery on a best-effort archive).
 */
export function quarantineCorruptedFile(target: string, now: Date = new Date()): string | null {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const quarantined = `${target}.corrupted-${stamp}`;
  try {
    renameSync(target, quarantined);
    return quarantined;
  } catch {
    return null;
  }
}
