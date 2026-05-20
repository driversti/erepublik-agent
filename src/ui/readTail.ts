import { closeSync, openSync, readSync, statSync } from 'node:fs';

/**
 * Read at most the trailing `maxBytes` of a file without slurping the whole
 * thing into memory. Uses a positioned `readSync` against an open file
 * descriptor — for a 1 GB log this allocates a 256 KB buffer instead of 1 GB.
 *
 * Why this exists: the dashboard polls `tailLog` / `tailHistory` on every
 * snapshot refresh. With `readFileSync` the cost scaled with the entire
 * append-only file, which would crash the runner (OOM) and stall the event
 * loop on disk-bound reads as the log/history grew over weeks of uptime.
 *
 * Returns a `Buffer` (not a string) so callers can byte-slice safely before
 * UTF-8 decoding — emoji in our logs occupy multiple bytes and slicing the
 * decoded string would chop mid-codepoint.
 */
export function readTailBytes(path: string, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  const stats = statSync(path);
  if (stats.size === 0) return Buffer.alloc(0);

  const toRead = Math.min(maxBytes, stats.size);
  const start = stats.size - toRead;
  const buf = Buffer.alloc(toRead);

  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < toRead) {
      const n = readSync(fd, buf, read, toRead - read, start + read);
      if (n === 0) break; // EOF — file truncated under us; return what we have
      read += n;
    }
    return read < toRead ? buf.subarray(0, read) : buf;
  } finally {
    closeSync(fd);
  }
}
