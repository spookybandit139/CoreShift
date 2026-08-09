'use strict';

const crypto = require('crypto');

const CHANNELS = [
  'library:scan',
  'library:add',
  'library:favorite',
  'library:launch',
  'library:platforms',
  'library:platform:open',
  'library:destination:open'
];

const DESTINATIONS = Object.freeze({
  steamDeals: 'https://store.steampowered.com/search/?specials=1',
  epicFree: 'https://store.epicgames.com/free-games',
  xboxDeals: 'https://www.xbox.com/en-US/microsoft-store',
  ubisoftDeals: 'https://store.ubisoft.com/us/deals?lang=default',
  steamRemoteHelp: 'https://store.steampowered.com/remoteplay',
  xboxRemoteHelp: 'https://www.xbox.com/consoles/remote-play'
});

function registerGameLibraryIpc({ ipcMain, app, dialog, shell, execFile, spawn, fs, path, getSettings, saveSettings, getMainWindow }) {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  let games = [];

  function handle(channel, operation) {
    ipcMain.handle(channel, async (_event, payload) => {
      try { return await operation(payload); }
      catch (error) { return { success: false, message: cleanError(error) }; }
    });
  }

  function librarySettings() {
    const settings = getSettings();
    const saved = settings.gameLibrary || {};
    return {
      favorites: Array.isArray(saved.favorites) ? saved.favorites.map(String).slice(0, 500) : [],
      customGames: Array.isArray(saved.customGames) ? saved.customGames.filter(validCustomRecord).slice(0, 250) : [],
      lastPlayed: saved.lastPlayed && typeof saved.lastPlayed === 'object' ? saved.lastPlayed : {}
    };
  }

  function saveLibrary(next) {
    const settings = getSettings();
    saveSettings({ ...settings, gameLibrary: next });
    return next;
  }

  async function scanLibrary() {
    const saved = librarySettings();
    const [steam, epic] = await Promise.all([scanSteam(), scanEpic()]);
    const custom = saved.customGames
      .filter(record => fs.existsSync(record.path))
      .map(record => ({ id: record.id, name: record.name, platform: 'Custom', launchType: 'path', launchValue: record.path, installPath: path.dirname(record.path), addedAt: record.addedAt || '' }));
    const unique = new Map();
    for (const game of [...steam, ...epic, ...custom]) if (!unique.has(game.id)) unique.set(game.id, game);
    games = [...unique.values()]
      .map(game => ({ ...game, favorite: saved.favorites.includes(game.id), lastPlayed: saved.lastPlayed[game.id] || '' }))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || String(b.lastPlayed).localeCompare(String(a.lastPlayed)) || a.name.localeCompare(b.name));
    return { success: true, games: games.map(publicGame), counts: countPlatforms(games), scannedAt: new Date().toISOString() };
  }

  async function addGame() {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Add a game to CoreShift',
      properties: ['openFile'],
      filters: [{ name: 'Windows games', extensions: ['exe'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true };
    const executable = path.resolve(result.filePaths[0]);
    if (path.extname(executable).toLowerCase() !== '.exe' || !fs.existsSync(executable)) throw new Error('Choose an existing Windows .exe file.');
    const saved = librarySettings();
    const existing = saved.customGames.find(record => path.resolve(record.path).toLowerCase() === executable.toLowerCase());
    if (!existing) {
      saved.customGames.push({ id: `custom:${hash(executable.toLowerCase())}`, name: path.basename(executable, '.exe'), path: executable, addedAt: new Date().toISOString() });
      saveLibrary(saved);
    }
    const response = await scanLibrary();
    return { ...response, message: existing ? 'That game is already in your library.' : `${path.basename(executable, '.exe')} was added to My Library.` };
  }

  async function toggleFavorite(payload) {
    const id = String(payload?.id || '');
    if (!games.some(game => game.id === id)) throw new Error('That game is not in the current library.');
    const saved = librarySettings();
    const set = new Set(saved.favorites);
    if (set.has(id)) set.delete(id); else set.add(id);
    saved.favorites = [...set];
    saveLibrary(saved);
    return scanLibrary();
  }

  async function launchGame(payload) {
    if (!games.length) await scanLibrary();
    const game = games.find(item => item.id === String(payload?.id || ''));
    if (!game) throw new Error('That game is no longer in the scanned library. Refresh My Library and try again.');
    if (game.launchType === 'url') await shell.openExternal(game.launchValue);
    else {
      if (!fs.existsSync(game.launchValue)) throw new Error('The saved game executable no longer exists.');
      const child = spawn(game.launchValue, [], { cwd: path.dirname(game.launchValue), detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
    }
    const saved = librarySettings();
    saved.lastPlayed[game.id] = new Date().toISOString();
    saveLibrary(saved);
    return { success: true, message: `${game.name} is launching.`, id: game.id };
  }

  async function platformStatus() {
    const steamPath = await findSteamPath();
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const epicPath = firstExisting([
      path.join(programFilesX86, 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe'),
      path.join(programFiles, 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe')
    ]);
    const ubisoftPath = firstExisting([
      path.join(programFilesX86, 'Ubisoft', 'Ubisoft Game Launcher', 'UbisoftConnect.exe'),
      path.join(programFiles, 'Ubisoft', 'Ubisoft Game Launcher', 'UbisoftConnect.exe')
    ]);
    const xboxInstalled = await hasXboxApp();
    return {
      success: true,
      platforms: [
        { id: 'steam', name: 'Steam', installed: Boolean(steamPath), detail: steamPath || 'Steam client not detected' },
        { id: 'epic', name: 'Epic Games', installed: Boolean(epicPath), detail: epicPath || 'Epic Games Launcher not detected' },
        { id: 'xbox', name: 'Xbox', installed: xboxInstalled, detail: xboxInstalled ? 'Xbox app detected' : 'Xbox app not detected' },
        { id: 'ubisoft', name: 'Ubisoft Connect', installed: Boolean(ubisoftPath), detail: ubisoftPath || 'Ubisoft Connect not detected' }
      ]
    };
  }

  async function openPlatform(payload) {
    const id = String(payload?.id || '');
    const protocols = { steam: 'steam://open/main', epic: 'com.epicgames.launcher://store', xbox: 'ms-xbox://', ubisoft: 'uplay://' };
    if (!protocols[id]) throw new Error('Unknown game platform.');
    await shell.openExternal(protocols[id]);
    return { success: true, message: `${id[0].toUpperCase() + id.slice(1)} is opening.` };
  }

  async function openDestination(payload) {
    const id = String(payload?.id || '');
    if (id === 'steamBigPicture') {
      await shell.openExternal('steam://open/bigpicture');
      return { success: true, message: 'Steam Big Picture is opening for Remote Play.' };
    }
    if (id === 'windowsRemoteDesktop') {
      const child = spawn('mstsc.exe', [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return { success: true, message: 'Windows Remote Desktop is opening.' };
    }
    const destination = DESTINATIONS[id];
    if (!destination) throw new Error('Unknown CoreShift destination.');
    await shell.openExternal(destination);
    return { success: true, message: 'Opening the official page in your browser.' };
  }

  async function scanSteam() {
    const steamPath = await findSteamPath();
    if (!steamPath) return [];
    const libraries = new Set([steamPath]);
    const libraryFile = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
    try {
      const content = fs.readFileSync(libraryFile, 'utf8');
      for (const match of content.matchAll(/"path"\s+"([^"]+)"/gi)) libraries.add(match[1].replace(/\\\\/g, '\\'));
    } catch { /* The default Steam library still scans. */ }
    const output = [];
    for (const library of libraries) {
      const steamApps = path.join(library, 'steamapps');
      let manifests = [];
      try { manifests = fs.readdirSync(steamApps).filter(name => /^appmanifest_\d+\.acf$/i.test(name)); } catch { continue; }
      for (const manifest of manifests) {
        try {
          const content = fs.readFileSync(path.join(steamApps, manifest), 'utf8');
          const appId = acfValue(content, 'appid');
          const name = acfValue(content, 'name');
          const installDir = acfValue(content, 'installdir');
          if (!appId || !name || !installDir) continue;
          output.push({ id: `steam:${appId}`, name, platform: 'Steam', launchType: 'url', launchValue: `steam://rungameid/${appId}`, installPath: path.join(steamApps, 'common', installDir), appId });
        } catch { /* Skip a manifest while Steam is updating it. */ }
      }
    }
    return output;
  }

  async function scanEpic() {
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    const manifestFolder = path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
    let files = [];
    try { files = fs.readdirSync(manifestFolder).filter(name => name.endsWith('.item')); } catch { return []; }
    const output = [];
    for (const file of files) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(manifestFolder, file), 'utf8'));
        if (!manifest.DisplayName || !manifest.AppName || !manifest.InstallLocation) continue;
        output.push({
          id: `epic:${manifest.AppName}`,
          name: manifest.DisplayName,
          platform: 'Epic Games',
          launchType: 'url',
          launchValue: `com.epicgames.launcher://apps/${encodeURIComponent(manifest.AppName)}?action=launch&silent=true`,
          installPath: manifest.InstallLocation,
          appId: manifest.AppName
        });
      } catch { /* Skip incomplete launcher manifests. */ }
    }
    return output;
  }

  async function findSteamPath() {
    const candidates = [];
    try {
      const result = await exec('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
      const match = result.stdout.match(/SteamPath\s+REG_\w+\s+(.+)/i);
      if (match) candidates.push(match[1].trim().replace(/\//g, '\\'));
    } catch { /* Fall back to normal install paths. */ }
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    candidates.push(path.join(programFilesX86, 'Steam'), path.join(programFiles, 'Steam'));
    return firstExisting(candidates);
  }

  async function hasXboxApp() {
    try {
      const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "if(Get-AppxPackage Microsoft.GamingApp -ErrorAction SilentlyContinue){'yes'}"]);
      return /yes/i.test(result.stdout);
    } catch { return false; }
  }

  function exec(file, args) {
    return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout: stdout || '', stderr: stderr || '' })));
  }

  handle('library:scan', scanLibrary);
  handle('library:add', addGame);
  handle('library:favorite', toggleFavorite);
  handle('library:launch', launchGame);
  handle('library:platforms', platformStatus);
  handle('library:platform:open', openPlatform);
  handle('library:destination:open', openDestination);

  return { scan: scanLibrary };
}

function validCustomRecord(record) {
  return record && typeof record.id === 'string' && typeof record.name === 'string' && typeof record.path === 'string' && record.id.startsWith('custom:');
}

function publicGame(game) {
  return { id: game.id, name: game.name, platform: game.platform, installPath: game.installPath || '', favorite: Boolean(game.favorite), lastPlayed: game.lastPlayed || '' };
}

function countPlatforms(games) {
  const counts = { all: games.length, installed: games.length, favorites: 0, steam: 0, epic: 0, xbox: 0, ubisoft: 0, custom: 0 };
  for (const game of games) {
    if (game.favorite) counts.favorites++;
    const platform = game.platform.toLowerCase();
    if (platform.startsWith('steam')) counts.steam++;
    else if (platform.startsWith('epic')) counts.epic++;
    else if (platform.startsWith('xbox')) counts.xbox++;
    else if (platform.startsWith('ubisoft')) counts.ubisoft++;
    else counts.custom++;
  }
  return counts;
}

function acfValue(content, key) {
  return content.match(new RegExp(`"${key}"\\s+"([^"]*)"`, 'i'))?.[1]?.trim() || '';
}

function firstExisting(candidates) {
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || '';
}

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16); }
function cleanError(error) { return String(error?.message || 'Game library operation failed.').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500); }

module.exports = { registerGameLibraryIpc, CHANNELS, DESTINATIONS, countPlatforms, acfValue };
