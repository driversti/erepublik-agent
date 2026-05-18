const state = { current: 1 };
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

document.getElementById('step1-next').addEventListener('click', () => show(2));
document.getElementById('step2-back').addEventListener('click', () => show(1));
