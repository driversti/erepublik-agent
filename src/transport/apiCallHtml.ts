import type { BrowserContext } from 'playwright-core';
import { assertAllowed } from './allowlist.js';
import { ForbiddenError } from './errors.js';
import { withTimeout, DEFAULT_TIMEOUT_MS } from './apiCall.js';
import { BASE, getOrCreateErepublikPage } from './browserPage.js';

/**
 * Inputs for {@link apiCallHtml}. GET-only — the eRepublik HTML pages we
 * scrape (e.g. the monetary market) don't need CSRF or form bodies, and the
 * response path returns text rather than enforcing JSON. For POSTs, use
 * {@link ./apiCall.apiCall} which handles `_token` and form encoding.
 */
export interface ApiCallHtmlInput {
  method: 'GET';
  path: string;
  /** Optional override; defaults to `${BASE}/en`. */
  referer?: string;
  /** Wall-clock deadline for the round-trip. Defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface ApiCallHtmlResult {
  status: number;
  html: string;
}

export async function apiCallHtml(
  ctx: BrowserContext,
  input: ApiCallHtmlInput,
): Promise<ApiCallHtmlResult> {
  assertAllowed(input.method, input.path);
  const url = `${BASE}${input.path}`;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const page = await getOrCreateErepublikPage(ctx);

  const evaluatePromise = page.evaluate<{ status: number; contentType: string; text: string }, { url: string }>(
    async ({ url: u }) => {
      // Deliberately no `X-Requested-With: XMLHttpRequest` here, unlike apiCall.
      // The exchange-market page is a full HTML document served from the same
      // origin; setting the XHR header changes how some eRepublik handlers
      // route the response (returning a JSON fragment instead of the full
      // page). Keep this a plain navigation-shaped GET.
      const r = await fetch(u, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
      });
      const text = await r.text();
      return { status: r.status, contentType: r.headers.get('content-type') ?? '', text };
    },
    { url },
  );

  const evalResult = await withTimeout(evaluatePromise, timeoutMs, `${input.method} ${input.path}`);
  return processHtmlResponse(input, evalResult);
}

/**
 * Pure response processor — extracted for testability. 403 → ForbiddenError;
 * otherwise return `{ status, html: text }`. Unlike `apiCall` we don't enforce
 * a content-type; market pages legitimately return text/html, but operators
 * who probe behind a CDN sometimes see `text/plain` or empty content-type.
 */
export function processHtmlResponse(
  input: Pick<ApiCallHtmlInput, 'method' | 'path'>,
  evalResult: { status: number; contentType: string; text: string },
): ApiCallHtmlResult {
  if (evalResult.status === 403) {
    throw new ForbiddenError(`${input.method} ${input.path}`);
  }
  return { status: evalResult.status, html: evalResult.text };
}
