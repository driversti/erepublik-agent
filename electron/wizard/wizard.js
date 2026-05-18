import { validateWizardForm } from './formValidation.js';

const state = { current: 1, values: null };
function show(step) {
  state.current = step;
  for (const el of document.querySelectorAll('.step')) {
    el.classList.toggle('active', Number(el.dataset.step) === step);
  }
  for (const el of document.querySelectorAll('.stepper .dot')) {
    const n = Number(el.dataset.step);
    el.classList.toggle('active', n === step);
    el.classList.toggle('done', n < step);
  }
}

document.getElementById('captchaProvider').addEventListener('change', (e) => {
  document.getElementById('captchaKeyWrap').style.display = e.target.value === '2captcha' ? 'block' : 'none';
});

document.getElementById('step1-next').addEventListener('click', () => {
  const input = {
    email: document.getElementById('email').value,
    password: document.getElementById('password').value,
    slug: document.getElementById('slug').value,
    maxFoodPrice: document.getElementById('maxFoodPrice').value,
    maxTravel: document.getElementById('maxTravel').value,
    minFuel: document.getElementById('minFuel').value,
    blockedCountries: document.getElementById('blockedCountries').value,
    returnAfter: document.getElementById('returnAfter').value,
    returnMax: document.getElementById('returnMax').value,
    tgToken: document.getElementById('tgToken').value,
    tgChat: document.getElementById('tgChat').value,
    captchaProvider: document.getElementById('captchaProvider').value,
    captchaKey: document.getElementById('captchaKey').value,
  };
  // Clear previous errors
  for (const el of document.querySelectorAll('.error')) el.textContent = '';
  const result = validateWizardForm(input);
  if (!result.ok) {
    for (const [field, msg] of Object.entries(result.errors)) {
      const el = document.getElementById(`${field}-error`);
      if (el) el.textContent = msg;
      else {
        const inputEl = document.getElementById(field);
        if (inputEl?.parentElement) {
          const div = document.createElement('div');
          div.className = 'error';
          div.id = `${field}-error`;
          div.textContent = msg;
          inputEl.parentElement.appendChild(div);
        }
      }
    }
    return;
  }
  state.values = result.values;
  show(2);
});

document.getElementById('step2-back').addEventListener('click', () => show(1));
