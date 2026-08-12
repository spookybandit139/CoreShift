'use strict';

const assert = require('assert');
const http = require('http');
const { isPrivateAddress, registerMobileControl } = require('../main/mobile-control');

for (const address of ['127.0.0.1', '10.0.0.8', '172.16.4.9', '172.31.255.254', '192.168.1.22', '::1', 'fd12::4', 'fe80::1', '::ffff:192.168.1.22']) {
  assert.strictEqual(isPrivateAddress(address), true, `${address} should be accepted as private.`);
}
for (const address of ['8.8.8.8', '172.32.0.1', '169.254.1.1', '2001:4860:4860::8888', '', 'not-an-ip']) {
  assert.strictEqual(isPrivateAddress(address), false, `${address || 'empty value'} should be rejected.`);
}

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
  let starts = 0;
  const controller = registerMobileControl({
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    getPreferredAddress: async () => '192.168.1.33',
    getBot: async () => ({ success: true, status: { state: 'stopped', connected: false, guildCount: 2, commandCount: 28, message: 'CoreShift bot is stopped.' } }),
    startBot: async () => { starts += 1; return { success: true, message: 'Bot started.' }; },
    stopBot: async () => ({ success: true, message: 'Bot stopped.' }),
    syncBot: async () => ({ success: true, message: 'Bot commands synced.' }),
    postBotMessage: async payload => ({ success: true, message: 'Posted ' + payload.type + '.' })
  });
  try {
    const started = await handlers.get('mobile:start')();
    assert.strictEqual(started.running, true);
    assert.match(started.url, /^http:\/\/192\.168\.1\.33:\d+\/pair\?code=[A-Za-z0-9_-]{20,}$/);
    assert.match(started.qrDataUrl, /^data:image\/png;base64,/);
    assert.match(started.accessCode, /^\d{6}$/);
    const pairUrl = new URL(started.url); pairUrl.hostname = '127.0.0.1';
    const initialHome = await request(`http://127.0.0.1:${pairUrl.port}/`);
    assert.strictEqual(initialHome.status, 401);
    const pairingPage = await request(pairUrl, { method: 'GET' });
    assert.strictEqual(pairingPage.status, 200);
    assert.match(pairingPage.text, /Enter security code/);
    assert.match(pairingPage.text, /6-digit code/);
    assert.match(pairingPage.text, /maxlength="6"/);
    const pendingCookie = pairingPage.headers['set-cookie'][0].split(';')[0];
    const wrongPin = await request(`http://127.0.0.1:${pairUrl.port}/pair/verify`, { method: 'POST', headers: { Cookie: pendingCookie, 'Content-Type': 'application/json' } }, JSON.stringify({ code: '000000' }));
    assert.strictEqual(wrongPin.status, 403);
    const verified = await request(`http://127.0.0.1:${pairUrl.port}/pair/verify`, { method: 'POST', headers: { Cookie: pendingCookie, 'Content-Type': 'application/json' } }, JSON.stringify({ code: started.accessCode }));
    assert.strictEqual(JSON.parse(verified.text).success, true);
    const sessionCookie = verified.headers['set-cookie'].find(value => value.startsWith('cs_mobile=')).split(';')[0];
    const home = await request(`http://127.0.0.1:${pairUrl.port}/`, { headers: { Cookie: sessionCookie } });
    assert.strictEqual(home.status, 200);
    assert.match(home.text, /Bot Command Center/);
    assert.doesNotMatch(home.text, /My games|Apply boost|Quick controls/);
    const csrf = home.text.match(/const csrf="([A-Za-z0-9_-]+)"/)?.[1];
    assert.ok(csrf, 'Paired Bot Command Center should include an action token.');
    const status = await request(`http://127.0.0.1:${pairUrl.port}/api/status`, { headers: { Cookie: sessionCookie } });
    const mobileStatus = JSON.parse(status.text);
    assert.strictEqual(mobileStatus.bot.commandCount, 28);
    assert.strictEqual(mobileStatus.games, undefined);
    const action = await request(`http://127.0.0.1:${pairUrl.port}/api/action`, { method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://127.0.0.1:${pairUrl.port}`, 'Content-Type': 'application/json', 'X-CS-Mobile': csrf } }, JSON.stringify({ action: 'bot-start' }));
    assert.strictEqual(JSON.parse(action.text).success, true);
    assert.strictEqual(starts, 1);
    const post = await request(`http://127.0.0.1:${pairUrl.port}/api/action`, { method: 'POST', headers: { Cookie: sessionCookie, Origin: `http://127.0.0.1:${pairUrl.port}`, 'Content-Type': 'application/json', 'X-CS-Mobile': csrf } }, JSON.stringify({ action: 'bot-post', type: 'rules', guildId: '1', channelId: '2' }));
    assert.strictEqual(JSON.parse(post.text).success, true);
    const refreshed = await handlers.get('mobile:pairing:reset')();
    assert.strictEqual(refreshed.paired, false);
    assert.match(refreshed.accessCode, /^\d{6}$/);
    const expiredSession = await request(`http://127.0.0.1:${pairUrl.port}/api/status`, { headers: { Cookie: sessionCookie } });
    assert.strictEqual(expiredSession.status, 401);
  } finally { await controller.stop(); }
}

smokeTestServer().then(() => console.log('Mobile Bot Command Center security and action tests passed.'));
