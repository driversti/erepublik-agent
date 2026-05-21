import type { BrowserContext } from 'playwright-core';
import { assertAllowed, type HttpMethod } from './allowlist.js';
import { ForbiddenError } from './errors.js';
import { BASE, getOrCreateErepublikPage } from './browserPage.js';

export interface ApiCallInput {
  method: HttpMethod;
  path: string;
  csrf: string;
  form?: Record<string, string | number>;
  /** Override Referer (default: `${BASE}/en`). Use battle URL for combat endpoints. */
  referer?: string;
  /**
   * Wall-clock deadline for the whole `page.evaluate` round-trip. When the
   * remote side stalls (Cloudflare interstitial, hung Playwright page, dead
   * TCP socket), the agent has no signal to stop waiting — strategies block
   * indefinitely and the daily loop wedges. Default {@link DEFAULT_TIMEOUT_MS}
   * (30 s) is comfortably above legitimate eRepublik response times.
   */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Thrown when {@link withTimeout} fires before the inner promise settles.
 * Distinct from network errors so callers (`apiCall` consumers, strategies)
 * can decide whether to retry or abort.
 */
export class ApiTimeoutError extends Error {
  constructor(public readonly operation: string, public readonly timeoutMs: number) {
    super(`Timeout ${timeoutMs}ms waiting for ${operation}`);
    this.name = 'ApiTimeoutError';
  }
}

export interface ApiCallResult<T = unknown> {
  status: number;
  body: T;
}

export async function apiCall<T = unknown>(ctx: BrowserContext, input: ApiCallInput): Promise<ApiCallResult<T>> {
  assertAllowed(input.method, input.path);

  const url = `${BASE}${input.path}`;
  const referer = input.referer ?? `${BASE}/en`;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const form: Record<string, string> = { _token: input.csrf };
  if (input.form) {
    for (const [k, v] of Object.entries(input.form)) form[k] = String(v);
  }

  const page = await getOrCreateErepublikPage(ctx);

  // Route the request through the live page so the browser attaches its full
  // header fingerprint (sec-ch-ua, sec-fetch-*, Accept-Language, etc.). The
  // page's own URL is used as Referer when input.referer matches the default —
  // for combat endpoints, the caller supplies the battlefield URL explicitly.
  const evaluatePromise = page.evaluate<{ status: number; contentType: string; text: string }, {
    url: string;
    method: HttpMethod;
    form: Record<string, string>;
    referer: string;
  }>(
    async ({ url: u, method, form: fbody, referer: ref }) => {
      const init: RequestInit = {
        method,
        credentials: 'include',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/plain, */*',
          ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
      };
      if (method === 'POST') {
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(fbody)) body.append(k, v);
        init.body = body.toString();
      }
      // Referer can't be set programmatically by fetch() — the browser will
      // fill it from the current page URL automatically. Navigation-based
      // routing handles the rest (see Referrer-Policy).
      // We intentionally don't override it here.
      void ref;
      const r = await fetch(u, init);
      const text = await r.text();
      return { status: r.status, contentType: r.headers.get('content-type') ?? '', text };
    },
    { url, method: input.method, form, referer },
  );

  const evalResult = await withTimeout(evaluatePromise, timeoutMs, `${input.method} ${input.path}`);
  return processResponse<T>(input, evalResult);
}

/**
 * Race a promise against a wall-clock timeout. On timeout throws
 * {@link ApiTimeoutError} with the operation label and configured ms; on
 * settle the inner result/rejection propagates unchanged.
 *
 * Exposed (not just internal) so strategies and tools that wrap their own
 * async operations can adopt the same timeout discipline without duplicating
 * the race plumbing.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ApiTimeoutError(operation, timeoutMs));
    }, timeoutMs);
    // `unref` so the timer doesn't keep the Node event loop alive when the
    // promise eventually settles after the rest of the process is idle.
    if (typeof timer === 'object' && timer && typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Pure response processor — extracted for testability. Handles three cases:
 *
 *  1. HTTP 403 → throw `ForbiddenError` *before* the content-type check.
 *     eRepublik serves Cloudflare's HTML interstitial (not JSON) on rate-limit
 *     blocks; the original code surfaced this as a generic "Non-JSON response"
 *     error, which strategies couldn't pattern-match. Now they catch the
 *     concrete error class and abort the run.
 *  2. Non-JSON, non-403 → throw the original "Non-JSON response" diagnostic
 *     (preserves the snippet for easier debugging on unexpected formats).
 *  3. Otherwise → parse JSON and return `{ status, body }`.
 */
export function processResponse<T>(
  input: Pick<ApiCallInput, 'method' | 'path'>,
  evalResult: { status: number; contentType: string; text: string },
): ApiCallResult<T> {
  if (evalResult.status === 403) {
    throw new ForbiddenError(`${input.method} ${input.path}`);
  }

  if (!evalResult.contentType.includes('json')) {
    throw new Error(
      `Non-JSON response from ${input.method} ${input.path} (status=${evalResult.status}): ${evalResult.text.slice(0, 200)}`,
    );
  }

  const body = JSON.parse(evalResult.text) as T;
  return { status: evalResult.status, body };
}
