/**
 * MarkdownV2 escaping helpers for Telegram Bot API.
 *
 * Telegram's MarkdownV2 reserves: _ * [ ] ( ) ~ ` > # + - = | { } . !
 * Inside `[link text](url)` URLs, only `)` and `\` need escaping (backslash
 * before any other char is treated literally — but `)` would close the URL).
 *
 * Note: outside a code block, escape every reserved character with a leading
 * backslash. This avoids "can't find end of the entity" parser errors when
 * messages contain values like `ERR_CONNECTION_CLOSED` (the `_` would open an
 * italic span that never closes).
 */

const MDV2_ESCAPE = /([_*[\]()~`>#+\-=|{}.!\\])/g;
const MDV2_URL_ESCAPE = /([\\)])/g;

export function escapeMdV2(text: string): string {
  return text.replace(MDV2_ESCAPE, '\\$1');
}

export function escapeMdV2Url(url: string): string {
  return url.replace(MDV2_URL_ESCAPE, '\\$1');
}

export function mdV2Link(text: string, url: string): string {
  return `[${escapeMdV2(text)}](${escapeMdV2Url(url)})`;
}
