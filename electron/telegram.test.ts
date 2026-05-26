import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { sendUpdateNotification } from './telegram.js';

describe('sendUpdateNotification', () => {
  let tmpDir: string;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'erep-telegram-'));
    fetchSpy = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('silently returns when config/.env is missing', async () => {
    await expect(sendUpdateNotification('1.2.3', tmpDir)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('silently returns when telegram keys are missing or blank', async () => {
    await fs.mkdir(path.join(tmpDir, 'config'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'config', '.env'),
      'TELEGRAM_BOT_TOKEN=\nTELEGRAM_CHAT_ID=\nOTHER=value\n',
    );
    await expect(sendUpdateNotification('1.2.3', tmpDir)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to telegram with version + chat_id when both keys are set', async () => {
    await fs.mkdir(path.join(tmpDir, 'config'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'config', '.env'),
      'TELEGRAM_BOT_TOKEN=secret123\nTELEGRAM_CHAT_ID=999\n',
    );

    await sendUpdateNotification('1.2.3', tmpDir);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botsecret123/sendMessage');
    expect(init.method).toBe('POST');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('chat_id')).toBe('999');
    expect(body.get('text')).toContain('v1.2.3');
    expect(body.get('disable_web_page_preview')).toBe('true');
  });

  it('does not throw if fetch rejects', async () => {
    await fs.mkdir(path.join(tmpDir, 'config'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'config', '.env'),
      'TELEGRAM_BOT_TOKEN=secret123\nTELEGRAM_CHAT_ID=999\n',
    );
    fetchSpy.mockRejectedValueOnce(new Error('network down'));

    await expect(sendUpdateNotification('1.2.3', tmpDir)).resolves.toBeUndefined();
  });
});
