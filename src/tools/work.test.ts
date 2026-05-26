import { describe, it, expect } from 'vitest';
import { isWorkSuccess } from './work.js';

describe('isWorkSuccess', () => {
  it('rejects non-200 status', () => {
    expect(isWorkSuccess(403, { status: true })).toBe(false);
    expect(isWorkSuccess(500, null)).toBe(false);
  });

  it('accepts 200 with empty body (legacy success shape)', () => {
    expect(isWorkSuccess(200, null)).toBe(true);
    expect(isWorkSuccess(200, undefined)).toBe(true);
    expect(isWorkSuccess(200, {})).toBe(true);
  });

  it('rejects 200 with explicit status:false', () => {
    expect(isWorkSuccess(200, { status: false, message: 'You have no job' })).toBe(false);
  });

  it('rejects 200 with explicit error:true', () => {
    expect(isWorkSuccess(200, { error: true, message: 'You have no job' })).toBe(false);
  });

  it('accepts 200 with status:true', () => {
    expect(isWorkSuccess(200, { status: true, message: '+10 strength' })).toBe(true);
  });

  it('accepts 200 with unknown shape (no failure marker)', () => {
    expect(isWorkSuccess(200, { message: 'whatever', payment: 7000 })).toBe(true);
  });
});
