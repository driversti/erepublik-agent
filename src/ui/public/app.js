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

// Escape strings before interpolating into innerHTML templates. Both the
// status grid and the history list mix server-sourced strings (region names,
// error messages) with HTML — without this, a malicious or malformed payload
// could inject markup.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

  // Page title + header label: in-game name first (recognisable), local slug
  // second (stable identifier across renames).
  const nameLabel = s.citizen?.name
    ? `${s.citizen.name}${s.accountSlug ? ` (${s.accountSlug})` : ''}`
    : (s.accountSlug ?? '—');
  document.title = s.citizen?.name
    ? `${s.citizen.name} · erepublik-agent`
    : (s.accountSlug ? `${s.accountSlug} · erepublik-agent` : 'erepublik-agent');
  setText('header-account', nameLabel);

  const grid = document.getElementById('status-grid');
  const rows = [
    ['Day', s.day ?? '—'],
    ['Mode', s.settings?.modeOverride ?? 'auto'],
    ['Account', s.accountSlug ?? '—'],
    ['Name', s.citizen.name ?? '—'],
    ['Citizen', s.citizen.id ?? '—'],
    ['Country', s.citizen.countryId ?? '—'],
    ['Division', s.citizen.division ?? '—'],
    ['Location', s.citizen.atHome === true ? 'home' : s.citizen.atHome === false ? 'abroad' : '—'],
    ['Last farm reason', s.lastFarmReason ?? '—'],
    ['Last error', s.lastError ?? '—'],
  ];
  grid.innerHTML = rows
    .map(([k, v]) => `<dt class="text-gray-500">${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join('');

  setBar('energy-text', 'energy-bar', s.citizen.energy, s.citizen.energyPoolLimit);
  setBar('fuel-text', 'fuel-bar', s.citizen.fuelLeft, s.citizen.maxFuel);

  const da = s.dailyActions;
  document.getElementById('daily-actions').innerHTML = [
    ['Work', da.work],
    ['Train', da.train],
    ['Overtime', da.workOvertime],
    ['VIP claim', da.vipClaim],
    ['Buy food', da.buyFood],
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
    renderSettingsForm(settings);
    document.getElementById('logs').textContent = (logs.lines ?? []).join('\n') || '(no log file yet)';

    const hist = await fetchJson('/api/history?lines=20');
    const events = (hist.events ?? []).slice().reverse(); // newest first
    document.getElementById('history-list').innerHTML = events
      .map((e) => {
        const ts = e.at ? new Date(e.at).toLocaleTimeString() : '—';
        let summary;
        if (e.type === 'cycle') summary = `cycle: ${esc(e.reason)}`;
        else if (e.type === 'battle') summary = `🎯 battle ${esc(e.battleId)} (${esc(e.regionName)}) [${esc(e.mode)}]`;
        else if (e.type === 'mode') summary = `mode: ${esc(e.from)} → ${esc(e.to)}`;
        else if (e.type === 'pause') summary = `pause: ${e.paused ? 'on' : 'off'}`;
        else if (e.type === 'error') summary = `❌ ${esc(e.message)}`;
        else summary = esc(JSON.stringify(e));
        return `<li><span class="text-gray-400 mr-2">${esc(ts)}</span>${summary}</li>`;
      })
      .join('') || '<li class="text-gray-400">(no events yet)</li>';
  } catch (err) {
    document.getElementById('last-updated').textContent = `error: ${err.message}`;
  }
}

refresh();
setInterval(refresh, POLL_MS);

let lastSettings = null;
let saveDebounceTimer = null;

function setSaveIndicator(text, color) {
  const el = document.getElementById('save-indicator');
  if (!el) return;
  el.textContent = text;
  el.className = `text-xs ${color}`;
}

async function putSettings(next) {
  setSaveIndicator('saving…', 'text-gray-500');
  try {
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 100)}`);
    lastSettings = await r.json();
    setSaveIndicator('saved ✓', 'text-emerald-600');
    setTimeout(() => setSaveIndicator('—', 'text-gray-400'), 1500);
  } catch (err) {
    setSaveIndicator(`error: ${err.message}`, 'text-red-600');
  }
}

function scheduleSave(mutator) {
  if (!lastSettings) return;
  const next = JSON.parse(JSON.stringify(lastSettings));
  mutator(next);
  lastSettings = next;
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => putSettings(next), 300);
}

function bindControls() {
  const paused = document.getElementById('toggle-paused');
  const farm = document.getElementById('toggle-farmEnabled');
  const autoEmploy = document.getElementById('toggle-autoEmploy');
  if (paused) paused.addEventListener('change', (e) => scheduleSave((s) => (s.paused = e.target.checked)));
  if (farm) farm.addEventListener('change', (e) => scheduleSave((s) => (s.farmEnabled = e.target.checked)));
  if (autoEmploy) autoEmploy.addEventListener('change', (e) => scheduleSave((s) => (s.autoEmploy = e.target.checked)));
  const mode = document.getElementById('mode-override');
  if (mode) mode.addEventListener('change', (e) => scheduleSave((s) => (s.modeOverride = e.target.value || null)));
  const maverick = document.getElementById('maverick-manual');
  if (maverick)
    maverick.addEventListener('change', (e) => {
      const v = e.target.value;
      scheduleSave((s) => (s.maverickManual = v === '' ? null : v === 'true'));
    });
  const att = document.getElementById('d4tw-attacker');
  if (att) att.addEventListener('change', (e) => scheduleSave((s) => (s.d4tw.targetDamageAttacker = Number(e.target.value))));
  const def = document.getElementById('d4tw-defender');
  if (def) def.addEventListener('change', (e) => scheduleSave((s) => (s.d4tw.targetDamageDefender = Number(e.target.value))));
  const maxB = document.getElementById('d4tw-maxBattles');
  if (maxB) maxB.addEventListener('change', (e) => scheduleSave((s) => (s.d4tw.maxBattlesPerSession = Number(e.target.value))));
  const aAtt = document.getElementById('d4twAir-attacker');
  if (aAtt)
    aAtt.addEventListener('change', (e) =>
      scheduleSave((s) => {
        s.d4twAir = s.d4twAir || {};
        s.d4twAir.targetDamageAttacker = Number(e.target.value);
      }),
    );
  const aDef = document.getElementById('d4twAir-defender');
  if (aDef)
    aDef.addEventListener('change', (e) =>
      scheduleSave((s) => {
        s.d4twAir = s.d4twAir || {};
        s.d4twAir.targetDamageDefender = Number(e.target.value);
      }),
    );
  const aMaxB = document.getElementById('d4twAir-maxBattles');
  if (aMaxB)
    aMaxB.addEventListener('change', (e) =>
      scheduleSave((s) => {
        s.d4twAir = s.d4twAir || {};
        s.d4twAir.maxBattlesPerSession = Number(e.target.value);
      }),
    );
  const aUseW = document.getElementById('d4twAir-useWeapon');
  if (aUseW)
    aUseW.addEventListener('change', (e) =>
      scheduleSave((s) => {
        s.d4twAir = s.d4twAir || {};
        s.d4twAir.useWeapon = !!e.target.checked;
      }),
    );
  const edMaxB = document.getElementById('emptyDiv-maxBattles');
  if (edMaxB)
    edMaxB.addEventListener('change', (e) =>
      scheduleSave((s) => {
        s.emptyDiv = s.emptyDiv || {};
        s.emptyDiv.maxBattlesPerSession = Number(e.target.value);
      }),
    );
  const cdMin = document.getElementById('cooldown-min');
  if (cdMin) cdMin.addEventListener('change', (e) => scheduleSave((s) => {
    s.farmSession = s.farmSession || {};
    s.farmSession.cooldownMinMinutes = Number(e.target.value);
  }));
  const cdMax = document.getElementById('cooldown-max');
  if (cdMax) cdMax.addEventListener('change', (e) => scheduleSave((s) => {
    s.farmSession = s.farmSession || {};
    s.farmSession.cooldownMaxMinutes = Number(e.target.value);
  }));
  const otEnabled = document.getElementById('ot-enabled');
  if (otEnabled)
    otEnabled.addEventListener('change', (e) =>
      scheduleSave((s) => {
        s.workOvertime = s.workOvertime || {};
        s.workOvertime.enabled = e.target.checked;
      }),
    );
  const otMode = document.getElementById('ot-mode');
  if (otMode)
    otMode.addEventListener('change', (e) =>
      scheduleSave((s) => {
        s.workOvertime = s.workOvertime || {};
        s.workOvertime.mode = e.target.value;
      }),
    );
}

function bindRunNowButton() {
  const btn = document.getElementById('btn-run-now');
  if (!btn) return;
  const hint = document.getElementById('run-now-hint');
  const defaultHint = hint?.textContent ?? '';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    if (hint) hint.textContent = 'Requested — runner will wake on next sleep tick.';
    try {
      const r = await fetch('/api/run-now', { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 100)}`);
    } catch (err) {
      if (hint) hint.textContent = `Failed: ${err.message}`;
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        if (hint) hint.textContent = defaultHint;
      }, 3000);
    }
  });
}

function renderSettingsForm(s) {
  lastSettings = s;
  const paused = document.getElementById('toggle-paused');
  const farm = document.getElementById('toggle-farmEnabled');
  const autoEmploy = document.getElementById('toggle-autoEmploy');
  if (paused && document.activeElement !== paused) paused.checked = !!s.paused;
  if (farm && document.activeElement !== farm) farm.checked = !!s.farmEnabled;
  if (autoEmploy && document.activeElement !== autoEmploy) autoEmploy.checked = !!s.autoEmploy;
  const mode = document.getElementById('mode-override');
  if (mode && document.activeElement !== mode) mode.value = s.modeOverride ?? '';
  const maverick = document.getElementById('maverick-manual');
  if (maverick && document.activeElement !== maverick) {
    maverick.value = s.maverickManual === null ? '' : String(s.maverickManual);
  }
  const att = document.getElementById('d4tw-attacker');
  if (att && document.activeElement !== att) att.value = String(s.d4tw.targetDamageAttacker);
  const def = document.getElementById('d4tw-defender');
  if (def && document.activeElement !== def) def.value = String(s.d4tw.targetDamageDefender);
  const maxB = document.getElementById('d4tw-maxBattles');
  if (maxB && document.activeElement !== maxB) maxB.value = String(s.d4tw.maxBattlesPerSession);
  const edMaxB = document.getElementById('emptyDiv-maxBattles');
  if (edMaxB && document.activeElement !== edMaxB)
    edMaxB.value = String(s.emptyDiv?.maxBattlesPerSession ?? 3);
  const weapons = document.getElementById('d4tw-weapons');
  if (weapons) weapons.textContent = JSON.stringify(s.d4tw.weaponPriority);
  const aAttE = document.getElementById('d4twAir-attacker');
  if (aAttE && document.activeElement !== aAttE)
    aAttE.value = String(s.d4twAir?.targetDamageAttacker ?? 30000);
  const aDefE = document.getElementById('d4twAir-defender');
  if (aDefE && document.activeElement !== aDefE)
    aDefE.value = String(s.d4twAir?.targetDamageDefender ?? 50000);
  const aMaxBE = document.getElementById('d4twAir-maxBattles');
  if (aMaxBE && document.activeElement !== aMaxBE)
    aMaxBE.value = String(s.d4twAir?.maxBattlesPerSession ?? 1);
  const aUseWE = document.getElementById('d4twAir-useWeapon');
  if (aUseWE && document.activeElement !== aUseWE)
    aUseWE.checked = !!s.d4twAir?.useWeapon;
  const aWeapons = document.getElementById('d4twAir-weapons');
  if (aWeapons) aWeapons.textContent = JSON.stringify(s.d4twAir?.weaponPriority ?? [5, 4, 3, 2, 1]);
  const airRank = document.getElementById('detected-airRank');
  if (airRank) airRank.textContent = s.detected?.airRankNumber != null ? String(s.detected.airRankNumber) : '—';
  const cdMin = document.getElementById('cooldown-min');
  if (cdMin && document.activeElement !== cdMin) cdMin.value = String(s.farmSession?.cooldownMinMinutes ?? 30);
  const cdMax = document.getElementById('cooldown-max');
  if (cdMax && document.activeElement !== cdMax) cdMax.value = String(s.farmSession?.cooldownMaxMinutes ?? 90);
  const otEnabled = document.getElementById('ot-enabled');
  if (otEnabled && document.activeElement !== otEnabled) otEnabled.checked = !!s.workOvertime?.enabled;
  const otMode = document.getElementById('ot-mode');
  if (otMode && document.activeElement !== otMode) otMode.value = s.workOvertime?.mode ?? 'once-per-day';
}

bindControls();
bindRunNowButton();
