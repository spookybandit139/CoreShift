'use strict';

// Local-only VEIN dedicated-server controller. The renderer never gets direct
// filesystem or process access; all paths and launch arguments are validated here.
const CHANNELS = ['vein:status', 'vein:configure', 'vein:chooseInstall', 'vein:chooseSteamCmd', 'vein:install', 'vein:start', 'vein:stop', 'vein:restart', 'vein:openFolder'];
const APP_ID = '2131400';
const DEFAULTS = Object.freeze({
  installPath: '', steamCmdPath: '', serverName: 'CoreShift VEIN Server', password: '',
  maxPlayers: 16, gamePort: 7777, queryPort: 7778, bindAddress: '', adminSteamIds: ''
});

function registerVeinServerIpc({ ipcMain, dialog, shell, spawn, execFile, fs, path, getSettings, saveSettings, getMainWindow }) {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  let serverProcess = null;
  let output = [];

  const clean = value => String(value ?? '').replace(/[\r\n\0]/g, '').trim();
  const emit = line => {
    const entry = `[${new Date().toLocaleTimeString()}] ${clean(line)}`.slice(0, 1200);
    if (!entry.trim()) return;
    output = [...output, entry].slice(-500);
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send('vein:output', entry);
  };
  const config = () => ({ ...DEFAULTS, ...(getSettings().veinServer || {}) });
  const saveConfig = next => {
    const saved = { ...config(), ...sanitize(next) };
    saveSettings({ ...getSettings(), veinServer: saved });
    return saved;
  };
  const status = () => {
    const current = config();
    const executable = findExecutable(current.installPath);
    return {
      success: true, running: Boolean(serverProcess && !serverProcess.killed), pid: serverProcess?.pid || null,
      installed: Boolean(executable), executable: executable || '', config: publicConfig(current),
      output: output.slice(-250), message: serverProcess ? 'VEIN server is running.' : (executable ? 'VEIN server is ready to start.' : 'Choose an install folder, then install VEIN with SteamCMD.')
    };
  };
  const handle = (channel, action) => ipcMain.handle(channel, async (_event, payload) => {
    try { return await action(payload); } catch (error) { return { success: false, message: clean(error?.message || 'VEIN server operation failed.') }; }
  });

  function sanitize(value = {}) {
    const integer = (key, fallback, min, max) => Math.max(min, Math.min(max, Number.parseInt(value[key] ?? fallback, 10) || fallback));
    const steamIds = String(value.adminSteamIds ?? '').split(/[\s,;]+/).filter(id => /^\d{17}$/.test(id)).slice(0, 50).join('\n');
    return {
      installPath: clean(value.installPath).slice(0, 500), steamCmdPath: clean(value.steamCmdPath).slice(0, 500),
      serverName: clean(value.serverName || DEFAULTS.serverName).slice(0, 80), password: clean(value.password).slice(0, 80),
      maxPlayers: integer('maxPlayers', DEFAULTS.maxPlayers, 1, 64), gamePort: integer('gamePort', DEFAULTS.gamePort, 1024, 65535),
      queryPort: integer('queryPort', DEFAULTS.queryPort, 1024, 65535), bindAddress: clean(value.bindAddress).slice(0, 45), adminSteamIds: steamIds
    };
  }
  // This API is exposed only to CoreShift's local, context-isolated renderer so
  // an owner can review or replace the password they configured for their world.
  function publicConfig(current) { return { ...current, hasPassword: Boolean(current.password) }; }
  function findExecutable(root) {
    if (!root || !fs.existsSync(root)) return '';
    const candidates = [
      path.join(root, 'VeinServer.exe'), path.join(root, 'Vein', 'Binaries', 'Win64', 'VeinServer.exe'),
      path.join(root, 'Vein', 'Binaries', 'Win64', 'VeinServer-Win64-Test.exe'), path.join(root, 'Vein', 'Binaries', 'Win64', 'VeinServer-Win64-Shipping.exe')
    ];
    return candidates.find(candidate => fs.existsSync(candidate)) || '';
  }
  function gameIniPath(root) { return path.join(root, 'Vein', 'Saved', 'Config', 'WindowsServer', 'Game.ini'); }
  function patchSection(content, section, values) {
    const header = `[${section}]`;
    const start = content.search(new RegExp(`^${escapeRegex(header)}\\s*$`, 'mi'));
    let before = content; let body = '';
    if (start >= 0) {
      const afterStart = start + content.slice(start).search(/\r?\n/) + 1;
      const next = content.slice(afterStart).search(/^\s*\[/m);
      before = content.slice(0, afterStart); body = next >= 0 ? content.slice(afterStart, afterStart + next) : content.slice(afterStart);
      const tail = next >= 0 ? content.slice(afterStart + next) : '';
      for (const [key, value] of Object.entries(values)) {
        const line = `${key}=${value}`;
        const matcher = new RegExp(`^${escapeRegex(key)}=.*$`, 'mi');
        body = matcher.test(body) ? body.replace(matcher, line) : `${body.replace(/\s*$/, '')}\r\n${line}\r\n`;
      }
      return `${before}${body.replace(/\s*$/, '\r\n')}${tail}`;
    }
    const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\r\n');
    return `${content.replace(/\s*$/, '')}\r\n\r\n${header}\r\n${lines}\r\n`;
  }
  function writeConfiguration(current) {
    if (!current.installPath) throw new Error('Choose the VEIN installation folder first.');
    const file = gameIniPath(current.installPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const values = { ServerName: current.serverName, Password: current.password, MaxPlayers: current.maxPlayers };
    if (current.adminSteamIds) values.AdminSteamIDs = current.adminSteamIds.split('\n')[0];
    content = patchSection(content, '/Script/Vein.VeinGameSession', values);
    // Multiple entries are used by VEIN for multiple admins; keep existing valid entries and append new ones.
    const desiredAdmins = current.adminSteamIds.split('\n').filter(Boolean);
    if (desiredAdmins.length > 1) {
      const extra = desiredAdmins.slice(1).map(id => `AdminSteamIDs=${id}`).join('\r\n');
      content = content.replace(/(\[\/Script\/Vein\.VeinGameSession\][\s\S]*?)(?=\r?\n\s*\[|$)/i, match => `${match.replace(/\s*$/, '')}\r\n${extra}\r\n`);
    }
    fs.writeFileSync(file, content, 'utf8');
    return file;
  }
  function launchArgs(current) {
    const args = ['-log', `-Port=${current.gamePort}`, `-QueryPort=${current.queryPort}`, `-MaxPlayers=${current.maxPlayers}`];
    if (current.bindAddress) args.push(`-multihome=${current.bindAddress}`);
    return args;
  }
  async function chooseInstall() {
    const result = await dialog.showOpenDialog(getMainWindow(), { title: 'Choose VEIN server folder', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true };
    const next = saveConfig({ installPath: path.resolve(result.filePaths[0]) });
    return { success: true, config: publicConfig(next), message: 'VEIN server folder selected.' };
  }
  async function chooseSteamCmd() {
    const result = await dialog.showOpenDialog(getMainWindow(), { title: 'Choose steamcmd.exe', properties: ['openFile'], filters: [{ name: 'SteamCMD', extensions: ['exe'] }] });
    if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true };
    const selected = path.resolve(result.filePaths[0]);
    if (path.basename(selected).toLowerCase() !== 'steamcmd.exe') throw new Error('Choose steamcmd.exe.');
    const next = saveConfig({ steamCmdPath: selected });
    return { success: true, config: publicConfig(next), message: 'SteamCMD selected.' };
  }
  async function install() {
    const current = config();
    if (!current.installPath) throw new Error('Choose where VEIN should be installed first.');
    if (!current.steamCmdPath || !fs.existsSync(current.steamCmdPath)) throw new Error('Choose a valid steamcmd.exe first.');
    if (serverProcess) throw new Error('Stop VEIN before installing or updating it.');
    fs.mkdirSync(current.installPath, { recursive: true });
    emit('Starting SteamCMD install/update for VEIN dedicated server…');
    const child = spawn(current.steamCmdPath, ['+force_install_dir', current.installPath, '+login', 'anonymous', '+app_update', APP_ID, 'validate', '+quit'], { cwd: path.dirname(current.steamCmdPath), windowsHide: true });
    child.stdout?.on('data', data => emit(data.toString())); child.stderr?.on('data', data => emit(data.toString()));
    return await new Promise(resolve => child.once('close', code => {
      emit(code === 0 ? 'SteamCMD completed.' : `SteamCMD exited with code ${code}.`);
      resolve(code === 0 ? { success: true, message: 'VEIN dedicated server installed/updated.', ...status() } : { success: false, message: 'SteamCMD did not finish successfully. Review the console output.' });
    }));
  }
  async function start() {
    if (serverProcess) return status();
    const current = config(); const executable = findExecutable(current.installPath);
    if (!executable) throw new Error('VEIN server executable was not found. Install it with SteamCMD first.');
    const ini = writeConfiguration(current);
    emit(`Launching ${path.basename(executable)} using ${ini}`);
    serverProcess = spawn(executable, launchArgs(current), { cwd: path.dirname(executable), windowsHide: true });
    serverProcess.stdout?.on('data', data => emit(data.toString())); serverProcess.stderr?.on('data', data => emit(data.toString()));
    serverProcess.once('error', error => { emit(`Launch error: ${error.message}`); serverProcess = null; });
    serverProcess.once('close', code => { emit(`VEIN server stopped (code ${code ?? 'unknown'}).`); serverProcess = null; });
    return { success: true, message: 'VEIN server launch requested.', ...status() };
  }
  async function stop() {
    if (!serverProcess) return { success: true, message: 'VEIN server is already stopped.', ...status() };
    const pid = serverProcess.pid; emit('Stopping VEIN server…');
    await new Promise(resolve => execFile('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => resolve()));
    serverProcess = null;
    return { success: true, message: 'VEIN server stopped.', ...status() };
  }
  handle('vein:status', status); handle('vein:configure', payload => ({ success: true, config: publicConfig(saveConfig(payload)), message: 'VEIN settings saved.' }));
  handle('vein:chooseInstall', chooseInstall); handle('vein:chooseSteamCmd', chooseSteamCmd); handle('vein:install', install); handle('vein:start', start); handle('vein:stop', stop);
  handle('vein:restart', async () => { await stop(); return start(); });
  handle('vein:openFolder', async () => { const folder = config().installPath; if (!folder || !fs.existsSync(folder)) throw new Error('Choose an existing VEIN folder first.'); await shell.openPath(folder); return { success: true, message: 'Opened VEIN server folder.' }; });
  return { stop };
}

function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
module.exports = { registerVeinServerIpc, DEFAULTS };
