const { app, BrowserWindow, ipcMain, desktopCapturer, shell, dialog, screen, safeStorage, globalShortcut, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const os = require('os');
const { pathToFileURL } = require('url');
const si = require('systeminformation');
const mysql = require('mysql2/promise');
const { registerPiaIpc } = require('./main/pia-ipc');
const { registerDiscordPresence } = require('./main/discord-presence');
const { registerUpdatesIpc } = require('./main/updates-ipc');
const { registerNetworkIpc } = require('./main/network-ipc');
const { registerClipEditorIpc } = require('./main/clip-editor-ipc');
const { registerDiscordBot } = require('./main/discord-bot');
const { registerIpPrivacy } = require('./main/ip-privacy');
const { registerBoosterIpc } = require('./main/booster-ipc');
const { registerGameLibraryIpc } = require('./main/game-library-ipc');
const { registerMobileControl } = require('./main/mobile-control');

let mainWindow;
let overlayWindow;
let crosshairWindow;
let dbConnection;
let activeAccount;
let discordBotController;
let ipPrivacyController;
let boosterController;
let gameLibraryController;
let mobileControlController;
const OWNER_USERNAME = 'spookybandit139';
const DISCORD_APPLICATION_ID = '1414846841371099156';
const REMEMBERED_SESSION_DAYS = 30;
function isOwner(account = activeAccount) { return account?.username?.toLowerCase() === OWNER_USERNAME; }
const defaultSettings = {
  mysql: { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '' },
  admin: { title: 'Ready to play?', description: 'Your system is tuned and standing by.', brand: 'CoreShift' },
  discordPresence: {
    enabled: true,
    clientId: DISCORD_APPLICATION_ID,
    details: 'Using the CoreShift Desktop Suite',
    state: 'Game Control Center'
  }
};

function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function getSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    const discordPresence = { ...defaultSettings.discordPresence, ...(saved.discordPresence || {}) };
    if (!discordPresence.clientId) discordPresence.clientId = DISCORD_APPLICATION_ID;
    return { ...defaultSettings, ...saved, discordPresence };
  }
  catch { return JSON.parse(JSON.stringify(defaultSettings)); }
}
function saveSettings(settings) {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

async function getSystemStats() {
  try {
    const [cpuLoad, mem, gpu, osInfo, cpu, disks, network] = await Promise.all([si.currentLoad(), si.mem(), si.graphics(), si.osInfo(), si.cpu(), si.fsSize(), si.networkStats()]);
    return { cpu: { load: cpuLoad.currentLoad, model: cpu.brand, cores: cpu.cores }, mem: { total: mem.total, used: mem.active, available: mem.available }, gpu: gpu.controllers?.[0] || null, os: osInfo, disks, network };
  } catch (err) { console.error('Stats error:', err); return { error: true }; }
}

async function getPreferredMobileAddress() {
  try {
    const adapters = await si.networkInterfaces();
    const isPrivateIpv4 = value => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(String(value || ''));
    const score = adapter => {
      const name = `${adapter.iface || ''} ${adapter.ifaceName || ''}`;
      const virtual = /wsl|docker|hyper-v|vmware|virtual|loopback|tailscale|zerotier/i.test(name);
      return (adapter.default ? 100 : 0) + (adapter.operstate === 'up' ? 10 : 0) + (virtual ? -50 : 5);
    };
    return adapters.filter(adapter => isPrivateIpv4(adapter.ip4) && !adapter.internal).sort((left, right) => score(right) - score(left))[0]?.ip4 || '';
  } catch (error) {
    console.error('Mobile Wi-Fi address lookup failed:', error);
    return '';
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 720, minWidth: 1024, minHeight: 600, backgroundColor: '#000000', frame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.loadFile('index.html');
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
    if (crosshairWindow && !crosshairWindow.isDestroyed()) crosshairWindow.close();
    mainWindow = null;
    if (process.platform !== 'darwin') app.quit();
  });
}

function createOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  overlayWindow = new BrowserWindow({
    width: 122, height: 52, x: 20, y: 20, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, focusable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.loadFile('overlay.html');
  overlayWindow.on('closed', () => { overlayWindow = null; });
  return overlayWindow;
}
function createCrosshairOverlay() {
  if (crosshairWindow && !crosshairWindow.isDestroyed()) return crosshairWindow;
  const display = screen.getPrimaryDisplay();
  crosshairWindow = new BrowserWindow({
    width: 160, height: 160, x: Math.round(display.bounds.x + display.bounds.width / 2 - 80), y: Math.round(display.bounds.y + display.bounds.height / 2 - 80),
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, focusable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  crosshairWindow.setAlwaysOnTop(true, 'screen-saver');
  crosshairWindow.setIgnoreMouseEvents(true);
  crosshairWindow.loadFile('crosshair-overlay.html');
  crosshairWindow.on('closed', () => { crosshairWindow = null; });
  return crosshairWindow;
}

async function ensureChatTable() {
  if (!dbConnection) throw new Error('Connect MySQL first.');
  await dbConnection.query('CREATE TABLE IF NOT EXISTS chat_messages (id INT AUTO_INCREMENT PRIMARY KEY, channel VARCHAR(64) NOT NULL, author VARCHAR(64) NOT NULL, message TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
}
async function ensureContentTable() {
  if (!dbConnection) throw new Error('Connect MySQL first.');
  await dbConnection.query('CREATE TABLE IF NOT EXISTS app_content (content_key VARCHAR(100) PRIMARY KEY, content_value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)');
}
async function ensureFeedbackTable() {
  if (!dbConnection) throw new Error('Connect MySQL first.');
  await dbConnection.query('CREATE TABLE IF NOT EXISTS user_feedback (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(40), reason VARCHAR(120), message TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
}
async function ensureCrosshairTable() {
  if (!dbConnection) throw new Error('Connect MySQL first.');
  await dbConnection.query('CREATE TABLE IF NOT EXISTS crosshair_presets (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(40) NOT NULL, name VARCHAR(80) NOT NULL, shape VARCHAR(20) NOT NULL, color VARCHAR(16) NOT NULL, size INT NOT NULL, thickness INT NOT NULL, gap_size INT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
}
async function ensureAccountsTables() {
  if (!dbConnection) throw new Error('Connect MySQL first.');
  await dbConnection.query('CREATE TABLE IF NOT EXISTS accounts (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(40) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL, role ENUM("admin","member") NOT NULL DEFAULT "member", created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_login TIMESTAMP NULL)');
  await dbConnection.query('CREATE TABLE IF NOT EXISTS login_audit (id INT AUTO_INCREMENT PRIMARY KEY, account_id INT NOT NULL, username VARCHAR(40) NOT NULL, local_ip VARCHAR(64), hostname VARCHAR(255), installation_id VARCHAR(64), hardware_id VARCHAR(64), logged_in_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  await dbConnection.query('CREATE TABLE IF NOT EXISTS auth_sessions (id BIGINT AUTO_INCREMENT PRIMARY KEY, account_id INT NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE, installation_id VARCHAR(64), expires_at DATETIME NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, revoked_at TIMESTAMP NULL, INDEX idx_auth_account (account_id), INDEX idx_auth_expiry (expires_at))');
  try { await dbConnection.query('ALTER TABLE login_audit ADD COLUMN installation_id VARCHAR(64)'); } catch {}
  try { await dbConnection.query('ALTER TABLE login_audit ADD COLUMN hardware_id VARCHAR(64)'); } catch {}
  await dbConnection.query('DELETE FROM auth_sessions WHERE expires_at <= NOW()');
}

function rememberedSessionPath() { return path.join(app.getPath('userData'), 'remembered-session.json'); }
function sessionTokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function readRememberedSession() {
  try {
    const record = JSON.parse(fs.readFileSync(rememberedSessionPath(), 'utf8'));
    if (!record.encryptedToken || !record.expiresAt || new Date(record.expiresAt).getTime() <= Date.now()) {
      fs.rmSync(rememberedSessionPath(), { force: true });
      return null;
    }
    if (!safeStorage.isEncryptionAvailable()) return null;
    const token = safeStorage.decryptString(Buffer.from(record.encryptedToken, 'base64'));
    return token ? { ...record, token } : null;
  } catch { return null; }
}
async function revokeRememberedSession() {
  const record = readRememberedSession();
  if (record && dbConnection) {
    try { await dbConnection.query('UPDATE auth_sessions SET revoked_at = NOW() WHERE token_hash = ?', [sessionTokenHash(record.token)]); } catch {}
  }
  try { fs.rmSync(rememberedSessionPath(), { force: true }); } catch {}
}
async function createRememberedSession(account) {
  await ensureAccountsTables();
  await revokeRememberedSession();
  if (!safeStorage.isEncryptionAvailable()) return false;
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + REMEMBERED_SESSION_DAYS * 24 * 60 * 60 * 1000);
  const installationId = getSettings().installationId || null;
  await dbConnection.query('INSERT INTO auth_sessions (account_id, token_hash, installation_id, expires_at) VALUES (?, ?, ?, ?)', [account.id, sessionTokenHash(token), installationId, expiresAt]);
  const record = {
    version: 1,
    accountId: account.id,
    expiresAt: expiresAt.toISOString(),
    encryptedToken: safeStorage.encryptString(token).toString('base64')
  };
  fs.writeFileSync(rememberedSessionPath(), JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  return true;
}
async function restoreRememberedSession() {
  if (activeAccount || !dbConnection) return activeAccount || null;
  const record = readRememberedSession();
  if (!record) return null;
  await ensureAccountsTables();
  const [rows] = await dbConnection.query('SELECT a.id, a.username, a.role, s.id AS session_id FROM auth_sessions s INNER JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > NOW() LIMIT 1', [sessionTokenHash(record.token)]);
  if (!rows[0]) {
    try { fs.rmSync(rememberedSessionPath(), { force: true }); } catch {}
    return null;
  }
  const role = rows[0].username.toLowerCase() === OWNER_USERNAME ? 'admin' : rows[0].role;
  if (role !== rows[0].role) await dbConnection.query('UPDATE accounts SET role = ? WHERE id = ?', [role, rows[0].id]);
  activeAccount = { id: rows[0].id, username: rows[0].username, role };
  await dbConnection.query('UPDATE auth_sessions SET last_used_at = NOW() WHERE id = ?', [rows[0].session_id]);
  return activeAccount;
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve(salt + ':' + key.toString('hex'))));
}
function passwordMatches(password, stored) {
  return new Promise((resolve, reject) => {
    const parts = stored.split(':');
    if (parts.length !== 2) return resolve(false);
    crypto.scrypt(password, parts[0], 64, (err, key) => err ? reject(err) : resolve(crypto.timingSafeEqual(Buffer.from(parts[1], 'hex'), key)));
  });
}
function getLocalIp() {
  const all = Object.values(os.networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal);
  return all?.address || '127.0.0.1';
}
async function writeLoginAudit(account) {
  const hardwareId = await getHardwareAuditId();
  await dbConnection.query('INSERT INTO login_audit (account_id, username, local_ip, hostname, installation_id, hardware_id) VALUES (?, ?, ?, ?, ?, ?)', [account.id, account.username, getLocalIp(), os.hostname(), getSettings().installationId || null, hardwareId]);
}
async function getHardwareAuditId() {
  try {
    const system = await si.system();
    const source = system.uuid || [system.manufacturer, system.model, os.hostname()].join('|');
    return crypto.createHash('sha256').update('CoreShift-device-audit-v2|' + source).digest('hex');
  } catch { return null; }
}
async function ensureConsentTable() {
  if (!dbConnection) throw new Error('Connect MySQL first.');
  await dbConnection.query('CREATE TABLE IF NOT EXISTS consent_audit (id INT AUTO_INCREMENT PRIMARY KEY, terms_version VARCHAR(64), local_ip VARCHAR(64), hostname VARCHAR(255), installation_id VARCHAR(64), hardware_id VARCHAR(64), accepted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
}

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('clips:saveReplayHotkey');
  });
  discordBotController.autoStart().catch(error => console.error('Discord bot auto-start failed:', error));
  ipPrivacyController.autoStart();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  if (crosshairWindow && !crosshairWindow.isDestroyed()) crosshairWindow.destroy();
  boosterController?.restoreOnExit();
  boosterController?.dispose();
  mobileControlController?.stop();
  discordBotController?.stop().catch(() => {});
  ipPrivacyController?.stop();
});

registerPiaIpc({
  ipcMain,
  fs,
  path,
  getDbConnection: () => dbConnection,
  getActiveAccount: () => activeAccount
});
registerDiscordPresence({ ipcMain, net, BrowserWindow, app });
registerUpdatesIpc({
  ipcMain,
  BrowserWindow,
  app,
  getDbConnection: () => dbConnection,
  getActiveAccount: () => activeAccount,
  ownerUsername: OWNER_USERNAME
});
registerNetworkIpc({ ipcMain, execFile, systeminformation: si });
registerClipEditorIpc({ ipcMain, app, fs, path, dialog, getMainWindow: () => mainWindow });
boosterController = registerBoosterIpc({ ipcMain, dialog, clipboard, execFile, spawn, systeminformation: si, getSettings, saveSettings, getMainWindow: () => mainWindow });
gameLibraryController = registerGameLibraryIpc({ ipcMain, app, dialog, shell, execFile, spawn, fs, path, getSettings, saveSettings, getMainWindow: () => mainWindow });
mobileControlController = registerMobileControl({
  ipcMain,
  getPreferredAddress: getPreferredMobileAddress,
  getBot: () => discordBotController?.getMobileStatus?.() || { success: false, message: 'Discord bot controls are still loading.' },
  startBot: () => discordBotController?.startFromMobile?.() || { success: false, message: 'Discord bot controls are not ready.' },
  stopBot: () => discordBotController?.stopFromMobile?.() || { success: false, message: 'Discord bot controls are not ready.' },
  syncBot: () => discordBotController?.syncFromMobile?.() || { success: false, message: 'Discord bot controls are not ready.' }
});
discordBotController = registerDiscordBot({
  ipcMain,
  BrowserWindow,
  app,
  fs,
  path,
  safeStorage,
  getSettings,
  saveSettings,
  getDbConnection: () => dbConnection,
  getActiveAccount: () => activeAccount,
  ownerUsername: OWNER_USERNAME
});
ipPrivacyController = registerIpPrivacy({
  ipcMain,
  BrowserWindow,
  shell,
  execFile,
  getSettings,
  saveSettings,
  getActiveAccount: () => activeAccount,
  ownerUsername: OWNER_USERNAME
});

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:close', () => app.quit());

ipcMain.handle('system:getStats', getSystemStats);

ipcMain.handle('clips:getSources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  return sources.map(source => ({ id: source.id, name: source.name }));
});
function clipsFolder() { return path.join(app.getPath('videos'), 'CoreShift Clips'); }
const CLIP_EXTENSIONS = new Set(['.webm', '.mp4', '.mov', '.m4v', '.mkv', '.avi', '.wmv']);
const CLIP_MIME_TYPES = { '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv' };
function resolveSavedClip(filePath) {
  const folder = path.resolve(clipsFolder());
  const resolved = path.resolve(String(filePath || ''));
  if (path.dirname(resolved) !== folder || !CLIP_EXTENSIONS.has(path.extname(resolved).toLowerCase())) throw new Error('That video is outside the CoreShift Clips folder or uses an unsupported format.');
  return resolved;
}
function clipFileName(requestedName) {
  const base = String(requestedName || 'clip').replace(/\.webm$/i, '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 80) || 'clip';
  return base + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.webm';
}
ipcMain.handle('clips:save', async (_event, payload) => {
  try {
    const arrayBuffer = payload?.arrayBuffer ?? payload;
    const buffer = Buffer.from(arrayBuffer);
    if (!buffer.length) throw new Error('The clip contains no video data.');
    if (buffer.length > 750 * 1024 * 1024) throw new Error('Clips are limited to 750 MB.');
    const folder = clipsFolder();
    fs.mkdirSync(folder, { recursive: true });
    const filePath = path.join(folder, clipFileName(payload?.name));
    fs.writeFileSync(filePath, buffer);
    if (payload?.metadata && typeof payload.metadata === 'object') {
      const metadata = JSON.stringify(payload.metadata).slice(0, 10000);
      fs.writeFileSync(filePath + '.json', metadata, 'utf8');
    }
    return { success: true, filePath, name: path.basename(filePath) };
  } catch (error) { return { success: false, message: error.message }; }
});
ipcMain.handle('clips:list', async () => {
  try {
    const folder = clipsFolder();
    await fs.promises.mkdir(folder, { recursive: true });
    const names = (await fs.promises.readdir(folder)).filter(name => CLIP_EXTENSIONS.has(path.extname(name).toLowerCase()));
    const clips = await Promise.all(names.map(async name => {
      const filePath = path.join(folder, name);
      const stats = await fs.promises.stat(filePath);
      let metadata = {};
      try { metadata = JSON.parse(await fs.promises.readFile(filePath + '.json', 'utf8')); } catch {}
      return { name, filePath, size: stats.size, modified: stats.mtime.toISOString(), metadata };
    }));
    clips.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    return { success: true, clips };
  } catch (error) { return { success: false, message: error.message }; }
});
ipcMain.handle('clips:read', async (_event, filePath) => {
  try {
    const resolved = resolveSavedClip(filePath);
    const stats = await fs.promises.stat(resolved);
    if (!stats.isFile()) throw new Error('That clip is not a file.');
    const extension = path.extname(resolved).toLowerCase();
    return { success: true, name: path.basename(resolved), filePath: resolved, fileUrl: pathToFileURL(resolved).href, mimeType: CLIP_MIME_TYPES[extension] || 'video/webm' };
  } catch (error) { return { success: false, message: error.message }; }
});
ipcMain.handle('clips:delete', async (_event, filePath) => {
  try {
    const resolved = resolveSavedClip(filePath);
    await fs.promises.unlink(resolved);
    await fs.promises.rm(resolved + '.json', { force: true }).catch(() => {});
    return { success: true, message: 'Clip deleted.' };
  } catch (error) { return { success: false, message: error.message }; }
});
/* Legacy-compatible folder action. */
ipcMain.handle('clips:openFolder', async () => {
  const folder = path.join(app.getPath('videos'), 'CoreShift Clips');
  fs.mkdirSync(folder, { recursive: true });
  const error = await shell.openPath(folder);
  return { success: !error, message: error || folder };
});

ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:save', (_event, updates) => saveSettings({ ...getSettings(), ...updates }));

ipcMain.handle('db:connect', async (_event, config) => {
  try {
    if (!config.database) throw new Error('Enter a database name.');
    if (!/^[A-Za-z0-9_]+$/.test(config.database)) throw new Error('Database names may use letters, numbers, and underscores only.');
    await dbConnection?.end();
    dbConnection = await mysql.createConnection({ host: config.host, port: Number(config.port), user: config.user, password: config.password });
    await dbConnection.query('CREATE DATABASE IF NOT EXISTS ??', [config.database]);
    await dbConnection.query('USE ??', [config.database]);
    await dbConnection.query('SELECT 1');
    await ensureChatTable();
    await ensureContentTable();
    await ensureFeedbackTable();
    await ensureAccountsTables();
    await restoreRememberedSession();
    const settings = getSettings();
    settings.mysql = config;
    saveSettings(settings);
    return { success: true, message: 'Connected to ' + config.database + '.' };
  } catch (err) {
    dbConnection = undefined;
    return { success: false, message: err.message || 'Could not connect to MySQL.' };
  }
});
ipcMain.handle('db:detect', async () => {
  const hosts = ['127.0.0.1', 'localhost'];
  const ports = [3306, 3307];
  for (const host of hosts) for (const port of ports) {
    try {
      const connection = await mysql.createConnection({ host, port, user: 'root', password: '' });
      await connection.end();
      return { success: true, config: { host, port, user: 'root', password: '' }, message: 'Detected MySQL at ' + host + ':' + port + '.' };
    } catch {}
  }
  return { success: false, message: 'Could not reach a default XAMPP MySQL server. Start MySQL in XAMPP, or enter your credentials manually.' };
});
ipcMain.handle('db:tables', async () => {
  if (!activeAccount || activeAccount.role !== 'admin') return { success: false, message: 'Admin role required for MySQL Studio.' };
  if (!dbConnection) return { success: false, message: 'Connect MySQL first.' };
  try {
    const [rows] = await dbConnection.query('SHOW TABLES');
    return { success: true, tables: rows.map(row => Object.values(row)[0]) };
  } catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('db:query', async (_event, sql) => {
  if (!activeAccount || activeAccount.role !== 'admin') return { success: false, message: 'Admin role required for MySQL Studio.' };
  if (!dbConnection) return { success: false, message: 'Connect MySQL in Settings first.' };
  try {
    const [rows] = await dbConnection.query(sql);
    return { success: true, rows: Array.isArray(rows) ? rows : [], affectedRows: rows.affectedRows || 0 };
  } catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('chat:load', async (_event, channel = 'general') => {
  if (!activeAccount) return { success: false, message: 'Sign in to access chat.' };
  try { await ensureChatTable(); const [rows] = await dbConnection.query('SELECT id, channel, author, message, created_at FROM chat_messages WHERE channel = ? ORDER BY id DESC LIMIT 100', [channel]); return { success: true, rows: rows.reverse() }; }
  catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('chat:send', async (_event, message) => {
  try {
    if (!activeAccount) throw new Error('Sign in to send messages.');
    await ensureChatTable();
    await dbConnection.query('INSERT INTO chat_messages (channel, author, message) VALUES (?, ?, ?)', [message.channel || 'general', activeAccount.username, message.text]);
    return { success: true };
  } catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('content:load', async () => {
  try {
    await ensureContentTable();
    const [rows] = await dbConnection.query('SELECT content_key, content_value FROM app_content');
    const content = {};
    rows.forEach(row => { try { content[row.content_key] = JSON.parse(row.content_value); } catch {} });
    return { success: true, content };
  } catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('content:save', async (_event, key, value) => {
  try {
    if (key !== 'docs') throw new Error('Invalid shared content type.');
    if (!activeAccount || (!isOwner() && activeAccount.role !== 'admin')) throw new Error('Admin role required to edit shared content.');
    await ensureContentTable();
    await dbConnection.query('INSERT INTO app_content (content_key, content_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE content_value = VALUES(content_value)', [key, JSON.stringify(value)]);
    return { success: true };
  } catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('feedback:send', async (_event, feedback) => {
  try {
    await ensureFeedbackTable();
    if (!feedback.message?.trim()) throw new Error('Enter feedback before submitting.');
    await dbConnection.query('INSERT INTO user_feedback (username, reason, message) VALUES (?, ?, ?)', [activeAccount?.username || 'Guest', feedback.reason || 'General feedback', feedback.message.trim()]);
    return { success: true, message: 'Thank you — your feedback was saved.' };
  } catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('crosshair:list', async () => {
  try {
    if (!activeAccount) throw new Error('Sign in to access crosshairs.');
    await ensureCrosshairTable();
    const [rows] = await dbConnection.query('SELECT id, username, name, shape, color, size, thickness, gap_size, created_at FROM crosshair_presets WHERE username = ? ORDER BY id DESC', [activeAccount.username]);
    return { success: true, rows };
  } catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('crosshair:save', async (_event, preset) => {
  try {
    if (!activeAccount) throw new Error('Sign in to save crosshairs.');
    await ensureCrosshairTable();
    if (!preset.name?.trim()) throw new Error('Name your crosshair.');
    await dbConnection.query('INSERT INTO crosshair_presets (username, name, shape, color, size, thickness, gap_size) VALUES (?, ?, ?, ?, ?, ?, ?)', [activeAccount.username, preset.name.trim(), preset.shape, preset.color, Number(preset.size), Number(preset.thickness), Number(preset.gap)]);
    return { success: true, message: 'Crosshair saved to MySQL.' };
  } catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('crosshair:delete', async (_event, id) => {
  try {
    if (!activeAccount) throw new Error('Sign in to manage crosshairs.');
    await ensureCrosshairTable();
    await dbConnection.query('DELETE FROM crosshair_presets WHERE id = ? AND username = ?', [id, activeAccount.username]);
    return { success: true };
  } catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('auth:register', async (_event, payload) => {
  try {
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(payload.username)) throw new Error('Use 3–40 letters, numbers, underscores, or hyphens.');
    if (!payload.password || payload.password.length < 8) throw new Error('Use a password with at least 8 characters.');
    await ensureAccountsTables();
    const role = payload.username.toLowerCase() === OWNER_USERNAME ? 'admin' : 'member';
    const passwordHash = await hashPassword(payload.password);
    const [insert] = await dbConnection.query('INSERT INTO accounts (username, password_hash, role, last_login) VALUES (?, ?, ?, NOW())', [payload.username, passwordHash, role]);
    activeAccount = { id: insert.insertId, username: payload.username, role };
    await writeLoginAudit(activeAccount);
    const remembered = payload.remember ? await createRememberedSession(activeAccount) : false;
    if (!payload.remember) await revokeRememberedSession();
    return { success: true, account: activeAccount, remembered, message: 'Account created. Role: ' + role + (remembered ? '. Remembered for 30 days.' : '.') };
  } catch (err) { return { success: false, message: err.code === 'ER_DUP_ENTRY' ? 'That username already exists.' : err.message }; }
});
ipcMain.handle('auth:login', async (_event, payload) => {
  try {
    await ensureAccountsTables();
    const [rows] = await dbConnection.query('SELECT id, username, password_hash, role FROM accounts WHERE username = ?', [payload.username]);
    if (!rows[0] || !await passwordMatches(payload.password || '', rows[0].password_hash)) throw new Error('Incorrect username or password.');
    // The named owner must never be left as a member because of an older account row.
    const role = rows[0].username.toLowerCase() === OWNER_USERNAME ? 'admin' : rows[0].role;
    if (role !== rows[0].role) await dbConnection.query('UPDATE accounts SET role = ? WHERE id = ?', [role, rows[0].id]);
    activeAccount = { id: rows[0].id, username: rows[0].username, role };
    await dbConnection.query('UPDATE accounts SET last_login = NOW() WHERE id = ?', [activeAccount.id]);
    await writeLoginAudit(activeAccount);
    const remembered = payload.remember ? await createRememberedSession(activeAccount) : false;
    if (!payload.remember) await revokeRememberedSession();
    return { success: true, account: activeAccount, remembered, message: remembered ? 'Signed in and remembered for 30 days.' : 'Signed in for this session.' };
  } catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('auth:session', async () => ({ account: await restoreRememberedSession() }));
ipcMain.handle('auth:logout', async () => {
  await revokeRememberedSession();
  activeAccount = null;
  return { success: true, message: 'Signed out and removed the remembered login from this PC.' };
});
ipcMain.handle('auth:audit', async () => {
  try {
    if (!isOwner()) throw new Error('Only Spookybandit139 can view login audit records.');
    await ensureAccountsTables();
    const [rows] = await dbConnection.query('SELECT username, local_ip, hostname, installation_id, hardware_id, logged_in_at FROM login_audit ORDER BY id DESC LIMIT 50');
    return { success: true, rows };
  } catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('audit:consent', async (_event, termsVersion) => {
  try {
    await ensureConsentTable();
    await dbConnection.query('INSERT INTO consent_audit (terms_version, local_ip, hostname, installation_id, hardware_id) VALUES (?, ?, ?, ?, ?)', [termsVersion, getLocalIp(), os.hostname(), getSettings().installationId || null, await getHardwareAuditId()]);
    return { success: true };
  } catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('auth:users', async () => {
  try {
    if (!isOwner()) throw new Error('Only Spookybandit139 can manage roles.');
    await ensureAccountsTables();
    const [rows] = await dbConnection.query('SELECT id, username, role, created_at, last_login FROM accounts ORDER BY username');
    return { success: true, rows };
  } catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('auth:setRole', async (_event, payload) => {
  try {
    if (!isOwner()) throw new Error('Only Spookybandit139 can manage roles.');
    if (!['admin', 'member'].includes(payload.role)) throw new Error('Invalid role.');
    if (String(payload.username).toLowerCase() === OWNER_USERNAME && payload.role !== 'admin') throw new Error('The owner account must remain an admin.');
    await ensureAccountsTables();
    await dbConnection.query('UPDATE accounts SET role = ? WHERE username = ?', [payload.role, payload.username]);
    return { success: true };
  } catch (err) { return { success: false, message: err.message }; }
});

ipcMain.handle('overlay:toggle', (_event, enabled) => {
  if (enabled) createOverlay();
  else overlayWindow?.close();
  return Boolean(enabled);
});
ipcMain.on('overlay:stats', (_event, stats) => overlayWindow?.webContents.send('overlay:stats', stats));
ipcMain.handle('crosshair:toggle', (_event, enabled) => {
  if (enabled) createCrosshairOverlay();
  else crosshairWindow?.close();
  return Boolean(enabled);
});
ipcMain.on('crosshair:updateOverlay', (_event, preset) => {
  const target = createCrosshairOverlay();
  target.webContents.send('crosshair:preset', preset);
  target.webContents.once('did-finish-load', () => target.webContents.send('crosshair:preset', preset));
});
ipcMain.handle('crosshair:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Crosshair preset', extensions: ['json'] }] });
  if (result.canceled) return { canceled: true };
  try {
    const source = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    const preset = { name: String(source.name || path.basename(result.filePaths[0], '.json')).slice(0, 80), shape: ['plus', 'dot', 'cross'].includes(source.shape) ? source.shape : 'plus', color: /^#[0-9a-f]{6}$/i.test(source.color || '') ? source.color : '#b7ff35', size: Math.min(56, Math.max(8, Number(source.size) || 28)), thickness: Math.min(8, Math.max(1, Number(source.thickness) || 3)), gap: Math.min(20, Math.max(0, Number(source.gap) || 6)) };
    return { success: true, preset };
  } catch { return { success: false, message: 'That file is not a valid CoreShift crosshair JSON preset.' }; }
});

ipcMain.handle('security:chooseFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
  return result.canceled ? { canceled: true } : { filePath: result.filePaths[0], name: path.basename(result.filePaths[0]) };
});
async function vtRequest(url, options, apiKey) {
  const response = await fetch(url, { ...options, headers: { 'x-apikey': apiKey, ...(options?.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'VirusTotal request failed (' + response.status + ').');
  return data;
}
ipcMain.handle('security:scanFile', async (_event, payload) => {
  try {
    if (!payload.apiKey) throw new Error('Add a VirusTotal API key in Settings first.');
    const stat = fs.statSync(payload.filePath);
    if (stat.size > 32 * 1024 * 1024) throw new Error('This checker supports files up to 32 MB.');
    const buffer = fs.readFileSync(payload.filePath);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    let report;
    try { report = await vtRequest('https://www.virustotal.com/api/v3/files/' + hash, { method: 'GET' }, payload.apiKey); }
    catch (err) {
      if (!String(err.message).includes('(404)')) throw err;
      const form = new FormData();
      form.append('file', new Blob([buffer]), path.basename(payload.filePath));
      const upload = await vtRequest('https://www.virustotal.com/api/v3/files', { method: 'POST', body: form }, payload.apiKey);
      return { success: true, queued: true, analysisId: upload.data.id, hash, message: 'File uploaded to VirusTotal. Analysis is queued.' };
    }
    return { success: true, hash, stats: report.data.attributes.last_analysis_stats, name: report.data.attributes.meaningful_name || path.basename(payload.filePath) };
  } catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('security:scanUrl', async (_event, payload) => {
  try {
    if (!payload.apiKey) throw new Error('Add a VirusTotal API key in Settings first.');
    const body = new URLSearchParams({ url: payload.url });
    const analysis = await vtRequest('https://www.virustotal.com/api/v3/urls', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, payload.apiKey);
    return { success: true, queued: true, analysisId: analysis.data.id, message: 'URL submitted to VirusTotal.' };
  } catch (err) { return { success: false, message: err.message }; }
});
ipcMain.handle('security:analysis', async (_event, payload) => {
  try {
    const analysis = await vtRequest('https://www.virustotal.com/api/v3/analyses/' + payload.analysisId, { method: 'GET' }, payload.apiKey);
    return { success: true, status: analysis.data.attributes.status, stats: analysis.data.attributes.stats };
  } catch (err) { return { success: false, message: err.message }; }
});
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-program-cache');
app.setPath('cache', path.join(app.getPath('userData'), 'Cache'));
