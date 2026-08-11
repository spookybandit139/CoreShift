'use strict';

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const net = require('net');

function registerMobileControl({ ipcMain, getStatus, getBooster, applyBoost, restoreBoost, scanGames, launchGame, focusDesktop }) {
  let server = null;
  let pairing = null;
  let session = null;
  let startedAt = '';

  const status = () => {
    const address = server?.address();
    const host = address && typeof address === 'object' ? getPrivateAddress() : '';
    return {
      success: true,
      running: Boolean(server && address),
      url: host && address ? `http://${host}:${address.port}/pair?code=${pairing?.code || ''}` : '',
      expiresAt: pairing?.expiresAt || '',
      paired: Boolean(session),
      startedAt,
      message: server ? 'Wi-Fi Control Center is available only on your private local network.' : 'Wi-Fi Control Center is off.'
    };
  };

  async function start() {
    if (server) return status();
    pairing = { code: crypto.randomBytes(4).toString('hex').toUpperCase(), expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
    session = null;
    server = http.createServer(handleRequest);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '0.0.0.0', port: 0, exclusive: true }, resolve);
    });
    server.on('error', error => console.error('Mobile control server error:', error));
    startedAt = new Date().toISOString();
    return status();
  }

  async function stop() {
    if (server) await new Promise(resolve => server.close(resolve));
    server = null; pairing = null; session = null; startedAt = '';
    return status();
  }

  async function handleRequest(req, res) {
    try {
      if (!isPrivateAddress(req.socket.remoteAddress)) return send(res, 403, { success: false, message: 'Wi-Fi Control Center only accepts private-network devices.' });
      const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && requestUrl.pathname === '/pair') return pair(req, res, requestUrl);
      if (req.method === 'GET' && requestUrl.pathname === '/') return authenticated(req, res, () => sendHtml(res, controllerPage(session?.csrf || '')));
      if (req.method === 'GET' && requestUrl.pathname === '/api/status') return authenticated(req, res, async () => send(res, 200, await mobileStatus()));
      if (req.method === 'POST' && requestUrl.pathname === '/api/action') return authenticated(req, res, async () => action(req, res));
      return send(res, 404, { success: false, message: 'Not found.' });
    } catch (error) {
      return send(res, 500, { success: false, message: clean(error.message || 'Mobile Control request failed.') });
    }
  }

  function pair(req, res, requestUrl) {
    if (!pairing || Date.now() > Date.parse(pairing.expiresAt) || requestUrl.searchParams.get('code') !== pairing.code) return sendHtml(res, pairingPage('That pairing link has expired. Generate a fresh link from CoreShift Settings.'));
    session = { token: crypto.randomBytes(32).toString('hex'), csrf: crypto.randomBytes(24).toString('hex'), createdAt: new Date().toISOString() };
    pairing = null;
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': `cs_mobile=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
      'Cache-Control': 'no-store'
    });
    res.end();
  }

  function authenticated(req, res, next) {
    const token = parseCookies(req.headers.cookie || '').cs_mobile || '';
    if (!session || !safeEqual(token, session.token)) return sendHtml(res, pairingPage('Pair this phone from the link shown in CoreShift Settings.'));
    return next();
  }

  async function mobileStatus() {
    const [system, booster, games] = await Promise.all([getStatus(), getBooster(), scanGames()]);
    return {
      success: true,
      system: { cpu: Math.round(system.cpu?.load || 0), memoryUsed: Math.round((system.mem?.used || 0) / 1073741824 * 10) / 10, memoryTotal: Math.round((system.mem?.total || 0) / 1073741824 * 10) / 10, gpu: clean(system.gpu?.model || 'Graphics adapter unavailable') },
      booster: booster?.session || {},
      games: Array.isArray(games?.games) ? games.games.slice(0, 40).map(game => ({ id: clean(game.id, 160), name: clean(game.name, 100), platform: clean(game.platform, 40), favorite: Boolean(game.favorite) })) : [],
      pairedAt: session?.createdAt || ''
    };
  }

  async function action(req, res) {
    const origin = String(req.headers.origin || '');
    const expectedOrigin = `http://${req.headers.host}`;
    if (origin !== expectedOrigin || !session || !safeEqual(String(req.headers['x-cs-mobile'] || ''), session.csrf)) return send(res, 403, { success: false, message: 'This action was not approved by the paired controller.' });
    const body = await readJson(req);
    const type = String(body.action || '');
    let result;
    if (type === 'boost') result = await applyBoost();
    else if (type === 'restore') result = await restoreBoost();
    else if (type === 'launch') result = await launchGame(String(body.gameId || ''));
    else if (type === 'focus') { focusDesktop(); result = { success: true, message: 'CoreShift is ready on your desktop.' }; }
    else return send(res, 400, { success: false, message: 'That mobile action is not available.' });
    return send(res, 200, result || { success: true });
  }

  ipcMain.handle('mobile:status', () => status());
  ipcMain.handle('mobile:start', start);
  ipcMain.handle('mobile:stop', stop);

  return { stop, status };
}

function getPrivateAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) if (entry.family === 'IPv4' && !entry.internal && isPrivateAddress(entry.address)) return entry.address;
  }
  return '';
}

function isPrivateAddress(address) {
  const value = String(address || '').replace(/^::ffff:/i, '').toLowerCase();
  if (value === '::1') return true;
  if (net.isIP(value) === 6) return value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; let body = '';
    req.on('data', chunk => { size += chunk.length; if (size > 4096) return reject(new Error('Request is too large.')); body += chunk; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Request must be valid JSON.')); } });
    req.on('error', reject);
  });
}

function parseCookies(value) { return Object.fromEntries(String(value).split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2)); }
function safeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function clean(value, length = 240) { return String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, length); }
function send(res, status, payload) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(payload)); }
function sendHtml(res, html) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" }); res.end(html); }
function pairingPage(message) { return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>CoreShift Wi-Fi Control</title><style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#091018;color:#eef5fa;font:16px system-ui}.card{max-width:360px;margin:20px;padding:26px;border:1px solid #33475d;border-radius:18px;background:#111b28}b{color:#b7ff35}p{line-height:1.5;color:#a9b7c5}</style><main class="card"><b>CORE<span>SHIFT</span></b><h1>Wi-Fi Control</h1><p>${clean(message, 300)}</p></main>`; }
function controllerPage(csrfValue) {
  const csrf = JSON.stringify(csrfValue || '');
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>CoreShift Control</title><style>body{margin:0;background:#081018;color:#eef5fa;font:15px system-ui}.app{max-width:680px;margin:auto;padding:20px}.brand{color:#b7ff35;font-weight:900;letter-spacing:2px}.card{margin:14px 0;padding:17px;border:1px solid #304154;border-radius:14px;background:#101a27}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}.metric{padding:12px;border-radius:10px;background:#0a121d}.metric small,.game small{display:block;color:#93a3b3}.metric b{display:block;margin-top:5px;font-size:21px}.actions{display:grid;grid-template-columns:1fr 1fr;gap:9px}button{padding:12px;border:1px solid #41566e;border-radius:9px;background:#162536;color:#eff7ff;font-weight:700}button.primary{border:0;background:#b7ff35;color:#12200b}.game{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 0;border-top:1px solid #263647}.game:first-child{border-top:0}.game button{padding:7px 10px;font-size:12px}.notice{color:#9aabba;line-height:1.4}</style><main class="app"><div class="brand">CORE<span>SHIFT</span></div><h1>Wi-Fi Control Center</h1><p class="notice">Paired locally to this PC. Keep CoreShift open and use only a trusted home Wi-Fi network.</p><section class="card"><div class="stats"><div class="metric"><small>CPU</small><b id="cpu">--</b></div><div class="metric"><small>MEMORY</small><b id="ram">--</b></div><div class="metric"><small>BOOST</small><b id="boost">--</b></div></div></section><section class="card"><h2>Quick controls</h2><div class="actions"><button class="primary" data-action="boost">Apply boost</button><button data-action="restore">Restore PC settings</button><button data-action="focus">Open CoreShift on PC</button><button id="refresh">Refresh status</button></div><p id="message" class="notice"></p></section><section class="card"><h2>My games</h2><div id="games" class="notice">Loading games...</div></section></main><script>const csrf=${csrf};function esc(v){return String(v).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}function escAttr(v){return String(v).replace(/[^a-zA-Z0-9:_-]/g,'')}async function load(){const r=await fetch('/api/status');const d=await r.json();if(!d.success){document.getElementById('message').textContent=d.message||'Status unavailable.';return}document.getElementById('cpu').textContent=d.system.cpu+'%';document.getElementById('ram').textContent=d.system.memoryUsed+' / '+d.system.memoryTotal+' GB';document.getElementById('boost').textContent=d.booster.active?'ACTIVE':'READY';document.getElementById('games').innerHTML=(d.games||[]).map(g=>'<div class="game"><span><b>'+esc(g.name)+'</b><small>'+esc(g.platform)+'</small></span><button data-game="'+escAttr(g.id)+'">Launch</button></div>').join('')||'No local games found.';document.querySelectorAll('[data-game]').forEach(b=>b.onclick=()=>act('launch',b.dataset.game))}async function act(action,gameId=''){const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-CS-Mobile':csrf},body:JSON.stringify({action,gameId})});const d=await r.json();document.getElementById('message').textContent=d.message||'Done.';load()}document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>act(b.dataset.action));document.getElementById('refresh').onclick=load;load()</script>`;
}

module.exports = { registerMobileControl, isPrivateAddress };
