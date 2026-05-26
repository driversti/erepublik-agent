import { escapeMdV2 } from '../telegram/mdV2.js';

/**
 * Discrete things that happened during a single `runCycle` invocation.
 * The runner accumulates these and `formatBatchDigest` renders the whole
 * cycle into a single MarkdownV2-escaped Telegram message at the end.
 *
 * Each event must carry only data the agent already gathered for free —
 * no extra API calls just to enrich a notification. See
 * [[feedback_telegram_batch_digest]].
 */
export type CycleEvent =
  | { kind: 'work' }
  | { kind: 'train'; count: number }
  | { kind: 'overtime'; netSalary: number | null; currency: string | null }
  | { kind: 'vipClaim' }
  | { kind: 'buyFood'; price: number }
  | { kind: 'buyGold'; amount: number }
  | {
      kind: 'employed';
      employerName: string;
      netSalary: number | null;
      currency: string | null;
    }
  | {
      kind: 'jobUpgrade';
      fromNet: number | null;
      toNet: number;
      currency: string;
      employerName: string;
    }
  | { kind: 'mission'; id: number; title: string }
  | { kind: 'chest'; threshold: number }
  | { kind: 'weeklyChallenge'; tier: number };

export interface BatchDigestOpts {
  /** eRepublik day number, e.g. 6761. */
  day: number;
  /** Optional weekly fuel summary line — omitted when undefined. */
  fuel?: {
    week: number;
    spent: number;
    budget: number;
    hits: number;
  };
}

// Stable ordering for action-like events so the digest reads top→bottom in the
// same shape every time. Missions/chests/weekly are appended after action lines
// in their own grouped sections.
const ACTION_ORDER: ReadonlyArray<CycleEvent['kind']> = [
  'work',
  'train',
  'overtime',
  'vipClaim',
  'buyFood',
  'buyGold',
  'employed',
  'jobUpgrade',
];

function renderActionLine(e: CycleEvent): string | null {
  switch (e.kind) {
    case 'work':
      return '✅ Worked';
    case 'train':
      return `✅ Trained ${e.count} ground${e.count === 1 ? '' : 's'}`;
    case 'overtime':
      return e.netSalary != null && e.currency != null
        ? `💼 OT: +${e.netSalary} ${e.currency}`
        : '💼 OT claimed';
    case 'vipClaim':
      return '🎟️ VIP claimed';
    case 'buyFood':
      return `🍞 Bought Q1 food — ${e.price} CC`;
    case 'buyGold':
      return `🥇 Bought ${e.amount} gold`;
    case 'employed':
      return e.netSalary != null && e.currency != null
        ? `💼 Hired by ${e.employerName} — ${e.netSalary} ${e.currency}`
        : `💼 Hired by ${e.employerName}`;
    case 'jobUpgrade': {
      const from = e.fromNet ?? '?';
      return `📈 Job upgrade: ${from} → ${e.toNet} ${e.currency} (${e.employerName})`;
    }
    default:
      return null;
  }
}

/**
 * Render the cycle's events as a single Telegram message. Returns `null`
 * when there is nothing to announce — caller should skip the `send` call in
 * that case so empty cycles stay silent.
 *
 * The returned string is MarkdownV2-escaped end-to-end; callers must not
 * wrap or further escape it.
 */
export function formatBatchDigest(events: CycleEvent[], opts: BatchDigestOpts): string | null {
  if (events.length === 0) return null;

  const lines: string[] = [];

  // Header — eRepublik day. Account tag is prepended by TelegramNotifier.
  lines.push(`*day ${opts.day}*`);

  // Action lines in fixed order. Within a kind we render every occurrence
  // (overtime should never have more than one per cycle, but we don't enforce).
  for (const kind of ACTION_ORDER) {
    for (const e of events) {
      if (e.kind !== kind) continue;
      const line = renderActionLine(e);
      if (line != null) lines.push(escapeMdV2(line));
    }
  }

  // Missions — group into a single comma-separated line with human titles.
  const missions = events.filter((e): e is Extract<CycleEvent, { kind: 'mission' }> => e.kind === 'mission');
  if (missions.length > 0) {
    const titles = missions.map((m) => m.title || `mission-${m.id}`).join(', ');
    lines.push(escapeMdV2(`🎁 Missions: ${titles}`));
  }

  // Daily Order chest thresholds — same compact grouping.
  const chests = events.filter((e): e is Extract<CycleEvent, { kind: 'chest' }> => e.kind === 'chest');
  if (chests.length > 0) {
    const labels = chests.map((c) => `${c.threshold}💪`).join(', ');
    lines.push(escapeMdV2(`📦 Daily Order chests: ${labels}`));
  }

  // Weekly Challenge — surface the latest tier number even if multiple
  // tiers crossed in one cycle (eRepublik claims them in a single POST).
  const weeklies = events.filter(
    (e): e is Extract<CycleEvent, { kind: 'weeklyChallenge' }> => e.kind === 'weeklyChallenge',
  );
  if (weeklies.length > 0) {
    const maxTier = weeklies.reduce((m, e) => Math.max(m, e.tier), 0);
    lines.push(escapeMdV2(`🏆 Weekly Challenge: tier ${maxTier}`));
  }

  // Optional weekly fuel pacing line. Read-only context; not an "event"
  // itself, so it stays out of the `events` array.
  if (opts.fuel) {
    const { week, spent, budget, hits } = opts.fuel;
    lines.push(escapeMdV2(`🔥 Fuel week ${week}: ${spent}/${budget} (hits ${hits})`));
  }

  return lines.join('\n');
}
