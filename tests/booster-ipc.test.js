'use strict';

const assert = require('assert');
const fs = require('fs');
const { registerBoosterIpc, sanitizeConfig, DEFAULT_CONFIG, CHANNELS, extractGuid } = require('../main/booster-ipc');

async function run() {
  assert.equal(new Set(CHANNELS).size, CHANNELS.length);
  for (const channel of ['booster:state', 'booster:apply', 'booster:restore', 'booster:game:choose', 'booster:game:launch', 'booster:processes', 'system:cleanRam']) {
    assert.ok(CHANNELS.includes(channel), `Missing booster channel: ${channel}`);
  }

  const defaults = sanitizeConfig();
  assert.deepEqual(defaults, DEFAULT_CONFIG);
  assert.equal(defaults.cpuIdle, false, 'High-heat CPU idle mode must remain opt-in.');
  assert.equal(defaults.problemReports, false, 'Problem reporting changes must remain opt-in.');

  const configured = sanitizeConfig({
    autoBoost: true,
    gamePath: 'C:\\Games\\Example.exe',
    powerPlan: false,
    cpuIdle: true,
    clearClipboard: true,
    unknownOption: true
  });
  assert.equal(configured.autoBoost, true);
  assert.equal(configured.gamePath, 'C:\\Games\\Example.exe');
  assert.equal(configured.powerPlan, false);
  assert.equal(configured.cpuIdle, true);
  assert.equal(configured.clearClipboard, true);
  assert.equal(configured.unknownOption, undefined);

  assert.equal(sanitizeConfig({ autoBoost: true, gamePath: '' }).autoBoost, false);
  assert.equal(sanitizeConfig({ powerPlan: 'yes' }).powerPlan, true, 'Non-boolean input must not override the safe default.');
  assert.equal(extractGuid('Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e'), '381b4222-f694-41f0-9685-ff5bb260df2e');
  assert.equal(extractGuid('no scheme'), '');

  const source = fs.readFileSync(require.resolve('../main/booster-ipc'), 'utf8');
  assert.doesNotMatch(source, /Stop-Process|taskkill|TerminateProcess|Remove-Item\s+-Recurse/i, 'Booster must not terminate apps or recursively delete files.');
  assert.match(source, /restoreOnExit/);
  assert.match(source, /temporaryPowerScheme/);

  const handlers = new Map();
  let settings = {};
  const controller = registerBoosterIpc({
    ipcMain: {
      removeHandler(channel) { handlers.delete(channel); },
      handle(channel, callback) { handlers.set(channel, callback); }
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    clipboard: { clear() {} },
    execFile(_file, _args, _options, callback) { callback(new Error('Not used in state test.'), '', ''); },
    spawn() { throw new Error('Not used in state test.'); },
    systeminformation: { processes: async () => ({ list: [] }) },
    getSettings: () => settings,
    saveSettings(next) { settings = next; return settings; },
    getMainWindow: () => null
  });
  assert.equal(handlers.size, CHANNELS.length);
  const state = await handlers.get('booster:state')();
  assert.equal(state.success, true);
  assert.equal(state.session.active, false);
  const saved = await handlers.get('booster:config:save')(null, { ...DEFAULT_CONFIG, clearClipboard: true });
  assert.equal(saved.success, true);
  assert.equal(settings.booster.clearClipboard, true);
  controller.dispose();

  console.log('Booster configuration, safety defaults, IPC surface, and restore tests passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
