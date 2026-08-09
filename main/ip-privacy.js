'use strict';

const https = require('https');

const IPC_CHANNELS = [
  'ipPrivacy:status',
  'ipPrivacy:profiles',
  'ipPrivacy:config:save',
  'ipPrivacy:rotate',
  'ipPrivacy:publicIp',
  'ipPrivacy:openSettings'
];

function registerIpPrivacy({ ipcMain, BrowserWindow, shell, execFile, getSettings, saveSettings, getActiveAccount, ownerUsername }) {
  for (const channel of IPC_CHANNELS) ipcMain.removeHandler(channel);
  let timer = null;
  let rotating = false;
  let status = {
    state: 'idle',
    message: 'Daily IP Privacy is ready.',
    publicIp: '',
    previousIp: '',
    lastRotationAt: '',
    nextRunAt: ''
  };

  function requireOwner() {
    if (getActiveAccount()?.username?.toLowerCase() !== String(ownerUsername).toLowerCase()) {
      throw new Error('Daily IP Privacy is available to Spookybandit139 only.');
    }
  }

  function getConfig() {
    const saved = getSettings().ipPrivacy || {};
    return {
      enabled: Boolean(saved.enabled),
      profileName: String(saved.profileName || '').slice(0, 200),
      dailyTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(saved.dailyTime || '')) ? saved.dailyTime : '04:00',
      lastAttemptDate: String(saved.lastAttemptDate || ''),
      lastRotationAt: String(saved.lastRotationAt || ''),
      previousIp: String(saved.previousIp || ''),
      publicIp: String(saved.publicIp || ''),
      lastResult: String(saved.lastResult || '')
    };
  }

  function updateStatus(next) {
    const config = getConfig();
    status = { ...status, ...next, nextRunAt: config.enabled ? calculateNextRun(config).toISOString() : '' };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('ipPrivacy:statusChanged', status);
    }
    return status;
  }

  function runFile(file, args, timeout = 20000) {
    return new Promise((resolve, reject) => {
      execFile(file, args, { windowsHide: true, timeout }, (error, stdout, stderr) => {
        const output = String(stdout || stderr || '').trim();
        if (error) return reject(new Error(output || error.message));
        resolve(output);
      });
    });
  }

  async function listProfiles() {
    if (process.platform !== 'win32') throw new Error('Windows VPN profiles are only available on Windows.');
    const script = [
      '$items = @()',
      'try { $items += Get-VpnConnection -ErrorAction Stop } catch {}',
      'try { $items += Get-VpnConnection -AllUserConnection -ErrorAction Stop } catch {}',
      '$items | Sort-Object Name -Unique | Select-Object Name, ServerAddress, TunnelType, ConnectionStatus, RememberCredential, SplitTunneling | ConvertTo-Json -Compress'
    ].join('; ');
    const output = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (!output) return [];
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(profile => ({
      name: String(profile.Name || ''),
      serverAddress: String(profile.ServerAddress || ''),
      tunnelType: String(profile.TunnelType || ''),
      connectionStatus: String(profile.ConnectionStatus || 'Disconnected'),
      rememberCredential: Boolean(profile.RememberCredential),
      splitTunneling: Boolean(profile.SplitTunneling)
    })).filter(profile => profile.name);
  }

  function requestPublicIp() {
    return new Promise((resolve, reject) => {
      const request = https.get({
        hostname: 'api.ipify.org',
        path: '/?format=json',
        headers: { 'User-Agent': 'CoreShift-IP-Privacy/1.0', Accept: 'application/json' },
        timeout: 8000
      }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { if (body.length < 2048) body += chunk; });
        response.on('end', () => {
          try {
            if (response.statusCode !== 200) throw new Error('Public IP service returned HTTP ' + response.statusCode + '.');
            const ip = String(JSON.parse(body).ip || '').trim();
            if (!/^[0-9a-f:.]{3,64}$/i.test(ip)) throw new Error('Public IP service returned an invalid address.');
            resolve(ip);
          } catch (error) { reject(error); }
        });
      });
      request.on('timeout', () => request.destroy(new Error('Public IP check timed out.')));
      request.on('error', reject);
    });
  }

  async function saveConfig(payload) {
    requireOwner();
    const dailyTime = String(payload?.dailyTime || '').trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyTime)) throw new Error('Choose a valid daily rotation time.');
    const profiles = await listProfiles();
    const profileName = String(payload?.profileName || '').trim();
    if (profileName && !profiles.some(profile => profile.name === profileName)) throw new Error('Select a detected Windows VPN profile.');
    if (payload?.enabled && !profileName) throw new Error('Select a Windows VPN profile before enabling daily rotation.');
    const current = getSettings();
    const previous = getConfig();
    const config = { ...previous, enabled: Boolean(payload?.enabled), profileName, dailyTime };
    saveSettings({ ...current, ipPrivacy: config });
    return { success: true, config, status: updateStatus({ message: config.enabled ? 'Daily VPN rotation is armed.' : 'Daily VPN rotation is disabled.' }) };
  }

  async function rotateConnection(reason = 'manual') {
    if (rotating) return { success: false, message: 'A VPN rotation is already running.', status };
    const config = getConfig();
    if (!config.profileName) return { success: false, message: 'Select and save a Windows VPN profile first.', status };
    const profiles = await listProfiles();
    const profile = profiles.find(item => item.name === config.profileName);
    if (!profile) return { success: false, message: 'The saved Windows VPN profile no longer exists.', status };
    rotating = true;
    const attemptedAt = new Date();
    const attemptDate = localDateKey(attemptedAt);
    let beforeIp = '';
    try {
      updateStatus({ state: 'checking', message: 'Checking the current public IP...' });
      beforeIp = await requestPublicIp().catch(() => '');
      updateStatus({ state: 'rotating', previousIp: beforeIp, message: 'Reconnecting Windows VPN profile ' + profile.name + '...' });
      if (profile.connectionStatus.toLowerCase() === 'connected') {
        await runFile('rasdial.exe', [profile.name, '/disconnect']).catch(() => '');
        await delay(1200);
      }
      await runFile('rasdial.exe', [profile.name], 30000);
      await delay(3500);
      const afterIp = await requestPublicIp();
      const changed = Boolean(beforeIp && afterIp && beforeIp !== afterIp);
      const message = changed
        ? 'Public IP changed successfully through ' + profile.name + '.'
        : 'VPN reconnected, but the provider returned the same public IP.';
      const current = getSettings();
      const nextConfig = { ...getConfig(), lastAttemptDate: attemptDate, lastRotationAt: attemptedAt.toISOString(), previousIp: beforeIp, publicIp: afterIp, lastResult: message };
      saveSettings({ ...current, ipPrivacy: nextConfig });
      return { success: true, changed, beforeIp, afterIp, message, status: updateStatus({ state: changed ? 'changed' : 'same', message, previousIp: beforeIp, publicIp: afterIp, lastRotationAt: attemptedAt.toISOString() }) };
    } catch (error) {
      const message = cleanError(error) + ' Open Windows Settings > Network & internet > VPN and connect once with Remember credentials enabled.';
      const current = getSettings();
      const nextConfig = { ...getConfig(), lastAttemptDate: attemptDate, lastRotationAt: attemptedAt.toISOString(), previousIp: beforeIp, lastResult: message };
      saveSettings({ ...current, ipPrivacy: nextConfig });
      return { success: false, message, status: updateStatus({ state: 'error', message, previousIp: beforeIp, lastRotationAt: attemptedAt.toISOString() }) };
    } finally { rotating = false; }
  }

  async function scheduleTick() {
    const config = getConfig();
    updateStatus({ nextRunAt: calculateNextRun(config).toISOString() });
    if (!config.enabled || rotating || !config.profileName) return;
    const now = new Date();
    const [hours, minutes] = config.dailyTime.split(':').map(Number);
    const due = now.getHours() > hours || (now.getHours() === hours && now.getMinutes() >= minutes);
    if (due && config.lastAttemptDate !== localDateKey(now)) await rotateConnection('schedule');
  }

  ipcMain.handle('ipPrivacy:status', async () => {
    try {
      requireOwner();
      const config = getConfig();
      return { success: true, config, status: updateStatus({ publicIp: config.publicIp, previousIp: config.previousIp, lastRotationAt: config.lastRotationAt, message: config.lastResult || status.message }) };
    } catch (error) { return { success: false, message: cleanError(error) }; }
  });
  ipcMain.handle('ipPrivacy:profiles', async () => {
    try { requireOwner(); return { success: true, profiles: await listProfiles() }; }
    catch (error) { return { success: false, profiles: [], message: cleanError(error) }; }
  });
  ipcMain.handle('ipPrivacy:config:save', async (_event, payload) => {
    try { return await saveConfig(payload); }
    catch (error) { return { success: false, message: cleanError(error) }; }
  });
  ipcMain.handle('ipPrivacy:rotate', async () => {
    try { requireOwner(); return await rotateConnection('manual'); }
    catch (error) { return { success: false, message: cleanError(error), status }; }
  });
  ipcMain.handle('ipPrivacy:publicIp', async () => {
    try {
      requireOwner();
      const publicIp = await requestPublicIp();
      return { success: true, publicIp, status: updateStatus({ state: 'idle', publicIp, message: 'Public IP check completed.' }) };
    } catch (error) { return { success: false, message: cleanError(error) }; }
  });
  ipcMain.handle('ipPrivacy:openSettings', async () => {
    try { requireOwner(); await shell.openExternal('ms-settings:network-vpn'); return { success: true }; }
    catch (error) { return { success: false, message: cleanError(error) }; }
  });

  return {
    autoStart() {
      if (timer) clearInterval(timer);
      timer = setInterval(() => scheduleTick().catch(error => updateStatus({ state: 'error', message: cleanError(error) })), 60000);
      setTimeout(() => scheduleTick().catch(error => updateStatus({ state: 'error', message: cleanError(error) })), 8000);
    },
    stop() { if (timer) clearInterval(timer); timer = null; }
  };
}

function calculateNextRun(config) {
  const now = new Date();
  const [hours, minutes] = String(config.dailyTime || '04:00').split(':').map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next <= now || config.lastAttemptDate === localDateKey(now)) next.setDate(next.getDate() + 1);
  return next;
}
function localDateKey(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function cleanError(error) { return String(error?.message || error || 'IP privacy operation failed.').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500); }

module.exports = { registerIpPrivacy, calculateNextRun };
