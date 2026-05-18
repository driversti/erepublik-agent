import { describe, it, expect } from 'vitest';
import { suggestCountries, parseChips } from './countryPicker.js';

const catalog = [
  { id: 1, name: 'Romania' },
  { id: 35, name: 'Poland' },
  { id: 27, name: 'Argentina' },
  { id: 9, name: 'Brazil' },
];

describe('suggestCountries', () => {
  it('returns prefix matches case-insensitively', () => {
    const out = suggestCountries('pol', catalog);
    expect(out).toEqual([{ id: 35, name: 'Poland' }]);
  });

  it('returns substring matches when no prefix match', () => {
    const out = suggestCountries('ent', catalog);
    expect(out).toEqual([{ id: 27, name: 'Argentina' }]);
  });

  it('returns empty for whitespace input', () => {
    expect(suggestCountries('   ', catalog)).toEqual([]);
  });

  it('limits to 8 results', () => {
    const big = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Country${i}` }));
    expect(suggestCountries('Country', big).length).toBe(8);
  });
});

describe('parseChips', () => {
  it('returns no chips for empty string', () => {
    expect(parseChips('', catalog)).toEqual({ chips: [], unknown: [] });
  });

  it('parses comma-separated names', () => {
    const out = parseChips('Poland, Romania', catalog);
    expect(out.chips).toEqual([
      { id: 35, name: 'Poland' },
      { id: 1, name: 'Romania' },
    ]);
    expect(out.unknown).toEqual([]);
  });

  it('reports unknown tokens', () => {
    const out = parseChips('Poland, Atlantis', catalog);
    expect(out.chips).toEqual([{ id: 35, name: 'Poland' }]);
    expect(out.unknown).toEqual(['Atlantis']);
  });

  it('accepts numeric IDs', () => {
    const out = parseChips('35, 1', catalog);
    expect(out.chips).toEqual([
      { id: 35, name: 'Poland' },
      { id: 1, name: 'Romania' },
    ]);
  });
});
