import { describe, it, expect } from 'vitest';
import { processHtmlResponse } from './apiCallHtml.js';
import { ForbiddenError } from './errors.js';

describe('processHtmlResponse', () => {
  it('returns { status, html } for any text content type', () => {
    const r = processHtmlResponse(
      { method: 'GET', path: '/en/economy/exchange-market' },
      { status: 200, contentType: 'text/html; charset=utf-8', text: '<html>hello</html>' },
    );
    expect(r).toEqual({ status: 200, html: '<html>hello</html>' });
  });

  it('throws ForbiddenError on HTTP 403 before any other check', () => {
    expect(() =>
      processHtmlResponse(
        { method: 'GET', path: '/en/economy/exchange-market' },
        { status: 403, contentType: 'text/html', text: '<html>blocked</html>' },
      ),
    ).toThrow(ForbiddenError);
  });

  it('returns text body even when content-type is missing', () => {
    const r = processHtmlResponse(
      { method: 'GET', path: '/en/economy/exchange-market' },
      { status: 200, contentType: '', text: 'plain' },
    );
    expect(r).toEqual({ status: 200, html: 'plain' });
  });
});
