const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let settings = {};
let latestStats = { cpu: 0, ram: 0 };
let selectedFilePath = '';
let activeChannel = 'general';
let account;
let updateAutoCheckStarted = false;
let currentUpdateState = 'idle';
const TERMS_VERSION = '2026-07-device-audit-v2';
const DEFAULT_APPEARANCE = { theme: 'lime', accent: '#b7ff35', surface: 'midnight', saturation: 100, motion: true, glow: true, compact: false, scale: 100, roundness: 13, textSize: 'standard', sidebarWidth: 'standard', grid: true, contrast: false, shadows: true, transparency: true };

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => node.classList.remove('show'), 3000);
}
function setBootStatus(message) { const node = $('#bootStatus'); if (node) node.textContent = message; }
function setOnlineCopy(id, value) { const node = $(id); if (node) node.textContent = value; }
function renderMobileControlStatus(status = {}) {
  const running = Boolean(status.running);
  const badge = $('#mobileControlState');
  badge.dataset.state = running ? 'on' : 'off';
  badge.textContent = running ? 'ON' : 'OFF';
  $('#mobileControlPairing').hidden = !running;
  $('#mobileControlUrl').value = status.url || '';
  $('#startMobileControlBtn').hidden = running;
  $('#stopMobileControlBtn').hidden = !running;
  $('#mobileControlStatus').textContent = status.message || (running ? 'Wi-Fi Control Center is running.' : 'Wi-Fi Control Center is off.');
}
async function refreshMobileControlStatus() {
  try { renderMobileControlStatus(await window.coreShiftAPI.getMobileControlStatus()); }
  catch (error) { $('#mobileControlStatus').textContent = error.message || 'Wi-Fi Control Center is unavailable.'; }
}
async function refreshOnlineStatus() {
  const online = navigator.onLine;
  const badge = $('#onlineStatus');
  if (badge) {
    badge.classList.toggle('offline', !online);
    badge.innerHTML = online ? '<em></em> Connection available' : '<em></em> Offline mode';
  }
  if (!online) {
    setOnlineCopy('#onlineNetworkDetail', 'Offline mode');
    setOnlineCopy('#onlineNetworkCopy', 'CoreShift local tools are still available. Connect to a network for updates, platform links, Discord, and community features.');
  } else {
    try {
      const result = await window.coreShiftAPI.getNetworkInfo();
      const adapter = result?.adapters?.[0];
      if (!result?.success || !adapter) throw new Error(result?.message || 'No active adapter was returned.');
      const speed = adapter.speed ? ` at ${adapter.speed} Mbps` : '';
      setOnlineCopy('#onlineNetworkDetail', `${adapter.name || adapter.iface}${speed}`);
      setOnlineCopy('#onlineNetworkCopy', `Local adapter ${adapter.ip4 || 'address unavailable'}. Use Latency Lab for an actual game-server test.`);
    } catch (error) {
      setOnlineCopy('#onlineNetworkDetail', 'Connection details unavailable');
      setOnlineCopy('#onlineNetworkCopy', 'CoreShift could not read a usable network adapter. Local tools remain available.');
    }
  }
  const sharedChat = Boolean(settings.mysql?.database);
  setOnlineCopy('#onlineCommunityDetail', sharedChat ? 'MySQL community storage configured' : 'Local community storage');
  setOnlineCopy('#onlineCommunityCopy', sharedChat ? 'This desktop can read and post to the configured MySQL community database.' : 'Connect MySQL in Settings to host chat for your own community.');
  try {
    const result = await window.coreShiftAPI.getUpdateStatus();
    const update = result?.status || {};
    setOnlineCopy('#onlineUpdateDetail', update.currentVersion ? `CoreShift ${update.currentVersion}` : 'Update service ready');
    setOnlineCopy('#onlineUpdateCopy', update.message || 'Version checks use the configured secure release feed.');
  } catch {
    setOnlineCopy('#onlineUpdateDetail', 'Update status unavailable');
    setOnlineCopy('#onlineUpdateCopy', 'Open Settings to configure or check your secure release source.');
  }
}
function finishBoot() {
  const screen = $('#bootScreen');
  if (!screen) return;
  screen.classList.add('done');
  setTimeout(() => screen.remove(), 700);
}
function escapeHtml(value) { const node = document.createElement('div'); node.textContent = value || ''; return node.innerHTML; }
function setCoreModeActive(name, launcherView = 'library') {
  const buttons = $$('[data-top-panel]');
  const target = buttons.find(button => button.dataset.topPanel === name && (name !== 'launcher' || button.dataset.launcherView === launcherView))
    || buttons.find(button => button.dataset.topPanel === name);
  buttons.forEach(button => button.classList.toggle('active', button === target));
}
function showLauncherPage(pageName = 'library') {
  $$('[data-launcher-page]').forEach(page => {
    const selected = page.dataset.launcherPage === pageName;
    page.hidden = !selected;
    page.classList.toggle('active', selected);
  });
  $$('[data-launcher-page-button]').forEach(button => button.classList.toggle('active', button.dataset.launcherPageButton === pageName));
}
function showPanel(name) {
  if (name !== 'latency') window.LatencyLab?.onHide?.();
  if ((name === 'database' || name === 'pia') && account?.role !== 'admin') {
    toast(name === 'pia' ? 'The PIA channel is available to admins only.' : 'MySQL Studio is available to admins only.');
    name = 'overview';
  }
  if ((name === 'bot' || name === 'ipprivacy') && account?.username?.toLowerCase() !== 'spookybandit139') {
    toast((name === 'bot' ? 'The Bot Command Center' : 'Daily IP Privacy') + ' is available to Spookybandit139 only.');
    name = 'overview';
  }
  if (name === 'pia' && !$('#panel-pia')) {
    window.PIAChannel?.init().then(() => showPanel('pia')).catch(error => toast(error.message));
    return;
  }
  $$('.panel').forEach(node => node.classList.toggle('visible', node.id === 'panel-' + name));
  $$('.nav-btn').forEach(node => node.classList.toggle('active', node.dataset.panel === name));
  setCoreModeActive(name);
  if (name === 'monitor' || name === 'overview') refreshStats();
  if (name === 'chat') loadChat();
  if (name === 'clips') window.CoreShiftClipStudio?.refresh?.();
  if (name === 'crosshairs') loadCrosshairs();
  if (name === 'pia') window.PIAChannel?.onShow?.().catch(error => toast(error.message));
  if (name === 'latency') window.LatencyLab?.onShow?.();
  if (name === 'ipprivacy') loadIpPrivacyPanel().catch(error => renderIpPrivacyStatus({ state: 'error', message: error.message }));
}
window.coreShiftShowPanel = showPanel;
window.coreShiftToast = toast;
$$('.nav-btn').forEach(button => button.addEventListener('click', () => showPanel(button.dataset.panel)));
$$('[data-go]').forEach(button => button.addEventListener('click', () => showPanel(button.dataset.go)));
$$('[data-top-panel]').forEach(button => button.addEventListener('click', () => {
  const panel = button.dataset.topPanel;
  const launcherView = button.dataset.launcherView || 'library';
  if (panel === 'launcher') showLauncherPage(launcherView);
  showPanel(panel);
  setCoreModeActive(panel, launcherView);
}));
$$('[data-launcher-page-button], [data-launcher-page-jump]').forEach(button => button.addEventListener('click', () => {
  const page = button.dataset.launcherPageButton || button.dataset.launcherPageJump;
  if (!page) return;
  showLauncherPage(page);
  showPanel('launcher');
  setCoreModeActive('launcher', page);
}));

async function refreshStats() {
  try {
    const stats = await window.coreShiftAPI.getSystemStats();
    if (!stats || stats.error) throw new Error('System telemetry is unavailable.');
    const cpu = Math.round(stats.cpu?.load || 0);
    const used = (stats.mem.used / 1073741824).toFixed(1);
    const total = (stats.mem.total / 1073741824).toFixed(1);
    const ram = Math.round((stats.mem.used / stats.mem.total) * 100);
    const gpu = stats.gpu?.model || 'Graphics adapter not found';
    const os = (stats.os?.distro || 'Windows') + ' ' + (stats.os?.release || '');
    latestStats = { cpu, ram };
    $('#cpuLoad').innerHTML = cpu + '<i>%</i>'; $('#ramUsage').innerHTML = used + '<i> / ' + total + ' GB</i>';
    $('#cpuMeter').style.width = cpu + '%'; $('#ramMeter').style.width = ram + '%'; $('#gpuName').textContent = gpu;
    $('#monitorCpu').textContent = cpu + '%'; $('#monitorRam').textContent = used + ' / ' + total + ' GB';
    $('#monitorGpu').textContent = gpu; $('#monitorOs').textContent = os; $('#osInfo').textContent = os;
    $('#monitorCpuModel').textContent = (stats.cpu?.model || 'CPU') + ' · ' + (stats.cpu?.cores || '--') + ' cores';
    const disk = (stats.disks || []).find(item => String(item.mount || '').toUpperCase().startsWith('C:')) || (stats.disks || [])[0];
    $('#monitorDisk').textContent = disk ? (disk.available / 1073741824).toFixed(1) + ' GB free' : 'Unavailable';
    const network = (stats.network || [])[0];
    $('#monitorNetwork').textContent = network ? ((network.rx_sec || 0) / 1048576).toFixed(2) + ' MB/s' : 'Unavailable';
    $('#monitorAvailable').textContent = stats.mem.available ? (stats.mem.available / 1073741824).toFixed(1) + ' GB' : 'Unavailable';
  } catch (error) { $('#osInfo').textContent = error.message; }
}
$('#refreshStatsBtn').addEventListener('click', () => { refreshStats(); toast('Telemetry refreshed'); });
$('#monitorRefreshBtn').addEventListener('click', () => { refreshStats(); toast('System monitor refreshed'); });
$('#refreshOnlineStatusBtn').addEventListener('click', async () => { await refreshOnlineStatus(); toast('Connection status refreshed.'); });
$('#startMobileControlBtn').addEventListener('click', async () => {
  const result = await window.coreShiftAPI.startMobileControl();
  renderMobileControlStatus(result);
  toast(result.success ? 'Wi-Fi Control Center started. Open the link on your phone.' : (result.message || 'Wi-Fi Control Center could not start.'));
});
$('#stopMobileControlBtn').addEventListener('click', async () => {
  const result = await window.coreShiftAPI.stopMobileControl();
  renderMobileControlStatus(result);
  toast('Wi-Fi Control Center stopped and paired phones disconnected.');
});
$('#copyMobileControlUrlBtn').addEventListener('click', async () => {
  const value = $('#mobileControlUrl').value;
  if (!value) return toast('Start Wi-Fi Control Center first.');
  try { await navigator.clipboard.writeText(value); toast('Phone pairing link copied.'); }
  catch { $('#mobileControlUrl').select(); document.execCommand('copy'); toast('Phone pairing link copied.'); }
});
window.addEventListener('online', refreshOnlineStatus);
window.addEventListener('offline', refreshOnlineStatus);

function renderQueryResult(result) {
  if (!result.success) return toast(result.message);
  const rows = result.rows || []; const cols = rows.length ? Object.keys(rows[0]) : [];
  $('#queryResult').textContent = rows.length + ' rows returned';
  const table = $('#queryRows').closest('table');
  table.querySelector('thead').innerHTML = '<tr>' + cols.map(key => '<th>' + escapeHtml(key) + '</th>').join('') + '</tr>';
  $('#queryRows').innerHTML = rows.length ? rows.map(row => '<tr>' + cols.map(key => '<td>' + escapeHtml(String(row[key] ?? '')) + '</td>').join('') + '</tr>').join('') : '<tr><td>No rows returned</td></tr>';
}
$('#runQueryBtn').addEventListener('click', async () => renderQueryResult(await window.coreShiftAPI.runDatabaseQuery($('#queryEditor').value.trim())));
$('#connectDbBtn').addEventListener('click', () => { showPanel('settings'); $('#mysqlDatabase').focus(); });
async function refreshTables() {
  const result = await window.coreShiftAPI.getDatabaseTables();
  if (!result.success) return toast(result.message);
  $('#schemaTables').innerHTML = result.tables.map((name, i) => '<span class="' + (!i ? 'selected' : '') + '">▣ ' + escapeHtml(name) + '</span>').join('') || '<span>No tables</span>';
  $('#dbConnectionLabel').textContent = '⌄ ' + ($('#mysqlDatabase').value || 'database');
  $('#dbConnectionHost').textContent = $('#mysqlHost').value + ':' + $('#mysqlPort').value;
}
$('#refreshTablesBtn').addEventListener('click', refreshTables);
function setConnected(message) { ['#connectionStatus', '#chatConnection'].forEach(selector => { const node = $(selector); node.classList.add('connected'); node.innerHTML = '<i></i> ' + escapeHtml(message); }); }
async function connectMySql(config) {
  $('#mysqlHelp').textContent = 'Connecting…'; const result = await window.coreShiftAPI.connectDatabase(config); $('#mysqlHelp').textContent = result.message;
  if (result.success) {
    const session = await window.coreShiftAPI.getAccountSession();
    const restored = !account && Boolean(session.account);
    if (session.account) {
      account = session.account;
      renderAccount();
      $('#authModal').hidden = true;
      renderAdminAudit();
      if (restored) toast('Welcome back, ' + account.username + '.');
    }
    setConnected(result.message); refreshTables(); loadChat(); refreshOnlineStatus();
    await loadUpdateCenter();
    if (account?.role === 'admin') window.PIAChannel?.onShow?.().catch(error => toast(error.message));
    await recordConsentIfNeeded();
    if (!account && settings.termsVersion === TERMS_VERSION) $('#authModal').hidden = false;
  } else toast(result.message); return result;
}
$('#mysqlForm').addEventListener('submit', async event => { event.preventDefault(); await connectMySql({ host: $('#mysqlHost').value.trim(), port: Number($('#mysqlPort').value), user: $('#mysqlUser').value.trim(), password: $('#mysqlPassword').value, database: $('#mysqlDatabase').value.trim() }); });
$('#detectMysqlBtn').addEventListener('click', async () => {
  const result = await window.coreShiftAPI.detectDatabase(); $('#mysqlHelp').textContent = result.message;
  if (result.success) { $('#mysqlHost').value = result.config.host; $('#mysqlPort').value = result.config.port; $('#mysqlUser').value = result.config.user; $('#mysqlPassword').value = result.config.password; toast('MySQL detected. Enter a database name, then connect.'); }
});

function renderChatText(text) {
  const safe = escapeHtml(text);
  const gif = safe.match(/^(https?:\/\/[^\s]+\.gif(?:\?[^\s]*)?)$/i);
  return gif ? '<img src="' + gif[1] + '" alt="Shared GIF">' : safe.replace(/\n/g, '<br>');
}
function hexToRgb(hex) {
  const value = (hex || '#b7ff35').replace('#', '');
  const full = value.length === 3 ? value.split('').map(item => item + item).join('') : value;
  const number = parseInt(full, 16);
  return ((number >> 16) & 255) + ',' + ((number >> 8) & 255) + ',' + (number & 255);
}
function applyAppearance(appearance = {}) {
  appearance = { ...DEFAULT_APPEARANCE, ...appearance };
  const accent = appearance.accent;
  const surface = ['midnight', 'dark', 'ash', 'light'].includes(appearance.surface) ? appearance.surface : 'midnight';
  const saturation = Math.min(135, Math.max(55, Number(appearance.saturation) || 100));
  const scale = Math.min(115, Math.max(85, Number(appearance.scale) || 100));
  const roundness = Math.min(24, Math.max(4, Number(appearance.roundness) || 13));
  const textSize = ['small', 'standard', 'large'].includes(appearance.textSize) ? appearance.textSize : 'standard';
  const sidebarWidth = ['narrow', 'standard', 'wide'].includes(appearance.sidebarWidth) ? appearance.sidebarWidth : 'standard';
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-rgb', hexToRgb(accent));
  document.documentElement.style.setProperty('--ui-saturation', String(saturation / 100));
  document.documentElement.style.setProperty('--ui-scale', String(scale / 100));
  document.documentElement.style.setProperty('--ui-radius', roundness + 'px');
  document.body.classList.remove('surface-midnight', 'surface-dark', 'surface-ash', 'surface-light');
  document.body.classList.add('surface-' + surface);
  document.body.classList.remove('text-small', 'text-standard', 'text-large', 'sidebar-narrow', 'sidebar-standard', 'sidebar-wide');
  document.body.classList.add('text-' + textSize, 'sidebar-' + sidebarWidth);
  document.body.classList.toggle('compact-ui', Boolean(appearance.compact));
  document.body.classList.toggle('no-motion', appearance.motion === false);
  document.body.classList.toggle('no-accent-glow', appearance.glow === false);
  document.body.classList.toggle('no-background-grid', appearance.grid === false);
  document.body.classList.toggle('high-contrast-ui', Boolean(appearance.contrast));
  document.body.classList.toggle('flat-ui', appearance.shadows === false);
  document.body.classList.toggle('opaque-panels', appearance.transparency === false);
  $('#accentPicker').value = accent;
  $('#surfaceTheme').value = surface;
  $('#saturationRange').value = String(saturation);
  $('#saturationOutput').textContent = saturation + '%';
  $('#interfaceScaleRange').value = String(scale);
  $('#interfaceScaleOutput').textContent = scale + '%';
  $('#roundnessRange').value = String(roundness);
  $('#roundnessOutput').textContent = roundness + 'px';
  $('#textSizeSelect').value = textSize;
  $('#sidebarWidthSelect').value = sidebarWidth;
  $('#motionToggle').checked = appearance.motion !== false;
  $('#glowToggle').checked = appearance.glow !== false;
  $('#compactToggle').checked = Boolean(appearance.compact);
  $('#gridToggle').checked = appearance.grid !== false;
  $('#contrastToggle').checked = Boolean(appearance.contrast);
  $('#shadowsToggle').checked = appearance.shadows !== false;
  $('#transparencyToggle').checked = appearance.transparency !== false;
  $$('.theme-pick').forEach(button => button.classList.toggle('active', button.dataset.theme === appearance.theme));
}
async function saveAppearance(updates) {
  const appearance = { ...DEFAULT_APPEARANCE, ...(settings.appearance || {}), ...updates };
  settings = await window.coreShiftAPI.saveSettings({ appearance });
  applyAppearance(appearance);
}
$$('.theme-pick').forEach(button => button.addEventListener('click', () => {
  saveAppearance({ theme: button.dataset.theme, accent: button.dataset.accent });
}));
$('#accentPicker').addEventListener('input', event => saveAppearance({ theme: 'custom', accent: event.target.value }));
$('#surfaceTheme').addEventListener('change', event => saveAppearance({ surface: event.target.value }));
$('#saturationRange').addEventListener('input', event => { document.documentElement.style.setProperty('--ui-saturation', String(Number(event.target.value) / 100)); $('#saturationOutput').textContent = event.target.value + '%'; });
$('#saturationRange').addEventListener('change', event => saveAppearance({ saturation: Number(event.target.value) }));
$('#interfaceScaleRange').addEventListener('input', event => { document.documentElement.style.setProperty('--ui-scale', String(Number(event.target.value) / 100)); $('#interfaceScaleOutput').textContent = event.target.value + '%'; });
$('#interfaceScaleRange').addEventListener('change', event => saveAppearance({ scale: Number(event.target.value) }));
$('#roundnessRange').addEventListener('input', event => { document.documentElement.style.setProperty('--ui-radius', event.target.value + 'px'); $('#roundnessOutput').textContent = event.target.value + 'px'; });
$('#roundnessRange').addEventListener('change', event => saveAppearance({ roundness: Number(event.target.value) }));
$('#textSizeSelect').addEventListener('change', event => saveAppearance({ textSize: event.target.value }));
$('#sidebarWidthSelect').addEventListener('change', event => saveAppearance({ sidebarWidth: event.target.value }));
$('#motionToggle').addEventListener('change', event => saveAppearance({ motion: event.target.checked }));
$('#glowToggle').addEventListener('change', event => saveAppearance({ glow: event.target.checked }));
$('#compactToggle').addEventListener('change', event => saveAppearance({ compact: event.target.checked }));
$('#gridToggle').addEventListener('change', event => saveAppearance({ grid: event.target.checked }));
$('#contrastToggle').addEventListener('change', event => saveAppearance({ contrast: event.target.checked }));
$('#shadowsToggle').addEventListener('change', event => saveAppearance({ shadows: event.target.checked }));
$('#transparencyToggle').addEventListener('change', event => saveAppearance({ transparency: event.target.checked }));
$('#resetAppearanceBtn').addEventListener('click', async () => { settings = await window.coreShiftAPI.saveSettings({ appearance: { ...DEFAULT_APPEARANCE } }); applyAppearance(DEFAULT_APPEARANCE); toast('Appearance reset to CoreShift defaults.'); });
$('#surpriseBtn').addEventListener('click', () => {
  const options = [['boost', 'Time to turn it up.'], ['clips', 'Your next highlight is waiting.'], ['chat', 'See what the squad is up to.']];
  const pick = options[Math.floor(Math.random() * options.length)];
  toast(pick[1]); showPanel(pick[0]);
});
async function loadChat() {
  const result = await window.coreShiftAPI.loadChat(activeChannel); const box = $('#chatMessages');
  if (!result.success) { box.innerHTML = '<div class="chat-empty">' + escapeHtml(result.message) + '</div>'; return; }
  box.innerHTML = result.rows.map(row => '<article class="chat-message"><b>' + escapeHtml(row.author) + '</b><time>' + new Date(row.created_at).toLocaleString() + '</time><p>' + renderChatText(row.message) + '</p></article>').join('') || '<div class="chat-empty">No messages yet. Be the first to say hello.</div>'; box.scrollTop = box.scrollHeight;
}
$('#chatForm').addEventListener('submit', async event => { event.preventDefault(); const text = $('#chatText').value.trim(); if (!text) return; const result = await window.coreShiftAPI.sendChat({ channel: activeChannel, author: account?.username || $('#chatName').value.trim() || 'Player', text }); if (result.success) { $('#chatText').value = ''; loadChat(); } else toast(result.message); });

function applyAdmin(admin) { $('#welcomeTitle').textContent = admin.title || 'Ready to play?'; $('#welcomeDescription').textContent = admin.description || 'Your system is tuned and standing by.'; $('#brandName').innerHTML = escapeHtml(admin.brand || 'CoreShift').replace(/SHIFT$/i, '<span>SHIFT</span>'); }
$('#saveAdminBtn').addEventListener('click', async () => { const admin = { title: $('#adminTitle').value.trim(), description: $('#adminDescription').value.trim(), brand: $('#adminBrand').value.trim() }; settings = await window.coreShiftAPI.saveSettings({ admin }); applyAdmin(admin); toast('App content saved'); });
$('#overlayToggle').addEventListener('change', async event => { settings = await window.coreShiftAPI.saveSettings({ overlayEnabled: event.target.checked }); window.coreShiftAPI.toggleOverlay(event.target.checked); });
$('#saveVirusTotalBtn').addEventListener('click', async () => { settings = await window.coreShiftAPI.saveSettings({ virustotalApiKey: $('#virusTotalKey').value.trim() }); toast('VirusTotal API key saved locally'); });
function renderDiscordPresenceStatus(status) {
  const node = $('#discordPresenceStatus');
  node.textContent = status?.message || (status?.connected ? 'CoreShift is visible on Discord.' : 'Discord presence is disconnected.');
  node.classList.toggle('connected', Boolean(status?.published));
}
function discordPresenceFromForm() {
  return { enabled: $('#discordPresenceToggle').checked, clientId: $('#discordClientId').value.trim(), details: $('#discordDetails').value.trim(), state: $('#discordState').value.trim() };
}
async function saveDiscordPresence() {
  const discordPresence = discordPresenceFromForm();
  settings = await window.coreShiftAPI.saveSettings({ discordPresence });
  const result = discordPresence.enabled ? await window.coreShiftAPI.connectDiscordPresence(discordPresence) : await window.coreShiftAPI.disconnectDiscordPresence();
  renderDiscordPresenceStatus(result);
  toast(result.message || 'Discord presence settings saved.');
}
$('#saveDiscordPresenceBtn').addEventListener('click', saveDiscordPresence);
$('#discordPresenceToggle').addEventListener('change', async event => {
  if (!event.target.checked) await saveDiscordPresence();
});
window.coreShiftAPI.onDiscordPresenceStatus(renderDiscordPresenceStatus);

function renderDiscordBotStatus(botStatus = {}) {
  const state = botStatus.state || 'stopped';
  const badge = $('#discordBotState');
  const status = $('#discordBotStatus');
  if (!badge || !status) return;
  badge.dataset.state = state;
  badge.textContent = state.toUpperCase();
  status.textContent = botStatus.message || 'CoreShift bot is stopped.';
  status.classList.toggle('connected', Boolean(botStatus.connected));
  $('#startDiscordBotBtn').disabled = ['connecting', 'registering', 'online'].includes(state);
  $('#stopDiscordBotBtn').disabled = state === 'stopped';
  if (botStatus.sync) {
    const detail = 'Global ' + botStatus.sync.globalCount + '/' + botStatus.sync.expectedCount + (botStatus.sync.testGuildId ? ' | Test server ' + botStatus.sync.guildCount + '/' + botStatus.sync.expectedCount : '');
    const inspection = $('#discordCommandInspection');
    const removed = botStatus.sync.cleanup?.commandsRemoved ? ' | Removed ' + botStatus.sync.cleanup.commandsRemoved + ' stale guild command(s)' : '';
    inspection.textContent = detail + removed + (botStatus.sync.guildError ? ' | ' + botStatus.sync.guildError : '');
    inspection.className = 'bot-command-inspection ' + (botStatus.sync.globalCount === botStatus.sync.expectedCount ? 'good' : 'bad');
  }
}
function renderDiscordCommandInspection(inspection) {
  const node = $('#discordCommandInspection');
  if (!inspection) { node.textContent = 'Command inspection failed.'; node.className = 'bot-command-inspection bad'; return; }
  const parts = ['Global: ' + inspection.globalNames.length + '/' + inspection.expected.length];
  if (inspection.testGuildId) parts.push('Test server: ' + inspection.guildNames.length + '/' + inspection.expected.length);
  if (inspection.missingGlobal.length) parts.push('Missing global: /' + inspection.missingGlobal.join(', /'));
  if (inspection.missingGuild.length) parts.push('Missing test: /' + inspection.missingGuild.join(', /'));
  if (inspection.forbiddenGlobal?.length) parts.push('FORBIDDEN GLOBAL: /' + inspection.forbiddenGlobal.join(', /'));
  if (inspection.forbiddenGuild?.length) parts.push('FORBIDDEN TEST: /' + inspection.forbiddenGuild.join(', /'));
  if (inspection.guildError) parts.push('Test error: ' + inspection.guildError);
  node.textContent = parts.join(' | ');
  node.className = 'bot-command-inspection ' + (!inspection.missingGlobal.length && !inspection.missingGuild.length && !inspection.forbiddenGlobal?.length && !inspection.forbiddenGuild?.length ? 'good' : 'bad');
}
async function loadDiscordBotControls() {
  const result = await window.coreShiftAPI.getDiscordBotStatus();
  if (!result?.success) return renderDiscordBotStatus({ state: 'error', message: result?.message || 'Bot controls could not load.' });
  $('#discordBotApplicationId').value = result.config.applicationId;
  $('#discordBotGuildId').value = result.config.testGuildId || '';
  $('#discordBotAutoStart').checked = Boolean(result.config.enabled);
  $('#discordBotInviteUrl').value = result.inviteUrl;
  $('#discordBotToken').placeholder = result.config.hasToken ? 'Encrypted token saved - paste only to replace it' : 'Paste the token from Discord Developer Portal';
  const deck = $('#botCommandDeckList');
  if (deck && result.config.expectedCommands) {
    deck.replaceChildren(...result.config.expectedCommands.map(name => { const code = document.createElement('code'); code.textContent = '/' + name; return code; }));
  }
  renderDiscordBotStatus(result.status);
}
async function saveDiscordBotSettings() {
  const result = await window.coreShiftAPI.saveDiscordBotConfig({
    token: $('#discordBotToken').value.trim(),
    enabled: $('#discordBotAutoStart').checked,
    testGuildId: $('#discordBotGuildId').value.trim()
  });
  if (result.success) {
    $('#discordBotToken').value = '';
    await loadDiscordBotControls();
  }
  toast(result.message || (result.success ? 'Discord bot settings saved.' : 'Bot settings were not saved.'));
}
$('#saveDiscordBotBtn').addEventListener('click', saveDiscordBotSettings);
$('#startDiscordBotBtn').addEventListener('click', async () => {
  const result = await window.coreShiftAPI.startDiscordBot();
  if (result.status) renderDiscordBotStatus(result.status);
  toast(result.message);
});
$('#stopDiscordBotBtn').addEventListener('click', async () => {
  const result = await window.coreShiftAPI.stopDiscordBot();
  if (result.status) renderDiscordBotStatus(result.status);
  toast(result.message);
});
$('#registerDiscordCommandsBtn').addEventListener('click', async () => {
  const result = await window.coreShiftAPI.registerDiscordBotCommands();
  toast(result.message);
  if (result.success) {
    const inspection = await window.coreShiftAPI.inspectDiscordBotCommands();
    if (inspection.success) renderDiscordCommandInspection(inspection.inspection);
  }
  await loadDiscordBotControls();
});
$('#inspectDiscordCommandsBtn').addEventListener('click', async () => {
  const result = await window.coreShiftAPI.inspectDiscordBotCommands();
  if (result.success) renderDiscordCommandInspection(result.inspection);
  else { renderDiscordCommandInspection(null); toast(result.message); }
});
$('#openDiscordBotPortalBtn').addEventListener('click', () => {
  window.open('https://discord.com/developers/applications/1414846841371099156/bot', '_blank');
});
$('#inviteDiscordBotBtn').addEventListener('click', async () => {
  const result = await window.coreShiftAPI.getDiscordBotInvite();
  if (!result.success) return toast(result.message || 'Invite link unavailable.');
  window.open(result.inviteUrl, '_blank');
});
window.coreShiftAPI.onDiscordBotStatus(renderDiscordBotStatus);

function formatPrivacyDate(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString();
}
function renderIpPrivacyStatus(ipStatus = {}) {
  const badge = $('#ipPrivacyState');
  if (!badge) return;
  const state = ipStatus.state || 'idle';
  badge.dataset.state = state;
  badge.textContent = state.toUpperCase();
  $('#ipPrivacyStatus').textContent = ipStatus.message || 'Daily IP Privacy is ready.';
  if (ipStatus.publicIp) $('#currentPublicIp').textContent = ipStatus.publicIp;
  if (ipStatus.previousIp) $('#previousPublicIp').textContent = ipStatus.previousIp;
  $('#lastIpRotation').textContent = formatPrivacyDate(ipStatus.lastRotationAt, 'Never');
  $('#nextIpRotation').textContent = formatPrivacyDate(ipStatus.nextRunAt, 'Not scheduled');
  const busy = ['checking', 'rotating'].includes(state);
  $('#checkPublicIpBtn').disabled = busy;
  $('#rotateIpNowBtn').disabled = busy;
  $('#rotateIpNowBtn').textContent = state === 'rotating' ? 'Rotating...' : 'Rotate now';
}
async function refreshVpnProfiles(selectedName = '') {
  const result = await window.coreShiftAPI.listVpnProfiles();
  const select = $('#ipVpnProfile');
  if (!result.success) {
    select.innerHTML = '<option value="">No Windows VPN profiles detected</option>';
    $('#ipPrivacyStatus').textContent = result.message;
    return;
  }
  const profiles = result.profiles || [];
  select.replaceChildren(new Option('Select a Windows VPN profile', ''));
  for (const profile of profiles) select.append(new Option(profile.name + ' - ' + profile.connectionStatus + ' - ' + profile.tunnelType, profile.name));
  if (profiles.some(profile => profile.name === selectedName)) select.value = selectedName;
  if (!profiles.length) $('#ipPrivacyStatus').textContent = 'No Windows VPN profiles found. Add one in Windows Settings > Network & internet > VPN.';
}
async function loadIpPrivacyPanel() {
  const result = await window.coreShiftAPI.getIpPrivacyStatus();
  if (!result.success) return renderIpPrivacyStatus({ state: 'error', message: result.message });
  $('#ipRotationTime').value = result.config.dailyTime || '04:00';
  $('#ipRotationEnabled').checked = Boolean(result.config.enabled);
  await refreshVpnProfiles(result.config.profileName || '');
  renderIpPrivacyStatus({ ...result.status, publicIp: result.config.publicIp, previousIp: result.config.previousIp, lastRotationAt: result.config.lastRotationAt });
}
$('#refreshVpnProfilesBtn').addEventListener('click', () => refreshVpnProfiles($('#ipVpnProfile').value).catch(error => toast(error.message)));
$('#openVpnSettingsBtn').addEventListener('click', async () => {
  const result = await window.coreShiftAPI.openWindowsVpnSettings();
  if (!result.success) toast(result.message);
});
$('#saveIpPrivacyBtn').addEventListener('click', async () => {
  const result = await window.coreShiftAPI.saveIpPrivacyConfig({ enabled: $('#ipRotationEnabled').checked, profileName: $('#ipVpnProfile').value, dailyTime: $('#ipRotationTime').value });
  if (result.status) renderIpPrivacyStatus(result.status);
  toast(result.message || (result.success ? 'Daily IP schedule saved.' : 'Could not save the schedule.'));
});
$('#checkPublicIpBtn').addEventListener('click', async () => {
  renderIpPrivacyStatus({ state: 'checking', message: 'Checking the current public IP...' });
  const result = await window.coreShiftAPI.checkPublicIp();
  if (result.status) renderIpPrivacyStatus(result.status);
  else renderIpPrivacyStatus({ state: result.success ? 'idle' : 'error', publicIp: result.publicIp, message: result.message });
  if (!result.success) toast(result.message);
});
$('#rotateIpNowBtn').addEventListener('click', async () => {
  if (!window.confirm('Reconnect the selected VPN now? Active games, calls, downloads, and remote database sessions may disconnect.')) return;
  renderIpPrivacyStatus({ state: 'rotating', message: 'Reconnecting the selected VPN profile...' });
  const result = await window.coreShiftAPI.rotatePublicIp();
  if (result.status) renderIpPrivacyStatus(result.status);
  toast(result.message);
});
window.coreShiftAPI.onIpPrivacyStatus(renderIpPrivacyStatus);

function renderUpdateStatus(updateStatus = {}) {
  const state = updateStatus.state || 'idle';
  currentUpdateState = state;
  const percent = Math.max(0, Math.min(100, Number(updateStatus.percent) || 0));
  const busy = ['checking', 'downloading', 'installing'].includes(state);
  const labels = { idle: 'READY', checking: 'CHECKING', available: 'UPDATE FOUND', downloading: 'DOWNLOADING', current: 'CURRENT', ready: 'INSTALL READY', installing: 'INSTALLING', error: 'RETRY' };
  $('#currentAppVersion').textContent = updateStatus.currentVersion || '—';
  $('#updateStateBadge').textContent = labels[state] || state.toUpperCase();
  $('#updateProgressBar').style.width = percent + '%';
  $('#updateStatus').textContent = updateStatus.message || 'Ready to check for updates.';
  $('#checkUpdatesBtn').disabled = busy;
  $('#checkUpdatesBtn').textContent = state === 'checking' ? 'Checking…' : state === 'downloading' ? 'Downloading…' : 'Check for updates';
  $('#installUpdateBtn').hidden = !['available', 'ready'].includes(state);
  $('#installUpdateBtn').textContent = state === 'available' ? 'Download update' : 'Restart & install';
}

async function loadUpdateCenter() {
  const result = await window.coreShiftAPI.getUpdateConfiguration();
  if (result.status) renderUpdateStatus(result.status);
  const ownerPanel = $('[data-update-owner]');
  ownerPanel.hidden = !result.owner;
  if (!result.success) {
    $('#updateStatus').textContent = result.message || 'Connect MySQL to load the shared update source.';
    return;
  }
  $('#updateFeedUrl').value = result.config.feedUrl || '';
  $('#updateAutoCheck').checked = Boolean(result.config.autoCheck);
  if (result.config.autoCheck && result.config.feedUrl && !updateAutoCheckStarted) {
    updateAutoCheckStarted = true;
    setTimeout(() => window.coreShiftAPI.checkForUpdates(), 1200);
  }
}

$('#checkUpdatesBtn').addEventListener('click', async () => {
  const result = await window.coreShiftAPI.checkForUpdates();
  if (result.status) renderUpdateStatus(result.status);
  if (!result.success) toast(result.message);
});
$('#installUpdateBtn').addEventListener('click', async () => {
  const result = currentUpdateState === 'available'
    ? await window.coreShiftAPI.downloadUpdate()
    : await window.coreShiftAPI.installUpdate();
  if (result.status) renderUpdateStatus(result.status);
  if (!result.success) toast(result.message);
});
$('#saveUpdateConfigBtn').addEventListener('click', async () => {
  const result = await window.coreShiftAPI.saveUpdateConfiguration({ feedUrl: $('#updateFeedUrl').value.trim(), autoCheck: $('#updateAutoCheck').checked });
  toast(result.message);
  if (result.success) loadUpdateCenter();
});
window.coreShiftAPI.onUpdateStatus(renderUpdateStatus);
$('#feedbackForm').addEventListener('submit', async event => {
  event.preventDefault();
  const result = await window.coreShiftAPI.sendFeedback({ reason: $('#feedbackReason').value, message: $('#feedbackMessage').value });
  toast(result.message);
  if (result.success) event.target.reset();
});
function readCrosshairForm() {
  return { name: $('#crosshairName').value.trim(), shape: $('#crosshairShape').value, color: $('#crosshairColor').value, size: Number($('#crosshairSize').value), thickness: Number($('#crosshairThickness').value), gap: Number($('#crosshairGap').value) };
}
function previewCrosshair(preset = readCrosshairForm()) {
  const node = $('#crosshairPreview');
  node.className = 'crosshair-preview ' + preset.shape;
  node.style.setProperty('--crosshair-color', preset.color);
  node.style.setProperty('--crosshair-size', preset.size + 'px');
  node.style.setProperty('--crosshair-thickness', preset.thickness + 'px');
  node.style.setProperty('--crosshair-gap', preset.gap + 'px');
  if ($('#crosshairToggle').checked) window.coreShiftAPI.updateCrosshairOverlay(preset);
}
async function loadCrosshairs() {
  const result = await window.coreShiftAPI.listCrosshairs();
  const list = $('#crosshairList');
  if (!result.success) { list.innerHTML = '<small>' + escapeHtml(result.message) + '</small>'; return; }
  list.innerHTML = result.rows.map(row => '<div class="crosshair-row"><i style="--crosshair-color:' + escapeHtml(row.color) + '">＋</i><span><b>' + escapeHtml(row.name) + '</b><small>' + escapeHtml(row.shape) + ' · ' + row.size + ' px</small></span><button data-load-crosshair="' + row.id + '">Load</button><button data-delete-crosshair="' + row.id + '">×</button></div>').join('') || '<small>No presets yet — build your first one.</small>';
  $$('[data-load-crosshair]').forEach(button => button.addEventListener('click', () => { const preset = result.rows.find(row => String(row.id) === button.dataset.loadCrosshair); if (!preset) return; $('#crosshairName').value = preset.name; $('#crosshairShape').value = preset.shape; $('#crosshairColor').value = preset.color; $('#crosshairSize').value = preset.size; $('#crosshairThickness').value = preset.thickness; $('#crosshairGap').value = preset.gap_size; previewCrosshair({ ...preset, gap: preset.gap_size }); toast('Crosshair loaded'); }));
  $$('[data-delete-crosshair]').forEach(button => button.addEventListener('click', async () => { const deleted = await window.coreShiftAPI.deleteCrosshair(Number(button.dataset.deleteCrosshair)); if (deleted.success) loadCrosshairs(); else toast(deleted.message); }));
}
['#crosshairShape', '#crosshairColor', '#crosshairSize', '#crosshairThickness', '#crosshairGap'].forEach(selector => $(selector).addEventListener('input', previewCrosshair));
$('#crosshairToggle').addEventListener('change', async event => {
  const enabled = await window.coreShiftAPI.toggleCrosshair(event.target.checked);
  if (enabled) window.coreShiftAPI.updateCrosshairOverlay(readCrosshairForm());
});
$('#importCrosshairBtn').addEventListener('click', async () => {
  const result = await window.coreShiftAPI.importCrosshair();
  if (result.canceled) return;
  if (!result.success) return toast(result.message);
  const preset = result.preset;
  $('#crosshairName').value = preset.name; $('#crosshairShape').value = preset.shape; $('#crosshairColor').value = preset.color; $('#crosshairSize').value = preset.size; $('#crosshairThickness').value = preset.thickness; $('#crosshairGap').value = preset.gap;
  previewCrosshair(preset); toast('Preset imported. Save it to add it to your profile.');
});
$('#crosshairForm').addEventListener('submit', async event => { event.preventDefault(); const result = await window.coreShiftAPI.saveCrosshair(readCrosshairForm()); toast(result.message); if (result.success) loadCrosshairs(); });

function showScanResult(result) {
  const node = $('#scanResult');
  if (!result.success) { node.innerHTML = '<span class="bad">' + escapeHtml(result.message) + '</span>'; return; }
  if (result.stats) node.innerHTML = '<span class="' + (result.stats.malicious ? 'bad' : 'good') + '">Malicious: ' + (result.stats.malicious || 0) + ' · Suspicious: ' + (result.stats.suspicious || 0) + ' · Harmless: ' + (result.stats.harmless || 0) + '</span>';
  else node.textContent = result.message || 'Analysis queued.';
}
async function pollAnalysis(analysisId) { setTimeout(async () => { const result = await window.coreShiftAPI.getSecurityAnalysis({ analysisId, apiKey: settings.virustotalApiKey }); if (result.success && result.status === 'completed') showScanResult(result); else if (result.success) $('#scanResult').textContent = 'VirusTotal analysis is still queued. Check again shortly.'; }, 7000); }
$('#chooseFileBtn').addEventListener('click', async () => { const result = await window.coreShiftAPI.chooseSecurityFile(); if (!result.canceled) { selectedFilePath = result.filePath; $('#selectedFile').textContent = result.name; } });
$('#scanFileBtn').addEventListener('click', async () => { if (!selectedFilePath) return toast('Choose a file first'); const result = await window.coreShiftAPI.scanSecurityFile({ filePath: selectedFilePath, apiKey: settings.virustotalApiKey }); showScanResult(result); if (result.queued) pollAnalysis(result.analysisId); });
$('#scanUrlForm').addEventListener('submit', async event => { event.preventDefault(); const result = await window.coreShiftAPI.scanSecurityUrl({ url: $('#scanUrl').value.trim(), apiKey: settings.virustotalApiKey }); showScanResult(result); if (result.queued) pollAnalysis(result.analysisId); });

let frames = 0; let fpsTime = performance.now();
function fpsLoop() { frames++; const now = performance.now(); if (now - fpsTime > 1000) { window.coreShiftAPI.sendOverlayStats({ fps: Math.round(frames * 1000 / (now - fpsTime)), cpu: latestStats.cpu, ram: latestStats.ram }); frames = 0; fpsTime = now; } requestAnimationFrame(fpsLoop); }
function renderAccount() {
  const profile = $('.profile');
  profile.innerHTML = '<i id="profileInitial">' + escapeHtml((account?.username || 'G').slice(0, 1).toUpperCase()) + '</i><div><b id="profileName">' + escapeHtml(account?.username || 'Guest') + '</b><small id="profileRole">' + escapeHtml(account?.role || 'Sign in to chat') + '</small></div><button id="loginBtn">' + (account ? 'Account' : 'Log in') + '</button>';
  $('#loginBtn').addEventListener('click', () => {
    const signedIn = Boolean(account);
    $('#authModalTitle').textContent = signedIn ? 'Your account' : 'Sign in';
    $('#authHelp').textContent = signedIn ? 'You are signed in as ' + account.username + '. Your remembered session can be removed from this PC.' : 'Accounts use your connected MySQL database. Passwords are securely hashed.';
    $('#authForm').hidden = signedIn;
    $('#logoutBtn').hidden = !signedIn;
    $('#authStatus').textContent = '';
    $('#authModal').hidden = false;
  });
  $('#chatName').value = account?.username || '';
  $('#chatName').readOnly = Boolean(account);
  const owner = account?.username?.toLowerCase() === 'spookybandit139';
  const mysqlCard = $('#mysqlForm')?.closest('article');
  if (mysqlCard) mysqlCard.hidden = Boolean(account && !owner);
  const studioButton = $('.nav-btn[data-panel="database"]');
  if (studioButton) {
    studioButton.hidden = Boolean(account && account.role !== 'admin');
    studioButton.innerHTML = '<i>▦</i>MySQL Studio <small>ADMIN</small>';
  }
  const piaButton = $('.nav-btn[data-panel="pia"]');
  if (piaButton) piaButton.hidden = account?.role !== 'admin';
  if (account?.role === 'admin') window.PIAChannel?.init().catch(error => toast(error.message));
  const virusCard = $('#virusTotalKey')?.closest('article');
  if (virusCard) virusCard.hidden = Boolean(account && !owner);
  const updateOwner = $('[data-update-owner]');
  if (updateOwner) updateOwner.hidden = !owner;
  const discordBotCard = $('#discordBotCard');
  if (discordBotCard) {
    discordBotCard.hidden = !owner;
    if (owner) loadDiscordBotControls().catch(error => renderDiscordBotStatus({ state: 'error', message: error.message }));
  }
  const discordBotNav = $('#discordBotNav');
  if (discordBotNav) discordBotNav.hidden = !owner;
  const ipPrivacyNav = $('#ipPrivacyNav');
  if (ipPrivacyNav) ipPrivacyNav.hidden = !owner;
  $$('[data-go="database"]').forEach(button => button.hidden = Boolean(account && account.role !== 'admin'));
}
function setupAccountModal() {
  document.body.insertAdjacentHTML('beforeend', '<div id="authModal" class="auth-modal" hidden><div class="auth-card"><p>CORE<span>SHIFT</span> ACCOUNT</p><h2 id="authModalTitle">Sign in</h2><small id="authHelp">Accounts use your connected MySQL database. Passwords are securely hashed.</small><form id="authForm"><input id="authUsername" maxlength="40" placeholder="Username" required><input id="authPassword" type="password" minlength="8" placeholder="Password (8+ characters)" required><label class="remember-login"><input id="rememberLogin" type="checkbox" checked><span><b>Remember this login for 30 days</b><small>Uses an encrypted token on this Windows account. Your password is never saved.</small></span></label><button class="primary">Sign in</button><button type="button" id="registerBtn" class="outline">Create account</button></form><button type="button" id="logoutBtn" class="outline" hidden>Sign out on this PC</button><div id="authStatus"></div></div></div>');
  async function submit(register) {
    const payload = { username: $('#authUsername').value.trim(), password: $('#authPassword').value, remember: $('#rememberLogin').checked };
    const result = register ? await window.coreShiftAPI.registerAccount(payload) : await window.coreShiftAPI.loginAccount(payload);
    $('#authStatus').textContent = result.message || (result.success ? 'Signed in.' : 'Could not sign in.');
    if (result.success) { account = result.account; renderAccount(); $('#authModal').hidden = true; toast('Signed in as ' + account.username); renderAdminAudit(); }
  }
  $('#authForm').addEventListener('submit', event => { event.preventDefault(); submit(false); });
  $('#registerBtn').addEventListener('click', () => submit(true));
  $('#logoutBtn').addEventListener('click', async () => {
    const result = await window.coreShiftAPI.logoutAccount();
    $('#authStatus').textContent = result.message;
    if (!result.success) return;
    account = null;
    renderAccount();
    $('#authModalTitle').textContent = 'Sign in';
    $('#authHelp').textContent = 'Your remembered session was removed. Sign in to continue.';
    $('#authForm').hidden = false;
    $('#logoutBtn').hidden = true;
    $('#authPassword').value = '';
    renderAdminAudit();
  });
}
function setupTermsModal() {
  document.body.insertAdjacentHTML('beforeend', '<div id="termsModal" class="auth-modal" hidden><div class="auth-card terms-card"><p>CORE<span>SHIFT</span> TERMS</p><h2>Before you continue</h2><div class="terms-copy"><b>Privacy and audit notice</b><p>After you agree and sign in, CoreShift saves your account username, local network IP address, device hostname, random installation ID, and login time to the configured MySQL database.</p><p>For fraud prevention and account auditing, CoreShift also stores a one-way hashed device identifier derived from the system UUID. The raw hardware UUID and public IP address are not stored. VirusTotal scans are only sent when you explicitly start a scan.</p></div><label class="terms-check"><input id="termsAccept" type="checkbox"> <span>I have read and agree to the Terms, Privacy and Audit Notice.</span></label><button id="acceptTermsBtn" class="primary" disabled>Accept and continue</button><button id="declineTermsBtn" class="outline">Decline and exit</button></div></div>');
  $('#termsAccept').addEventListener('change', event => { $('#acceptTermsBtn').disabled = !event.target.checked; });
  $('#acceptTermsBtn').addEventListener('click', async () => {
    const installationId = settings.installationId || crypto.randomUUID();
    settings = await window.coreShiftAPI.saveSettings({ termsAcceptedAt: new Date().toISOString(), termsVersion: TERMS_VERSION, installationId });
    await recordConsentIfNeeded();
    $('#termsModal').hidden = true;
    if (!account) $('#authModal').hidden = false;
  });
  $('#declineTermsBtn').addEventListener('click', () => window.coreShiftAPI.closeWindow());
}
async function recordConsentIfNeeded() {
  if (settings.termsVersion !== TERMS_VERSION || settings.consentRecordedFor === TERMS_VERSION) return;
  const result = await window.coreShiftAPI.recordConsent(TERMS_VERSION);
  if (result.success) settings = await window.coreShiftAPI.saveSettings({ consentRecordedFor: TERMS_VERSION });
}
function setupChannels() {
  const channelList = $('.chat-layout aside');
  const title = $('.chat-layout article header b'); if (title) title.id = 'channelTitle';
  channelList.querySelectorAll('button').forEach((button, index) => { button.dataset.channel = ['general', 'clips', 'game-help', 'star-wars', 'tips'][index] || 'general'; button.addEventListener('click', () => { activeChannel = button.dataset.channel; channelList.querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button)); $('#channelTitle').textContent = '# ' + activeChannel; $('#chatText').placeholder = 'Message #' + activeChannel; loadChat(); }); });
}
async function renderAdminAudit() {
  let box = $('#adminAudit');
  if (!box && $('#saveAdminBtn')) { $('#saveAdminBtn').insertAdjacentHTML('afterend', '<div id="adminAudit" class="profile-login"></div>'); box = $('#adminAudit'); }
  if (!box) return;
  if (account?.username?.toLowerCase() !== 'spookybandit139') { box.textContent = 'Only Spookybandit139 can view login audit records or manage roles.'; return; }
  const result = await window.coreShiftAPI.getLoginAudit();
  if (!result.success) { box.textContent = result.message; return; }
  const users = await window.coreShiftAPI.getAccounts();
  box.innerHTML = '<b>Owner controls — recent local login audit</b>' + result.rows.map(row => '<div>' + escapeHtml(row.username) + ' · ' + escapeHtml(row.local_ip || 'local') + ' · device ' + escapeHtml((row.hardware_id || 'legacy').slice(0, 12)) + '… · ' + new Date(row.logged_in_at).toLocaleString() + '</div>').join('') + '<b class="role-title">Account roles</b>' + (users.rows || []).map(user => '<div class="role-row"><span>' + escapeHtml(user.username) + '</span><select data-role-user="' + escapeHtml(user.username) + '"><option value="member"' + (user.role === 'member' ? ' selected' : '') + '>member</option><option value="admin"' + (user.role === 'admin' ? ' selected' : '') + '>admin</option></select></div>').join('');
  $$('[data-role-user]').forEach(select => select.addEventListener('change', async () => { const change = await window.coreShiftAPI.setAccountRole({ username: select.dataset.roleUser, role: select.value }); toast(change.success ? 'Role updated' : change.message); if (!change.success) renderAdminAudit(); }));
}
async function initialize() {
  setBootStatus('Loading secure local preferences…');
  settings = await window.coreShiftAPI.getSettings(); const mysql = settings.mysql || {}; const admin = settings.admin || {};
  await refreshMobileControlStatus();
  $('#mysqlHost').value = mysql.host || '127.0.0.1'; $('#mysqlPort').value = mysql.port || 3306; $('#mysqlUser').value = mysql.user || 'root'; $('#mysqlPassword').value = mysql.password || ''; $('#mysqlDatabase').value = mysql.database || '';
  $('#adminTitle').value = admin.title || ''; $('#adminDescription').value = admin.description || ''; $('#adminBrand').value = admin.brand || ''; $('#virusTotalKey').value = settings.virustotalApiKey || ''; $('#overlayToggle').checked = Boolean(settings.overlayEnabled);
  const discordPresence = settings.discordPresence || {}; $('#discordPresenceToggle').checked = Boolean(discordPresence.enabled); $('#discordClientId').value = discordPresence.clientId || ''; $('#discordDetails').value = discordPresence.details || 'Using the CoreShift Desktop Suite'; $('#discordState').value = discordPresence.state || 'Game Control Center';
  applyAppearance(settings.appearance || DEFAULT_APPEARANCE);
  renderUpdateStatus((await window.coreShiftAPI.getUpdateStatus()).status);
  await refreshOnlineStatus();
  setupAccountModal(); setupTermsModal(); setupChannels(); account = (await window.coreShiftAPI.getAccountSession()).account; renderAccount(); renderAdminAudit(); if (!account && settings.termsVersion === TERMS_VERSION) $('#authModal').hidden = false;
  applyAdmin(admin); refreshStats(); fpsLoop(); if (settings.overlayEnabled) window.coreShiftAPI.toggleOverlay(true);
  if (window.LatencyLab) await window.LatencyLab.init();
  if (window.CoreShiftClipStudio) await window.CoreShiftClipStudio.init();
  if (discordPresence.enabled && discordPresence.clientId) renderDiscordPresenceStatus(await window.coreShiftAPI.connectDiscordPresence(discordPresence));
  else renderDiscordPresenceStatus(await window.coreShiftAPI.getDiscordPresenceStatus());
  previewCrosshair();
  if (mysql.database) { setBootStatus('Securing database connection…'); await connectMySql(mysql); } else { $('#authStatus').innerHTML = 'No database is configured yet. <button id="setupDbBtn">Set up MySQL</button>'; $('#setupDbBtn').addEventListener('click', () => { $('#authModal').hidden = true; showPanel('settings'); }); }
  setBootStatus(account ? 'Welcome back.' : 'Authentication required.');
  setTimeout(() => { finishBoot(); if (settings.termsVersion !== TERMS_VERSION) $('#termsModal').hidden = false; }, 450);
}
$('#minimizeBtn').addEventListener('click', () => window.coreShiftAPI.minimizeWindow());
$('#closeBtn').addEventListener('click', () => window.coreShiftAPI.closeWindow());
initialize();
