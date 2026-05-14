import type { BrowserContext } from 'playwright-core';
import { assertAllowed, type HttpMethod } from './allowlist.js';

const BASE = 'https://www.erepublik.com';

export interface ApiCallInput {
  method: HttpMethod;
  path: string;
  csrf: string;
  form?: Record<string, string | number>;
}

export interface ApiCallResult<T = unknown> {
  status: number;
  body: T;
}

export async function apiCall<T = unknown>(ctx: BrowserContext, input: ApiCallInput): Promise<ApiCallResult<T>> {
  assertAllowed(input.method, input.path);

  const url = `${BASE}${input.path}`;
  const headers: Record<string, string> = {
    'X-Requested-With': 'XMLHttpRequest',
    Origin: BASE,
    Referer: `${BASE}/en`,
  };

  const form: Record<string, string> = { _token: input.csrf };
  if (input.form) {
    for (const [k, v] of Object.entries(input.form)) form[k] = String(v);
  }

  const res =
    input.method === 'POST'
      ? await ctx.request.post(url, { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, form })
      : await ctx.request.get(url, { headers });

  const contentType = res.headers()['content-type'] ?? '';
  if (!contentType.includes('json')) {
    const text = await res.text();
    throw new Error(`Non-JSON response from ${input.method} ${input.path} (status=${res.status()}): ${text.slice(0, 200)}`);
  }

  const body = (await res.json()) as T;
  return { status: res.status(), body };
}
