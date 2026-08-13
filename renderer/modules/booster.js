(() => {
  'use strict';

  const runtime = { config: null, busy: false, saveTimer: null };
  const byId = id => document.getElementById(id);
  const toast = message => window.coreShiftToast?.(String(message || 'Booster operation completed.'));

  function selectedConfig() {
    const config = { ...(runtime.config || {}) };
    document.querySelectorAll('[data-booster-option]').forEach(input => { config[input.dataset.boosterOption] = input.checked; });
    config.autoBoost = byId('autoBoostToggle').checked;
    return config;
  }

  async function loadState() {
    const response = await window.coreShiftAPI.getBoosterState();
    if (!response?.success) return setStatus(response?.message || 'Booster state is unavailable.');
    renderState(response);
  }

  function renderState(response) {
    const config = response.config || runtime.config || {};
    const session = response.session || {};
    runtime.config = config;
    document.querySelectorAll('[data-booster-option]').forEach(input => {
      if (typeof config[input.dataset.boosterOption] === 'boolean') input.checked = config[input.dataset.boosterOption];
    });
    byId('autoBoostToggle').checked = Boolean(config.autoBoost);
    renderGame(config.gamePath);
    byId('boostReleasedMemory').textContent = session.availableGainBytes ? formatBytes(session.availableGainBytes) : 'Not measured';
    byId('boostItemsOptimized').textContent = String(session.itemsOptimized || 0);
    byId('boostProcessesTrimmed').textContent = String(session.processCount || 0);
    byId('boostState').textContent = session.active ? 'ACTIVE' : 'READY';
    byId('boostBadge').textContent = session.active ? '● Boost active' : '● Ready';
    if (byId('boostPercent')) byId('boostPercent').textContent = session.active ? 'ON' : 'GO';
    byId('restoreBoostBtn').disabled = !session.active;
    byId('panel-boost').classList.toggle('active', Boolean(session.active));
    if (session.lastMessage) setStatus(session.lastMessage);
    if (session.gameDetected) byId('boostBadge').textContent = `● ${session.gameDetected} detected`;
  }

  function renderGame(gamePath) {
    const path = String(gamePath || '');
    const name = path.split(/[\\/]/).pop() || '';
    byId('boosterGameName').textContent = name ? name.replace(/\.exe$/i, '') : 'No game selected';
    byId('boosterGamePath').textContent = path || 'Choose a Windows game executable for automatic detection.';
    byId('launchBoosterGameBtn').disabled = !path;
  }

  async function saveConfig({ notify = false } = {}) {
    const response = await window.coreShiftAPI.saveBoosterConfig(selectedConfig());
    if (response?.success) {
      runtime.config = response.config;
      renderGame(response.config.gamePath);
      byId('autoBoostToggle').checked = Boolean(response.config.autoBoost);
      if (notify) toast(response.message);
    } else if (notify) toast(response?.message || 'Booster options could not be saved.');
    return response;
  }

  function scheduleSave() {
    clearTimeout(runtime.saveTimer);
    runtime.saveTimer = setTimeout(() => saveConfig(), 250);
  }

  async function applyBoost() {
    if (runtime.busy) return;
    setBusy(true, 'APPLYING', 'Applying reversible Windows gaming settings…');
    try {
      await saveConfig();
      const response = await window.coreShiftAPI.applyBooster(selectedConfig());
      if (response?.success) renderState(response);
      else setStatus(response?.message || 'The selected boost could not be applied.');
      toast(response?.message || 'Booster operation finished.');
      window.coreShiftAPI.getSystemStats?.().catch?.(() => {});
    } finally { setBusy(false); }
  }

  async function cleanRam() {
    if (runtime.busy) return;
    setBusy(true, 'CHECKING', 'Measuring RAM headroom without disturbing running programs…');
    try {
      const response = await window.coreShiftAPI.cleanRam();
      if (response?.success) {
        byId('boostReleasedMemory').textContent = formatBytes(response.availableGainBytes || 0);
        byId('boostProcessesTrimmed').textContent = String(response.processCount || 0);
        byId('boostItemsOptimized').textContent = '0';
      }
      setStatus(response?.message || 'RAM cleanup failed.');
      const settingsStatus = byId('ramCleanupStatus');
      if (settingsStatus) settingsStatus.textContent = response?.message || 'RAM cleanup failed.';
      toast(response?.message || 'RAM cleanup failed.');
    } finally { setBusy(false); }
  }

  async function restoreBoost() {
    if (runtime.busy || !window.confirm('Restore the power plan and Windows settings that were active before CoreShift Boost?')) return;
    setBusy(true, 'RESTORING', 'Restoring the previous Windows session settings…');
    try {
      const response = await window.coreShiftAPI.restoreBooster();
      renderState(response);
      toast(response?.message || 'Restore finished.');
    } finally { setBusy(false); }
  }

  async function chooseGame() {
    const response = await window.coreShiftAPI.chooseBoosterGame();
    if (response?.success) {
      runtime.config = response.config;
      renderGame(response.config.gamePath);
      toast(response.message);
    } else if (!response?.canceled) toast(response?.message || 'A game executable was not selected.');
  }

  async function launchGame() {
    if (runtime.busy) return;
    setBusy(true, 'LAUNCHING', 'Applying your profile and launching the saved game…');
    try {
      await saveConfig();
      const response = await window.coreShiftAPI.launchBoosterGame();
      if (response?.boost) renderState(response.boost);
      setStatus(response?.message || 'The saved game could not be launched.');
      toast(response?.message || 'Game launch failed.');
    } finally { setBusy(false); }
  }

  async function refreshProcesses() {
    const list = byId('boosterProcessList');
    if (!list) return;
    const response = await window.coreShiftAPI.listBoosterProcesses();
    if (!response?.success) return list.replaceChildren(empty(response?.message || 'Process information is unavailable.'));
    const rows = Array.isArray(response.rows) ? response.rows : [];
    if (!rows.length) return list.replaceChildren(empty('No background process information was returned.'));
    const fragment = document.createDocumentFragment();
    for (const process of rows) {
      const row = document.createElement('div');
      row.className = 'booster-process-row';
      const icon = document.createElement('i');
      icon.textContent = String(process.name || 'P').slice(0, 2).toUpperCase();
      const copy = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = process.name || 'Process';
      const detail = document.createElement('small');
      detail.textContent = `PID ${process.pid} · ${Number(process.cpu || 0).toFixed(1)}% CPU`;
      copy.append(name, detail);
      const memory = document.createElement('span');
      memory.textContent = `${Math.round(Number(process.memoryMb) || 0)} MB`;
      row.append(icon, copy, memory);
      fragment.append(row);
    }
    list.replaceChildren(fragment);
  }

  function setBusy(busy, state = '', message = '') {
    runtime.busy = busy;
    byId('panel-boost').classList.toggle('busy', busy);
    for (const id of ['boostBtn', 'cleanRamOnlyBtn', 'restoreBoostBtn', 'chooseBoosterGameBtn', 'launchBoosterGameBtn']) {
      const button = byId(id);
      if (button) button.disabled = busy || (id === 'launchBoosterGameBtn' && !runtime.config?.gamePath) || (id === 'restoreBoostBtn' && !byId('panel-boost').classList.contains('active'));
    }
    if (state) byId('boostState').textContent = state;
    if (message) setStatus(message);
  }

  function setStatus(message) { byId('boostStatus').textContent = String(message || ''); }
  function formatBytes(bytes) { return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : `${Math.max(0, bytes / 1048576).toFixed(0)} MB`; }
  function empty(message) { const node = document.createElement('div'); node.className = 'booster-empty'; node.textContent = message; return node; }

  function bindEvents() {
    byId('boostBtn').addEventListener('click', applyBoost);
    byId('cleanRamOnlyBtn').addEventListener('click', cleanRam);
    byId('restoreBoostBtn').addEventListener('click', restoreBoost);
    byId('chooseBoosterGameBtn').addEventListener('click', chooseGame);
    byId('launchBoosterGameBtn').addEventListener('click', launchGame);
    byId('refreshBoosterProcessesBtn').addEventListener('click', refreshProcesses);
    byId('autoBoostToggle').addEventListener('change', () => saveConfig({ notify: true }));
    document.querySelectorAll('[data-booster-option]').forEach(input => input.addEventListener('change', scheduleSave));
    byId('quickBoostBtn').addEventListener('click', () => { window.coreShiftShowPanel?.('boost'); applyBoost(); });
    const settingsRamButton = byId('cleanRamBtn');
    if (settingsRamButton) settingsRamButton.addEventListener('click', cleanRam);
  }

  async function init() {
    bindEvents();
    await Promise.all([loadState(), refreshProcesses()]);
    setInterval(() => {
      if (byId('panel-boost')?.classList.contains('visible') && !runtime.busy) loadState();
    }, 7000);
  }

  init().catch(error => setStatus(error.message));
  window.CoreShiftBooster = Object.freeze({ apply: applyBoost, refresh: loadState });
})();
