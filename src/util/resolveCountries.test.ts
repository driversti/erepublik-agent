import { describe, it, expect } from 'vitest';
import { resolveCountries, type Country } from './resolveCountries.js';

const catalog: Country[] = [
  { id: 1, name: 'Romania' },
  { id: 27, name: 'Argentina' },
  { id: 35, name: 'Poland' },
  { id: 24, name: 'USA' },
  { id: 29, name: 'United Kingdom' },
];

describe('resolveCountries', () => {
  it('returns empty result for blank input', () => {
    const r = resolveCountries('', catalog);
    expect(r.ids).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it('returns empty result for whitespace-only input', () => {
    const r = resolveCountries('   ', catalog);
    expect(r.ids).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it('resolves a single numeric ID present in the catalog', () => {
    const r = resolveCountries('27', catalog);
    expect(r.ids).toEqual([27]);
    expect(r.unknown).toEqual([]);
  });

  it('rejects a numeric ID not in the catalog', () => {
    const r = resolveCountries('999', catalog);
    expect(r.ids).toEqual([]);
    expect(r.unknown).toEqual(['999']);
  });

  it('resolves a name match case-insensitively', () => {
    const r = resolveCountries('poland', catalog);
    expect(r.ids).toEqual([35]);
    expect(r.unknown).toEqual([]);
  });

  it('resolves multi-word names', () => {
    const r = resolveCountries('United Kingdom', catalog);
    expect(r.ids).toEqual([29]);
  });

  it('handles a mix of names and IDs', () => {
    const r = resolveCountries('Poland, 27, USA', catalog);
    expect(r.ids).toEqual([35, 27, 24]);
  });

  it('trims whitespace around tokens', () => {
    const r = resolveCountries('  Poland  ,  27  ', catalog);
    expect(r.ids).toEqual([35, 27]);
  });

  it('dedupes the resolved list', () => {
    const r = resolveCountries('Poland, 35, poland', catalog);
    expect(r.ids).toEqual([35]);
  });

  it('reports unknown tokens with a suggestion when close', () => {
    const r = resolveCountries('Polnd', catalog);
    expect(r.ids).toEqual([]);
    expect(r.unknown).toEqual(['Polnd']);
    expect(r.suggestions['Polnd']).toBe('Poland');
  });

  it('reports unknown tokens without a suggestion when nothing is close', () => {
    const r = resolveCountries('zzzzz', catalog);
    expect(r.ids).toEqual([]);
    expect(r.unknown).toEqual(['zzzzz']);
    expect(r.suggestions['zzzzz']).toBeUndefined();
  });

  it('returns partial results when some tokens are unknown', () => {
    const r = resolveCountries('Poland, FakeCountry, 27', catalog);
    expect(r.ids).toEqual([35, 27]);
    expect(r.unknown).toEqual(['FakeCountry']);
  });
});
