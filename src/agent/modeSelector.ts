import type { StrategyId } from '../farm/strategies/index.js';

export function autoMode(division: number | null, hasMaverick: boolean): StrategyId {
  if (division == null) return 'standard';
  if (division <= 3) return 'standard';
  if (division === 4 && hasMaverick) return 'maverickD3';
  if (division === 4) return 'd4tw';
  return 'standard';
}

export interface ModeSettings {
  modeOverride: StrategyId | null;
  maverickManual: boolean | null;
}

export interface ModeDetected {
  division: number | null;
  hasMaverick: boolean | null;
}

export function effectiveMode(settings: ModeSettings, detected: ModeDetected): StrategyId {
  if (settings.modeOverride != null) return settings.modeOverride;
  const maverick = settings.maverickManual ?? detected.hasMaverick ?? false;
  return autoMode(detected.division, maverick);
}
