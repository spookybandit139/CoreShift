'use strict';

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const net = require('net');

const PAIRING_LIFETIME_MS = 10 * 60 * 1000;
const SESSION_LIFETIME_MS = 2 * 60 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;
const PAIRING_BLOCK_MS = 10 * 60 * 1000;

function registerMobileControl({ ipcMain, getStatus, getBooster, applyBoost, restoreBoost, scanGames, launchGame, focusDesktop, getPreferredAddress, getBot, startBot, stopBot, syncBot }) {
  let server = null;
  let pairing = null;
  let session = null;
  let startedAt = '';
  let advertisedAddress = '';
  const pairingAttempts = new Map();

  async function status() {
    const address = server?.address();
    const running = Boolean(server && address && advertisedAddress);
    const awaitingPairing = Boolean(pairing && Date.now() <= Date.parse(pairing.expiresAt));
    return {
      success: true,
      running,
      url: running && awaitingPairing ? `http://${advertisedAddress}:${address.port}/pair?code=${pairing.code}` : '',
      host: running ? advertisedAddress : '',
      expiresAt: awaitingPairing ? pairing.expiresAt : '',
      paired: isSessionValid(),
      pairedAt: session?.createdAt || '',
      lastSeenAt: session?.lastSeenAt || '',
      startedAt,
      message: !server ? 'Wi-Fi Control Center is off.' : !advertisedAddress ? 'Connect your PC to a private Wi-Fi network, then start Wi-Fi Control Center again.' : isSessionValid() ? 'Your phone is paired. Live status refreshes every few seconds.' : 'Open the temporary pairing link on one trusted phone.'
    };
  }

  function createPairing() {
    pairing = {
      code: crypto.randomBytes(16).toString('base64url'),
      expiresAt: new Date(Date.now() + PAIRING_LIFETIME_MS).toISOString()
    };
    session = null;
    pairingAttempts.clear();
  }

  async function start() {
    if (server) return status();
    advertisedAddress = await preferredAddress(getPreferredAddress);
    if (!advertisedAddress) return { success: false, running: false, message: 'CoreShift could not find a private Wi-Fi address. Connect to your home Wi-Fi and try again.' };
    createPairing();
    server = http.createServer(handleRequest);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '0.0.0.0', port: 0, exclusive: true }, resolve);
      });
    } catch (error) {
      server = null; pairing = null; advertisedAddress = '';
      return { success: false, running: false, message: clean(error.message || 'Wi-Fi Control Center could not start.') };
    }
    server.on('error', error => console.error('Mobile control server error:', error));
    startedAt = new Date().toISOString();
    return status();
  }

  async function resetPairing() {
    if (!server) return { success: false, message: 'Start Wi-Fi Control Center first.' };
    createPairing();
    return status();
  }

  async function stop() {
    if (server) await new Promise(resolve => server.close(resolve));
    server = null; pairing = null; session = null; startedAt = ''; advertisedAddress = ''; pairingAttempts.clear();
    return status();
  }

  async function handleRequest(req, res) {
    try {
      if (!isPrivateAddress(req.socket.remoteAddress)) return send(res, 403, { success: false, message: 'Wi-Fi Control Center only accepts private-network devices.' });
      const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && requestUrl.pathname === '/pair') return pair(req, res, requestUrl);
      if (req.method === 'GET' && requestUrl.pathname === '/') return authenticated(req, res, () => sendHtml(res, controllerPage(session.csrf)));
      if (req.method === 'GET' && requestUrl.pathname === '/api/status') return authenticated(req, res, async () => send(res, 200, await mobileStatus()));
      if (req.method === 'POST' && requestUrl.pathname === '/api/action') return authenticated(req, res, async () => action(req, res));
      return send(res, 404, { success: false, message: 'Not found.' });
    } catch (error) {
      return send(res, 500, { success: false, message: clean(error.message || 'Mobile Control request failed.') });
    }
  }

  function pair(req, res, requestUrl) {
    const remote = normalAddress(req.socket.remoteAddress);
    const blockedUntil = pairingAttempts.get(remote)?.blockedUntil || 0;
    if (blockedUntil > Date.now()) return sendHtml(res, pairingPage('Too many incorrect pairing attempts. Generate a new link from CoreShift Settings.'), 429);
    const code = requestUrl.searchParams.get('code') || '';
    if (!pairing || Date.now() > Date.parse(pairing.expiresAt) || !safeEqual(code, pairing.code)) {
      noteFailedPairing(remote);
      return sendHtml(res, pairingPage('That pairing link is invalid or expired. Generate a fresh link from CoreShift Settings.'), 403);
    }
    session = {
      token: crypto.randomBytes(32).toString('base64url'),
      csrf: crypto.randomBytes(24).toString('base64url'),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS).toISOString(),
      lastSeenAt: new Date().toISOString()
    };
    pairing = null;
    pairingAttempts.clear();
    res.writeHead(302, secureHeaders({
      Location: '/',
      'Set-Cookie': `cs_mobile=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}`
    }));
    res.end();
  }

  function noteFailedPairing(remote) {
    const current = pairingAttempts.get(remote) || { attempts: 0, blockedUntil: 0 };
    current.attempts += 1;
    if (current.attempts >= MAX_PAIRING_ATTEMPTS) current.blockedUntil = Date.now() + PAIRING_BLOCK_MS;
    pairingAttempts.set(remote, current);
  }

  function isSessionValid() { return Boolean(session && Date.now() <= Date.parse(session.expiresAt)); }

  function authenticated(req, res, next) {
    const token = parseCookies(req.headers.cookie || '').cs_mobile || '';
    if (!isSessionValid() || !safeEqual(token, session?.token || '')) return sendHtml(res, pairingPage('Pair this phone from the link shown in CoreShift Settings.'), 401);
    session.lastSeenAt = new Date().toISOString();
    return next();
  }

  async function mobileStatus() {
    const [system, booster, games, botResult] = await Promise.all([
      getStatus(), getBooster(), scanGames(), Promise.resolve(getBot?.()).catch(() => ({ success: false, message: 'Bot controls are unavailable.' }))
    ]);
    const botStatus = botResult?.status || {};
    return {
      success: true,
      system: {
        cpu: Math.round(system.cpu?.load || 0),
        memoryUsed: Math.round((system.mem?.used || 0) / 1073741824 * 10) / 10,
        memoryTotal: Math.round((system.mem?.total || 0) / 1073741824 * 10) / 10,
        gpu: clean(system.gpu?.model || 'Graphics adapter unavailable', 80)
      },
      booster: booster?.session || {},
      games: Array.isArray(games?.games) ? games.games.slice(0, 40).map(game => ({ id: clean(game.id, 160), name: clean(game.name, 100), platform: clean(game.platform, 40), favorite: Boolean(game.favorite) })) : [],
      bot: {
        available: Boolean(botResult?.success),
        state: clean(botStatus.state || 'stopped', 30),
        connected: Boolean(botStatus.connected),
        userTag: clean(botStatus.userTag || '', 80),
        guildCount: Number(botStatus.guildCount || 0),
        message: clean(botResult?.message || botStatus.message || '', 180)
      },
      pairedAt: session?.createdAt || '',
      sessionExpiresAt: session?.expiresAt || ''
    };
  }

  async function action(req, res) {
    const origin = String(req.headers.origin || '');
    const expectedOrigin = `http://${req.headers.host}`;
    if (origin !== expectedOrigin || !isSessionValid() || !safeEqual(String(req.headers['x-cs-mobile'] || ''), session.csrf)) return send(res, 403, { success: false, message: 'This action was not approved by the paired controller.' });
    const body = await readJson(req);
    const type = String(body.action || '');
    let result;
    if (type === 'boost') result = await applyBoost();
    else if (type === 'restore') result = await restoreBoost();
    else if (type === 'launch') result = await launchGame(String(body.gameId || ''));
    else if (type === 'focus') { focusDesktop(); result = { success: true, message: 'CoreShift is ready on your desktop.' }; }
    else if (type === 'bot-start') result = await safeBotAction(startBot, 'Bot start is not available.');
    else if (type === 'bot-stop') result = await safeBotAction(stopBot, 'Bot stop is not available.');
    else if (type === 'bot-sync') result = await safeBotAction(syncBot, 'Bot command sync is not available.');
    else return send(res, 400, { success: false, message: 'That mobile action is not available.' });
    return send(res, 200, result || { success: true });
  }

  ipcMain.removeHandler?.('mobile:status');
  ipcMain.removeHandler?.('mobile:start');
  ipcMain.removeHandler?.('mobile:stop');
  ipcMain.removeHandler?.('mobile:pairing:reset');
  ipcMain.handle('mobile:status', status);
  ipcMain.handle('mobile:start', start);
  ipcMain.handle('mobile:stop', stop);
  ipcMain.handle('mobile:pairing:reset', resetPairing);

  return { stop, status, resetPairing };
}

async function safeBotAction(action, unavailable) {
  if (typeof action !== 'function') return { success: false, message: unavailable };
  try { return await action(); } catch (error) { return { success: false, message: clean(error.message || unavailable) }; }
}

async function preferredAddress(getPreferredAddress) {
  const supplied = await Promise.resolve(getPreferredAddress?.()).catch(() => '');
  if (isUsableLocalAddress(supplied)) return supplied;
  const candidates = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) if (entry.family === 'IPv4' && !entry.internal && isUsableLocalAddress(entry.address)) candidates.push({ address: entry.address, name });
  }
  candidates.sort((left, right) => scoreAdapter(right.name) - scoreAdapter(left.name));
  return candidates[0]?.address || '';
}

function isUsableLocalAddress(address) { return isPrivateAddress(address) && !String(address).startsWith('127.'); }
function scoreAdapter(name) { return /wsl|docker|hyper-v|vmware|virtual|loopback|tailscale|zerotier/i.test(String(name)) ? -10 : 1; }
function normalAddress(address) { return String(address || '').replace(/^::ffff:/i, '').toLowerCase(); }
function isPrivateAddress(address) {
  const value = normalAddress(address);
  if (value === '::1') return true;
  if (net.isIP(value) === 6) return value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; let body = ''; let failed = false;
    req.on('data', chunk => { if (failed) return; size += chunk.length; if (size > 4096) { failed = true; reject(new Error('Request is too large.')); req.resume(); return; } body += chunk; });
    req.on('end', () => { if (failed) return; try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Request must be valid JSON.')); } });
    req.on('error', reject);
  });
}

function parseCookies(value) { return Object.fromEntries(String(value).split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2)); }
function safeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function clean(value, length = 240) { return String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, length); }
function secureHeaders(extra = {}) { return { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', ...extra }; }
function send(res, status, payload) { res.writeHead(status, secureHeaders({ 'Content-Type': 'application/json; charset=utf-8' })); res.end(JSON.stringify(payload)); }
function sendHtml(res, html, status = 200) { res.writeHead(status, secureHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" })); res.end(html); }
function pairingPage(message) { return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>CoreShift Wi-Fi Control</title><style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#091018;color:#eef5fa;font:16px system-ui}.card{max-width:360px;margin:20px;padding:26px;border:1px solid #33475d;border-radius:18px;background:#111b28}b{color:#b7ff35}p{line-height:1.5;color:#a9b7c5}</style><main class="card"><b>CORE<span>SHIFT</span></b><h1>Wi-Fi Control</h1><p>${clean(message, 300)}</p></main>`; }
function controllerPage(csrfValue) {
  const csrf = JSON.stringify(csrfValue || '');
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>CoreShift Control</title><style>body{margin:0;background:#081018;color:#eef5fa;font:15px system-ui}.app{max-width:680px;margin:auto;padding:20px}.brand{color:#b7ff35;font-weight:900;letter-spacing:2px}.sync{float:right;color:#b7ff35;font-size:12px}.card{margin:14px 0;padding:17px;border:1px solid #304154;border-radius:14px;background:#101a27}.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:9px}.metric{padding:12px;border-radius:10px;background:#0a121d}.metric small,.game small{display:block;color:#93a3b3}.metric b{display:block;margin-top:5px;font-size:19px}.actions{display:grid;grid-template-columns:1fr 1fr;gap:9px}button{padding:12px;border:1px solid #41566e;border-radius:9px;background:#162536;color:#eff7ff;font-weight:700}button.primary{border:0;background:#b7ff35;color:#12200b}button:disabled{opacity:.45}.game{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 0;border-top:1px solid #263647}.game:first-child{border-top:0}.game button{padding:7px 10px;font-size:12px}.notice{color:#9aabba;line-height:1.4}</style><main class="app"><div class="brand">CORE<span>SHIFT</span><span class="sync" id="sync">CONNECTING…</span></div><h1>Wi-Fi Control Center</h1><p class="notice">Paired locally to this PC. Keep CoreShift open and use only a trusted home Wi-Fi network.</p><section class="card"><div class="stats"><div class="metric"><small>CPU</small><b id="cpu">--</b></div><div class="metric"><small>MEMORY</small><b id="ram">--</b></div><div class="metric"><small>GPU</small><b id="gpu">--</b></div><div class="metric"><small>BOOST</small><b id="boost">--</b></div></div></section><section class="card"><h2>Quick controls</h2><div class="actions"><button class="primary" data-action="boost">Apply boost</button><button data-action="restore">Restore PC settings</button><button data-action="focus">Open CoreShift on PC</button><button id="refresh">Refresh now</button></div><p id="message" class="notice">Live status updates every 3 seconds.</p></section><section class="card"><h2>Discord bot</h2><p id="bot" class="notice">Checking desktop owner access…</p><div class="actions"><button data-action="bot-start" id="botStart">Start bot</button><button data-action="bot-stop" id="botStop">Stop bot</button><button data-action="bot-sync" id="botSync">Sync commands</button></div></section><section class="card"><h2>My games</h2><div id="games" class="notice">Loading games...</div></section></main><script>const csrf=${csrf};let busy=false;function esc(v){return String(v).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}function escAttr(v){return String(v).replace(/[^a-zA-Z0-9:_-]/g,'')}function msg(v){document.getElementById('message').textContent=v||''}async function load(silent=false){if(busy)return;try{const r=await fetch('/api/status',{cache:'no-store'});const d=await r.json();if(!d.success)throw new Error(d.message||'Status unavailable.');document.getElementById('cpu').textContent=d.system.cpu+'%';document.getElementById('ram').textContent=d.system.memoryUsed+' / '+d.system.memoryTotal+' GB';document.getElementById('gpu').textContent=d.system.gpu;document.getElementById('boost').textContent=d.booster.active?'ACTIVE':'READY';document.getElementById('sync').textContent='SYNCED';const b=d.bot||{};document.getElementById('bot').textContent=b.available?(b.connected?'ONLINE'+(b.userTag?' • '+b.userTag:'')+' • '+b.guildCount+' servers':'OFFLINE • '+(b.message||'Ready to start from this phone.')):(b.message||'Sign in as the desktop owner to use bot controls.');['botStart','botStop','botSync'].forEach(id=>document.getElementById(id).disabled=!b.available);document.getElementById('games').innerHTML=(d.games||[]).map(g=>'<div class="game"><span><b>'+esc(g.name)+'</b><small>'+esc(g.platform)+'</small></span><button data-game="'+escAttr(g.id)+'">Launch</button></div>').join('')||'No local games found.';document.querySelectorAll('[data-game]').forEach(b=>b.onclick=()=>act('launch',b.dataset.game));if(!silent)msg('Synced just now.')}catch(e){document.getElementById('sync').textContent='RECONNECTING…';if(!silent)msg(e.message||'Connection lost. Keep CoreShift open.')}}async function act(action,gameId=''){if(busy)return;busy=true;try{const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-CS-Mobile':csrf},body:JSON.stringify({action,gameId})});const d=await r.json();msg(d.message||'Done.')}catch(e){msg(e.message||'Action failed.')}finally{busy=false;load(true)}}document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>act(b.dataset.action));document.getElementById('refresh').onclick=()=>load();setInterval(()=>{if(!document.hidden)load(true)},3000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)load(true)});load()</script>`;
}

module.exports = { registerMobileControl, isPrivateAddress };
