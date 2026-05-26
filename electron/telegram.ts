import fs from 'node:fs/promises';
import path from 'node:path';

interface TelegramConfig {
  token: string;
  chatId: string;
}

async function readTelegramConfig(userDataDir: string): Promise<TelegramConfig | null> {
  const envPath = path.join(userDataDir, 'config', '.env');
  let raw: string;
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    return null;
  }
  const map: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    map[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const token = map.TELEGRAM_BOT_TOKEN;
  const chatId = map.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  return { token, chatId };
}

export async function sendUpdateNotification(version: string, userDataDir: string): Promise<void> {
  const cfg = await readTelegramConfig(userDataDir);
  if (!cfg) return;
  const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;
  const body = new URLSearchParams({
    chat_id: cfg.chatId,
    text: `🆙 Update v${version} ready to install. Open the dashboard and click "Restart now".`,
    disable_web_page_preview: 'true',
  });
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    console.warn('[telegram] update notification failed:', err);
  }
}
