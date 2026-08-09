'use strict';

const assert = require('assert');
const { registerIpPrivacy, calculateNextRun } = require('../main/ip-privacy');

async function run() {
  const handlers = new Map();
  let settings = {};
  let account = { username: 'Spookybandit139' };
  const ipcMain = {
    removeHandler(channel) { handlers.delete(channel); },
    handle(channel, callback) { handlers.set(channel, callback); }
  };
  const controller = registerIpPrivacy({
    ipcMain,
    BrowserWindow: { getAllWindows: () => [] },
    shell: { openExternal: async () => {} },
    execFile(file, args, options, callback) {
      if (file === 'powershell.exe') return callback(null, '', '');
      callback(new Error('Unexpected executable in no-profile test.'), '', '');
    },
    getSettings: () => settings,
    saveSettings(next) { settings = next; return settings; },
    getActiveAccount: () => account,
    ownerUsername: 'spookybandit139'
  });

  const status = await handlers.get('ipPrivacy:status')();
  assert.equal(status.success, true);
  assert.equal(status.config.enabled, false);
  assert.equal(status.status.nextRunAt, '');

  const profiles = await handlers.get('ipPrivacy:profiles')();
  assert.deepEqual(profiles.profiles, []);

  const unsafeEnable = await handlers.get('ipPrivacy:config:save')(null, { enabled: true, profileName: '', dailyTime: '04:00' });
  assert.equal(unsafeEnable.success, false);
  assert.match(unsafeEnable.message, /Select a Windows VPN profile/i);

  const disabled = await handlers.get('ipPrivacy:config:save')(null, { enabled: false, profileName: '', dailyTime: '05:30' });
  assert.equal(disabled.success, true);
  assert.equal(settings.ipPrivacy.dailyTime, '05:30');

  const next = calculateNextRun({ dailyTime: '05:30', lastAttemptDate: '' });
  assert.ok(next instanceof Date && !Number.isNaN(next.getTime()) && next > new Date());

  account = { username: 'member' };
  const denied = await handlers.get('ipPrivacy:status')();
  assert.equal(denied.success, false);
  assert.match(denied.message, /Spookybandit139 only/i);

  controller.stop();
  console.log('IP privacy tests passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
