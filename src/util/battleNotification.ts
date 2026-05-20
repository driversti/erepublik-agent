import { escapeMdV2, mdV2Link } from '../telegram/mdV2.js';
import { flagFor } from './countryFlag.js';

export interface BattleNotificationInfo {
  battleId: number;
  /** Per-division zone identifier inside the battle. Drives the deep-link URL. */
  battleZoneId: number;
  regionName: string;
  invaderCountryId: number;
  defenderCountryId: number;
  division: number;
}

/**
 * Builds the battlefield deep-link — `/military/battlefield/{battleId}/{battleZoneId}`.
 * The trailing `battleZoneId` lands the operator directly on the division the
 * agent just hit, instead of eRepublik's default (the citizen's native division,
 * which is wrong for the Maverick strategy that descends to D3).
 *
 * The pattern is the same one the ePlus `divisionSwitcher` userscript uses to
 * jump between divisions — confirmed against eRepublik's URL router via
 * `ePlus/client/src/plugins/free/divisionSwitcher.ts:210`.
 *
 * `TelegramNotifier.send()` already sets `disable_web_page_preview: true`, so
 * the link won't expand to a card in the chat.
 */
function battleUrl(battleId: number, battleZoneId: number): string {
  return `https://www.erepublik.com/en/military/battlefield/${battleId}/${battleZoneId}`;
}

/** Renders the country-vs-country header used in both success and failure messages. */
function header(info: BattleNotificationInfo): string {
  const linkText = `#${info.battleId} ${info.regionName}`;
  const link = mdV2Link(linkText, battleUrl(info.battleId, info.battleZoneId));
  const invFlag = flagFor(info.invaderCountryId);
  const defFlag = flagFor(info.defenderCountryId);
  // Em-dash and middle-dot aren't MarkdownV2-reserved; `D{n}` is just digits.
  return `${link} — ${invFlag} vs ${defFlag} · D${info.division}`;
}

/**
 * Single per-battle success message. Fires once after the win is locked in
 * (both sides for empty-div strategies; single deploy for D4-TW). The
 * operator uses this to spot medal-poaching attempts before the round ends.
 */
export function formatBattleSuccessMessage(info: BattleNotificationInfo): string {
  return `💥 ${header(info)}`;
}

/**
 * Single per-battle failure message — sent when a battle attempt couldn't
 * complete (travel failure, deploy refusal, partial battle, etc.). The
 * operator needs to see the URL so they can finish the battle manually
 * before the medal is lost.
 */
export function formatBattleFailureMessage(
  info: BattleNotificationInfo,
  reason: string,
): string {
  const trimmed = reason.length > 200 ? `${reason.slice(0, 200)}…` : reason;
  return `⚠️ ${header(info)}\nFailed: ${escapeMdV2(trimmed)}`;
}
