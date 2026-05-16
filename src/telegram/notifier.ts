export interface TelegramConfig {
  token?: string;
  chatId?: string;
  /** Prepended to every message so multi-account users can tell instances apart. */
  accountTag?: string;
}

export class TelegramNotifier {
  private readonly enabled: boolean;
  private readonly token: string;
  private readonly chatId: string;
  private readonly accountTag: string;

  constructor(cfg: TelegramConfig) {
    this.token = cfg.token ?? '';
    this.chatId = cfg.chatId ?? '';
    this.accountTag = cfg.accountTag ?? '';
    this.enabled = this.token.length > 0 && this.chatId.length > 0;
  }

  async send(text: string): Promise<void> {
    if (!this.enabled) return;
    const message = this.accountTag ? `\\[${this.accountTag}] ${text}` : text;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text: message, parse_mode: 'Markdown', disable_web_page_preview: true }),
      });
      if (!res.ok) {
        console.error(`[telegram] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    } catch (err) {
      console.error('[telegram] send failed:', (err as Error).message);
    }
  }

  async sendError(message: string): Promise<void> {
    await this.send(`⚠️ erepublik-agent error: ${message}`);
  }
}
