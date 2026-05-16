import { describe, expect, it } from 'vitest';
import { autoMode, effectiveMode } from './modeSelector.js';

describe('autoMode', () => {
  it('returns standard for div 1-3', () => {
    for (const d of [1, 2, 3]) expect(autoMode(d, false)).toBe('standard');
    for (const d of [1, 2, 3]) expect(autoMode(d, true)).toBe('standard');
  });
  it('returns d4tw for div 4 without Maverick', () => {
    expect(autoMode(4, false)).toBe('d4tw');
  });
  it('returns maverickD3 for div 4 with Maverick', () => {
    expect(autoMode(4, true)).toBe('maverickD3');
  });
  it('falls back to standard for unknown divisions (e.g. D11)', () => {
    expect(autoMode(11, false)).toBe('standard');
  });
  it('returns standard when division is null (pre-detection)', () => {
    expect(autoMode(null, false)).toBe('standard');
  });
});

describe('effectiveMode', () => {
  const settingsDefault = { modeOverride: null, maverickManual: null };
  it('uses autoMode when no override', () => {
    expect(effectiveMode(settingsDefault, { division: 4, hasMaverick: false })).toBe('d4tw');
  });
  it('honors modeOverride', () => {
    expect(effectiveMode({ modeOverride: 'maverickD3', maverickManual: null }, { division: 1, hasMaverick: false })).toBe('maverickD3');
  });
  it('maverickManual=true forces hasMaverick true even if detected=false', () => {
    expect(effectiveMode({ modeOverride: null, maverickManual: true }, { division: 4, hasMaverick: false })).toBe('maverickD3');
  });
  it('maverickManual=false forces hasMaverick false even if detected=true', () => {
    expect(effectiveMode({ modeOverride: null, maverickManual: false }, { division: 4, hasMaverick: true })).toBe('d4tw');
  });
});
