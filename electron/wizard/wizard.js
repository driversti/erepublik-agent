import { validateWizardForm } from './formValidation.js';
import { suggestCountries, parseChips } from './countryPicker.js';

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

let countryCatalog = [];
fetch('countries.json').then(r => r.json()).then(j => { countryCatalog = j; });

const blockedInput = document.getElementById('blockedCountries');
const errEl = document.getElementById('blockedCountries-error');
const suggestBox = document.createElement('div');
suggestBox.style.cssText = 'position:absolute; background:#313244; border:1px solid #45475a; max-height:240px; overflow-y:auto; z-index:10;';
suggestBox.style.display = 'none';
blockedInput.parentElement.style.position = 'relative';
blockedInput.parentElement.appendChild(suggestBox);

blockedInput.addEventListener('input', () => {
  const trailing = blockedInput.value.split(',').pop().trim();
  const matches = suggestCountries(trailing, countryCatalog);
  if (matches.length === 0) { suggestBox.style.display = 'none'; return; }
  suggestBox.innerHTML = '';
  for (const c of matches) {
    const item = document.createElement('div');
    item.style.cssText = 'padding:6px 10px; cursor:pointer;';
    item.textContent = c.name;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const parts = blockedInput.value.split(',').map(s => s.trim()).filter(Boolean);
      parts.pop();
      parts.push(c.name);
      blockedInput.value = parts.join(', ') + ', ';
      suggestBox.style.display = 'none';
      blockedInput.focus();
    });
    suggestBox.appendChild(item);
  }
  suggestBox.style.display = 'block';
});
blockedInput.addEventListener('blur', () => setTimeout(() => { suggestBox.style.display = 'none'; }, 200));
blockedInput.addEventListener('change', () => {
  const { unknown } = parseChips(blockedInput.value, countryCatalog);
  errEl.textContent = unknown.length > 0 ? `Unknown country: ${unknown.join(', ')}` : '';
});

document.getElementById('step2-back').addEventListener('click', () => show(1));

const step2Log = document.getElementById('step2-log');
const step2Open = document.getElementById('step2-open');
const step2Retry = document.getElementById('step2-retry');

function appendLog(text, kind = '') {
  const line = document.createElement('div');
  if (kind === 'stderr') line.style.color = '#f38ba8';
  line.textContent = text;
  step2Log.appendChild(line);
  step2Log.scrollTop = step2Log.scrollHeight;
}

window.electronAPI.onBootstrapOutput((data) => {
  if (data.stream === 'exit') {
    if (data.code === 0) {
      appendLog('[wizard] login successful — preparing next step…');
      setTimeout(() => show(3), 600);
    } else {
      appendLog(`[wizard] bootstrap exited with code ${data.code}`, 'stderr');
      step2Retry.style.display = 'inline-block';
    }
  } else {
    appendLog((data.text ?? '').trimEnd(), data.stream === 'stderr' ? 'stderr' : '');
  }
});

async function runBootstrap() {
  step2Log.innerHTML = '';
  step2Retry.style.display = 'none';
  step2Open.disabled = true;
  const save = await window.electronAPI.saveConfig(state.values);
  if (!save.ok) {
    appendLog(`[wizard] failed to save config: ${save.error ?? 'unknown error'}`, 'stderr');
    step2Open.disabled = false;
    return;
  }
  await window.electronAPI.startBootstrap();
  step2Open.disabled = false;
}

step2Open.addEventListener('click', runBootstrap);
step2Retry.addEventListener('click', runBootstrap);

const step3Start = document.getElementById('step3-start');
const autostartChk = document.getElementById('autostart');

step3Start.addEventListener('click', async () => {
  step3Start.disabled = true;
  step3Start.textContent = 'Starting…';
  await window.electronAPI.finish({ autostart: autostartChk.checked });
});
