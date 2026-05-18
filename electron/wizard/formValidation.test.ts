import { describe, it, expect } from 'vitest';
import { validateWizardForm, type WizardFormInput } from './formValidation.js';

const valid: WizardFormInput = {
  email: 'me@example.com',
  password: 'secret123',
  slug: 'main',
  maxFoodPrice: '3.0',
  maxTravel: '400',
  minFuel: '10',
  blockedCountries: '',
  returnAfter: '15',
  returnMax: '500',
  tgToken: '',
  tgChat: '',
  captchaProvider: 'none',
  captchaKey: '',
};

describe('validateWizardForm', () => {
  it('accepts a fully-valid input', () => {
    const result = validateWizardForm(valid);
    expect(result.ok).toBe(true);
  });

  it('rejects empty email', () => {
    const result = validateWizardForm({ ...valid, email: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.email).toMatch(/email/i);
  });

  it('rejects malformed email', () => {
    const result = validateWizardForm({ ...valid, email: 'not-an-email' });
    expect(result.ok).toBe(false);
  });

  it('rejects empty password', () => {
    const result = validateWizardForm({ ...valid, password: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.password).toBeTruthy();
  });

  it('rejects empty slug', () => {
    const result = validateWizardForm({ ...valid, slug: '   ' });
    expect(result.ok).toBe(false);
  });

  it('rejects non-numeric maxFoodPrice', () => {
    const result = validateWizardForm({ ...valid, maxFoodPrice: 'lots' });
    expect(result.ok).toBe(false);
  });

  it('rejects negative numeric fields', () => {
    const result = validateWizardForm({ ...valid, maxTravel: '-1' });
    expect(result.ok).toBe(false);
  });

  it('requires captchaKey when provider is 2captcha', () => {
    const result = validateWizardForm({ ...valid, captchaProvider: '2captcha', captchaKey: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.captchaKey).toBeTruthy();
  });

  it('accepts 2captcha provider with key present', () => {
    const result = validateWizardForm({ ...valid, captchaProvider: '2captcha', captchaKey: 'abc123' });
    expect(result.ok).toBe(true);
  });

  it('coerces numbers correctly on success', () => {
    const result = validateWizardForm(valid);
    if (result.ok) {
      expect(result.values.maxFoodPrice).toBe(3.0);
      expect(result.values.maxTravel).toBe(400);
      expect(result.values.minFuel).toBe(10);
    } else {
      throw new Error('expected ok=true');
    }
  });
});
