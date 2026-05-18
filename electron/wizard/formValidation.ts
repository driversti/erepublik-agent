export interface WizardFormInput {
  email: string;
  password: string;
  slug: string;
  maxFoodPrice: string;
  maxTravel: string;
  minFuel: string;
  blockedCountries: string;
  returnAfter: string;
  returnMax: string;
  tgToken: string;
  tgChat: string;
  captchaProvider: string;
  captchaKey: string;
}

export interface WizardFormValues {
  email: string;
  password: string;
  slug: string;
  maxFoodPrice: number;
  maxTravel: number;
  minFuel: number;
  blockedCountries: string; // raw — country resolution happens elsewhere
  returnAfter: number;
  returnMax: number;
  tgToken: string;
  tgChat: string;
  captchaProvider: 'none' | '2captcha';
  captchaKey: string;
}

export type WizardFormErrors = Partial<Record<keyof WizardFormInput, string>>;

export type WizardFormResult =
  | { ok: true; values: WizardFormValues }
  | { ok: false; errors: WizardFormErrors };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function num(
  raw: string,
  label: string,
  opts: { min?: number; allowFloat?: boolean },
): { value: number } | { error: string } {
  if (raw.trim() === '') return { error: `${label} is required` };
  const n = opts.allowFloat ? Number.parseFloat(raw) : Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return { error: `${label} must be a number` };
  if (opts.min !== undefined && n < opts.min) return { error: `${label} must be ≥ ${opts.min}` };
  return { value: n };
}

export function validateWizardForm(input: WizardFormInput): WizardFormResult {
  const errors: WizardFormErrors = {};

  if (!EMAIL_RE.test(input.email.trim())) errors.email = 'Enter a valid email';
  if (input.password.length === 0) errors.password = 'Password is required';
  if (input.slug.trim().length === 0) errors.slug = 'Account label is required';

  const maxFoodPrice = num(input.maxFoodPrice, 'Max Q1 food price', { min: 0, allowFloat: true });
  if ('error' in maxFoodPrice) errors.maxFoodPrice = maxFoodPrice.error;

  const maxTravel = num(input.maxTravel, 'Max travel CC', { min: 0 });
  if ('error' in maxTravel) errors.maxTravel = maxTravel.error;

  const minFuel = num(input.minFuel, 'Min fuel barrels', { min: 0 });
  if ('error' in minFuel) errors.minFuel = minFuel.error;

  const returnAfter = num(input.returnAfter, 'Return home after', { min: 0 });
  if ('error' in returnAfter) errors.returnAfter = returnAfter.error;

  const returnMax = num(input.returnMax, 'Max return-home CC', { min: 0 });
  if ('error' in returnMax) errors.returnMax = returnMax.error;

  if (input.captchaProvider !== 'none' && input.captchaProvider !== '2captcha') {
    errors.captchaProvider = 'Pick a provider';
  }
  if (input.captchaProvider === '2captcha' && input.captchaKey.trim().length === 0) {
    errors.captchaKey = '2captcha key is required when provider is 2captcha';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    values: {
      email: input.email.trim(),
      password: input.password,
      slug: input.slug.trim(),
      maxFoodPrice: (maxFoodPrice as { value: number }).value,
      maxTravel: (maxTravel as { value: number }).value,
      minFuel: (minFuel as { value: number }).value,
      blockedCountries: input.blockedCountries.trim(),
      returnAfter: (returnAfter as { value: number }).value,
      returnMax: (returnMax as { value: number }).value,
      tgToken: input.tgToken.trim(),
      tgChat: input.tgChat.trim(),
      captchaProvider: input.captchaProvider as 'none' | '2captcha',
      captchaKey: input.captchaKey.trim(),
    },
  };
}
