import { describe, expect, it } from 'vitest';
import { flagFor, isoCodeFor } from './countryFlag.js';

describe('flagFor', () => {
  it('returns the regional-indicator flag emoji for known country IDs', () => {
    expect(flagFor(40)).toBe('🇺🇦'); // Ukraine
    expect(flagFor(41)).toBe('🇷🇺'); // Russia
    expect(flagFor(35)).toBe('🇵🇱'); // Poland
    expect(flagFor(24)).toBe('🇺🇸'); // USA
  });

  it('falls back to the white flag for unknown IDs', () => {
    expect(flagFor(99999)).toBe('🏳️');
  });

  it('handles high-number IDs (post-2020 country additions)', () => {
    expect(flagFor(170)).toBe('🇳🇬'); // Nigeria
  });
});

describe('isoCodeFor', () => {
  it('returns the ISO-2 code for known IDs and undefined otherwise', () => {
    expect(isoCodeFor(40)).toBe('UA');
    expect(isoCodeFor(0)).toBeUndefined();
  });
});
