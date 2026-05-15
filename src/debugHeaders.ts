import 'dotenv/config';
import { z } from 'zod';
import { openSession } from './browser/session.js';

const Env = z.object({
  ERP_ACCOUNT_SLUG: z.string().default('main'),
  HEADED: z.enum(['true', 'false']).default('false'),
});
const env = Env.parse(process.env);

const ctx = await openSession({ accountSlug: env.ERP_ACCOUNT_SLUG, headed: env.HEADED === 'true' });

try {
  // 1. What cookies are in our context?
  const cookies = await ctx.cookies('https://www.erepublik.com');
  console.log('── COOKIES (erepublik.com) ──');
  for (const c of cookies) {
    const value = c.value.length > 30 ? c.value.slice(0, 30) + '…' : c.value;
    console.log(`  ${c.name} = ${value} (domain=${c.domain}, secure=${c.secure}, httpOnly=${c.httpOnly})`);
  }
  const erpk = cookies.find((c) => c.name === 'erpk');
  console.log(`\n  erpk cookie present: ${erpk ? 'YES (' + erpk.value.length + ' chars)' : 'NO ❌'}`);

  // 2. What user-agent does the page see?
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (!page.url().startsWith('https://www.erepublik.com')) {
    await page.goto('https://www.erepublik.com/en', { waitUntil: 'domcontentloaded' });
  }
  const ua = await page.evaluate(() => navigator.userAgent);
  console.log(`\n── BROWSER User-Agent (from navigator) ──\n  ${ua}`);

  // 3. What does ctx.request actually send? Hit httpbin or an echo endpoint we control.
  //    Since we can't add arbitrary endpoints, fetch from the erepublik root and inspect
  //    cookies it accepts (Set-Cookie should not change for a logged-in GET).
  console.log('\n── ctx.request.get() to /en/main ──');
  const resp = await ctx.request.get('https://www.erepublik.com/en/main', {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  console.log(`  status=${resp.status()}`);
  console.log('  request was sent with cookies that include erpk:', erpk ? 'YES (Playwright share)' : 'NO');

  // 4. Compare: fetch the SAME endpoint via the page's fetch() and see status
  console.log('\n── page.evaluate(fetch) to /en/main ──');
  const pageStatus = await page.evaluate(async () => {
    const r = await fetch('https://www.erepublik.com/en/main', {
      method: 'GET',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
    });
    return { status: r.status, ok: r.ok };
  });
  console.log(`  status=${pageStatus.status} ok=${pageStatus.ok}`);
} finally {
  await ctx.close();
}
