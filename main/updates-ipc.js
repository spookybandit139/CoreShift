'use strict';

const { NsisUpdater } = require('electron-updater');

const CHANNELS = ['updates:config:get', 'updates:config:save', 'updates:check', 'updates:download', 'updates:install', 'updates:status'];
const CONTENT_KEY = 'update_config';
const DEFAULT_UPDATE_FEED = 'https://github.com/spookybandit139/CoreShift/releases/latest/download';

function registerUpdatesIpc({ ipcMain, BrowserWindow, app, getDbConnection, getActiveAccount, ownerUsername }) {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);

  let updater = null;
  let updaterFeed = '';
  let status = {
    state: 'idle',
    currentVersion: app.getVersion(),
    availableVersion: null,
    percent: 0,
    message: 'Ready to check for updates.'
  };

  function broadcast(next) {
    status = { ...status, ...next, currentVersion: app.getVersion() };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('updates:statusChanged', status);
    }
    return status;
  }

  function requireDatabase() {
    const connection = getDbConnection();
    if (!connection) throw new Error('Connect to CoreShift MySQL before checking for updates.');
    return connection;
  }

  async function ensureContentTable(connection) {
    await connection.query('CREATE TABLE IF NOT EXISTS app_content (content_key VARCHAR(100) PRIMARY KEY, content_value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)');
  }

  async function getConfiguration() {
    const connection = getDbConnection();
    if (!connection) return { feedUrl: DEFAULT_UPDATE_FEED, autoCheck: false };
    await ensureContentTable(connection);
    const [rows] = await connection.query('SELECT content_value FROM app_content WHERE content_key = ? LIMIT 1', [CONTENT_KEY]);
    if (!rows[0]) return { feedUrl: DEFAULT_UPDATE_FEED, autoCheck: false };
    try {
      const parsed = JSON.parse(rows[0].content_value);
      return { feedUrl: normalizeFeedUrl(parsed.feedUrl, true) || DEFAULT_UPDATE_FEED, autoCheck: Boolean(parsed.autoCheck) };
    } catch { return { feedUrl: DEFAULT_UPDATE_FEED, autoCheck: false }; }
  }

  function isOwner() {
    return getActiveAccount()?.username?.toLowerCase() === String(ownerUsername).toLowerCase();
  }

  function configureUpdater(feedUrl) {
    if (updater && updaterFeed === feedUrl) return updater;
    if (updater) updater.removeAllListeners();
    updaterFeed = feedUrl;
    updater = new NsisUpdater({ provider: 'generic', url: feedUrl });
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.on('checking-for-update', () => broadcast({ state: 'checking', percent: 0, message: 'Checking the CoreShift release channel...' }));
    updater.on('update-available', info => broadcast({ state: 'available', availableVersion: info.version, percent: 0, message: `CoreShift ${info.version} is available. Download it when you are ready.` }));
    updater.on('update-not-available', () => broadcast({ state: 'current', availableVersion: null, percent: 100, message: `CoreShift ${app.getVersion()} is up to date.` }));
    updater.on('download-progress', progress => broadcast({ state: 'downloading', percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)), message: `Downloading update — ${Math.round(progress.percent || 0)}%` }));
    updater.on('update-downloaded', info => broadcast({ state: 'ready', availableVersion: info.version, percent: 100, message: `CoreShift ${info.version} is ready. Restart to install it.` }));
    updater.on('error', error => broadcast({ state: 'error', percent: 0, message: cleanError(error) }));
    return updater;
  }

  ipcMain.handle('updates:config:get', async () => {
    try { return { success: true, config: await getConfiguration(), owner: isOwner(), status }; }
    catch (error) { return { success: false, owner: isOwner(), config: { feedUrl: '', autoCheck: false }, status, message: error.message }; }
  });

  ipcMain.handle('updates:config:save', async (_event, payload) => {
    try {
      if (!isOwner()) throw new Error('Only Spookybandit139 can change the CoreShift release source.');
      const connection = requireDatabase();
      await ensureContentTable(connection);
      const config = { feedUrl: normalizeFeedUrl(payload?.feedUrl), autoCheck: Boolean(payload?.autoCheck) };
      await connection.query('INSERT INTO app_content (content_key, content_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE content_value = VALUES(content_value)', [CONTENT_KEY, JSON.stringify(config)]);
      if (updater) updater.removeAllListeners();
      updater = null;
      updaterFeed = '';
      return { success: true, config, message: 'Update source saved to MySQL for every CoreShift user.' };
    } catch (error) { return { success: false, message: error.message }; }
  });

  ipcMain.handle('updates:check', async () => {
    try {
      if (!app.isPackaged) throw new Error('Update checks run only in an installed CoreShift build.');
      const config = await getConfiguration();
      broadcast({ state: 'checking', percent: 0, message: 'Checking the CoreShift release channel...' });
      await configureUpdater(config.feedUrl).checkForUpdates();
      return { success: true, status };
    } catch (error) {
      const next = broadcast({ state: 'error', percent: 0, message: cleanError(error) });
      return { success: false, status: next, message: next.message };
    }
  });

  ipcMain.handle('updates:download', async () => {
    try {
      if (!updater || status.state !== 'available') throw new Error('Check for an update before downloading it.');
      broadcast({ state: 'downloading', percent: 0, message: 'Downloading the CoreShift update…' });
      await updater.downloadUpdate();
      return { success: true, status };
    } catch (error) {
      const next = broadcast({ state: 'error', percent: 0, message: cleanError(error) });
      return { success: false, status: next, message: next.message };
    }
  });

  ipcMain.handle('updates:install', () => {
    if (!updater || status.state !== 'ready') return { success: false, message: 'Download an update before restarting.' };
    broadcast({ state: 'installing', message: 'Closing CoreShift and starting the update installer...' });
    setImmediate(() => updater.quitAndInstall(false, true));
    return { success: true, message: 'Restarting to install the update.' };
  });

  ipcMain.handle('updates:status', () => ({ success: true, status }));
}

function normalizeFeedUrl(value, allowBlank = false) {
  const input = String(value || '').trim();
  if (!input && allowBlank) return '';
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error('Enter a valid HTTPS update-source URL.'); }
  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw new Error('The update source must use HTTPS. Localhost HTTP is allowed for testing.');
  parsed.search = '';
  parsed.hash = '';
  if (parsed.hostname.toLowerCase() === 'github.com') {
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const owner = parts[0];
      const repository = parts[1].replace(/\.git$/i, '');
      const isLatestRelease = parts[2]?.toLowerCase() === 'releases' && parts[3]?.toLowerCase() === 'latest';
      parsed.pathname = isLatestRelease
        ? '/' + owner + '/' + repository + '/releases/latest/download'
        : '/' + owner + '/' + repository + '/releases/latest/download';
    }
  }
  return parsed.toString().replace(/\/$/, '');
}

function cleanError(error) {
  const message = String(error?.message || error || 'Update check failed.').replace(/[\r\n]+/g, ' ').trim();
  if (/ENOENT.*app-update\.yml/i.test(message)) return 'This installation is missing its updater configuration. Install the newest CoreShift setup once to repair automatic updates.';
  if (/404|latest\.yml/i.test(message)) return 'No published CoreShift update manifest was found at this release source.';
  if (/net::|ENOTFOUND|ECONN|ETIMEDOUT/i.test(message)) return 'CoreShift could not reach the update server. Check your connection and try again.';
  return message.slice(0, 240);
}

module.exports = { registerUpdatesIpc };
