'use strict';

const assert = require('assert');
const { execFile, spawn } = require('child_process');
const si = require('systeminformation');
const { registerBoosterIpc, DEFAULT_CONFIG } = require('../main/booster-ipc');

async function run() {
  if (process.platform !== 'win32') return console.log('Windows booster smoke test skipped on this platform.');
  const handlers = new Map();
  let settings = {};
  const controller = registerBoosterIpc({
    ipcMain: {
      removeHandler(channel) { handlers.delete(channel); },
      handle(channel, callback) { handlers.set(channel, callback); }
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    clipboard: { clear() {} },
    execFile,
    spawn,
    systeminformation: si,
    getSettings: () => settings,
    saveSettings(next) { settings = next; return settings; },
    getMainWindow: () => null
  });

  let applied = false;
  try {
    const cleanup = await handlers.get('system:cleanRam')();
    assert.equal(cleanup.success, true, cleanup.message);
    assert.ok(cleanup.processCount >= 0);
    assert.ok(cleanup.releasedBytes >= 0);

    const config = Object.fromEntries(Object.keys(DEFAULT_CONFIG).map(key => [key, typeof DEFAULT_CONFIG[key] === 'boolean' ? false : '']));
    config.powerPlan = true;
    config.cpuCores = true;
    config.gameMode = true;
    const boost = await handlers.get('booster:apply')(null, { config });
    assert.equal(boost.success, true, boost.message);
    assert.equal(boost.session.active, true);
    applied = true;

    const restored = await handlers.get('booster:restore')();
    assert.equal(restored.success, true, restored.message);
    assert.equal(restored.session.active, false);
    applied = false;
    console.log(`Windows booster smoke test passed: ${cleanup.message}`);
  } finally {
    if (applied) await handlers.get('booster:restore')();
    controller.dispose();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
