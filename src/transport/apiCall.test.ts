import { describe, it, expect } from 'vitest';
import { processResponse, withTimeout, ApiTimeoutError } from './apiCall.js';
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

describe('withTimeout', () => {
  it('resolves with the inner promise value when it finishes first', async () => {
    const value = await withTimeout(Promise.resolve(42), 1000, 'op');
    expect(value).toBe(42);
  });

  it('rejects with ApiTimeoutError when the inner promise stalls past the deadline', async () => {
    const stall = new Promise<number>(() => {
      /* never resolves */
    });
    await expect(withTimeout(stall, 50, 'POST /en/military/foo')).rejects.toBeInstanceOf(
      ApiTimeoutError,
    );
  });

  it('includes the operation label in the timeout error message', async () => {
    const stall = new Promise<number>(() => undefined);
    try {
      await withTimeout(stall, 50, 'POST /en/military/foo');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiTimeoutError);
      expect((e as ApiTimeoutError).message).toContain('POST /en/military/foo');
      expect((e as ApiTimeoutError).message).toContain('50');
    }
  });

  it('propagates rejection from the inner promise unchanged', async () => {
    const fail = Promise.reject(new Error('inner fail'));
    await expect(withTimeout(fail, 1000, 'op')).rejects.toThrow('inner fail');
  });
});
