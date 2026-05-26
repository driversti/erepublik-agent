import { describe, it, expect } from 'vitest';
import { formatBatchDigest, type CycleEvent } from './cycleEvents.js';

const day = 6761;

describe('formatBatchDigest', () => {
  it('returns null when there are no events', () => {
    expect(formatBatchDigest([], { day })).toBeNull();
  });

  it('renders a header with the eRepublik day', () => {
    const out = formatBatchDigest([{ kind: 'work' }], { day });
    expect(out).not.toBeNull();
    expect(out).toMatch(/^\*day 6761\*/);
  });

  it('renders core action lines in fixed order regardless of input order', () => {
    const events: CycleEvent[] = [
      { kind: 'vipClaim' },
      { kind: 'buyFood', price: 3.5 },
      { kind: 'train', count: 3 },
      { kind: 'work' },
    ];
    const out = formatBatchDigest(events, { day })!;
    const lines = out.split('\n');
    // Line 0 is header — drop it.
    expect(lines[1]).toContain('Worked');
    expect(lines[2]).toContain('Trained 3 grounds');
    expect(lines[3]).toContain('VIP claimed');
    expect(lines[4]).toContain('Bought Q1 food');
  });

  it('singularises train count when only one ground was trained', () => {
    const out = formatBatchDigest([{ kind: 'train', count: 1 }], { day })!;
    expect(out).toContain('Trained 1 ground');
    expect(out).not.toContain('1 grounds');
  });

  it('renders overtime with net salary when available', () => {
    const out = formatBatchDigest(
      [{ kind: 'overtime', netSalary: 12.34, currency: 'PLN' }],
      { day },
    )!;
    // `+` is MarkdownV2-reserved, so it lands in the digest as `\+`.
    expect(out).toContain('OT: \\+12\\.34 PLN');
  });

  it('falls back to bare success when overtime salary is missing', () => {
    const out = formatBatchDigest(
      [{ kind: 'overtime', netSalary: null, currency: null }],
      { day },
    )!;
    expect(out).toContain('OT claimed');
    expect(out).not.toContain('+');
  });

  it('renders gold purchase amount', () => {
    const out = formatBatchDigest([{ kind: 'buyGold', amount: 10 }], { day })!;
    expect(out).toContain('Bought 10 gold');
  });

  it('groups multiple missions into a single comma-separated line with titles', () => {
    const events: CycleEvent[] = [
      { kind: 'mission', id: 100001, title: 'Work in your job' },
      { kind: 'mission', id: 100003, title: 'Train' },
      { kind: 'mission', id: 100011, title: 'Buy Food' },
    ];
    const out = formatBatchDigest(events, { day })!;
    const missionLines = out.split('\n').filter((l) => l.includes('Missions:'));
    expect(missionLines).toHaveLength(1);
    expect(missionLines[0]).toContain('Work in your job');
    expect(missionLines[0]).toContain('Train');
    expect(missionLines[0]).toContain('Buy Food');
    // Comma-separated — verify a comma sits between two titles.
    expect(missionLines[0]).toMatch(/Work in your job,.*Train/);
  });

  it('falls back to mission-{id} when title is empty', () => {
    const out = formatBatchDigest(
      [{ kind: 'mission', id: 99999, title: '' }],
      { day },
    )!;
    // `-` is escaped under MarkdownV2 → `\-`.
    expect(out).toContain('mission\\-99999');
  });

  it('groups multiple Daily Order chests into one line with energy labels', () => {
    const events: CycleEvent[] = [
      { kind: 'chest', threshold: 20 },
      { kind: 'chest', threshold: 40 },
    ];
    const out = formatBatchDigest(events, { day })!;
    const chestLines = out.split('\n').filter((l) => l.includes('Daily Order'));
    expect(chestLines).toHaveLength(1);
    expect(chestLines[0]).toContain('20💪');
    expect(chestLines[0]).toContain('40💪');
  });

  it('surfaces the highest claimed weekly tier when multiple tiers crossed', () => {
    const events: CycleEvent[] = [
      { kind: 'weeklyChallenge', tier: 5 },
      { kind: 'weeklyChallenge', tier: 7 },
      { kind: 'weeklyChallenge', tier: 6 },
    ];
    const out = formatBatchDigest(events, { day })!;
    expect(out).toContain('tier 7');
    expect(out).not.toContain('tier 5');
    expect(out).not.toContain('tier 6');
  });

  it('appends the optional fuel pacing line when supplied', () => {
    const out = formatBatchDigest(
      [{ kind: 'work' }],
      { day, fuel: { week: 965, spent: 7, budget: 70, hits: 6 } },
    )!;
    expect(out).toContain('Fuel week 965');
    expect(out).toContain('7/70');
    expect(out).toContain('hits 6');
  });

  it('omits the fuel line when not supplied', () => {
    const out = formatBatchDigest([{ kind: 'work' }], { day })!;
    expect(out).not.toContain('Fuel');
  });

  it('escapes MarkdownV2-reserved characters inside titles and currency', () => {
    const out = formatBatchDigest(
      [
        { kind: 'employed', employerName: 'Foo.Bar-Co', netSalary: 9.5, currency: 'PLN' },
        { kind: 'mission', id: 1, title: 'Buy Food (Q1)' },
      ],
      { day },
    )!;
    // `.`, `-`, `(`, `)` must be backslash-escaped per MarkdownV2 rules so
    // Telegram's parser doesn't reject the whole message.
    expect(out).toContain('Foo\\.Bar\\-Co');
    expect(out).toContain('Buy Food \\(Q1\\)');
  });

  it('combines a realistic mid-day cycle into one cohesive message', () => {
    const events: CycleEvent[] = [
      { kind: 'work' },
      { kind: 'train', count: 3 },
      { kind: 'vipClaim' },
      { kind: 'buyFood', price: 3.5 },
      { kind: 'buyGold', amount: 10 },
      { kind: 'mission', id: 100001, title: 'Work' },
      { kind: 'mission', id: 100003, title: 'Train' },
      { kind: 'chest', threshold: 20 },
      { kind: 'chest', threshold: 40 },
      { kind: 'weeklyChallenge', tier: 7 },
    ];
    const out = formatBatchDigest(events, {
      day,
      fuel: { week: 965, spent: 7, budget: 70, hits: 6 },
    })!;
    const lines = out.split('\n');
    // header + 5 action lines + missions + chests + weekly + fuel = 10
    expect(lines).toHaveLength(10);
  });
});
