import { describe, it, expect } from 'vitest';
import { processResponse } from './apiCall.js';
import { ForbiddenError } from './errors.js';

describe('processResponse', () => {
  const input = { method: 'POST' as const, path: '/en/military/foo', csrf: 'x' };

  it('parses JSON body on success', () => {
    const out = processResponse(input, {
      status: 200,
      contentType: 'application/json; charset=utf-8',
      text: '{"hello":"world"}',
    });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ hello: 'world' });
  });

  it('throws ForbiddenError on HTTP 403 (before content-type check)', () => {
    expect(() =>
      processResponse(input, {
        status: 403,
        contentType: 'text/html',
        text: '<!doctype html><title>Forbidden</title>',
      }),
    ).toThrow(ForbiddenError);
  });

  it('throws ForbiddenError on HTTP 403 even for a JSON response', () => {
    expect(() =>
      processResponse(input, {
        status: 403,
        contentType: 'application/json',
        text: '{"error":true,"message":"Forbidden"}',
      }),
    ).toThrow(ForbiddenError);
  });

  it('throws generic Non-JSON error on non-403 + non-JSON response', () => {
    expect(() =>
      processResponse(input, {
        status: 503,
        contentType: 'text/html',
        text: '<!doctype html>',
      }),
    ).toThrow(/Non-JSON response/);
  });

  it('attaches endpoint context to ForbiddenError', () => {
    try {
      processResponse(input, { status: 403, contentType: 'text/html', text: '' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError);
      expect((e as ForbiddenError).endpoint).toContain('/en/military/foo');
      expect((e as ForbiddenError).endpoint).toContain('POST');
    }
  });
});
