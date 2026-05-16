const POLL_MS = 3000;

async function fetchJson(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setBar(textId, barId, current, max) {
  if (current == null || max == null || max <= 0) {
    setText(textId, '—');
    document.getElementById(barId).style.width = '0%';
    return;
  }
  setText(textId, `${current} / ${max}`);
  document.getElementById(barId).style.width = `${Math.min(100, (current / max) * 100)}%`;
}

function renderStatus(s) {
  const pill = document.getElementById('status-pill');
  if (s.settings?.paused) {
    pill.textContent = '⏸ PAUSED';
    pill.className = 'px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500 text-white';
  } else {
    pill.textContent = '● RUNNING';
    pill.className = 'px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500 text-white';
  }
  if (s.lastUpdatedAt) {
    const ago = Math.floor((Date.now() - s.lastUpdatedAt) / 1000);
    setText('last-updated', `last cycle ${ago}s ago`);
  } else {
    setText('last-updated', 'no cycle yet');
  }

  const grid = document.getElementById('status-grid');
  const rows = [
    ['Day', s.day ?? '—'],
    ['Mode', s.settings?.modeOverride ?? 'auto'],
    ['Citizen', s.citizen.id ?? '—'],
    ['Country', s.citizen.countryId ?? '—'],
    ['Division', s.citizen.division ?? '—'],
    ['Location', s.citizen.atHome === true ? 'home' : s.citizen.atHome === false ? 'abroad' : '—'],
    ['Last farm reason', s.lastFarmReason ?? '—'],
    ['Last error', s.lastError ?? '—'],
  ];
  grid.innerHTML = rows
    .map(([k, v]) => `<dt class="text-gray-500">${k}</dt><dd>${v}</dd>`)
    .join('');

  setBar('energy-text', 'energy-bar', s.citizen.energy, s.citizen.energyPoolLimit);
  setBar('fuel-text', 'fuel-bar', s.citizen.fuelLeft, s.citizen.maxFuel);

  const da = s.dailyActions;
  document.getElementById('daily-actions').innerHTML = [
    ['Work', da.work],
    ['Train', da.train],
    ['Buy food', da.buyFood],
    ['VIP claim', da.vipClaim],
  ]
    .map(([k, v]) => `<li>${v ? '✅' : '⏳'} ${k}</li>`)
    .join('');
}

async function refresh() {
  try {
    const [status, settings, logs] = await Promise.all([
      fetchJson('/api/status'),
      fetchJson('/api/settings'),
      fetchJson('/api/logs?lines=100'),
    ]);
    // Settings already lives in status.settings, but /api/settings is the
    // source of truth — let the latter win.
    status.settings = settings;
    renderStatus(status);
    document.getElementById('settings-json').textContent = JSON.stringify(settings, null, 2);
    document.getElementById('logs').textContent = (logs.lines ?? []).join('\n') || '(no log file yet)';
  } catch (err) {
    document.getElementById('last-updated').textContent = `error: ${err.message}`;
  }
}

refresh();
setInterval(refresh, POLL_MS);
