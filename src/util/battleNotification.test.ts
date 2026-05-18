import { describe, expect, it } from 'vitest';
import {
  formatBattleFailureMessage,
  formatBattleSuccessMessage,
} from './battleNotification.js';

const sample = {
  battleId: 12345,
  battleZoneId: 9876,
  regionName: 'Donbass',
  invaderCountryId: 40, // UA
  defenderCountryId: 41, // RU
  division: 3,
};

describe('formatBattleSuccessMessage', () => {
  it('renders battle id, deep-link with battleZoneId, both flags, division', () => {
    expect(formatBattleSuccessMessage(sample)).toBe(
      '💥 [#12345 Donbass](https://www.erepublik.com/en/military/battlefield/12345/9876) — 🇺🇦 vs 🇷🇺 · D3',
    );
  });

  it('strips parens / brackets in region names to keep the link parseable', () => {
    const msg = formatBattleSuccessMessage({ ...sample, regionName: 'Northern Region (East)' });
    expect(msg).toContain('[#12345 Northern Region East](https://www.erepublik.com/en/military/battlefield/12345/9876)');
  });

  it('falls back to white flag for unknown country IDs', () => {
    const msg = formatBattleSuccessMessage({ ...sample, invaderCountryId: 99999 });
    expect(msg).toContain('🏳️ vs 🇷🇺');
  });
});

describe('formatBattleFailureMessage', () => {
  it('includes the same header plus the reason on a new line', () => {
    const msg = formatBattleFailureMessage(sample, 'travel-b: blocked by sanctions');
    expect(msg.startsWith('⚠️ ')).toBe(true);
    expect(msg).toContain('[#12345 Donbass]');
    expect(msg).toContain('🇺🇦 vs 🇷🇺');
    expect(msg).toContain('\nFailed: travel-b: blocked by sanctions');
  });

  it('truncates very long reason strings', () => {
    const long = 'x'.repeat(500);
    const msg = formatBattleFailureMessage(sample, long);
    expect(msg).toContain('xxxxxxxxxx…');
    expect(msg.length).toBeLessThan(500);
  });
});
