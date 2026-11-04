'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerVeinServerIpc } = require('../main/vein-server-ipc');

async function run() {
  const handlers = new Map();
  let settings = {};
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'coreshift-vein-'));
  try {
    registerVeinServerIpc({
      ipcMain: { removeHandler: channel => handlers.delete(channel), handle: (channel, callback) => handlers.set(channel, callback) },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, shell: { openPath: async () => '' },
      spawn: () => { throw new Error('Spawn should not run in configuration tests.'); },
      execFile: () => {}, fs, path, getSettings: () => settings, saveSettings: next => { settings = next; return settings; }, getMainWindow: () => null
    });
    for (const channel of ['vein:status', 'vein:configure', 'vein:install', 'vein:start', 'vein:stop', 'vein:restart']) assert.ok(handlers.has(channel), `Missing ${channel}`);
    const saved = await handlers.get('vein:configure')(null, {
      installPath: temp, steamCmdPath: 'C:\\Tools\\steamcmd.exe', serverName: 'My VEIN World', password: 'local-pass',
      maxPlayers: 999, gamePort: 7777, queryPort: 7778, bindAddress: '127.0.0.1', adminSteamIds: 'bad 76561198000000000 76561198000000001'
    });
    assert.equal(saved.success, true);
    assert.equal(settings.veinServer.maxPlayers, 64, 'Player cap must be bounded.');
    assert.equal(settings.veinServer.adminSteamIds, '76561198000000000\n76561198000000001', 'Only SteamID64 values are retained.');
    const status = await handlers.get('vein:status')();
    assert.equal(status.running, false);
    assert.equal(status.config.serverName, 'My VEIN World');
    const install = await handlers.get('vein:install')();
    assert.equal(install.success, false, 'SteamCMD must exist before it can be executed.');
    const start = await handlers.get('vein:start')();
    assert.equal(start.success, false, 'A server executable must exist before it can be launched.');
    console.log('VEIN server IPC configuration and launch guards passed.');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
