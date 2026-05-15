import type { BrowserContext, Page } from 'playwright-core';

const BASE = 'https://www.erepublik.com';
const TWOCAPTCHA_API = 'https://api.2captcha.com';
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 24; // ~2 minutes
const POST_SUBMIT_WAIT_MS = 2_500;
const IMAGE_LOAD_TIMEOUT_MS = 15_000;

export type CaptchaProvider = 'none' | '2captcha';

export interface CaptchaConfig {
  provider: CaptchaProvider;
  apiKey?: string;
  /** Solve retries before giving up. Only meaningful for auto-solving providers. */
  maxAttempts?: number;
  /** Optional Telegram-style notifier. Called on detect / success / failure. */
  notify?: (msg: string) => Promise<void>;
}

export interface CaptchaResult {
  detected: boolean;
  solved: boolean;
  attempts: number;
  reason?: string;
}

interface CaptchaPresence {
  verifyButton: boolean;
  captchaImage: boolean;
}

interface TwoCaptchaCreateTaskResponse {
  errorId: number;
  taskId?: number;
  errorCode?: string;
  errorDescription?: string;
}

interface TwoCaptchaResultResponse {
  errorId: number;
  status?: 'processing' | 'ready';
  solution?: { coordinates?: Array<{ x: number; y: number }> };
  errorCode?: string;
  errorDescription?: string;
}

async function getErepublikPage(ctx: BrowserContext): Promise<Page> {
  for (const p of ctx.pages()) {
    if (p.url().startsWith(BASE)) return p;
  }
  return ctx.pages()[0] ?? (await ctx.newPage());
}

async function detectOnPage(page: Page): Promise<CaptchaPresence> {
  return page.evaluate(() => ({
    verifyButton: !!document.getElementById('startSessionVerify'),
    captchaImage: !!document.getElementById('captchaImage'),
  }));
}

export async function detectCaptcha(ctx: BrowserContext): Promise<boolean> {
  const page = await getErepublikPage(ctx);
  const p = await detectOnPage(page);
  return p.verifyButton || p.captchaImage;
}

async function createTwoCaptchaTask(apiKey: string, base64Image: string): Promise<number> {
  const res = await fetch(`${TWOCAPTCHA_API}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: 'CoordinatesTask',
        body: base64Image,
        comment: 'click the images in the specified order',
      },
    }),
  });
  const data = (await res.json()) as TwoCaptchaCreateTaskResponse;
  if (data.errorId !== 0 || !data.taskId) {
    throw new Error(
      `2captcha createTask failed: ${data.errorCode ?? 'err'} ${data.errorDescription ?? 'unknown'}`,
    );
  }
  return data.taskId;
}

async function pollTwoCaptchaResult(
  apiKey: string,
  taskId: number,
): Promise<Array<{ x: number; y: number }>> {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(`${TWOCAPTCHA_API}/getTaskResult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const data = (await res.json()) as TwoCaptchaResultResponse;
    if (data.errorId !== 0) {
      throw new Error(
        `2captcha getTaskResult failed: ${data.errorCode ?? 'err'} ${data.errorDescription ?? 'unknown'}`,
      );
    }
    if (data.status === 'ready') {
      const coords = data.solution?.coordinates;
      if (!coords?.length) throw new Error('2captcha returned no coordinates');
      return coords;
    }
  }
  throw new Error(
    `2captcha did not return a solution within ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`,
  );
}

async function revealCaptchaImage(page: Page): Promise<string> {
  // Click "startSessionVerify" to surface the captcha image (no-op if already visible).
  await page.evaluate(() => {
    const btn = document.getElementById('startSessionVerify') as HTMLElement | null;
    btn?.click();
  });

  const handle = await page.waitForFunction(
    () => {
      const img = document.getElementById('captchaImage') as HTMLImageElement | null;
      if (!img || !img.src || !img.src.startsWith('data:image')) return null;
      const comma = img.src.indexOf(',');
      return comma >= 0 ? img.src.slice(comma + 1) : null;
    },
    null,
    { timeout: IMAGE_LOAD_TIMEOUT_MS },
  );
  const base64 = (await handle.jsonValue()) as string | null;
  if (!base64) throw new Error('captcha image did not load');
  return base64;
}

async function submitSolution(
  page: Page,
  coords: Array<{ x: number; y: number }>,
): Promise<void> {
  // Mirror ePlus: dispatch synthetic MouseEvents on the captcha image, then click submit.
  // eRepublik's captcha JS reads offsetX/offsetY, which the browser derives from clientX -
  // target.boundingRect.left, so we feed it rect.left + coord.x exactly like ePlus does.
  await page.evaluate((c) => {
    const img = document.getElementById('captchaImage') as HTMLImageElement | null;
    if (!img) throw new Error('captcha image disappeared before solution submit');
    const rect = img.getBoundingClientRect();
    for (const { x, y } of c) {
      img.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + x,
          clientY: rect.top + y,
        }),
      );
    }
  }, coords);

  // Small pause mirrors the 1s settle ePlus uses between clicks and submit.
  await new Promise((r) => setTimeout(r, 1_000));

  await page.evaluate(() => {
    const btn = document.getElementById('sessionUnlockSubmit') as HTMLElement | null;
    btn?.click();
  });
}

async function refreshCaptcha(page: Page): Promise<void> {
  await page.evaluate(() => {
    const refresh = document.getElementById('refreshIcon') as HTMLElement | null;
    refresh?.click();
  });
  await new Promise((r) => setTimeout(r, 1_500));
}

async function trySolveOnce(page: Page, apiKey: string): Promise<void> {
  const base64 = await revealCaptchaImage(page);
  const taskId = await createTwoCaptchaTask(apiKey, base64);
  console.log(`[captcha] 2captcha taskId=${taskId}, polling for result…`);
  const coords = await pollTwoCaptchaResult(apiKey, taskId);
  console.log(`[captcha] solution received (${coords.length} clicks), submitting…`);
  await submitSolution(page, coords);
  await new Promise((r) => setTimeout(r, POST_SUBMIT_WAIT_MS));
}

/**
 * Detect — and, if configured, auto-solve — eRepublik's session-unlock captcha.
 * Mirrors the ePlus userscript flow (DOM-based detection, 2Captcha CoordinatesTask,
 * synthetic MouseEvent clicks). Call this on a page already navigated to a normal
 * eRepublik route (e.g. /en/military/campaigns after extractCitizenContext).
 *
 * Provider `none` → just detect and notify; the caller should bail the cycle.
 * Provider `2captcha` → submit base64 image to api.2captcha.com, poll for
 * coordinates, dispatch clicks, submit. Retries up to `maxAttempts` times.
 */
export async function handleCaptchaIfPresent(
  ctx: BrowserContext,
  cfg: CaptchaConfig,
): Promise<CaptchaResult> {
  const page = await getErepublikPage(ctx);
  const initial = await detectOnPage(page);
  if (!initial.verifyButton && !initial.captchaImage) {
    return { detected: false, solved: false, attempts: 0 };
  }

  console.log('[captcha] detected on page — session lock active');
  await cfg.notify?.('🤖 *captcha detected* — eRepublik session lock');

  if (cfg.provider === 'none') {
    const reason = 'ERP_CAPTCHA_PROVIDER=none — manual intervention required';
    await cfg.notify?.(`❌ *captcha unhandled* — ${reason}`);
    return { detected: true, solved: false, attempts: 0, reason };
  }
  if (!cfg.apiKey) {
    const reason = `provider=${cfg.provider} but ERP_CAPTCHA_API_KEY is unset`;
    await cfg.notify?.(`❌ *captcha unhandled* — ${reason}`);
    return { detected: true, solved: false, attempts: 0, reason };
  }

  const maxAttempts = Math.max(1, cfg.maxAttempts ?? 3);
  let lastErr: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await trySolveOnce(page, cfg.apiKey);
      const after = await detectOnPage(page);
      if (!after.verifyButton && !after.captchaImage) {
        console.log(`[captcha] solved on attempt ${attempt}/${maxAttempts}`);
        await cfg.notify?.(`✅ *captcha solved* (attempt ${attempt}/${maxAttempts})`);
        return { detected: true, solved: true, attempts: attempt };
      }
      lastErr = 'still present after submit';
      console.warn(`[captcha] attempt ${attempt}/${maxAttempts}: ${lastErr}, refreshing`);
      await refreshCaptcha(page);
    } catch (err) {
      lastErr = (err as Error).message;
      console.error(`[captcha] attempt ${attempt}/${maxAttempts} threw: ${lastErr}`);
      // 2captcha service flake — give it a beat before retrying.
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  await cfg.notify?.(`❌ *captcha solve failed* after ${maxAttempts} attempts — ${lastErr ?? 'unknown'}`);
  return { detected: true, solved: false, attempts: maxAttempts, reason: lastErr };
}
