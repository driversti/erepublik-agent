import { eRepublikDay } from './day.js';

// eRepublikDay 0 = Nov 21, 2007 (Wednesday). Mod 7: Wed=0, Thu=1, Fri=2, Sat=3,
// Sun=4, Mon=5, Tue=6. So a week anchored on Tuesday starts at offset 6.
const TUESDAY_OFFSET_FROM_EPOCH = 6;

/** Tuesday-anchored week number (America/Los_Angeles). Week 0 = Tue Nov 27, 2007. */
export function eRepublikWeek(now: Date = new Date()): number {
  return Math.floor((eRepublikDay(now) - TUESDAY_OFFSET_FROM_EPOCH) / 7);
}

/** eRepublikDay of the Tuesday that begins the week containing `now`. */
export function eRepublikWeekStartDay(now: Date = new Date()): number {
  return eRepublikWeek(now) * 7 + TUESDAY_OFFSET_FROM_EPOCH;
}

/**
 * Fraction of the current week elapsed (0..1), measured in LA-local time.
 * 0.0 = Tue 00:00 PST, 0.5 = Fri 12:00 PST, ~1.0 = next Tue 00:00 PST.
 * Used for pacing the 70 barrels/week fuel budget.
 */
export function weekElapsedFraction(now: Date = new Date()): number {
  const daysIntoWeek = eRepublikDay(now) - eRepublikWeekStartDay(now); // 0..6
  return (daysIntoWeek + laDayFraction(now)) / 7;
}

function laDayFraction(now: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Los_Angeles',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const h = Number(parts.hour);
  const m = Number(parts.minute);
  const s = Number(parts.second);
  return (h * 3600 + m * 60 + s) / 86_400;
}

/** Returns the LA-local hour (0..23) for `now`. */
export function laHour(now: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Los_Angeles',
      hour: '2-digit',
      hour12: false,
    }).format(now),
  );
}
