const LA_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const EPOCH_UTC_MS = Date.UTC(2007, 10, 21); // Nov 21, 2007

export function eRepublikDay(now: Date = new Date()): number {
  const parts = LA_DATE_FMT.format(now).split('-').map(Number);
  const [y, m, d] = parts as [number, number, number];
  const laDateUtcMs = Date.UTC(y, m - 1, d);
  return Math.floor((laDateUtcMs - EPOCH_UTC_MS) / 86_400_000);
}
