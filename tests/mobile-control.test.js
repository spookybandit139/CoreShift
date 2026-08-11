'use strict';

const assert = require('assert');
const http = require('http');
const { isPrivateAddress } = require('../main/mobile-control');
const { registerMobileControl } = require('../main/mobile-control');

for (const address of ['127.0.0.1', '10.0.0.8', '172.16.4.9', '172.31.255.254', '192.168.1.22', '::1', 'fd12::4', 'fe80::1', '::ffff:192.168.1.22']) {
  assert.strictEqual(isPrivateAddress(address), true, `${address} should be accepted as private.`);
}
for (const address of ['8.8.8.8', '172.32.0.1', '169.254.1.1', '2001:4860:4860::8888', '', 'not-an-ip']) {
  assert.strictEqual(isPrivateAddress(address), false, `${address || 'empty value'} should be rejected.`);
}

console.log('Mobile Control private-network boundary tests passed.');

function request(url, options = {}, body = '') {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function smokeTestServer() {
  const handlers = new Map();
  let focused = 0;
  const controller = registerMobileControl({
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    getStatus: async () => ({ cpu: { load: 12 }, mem: { used: 2 * 1073741824, total: 8 * 1073741824 }, gpu: { model: 'Test GPU' } }),
    getBooster: async () => ({ success: true, session: { active: false } }),
    applyBoost: async () => ({ success: true, message: 'Boost applied.' }),
    restoreBoost: async () => ({ success: true, message: 'Settings restored.' }),
    scanGames: async () => ({ success: true, games: [{ id: 'steam:1', name: 'Test Game', platform: 'Steam' }] }),
    launchGame: async () => ({ success: true, message: 'Game launched.' }),
    focusDesktop: () => { focused += 1; }
  });
  try {
    const started = await handlers.get('mobile:start')();
    assert.strictEqual(started.running, true);
    const pairUrl = new URL(started.url); pairUrl.hostname = '127.0.0.1';
    const paired = await request(pairUrl, { method: 'GET' });
    assert.strictEqual(paired.status, 302);
    const cookie = paired.headers['set-cookie'][0].split(';')[0];
    const home = await request(`http://127.0.0.1:${pairUrl.port}/`, { headers: { Cookie: cookie } });
    assert.strictEqual(home.status, 200);
    const csrf = home.text.match(/const csrf="([a-f0-9]+)"/i)?.[1];
    assert.ok(csrf, 'Paired controller page should include an action token.');
    const status = await request(`http://127.0.0.1:${pairUrl.port}/api/status`, { headers: { Cookie: cookie } });
    assert.strictEqual(JSON.parse(status.text).games[0].name, 'Test Game');
    const action = await request(`http://127.0.0.1:${pairUrl.port}/api/action`, { method: 'POST', headers: { Cookie: cookie, Origin: `http://127.0.0.1:${pairUrl.port}`, 'Content-Type': 'application/json', 'X-CS-Mobile': csrf } }, JSON.stringify({ action: 'focus' }));
    assert.strictEqual(JSON.parse(action.text).success, true);
    assert.strictEqual(focused, 1);
  } finally { await controller.stop(); }
}

smokeTestServer().then(() => console.log('Mobile Control pairing and action smoke tests passed.'));
