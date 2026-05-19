import type { BrowserContext, Page } from 'playwright-core';
import { assertAllowed, type HttpMethod } from './allowlist.js';
import { ForbiddenError } from './errors.js';

const BASE = 'https://www.erepublik.com';

export interface ApiCallInput {
  method: HttpMethod;
  path: string;
  csrf: string;
  form?: Record<string, string | number>;
  /** Override Referer (default: `${BASE}/en`). Use battle URL for combat endpoints. */
  referer?: string;
}

export interface ApiCallResult<T = unknown> {
  status: number;
  body: T;
}

/**
 * Returns a long-lived page bound to www.erepublik.com. Reused as the host for
 * all `fetch()` calls so requests carry the full browser fingerprint
 * (sec-ch-ua-*, sec-fetch-*, navigator UA, cookies, TLS profile) instead of
 * Playwright's bare-bones `ctx.request` profile that bot-detection can spot.
 */
async function getOrCreateErepublikPage(ctx: BrowserContext): Promise<Page> {
  for (const p of ctx.pages()) {
    if (p.url().startsWith(BASE)) return p;
  }
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!page.url().startsWith(BASE)) {
    await page.goto(`${BASE}/en`, { waitUntil: 'domcontentloaded' });
  }
  return page;
}

export async function apiCall<T = unknown>(ctx: BrowserContext, input: ApiCallInput): Promise<ApiCallResult<T>> {
  assertAllowed(input.method, input.path);

  const url = `${BASE}${input.path}`;
  const referer = input.referer ?? `${BASE}/en`;

  const form: Record<string, string> = { _token: input.csrf };
  if (input.form) {
    for (const [k, v] of Object.entries(input.form)) form[k] = String(v);
  }

  const page = await getOrCreateErepublikPage(ctx);

  // Route the request through the live page so the browser attaches its full
  // header fingerprint (sec-ch-ua, sec-fetch-*, Accept-Language, etc.). The
  // page's own URL is used as Referer when input.referer matches the default —
  // for combat endpoints, the caller supplies the battlefield URL explicitly.
  const evalResult = await page.evaluate<{ status: number; contentType: string; text: string }, {
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

  return processResponse<T>(input, evalResult);
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
