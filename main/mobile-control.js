'use strict';

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const QRCode = require('qrcode');

const PAIRING_LIFETIME_MS = 5 * 60 * 1000;
const SESSION_LIFETIME_MS = 30 * 60 * 1000;
const SESSION_IDLE_MS = 10 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;
const PAIRING_BLOCK_MS = 10 * 60 * 1000;

function registerMobileControl({ ipcMain, getPreferredAddress, getBot, startBot, stopBot, syncBot, postBotMessage }) {
  let server = null;
  let pairing = null;
  let pendingPair = null;
  let session = null;
  let startedAt = '';
  let advertisedAddress = '';
  const pairingAttempts = new Map();

  async function status() {
    const address = server?.address();
    const running = Boolean(server && address && advertisedAddress);
    const awaitingPairing = Boolean(pairing && Date.now() <= Date.parse(pairing.expiresAt));
    const pairingUrl = running && awaitingPairing ? `http://${advertisedAddress}:${address.port}/pair?code=${pairing.linkCode}` : '';
    const qrDataUrl = pairingUrl ? await QRCode.toDataURL(pairingUrl, { errorCorrectionLevel: 'M', margin: 1, width: 280, color: { dark: '#081018', light: '#00000000' } }) : '';
    return {
      success: true,
      running,
      url: pairingUrl,
      qrDataUrl,
      accessCode: running && awaitingPairing ? pairing.accessCode : '',
      expiresAt: awaitingPairing ? pairing.expiresAt : '',
      paired: isSessionValid(),
      pairedAt: session?.createdAt || '',
      lastSeenAt: session?.lastSeenAt || '',
      startedAt,
      message: !server ? 'Mobile Bot Command Center is off.' : isSessionValid() ? 'Your phone is paired to the Bot Command Center. The session expires after 10 minutes of inactivity.' : 'Open the private link, then enter the 6-digit security code shown here.'
    };
  }

  function createPairing() {
    pairing = {
      linkCode: crypto.randomBytes(16).toString('base64url'),
      accessCode: String(crypto.randomInt(100000, 1000000)),
      expiresAt: new Date(Date.now() + PAIRING_LIFETIME_MS).toISOString()
    };
    pendingPair = null;
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
      return { success: false, running: false, message: clean(error.message || 'Mobile Bot Command Center could not start.') };
    }
    server.on('error', error => console.error('Mobile bot control server error:', error));
    startedAt = new Date().toISOString();
    return status();
  }

  async function resetPairing() {
    if (!server) return { success: false, message: 'Start Mobile Bot Command Center first.' };
    createPairing();
    return status();
  }

  async function stop() {
    if (server) await new Promise(resolve => server.close(resolve));
    server = null; pairing = null; pendingPair = null; session = null; startedAt = ''; advertisedAddress = ''; pairingAttempts.clear();
    return status();
  }

  async function handleRequest(req, res) {
    try {
      if (!isPrivateAddress(req.socket.remoteAddress)) return send(res, 403, { success: false, message: 'Mobile Bot Command Center only accepts private-network devices.' });
      const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && requestUrl.pathname === '/pair') return pair(req, res, requestUrl);
      if (req.method === 'POST' && requestUrl.pathname === '/pair/verify') return verifyPair(req, res);
      if (req.method === 'GET' && requestUrl.pathname === '/') return authenticated(req, res, () => sendHtml(res, controllerPage(session.csrf)));
      if (req.method === 'GET' && requestUrl.pathname === '/api/status') return authenticated(req, res, async () => send(res, 200, await mobileStatus()));
      if (req.method === 'POST' && requestUrl.pathname === '/api/action') return authenticated(req, res, async () => action(req, res));
      return send(res, 404, { success: false, message: 'Not found.' });
    } catch (error) {
      return send(res, 500, { success: false, message: clean(error.message || 'Mobile Bot Command Center request failed.') });
    }
  }

  function pair(req, res, requestUrl) {
    const remote = normalAddress(req.socket.remoteAddress);
    if (isPairBlocked(remote)) return sendHtml(res, pairingPage('Too many incorrect attempts. Generate a new link from CoreShift Settings.'), 429);
    const linkCode = requestUrl.searchParams.get('code') || '';
    if (!isPairingValid() || !safeEqual(linkCode, pairing.linkCode)) {
      noteFailedPairing(remote);
      return sendHtml(res, pairingPage('That pairing link is invalid or expired. Generate a fresh link from CoreShift Settings.'), 403);
    }
    pendingPair = { token: crypto.randomBytes(24).toString('base64url'), remote, expiresAt: new Date(Date.now() + PAIRING_LIFETIME_MS).toISOString() };
    res.writeHead(200, secureHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': `cs_mobile_pair=${pendingPair.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(PAIRING_LIFETIME_MS / 1000)}`,
      'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    }));
    res.end(pinPage());
  }

  async function verifyPair(req, res) {
    const remote = normalAddress(req.socket.remoteAddress);
    if (isPairBlocked(remote)) return send(res, 429, { success: false, message: 'Too many incorrect attempts. Generate a new link from CoreShift Settings.' });
    const pendingToken = parseCookies(req.headers.cookie || '').cs_mobile_pair || '';
    if (!isPairingValid() || !pendingPair || Date.now() > Date.parse(pendingPair.expiresAt) || pendingPair.remote !== remote || !safeEqual(pendingToken, pendingPair.token)) return send(res, 401, { success: false, message: 'Open a fresh link from CoreShift Settings before entering the code.' });
    const body = await readJson(req);
    const pin = String(body.code || '').trim();
    if (!/^\d{6}$/.test(pin) || !safeEqual(pin, pairing.accessCode)) {
      noteFailedPairing(remote);
      return send(res, 403, { success: false, message: 'That 6-digit security code is not correct.' });
    }
    session = {
      token: crypto.randomBytes(32).toString('base64url'),
      csrf: crypto.randomBytes(24).toString('base64url'),
      remote: normalAddress(req.socket.remoteAddress),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS).toISOString(),
      lastSeenAt: new Date().toISOString()
    };
    pairing = null;
    pendingPair = null;
    pairingAttempts.clear();
    return send(res, 200, { success: true, message: 'Phone paired. Opening Bot Command Center.' }, {
      'Set-Cookie': [`cs_mobile=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}`, 'cs_mobile_pair=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0']
    });
  }

  function isPairingValid() { return Boolean(pairing && Date.now() <= Date.parse(pairing.expiresAt)); }
  function isPairBlocked(remote) { return (pairingAttempts.get(remote)?.blockedUntil || 0) > Date.now(); }
  function noteFailedPairing(remote) {
    const current = pairingAttempts.get(remote) || { attempts: 0, blockedUntil: 0 };
    current.attempts += 1;
    if (current.attempts >= MAX_PAIRING_ATTEMPTS) current.blockedUntil = Date.now() + PAIRING_BLOCK_MS;
    pairingAttempts.set(remote, current);
  }
  function isSessionValid() { return Boolean(session && Date.now() <= Date.parse(session.expiresAt) && Date.now() - Date.parse(session.lastSeenAt) <= SESSION_IDLE_MS); }

  function authenticated(req, res, next) {
    const token = parseCookies(req.headers.cookie || '').cs_mobile || '';
    if (!isSessionValid() || normalAddress(req.socket.remoteAddress) !== session?.remote || !safeEqual(token, session?.token || '')) return sendHtml(res, pairingPage('This session expired or is not from the paired phone. Open a fresh pairing link from CoreShift Settings.'), 401);
    session.lastSeenAt = new Date().toISOString();
    return next();
  }

  async function mobileStatus() {
    const botResult = await Promise.resolve(getBot?.()).catch(() => ({ success: false, message: 'Bot controls are unavailable.' }));
    const botStatus = botResult?.status || {};
    return {
      success: true,
      bot: {
        available: Boolean(botResult?.success),
        state: clean(botStatus.state || 'stopped', 30),
        connected: Boolean(botStatus.connected),
        userTag: clean(botStatus.userTag || '', 80),
        guildCount: Number(botStatus.guildCount || 0),
        commandCount: Number(botStatus.commandCount || 0),
        message: clean(botResult?.message || botStatus.message || '', 180)
      },
      commands: Array.isArray(botResult?.commands) ? botResult.commands.slice(0, 40).map(command => clean(command, 32)) : [],
      guilds: Array.isArray(botResult?.guilds) ? botResult.guilds.slice(0, 30).map(guild => ({ id: clean(guild.id, 32), name: clean(guild.name, 100), channels: Array.isArray(guild.channels) ? guild.channels.slice(0, 100).map(channel => ({ id: clean(channel.id, 32), name: clean(channel.name, 100) })) : [] })) : [],
      pairedAt: session?.createdAt || '',
      sessionExpiresAt: session?.expiresAt || ''
    };
  }

  async function action(req, res) {
    const origin = String(req.headers.origin || '');
    const expectedOrigin = `http://${req.headers.host}`;
    if (origin !== expectedOrigin || !isSessionValid() || !safeEqual(String(req.headers['x-cs-mobile'] || ''), session.csrf)) return send(res, 403, { success: false, message: 'This action was not approved by the paired phone.' });
    const payload = await readJson(req);
    const type = String(payload.action || '');
    let result;
    if (type === 'bot-start') result = await safeBotAction(startBot, 'Bot start is not available.');
    else if (type === 'bot-stop') result = await safeBotAction(stopBot, 'Bot stop is not available.');
    else if (type === 'bot-sync') result = await safeBotAction(syncBot, 'Bot command sync is not available.');
    else if (type === 'bot-post') {
      if (!['announcement', 'rules', 'welcome', 'security'].includes(String(payload.type || ''))) return send(res, 400, { success: false, message: 'That server post type is not available.' });
      result = await safeBotAction(() => postBotMessage?.(payload), 'Server posts are not available.');
    }
    else return send(res, 400, { success: false, message: 'That Bot Command Center action is not available.' });
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
  for (const [name, entries] of Object.entries(os.networkInterfaces())) for (const entry of entries || []) if (entry.family === 'IPv4' && !entry.internal && isUsableLocalAddress(entry.address)) candidates.push({ address: entry.address, name });
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
function send(res, status, payload, headers = {}) { res.writeHead(status, secureHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...headers })); res.end(JSON.stringify(payload)); }
function sendHtml(res, html, status = 200) { res.writeHead(status, secureHeaders({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" })); res.end(html); }
function pairingPage(message) { return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>CoreShift Bot Command Center</title><style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#091018;color:#eef5fa;font:16px system-ui}.card{max-width:360px;margin:20px;padding:26px;border:1px solid #33475d;border-radius:18px;background:#111b28}b{color:#b7ff35}p{line-height:1.5;color:#a9b7c5}</style><main class="card"><b>CORE<span>SHIFT</span></b><h1>Bot Command Center</h1><p>${clean(message, 300)}</p></main>`; }
function pinPage() { return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>CoreShift Security Code</title><style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#091018;color:#eef5fa;font:16px system-ui}.card{max-width:360px;margin:20px;padding:26px;border:1px solid #33475d;border-radius:18px;background:#111b28}b{color:#b7ff35}p{line-height:1.5;color:#a9b7c5}input,button{box-sizing:border-box;width:100%;padding:13px;border-radius:9px;font:inherit}input{border:1px solid #41566e;background:#091018;color:#fff;letter-spacing:8px;text-align:center;font-size:24px}button{margin-top:10px;border:0;background:#b7ff35;color:#12200b;font-weight:800}.error{min-height:24px;color:#ffb4b4}</style><main class="card"><b>CORE<span>SHIFT</span></b><h1>Enter security code</h1><p>Enter the 6-digit code displayed in CoreShift on your PC.</p><form id="form"><input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" aria-label="6 digit security code" autofocus><button>Open Bot Command Center</button></form><p id="error" class="error"></p></main><script>const f=document.getElementById('form'),c=document.getElementById('code'),e=document.getElementById('error');f.onsubmit=async x=>{x.preventDefault();e.textContent='';try{const r=await fetch('/pair/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c.value})}),d=await r.json();if(!d.success)throw new Error(d.message||'Code was not accepted.');location.replace('/')}catch(err){e.textContent=err.message||'Could not verify the code.';c.select()}};</script>`; }
function legacyControllerPage(csrfValue) {
  const csrf = JSON.stringify(csrfValue || '');
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>CoreShift Bot Command Center</title><style>body{margin:0;background:#081018;color:#eef5fa;font:15px system-ui}.app{max-width:620px;margin:auto;padding:20px}.brand{color:#b7ff35;font-weight:900;letter-spacing:2px}.sync{float:right;color:#b7ff35;font-size:12px}.card{margin:14px 0;padding:17px;border:1px solid #304154;border-radius:14px;background:#101a27}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}.metric{padding:12px;border-radius:10px;background:#0a121d}.metric small{display:block;color:#93a3b3}.metric b{display:block;margin-top:5px;font-size:18px;overflow-wrap:anywhere}.actions{display:grid;grid-template-columns:1fr 1fr;gap:9px}button{padding:12px;border:1px solid #41566e;border-radius:9px;background:#162536;color:#eff7ff;font-weight:700}button.primary{border:0;background:#b7ff35;color:#12200b}button:disabled{opacity:.45}.notice{color:#9aabba;line-height:1.4}</style><main class="app"><div class="brand">CORE<span>SHIFT</span><span class="sync" id="sync">CONNECTING</span></div><h1>Bot Command Center</h1><p class="notice">This phone can only control the Discord bot on this PC. Keep CoreShift open and use trusted home Wi-Fi.</p><section class="card"><div class="stats"><div class="metric"><small>STATUS</small><b id="state">--</b></div><div class="metric"><small>SERVERS</small><b id="guilds">--</b></div><div class="metric"><small>COMMANDS</small><b id="commands">--</b></div></div><p id="bot" class="notice">Reading bot status…</p></section><section class="card"><h2>Bot actions</h2><div class="actions"><button class="primary" data-action="bot-start" id="botStart">Start bot</button><button data-action="bot-stop" id="botStop">Stop bot</button><button data-action="bot-sync" id="botSync">Sync commands</button><button id="refresh">Refresh status</button></div><p id="message" class="notice">Ready.</p></section></main><script>const csrf=${csrf};let busy=false;function msg(v){document.getElementById('message').textContent=v||''}async function load(silent=false){if(busy)return;try{const r=await fetch('/api/status',{cache:'no-store'}),d=await r.json();if(!d.success)throw new Error(d.message||'Status unavailable.');const b=d.bot||{};document.getElementById('state').textContent=(b.connected?'ONLINE':String(b.state||'OFFLINE').toUpperCase());document.getElementById('guilds').textContent=String(b.guildCount||0);document.getElementById('commands').textContent=String(b.commandCount||0);document.getElementById('bot').textContent=b.message||'Bot status is ready.';document.getElementById('sync').textContent='SYNCED';['botStart','botStop','botSync'].forEach(id=>document.getElementById(id).disabled=!b.available);if(!silent)msg('Synced just now.')}catch(e){document.getElementById('sync').textContent='RECONNECTING';if(!silent)msg(e.message||'Connection lost. Keep CoreShift open.')}}async function act(action){if(busy)return;busy=true;try{const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-CS-Mobile':csrf},body:JSON.stringify({action})}),d=await r.json();msg(d.message||'Done.')}catch(e){msg(e.message||'Action failed.')}finally{busy=false;load(true)}}document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>act(b.dataset.action));document.getElementById('refresh').onclick=()=>load();setInterval(()=>{if(!document.hidden)load(true)},3000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)load(true)});load()</script>`;
}

function controllerPage(csrfValue) {
  const csrf = JSON.stringify(csrfValue || '');
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>El Rancho Bot Command Center</title><style>body{margin:0;background:#081018;color:#eef5fa;font:15px system-ui}.app{max-width:620px;margin:auto;padding:20px}.brand{color:#b7ff35;font-weight:900;letter-spacing:2px}.sync{float:right;color:#b7ff35;font-size:12px}.card{margin:14px 0;padding:17px;border:1px solid #304154;border-radius:14px;background:#101a27}.stats,.actions{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}.actions{grid-template-columns:1fr 1fr}label{display:block;margin:12px 0 4px;color:#b8c7d4;font-size:12px;font-weight:700}.metric{padding:12px;border-radius:10px;background:#0a121d}.metric small{display:block;color:#93a3b3}.metric b{display:block;margin-top:5px;font-size:18px;overflow-wrap:anywhere}input,textarea,select,button{box-sizing:border-box;width:100%;padding:12px;border:1px solid #41566e;border-radius:9px;background:#0a121d;color:#eff7ff;font:inherit}textarea{min-height:92px;resize:vertical}button{background:#162536;font-weight:700}button.primary{border:0;background:#b7ff35;color:#12200b}button:disabled{opacity:.45}.notice{color:#9aabba;line-height:1.4}.command-list{display:flex;flex-wrap:wrap;gap:6px}.command-list code{padding:5px 7px;border:1px solid #41566e;border-radius:6px;color:#b7ff35;font-size:11px}@media(max-width:420px){.stats{grid-template-columns:1fr}.actions{grid-template-columns:1fr}}</style><main class="app"><div class="brand">EL RANCHO <span class="sync" id="sync">CONNECTING</span></div><h1>Bot Command Center</h1><p class="notice">Private local Wi-Fi connection. This session is locked to this phone’s local address and expires after 10 minutes of inactivity. Keep CoreShift open.</p><section class="card"><div class="stats"><div class="metric"><small>STATUS</small><b id="state">--</b></div><div class="metric"><small>SERVERS</small><b id="guilds">--</b></div><div class="metric"><small>COMMANDS</small><b id="commands">--</b></div></div><p id="bot" class="notice">Reading bot status…</p></section><section class="card"><h2>Bot controls</h2><div class="actions"><button class="primary" data-action="bot-start" id="botStart">Start bot</button><button data-action="bot-stop" id="botStop">Stop bot</button><button data-action="bot-sync" id="botSync">Sync commands</button><button id="refresh">Refresh status</button></div><p id="message" class="notice">Ready.</p></section><section class="card"><h2>Server posts</h2><p class="notice">Post premade rules, a welcome, or a security reminder from your phone. Posts never ping @everyone or roles.</p><label>Server<select id="guild"></select></label><label>Channel<select id="channel"></select></label><label>Post type<select id="postType"><option value="announcement">Announcement</option><option value="rules">Premade rules</option><option value="welcome">Welcome message</option><option value="security">Security reminder</option></select></label><div id="customPost"><label>Title<input id="title" maxlength="256" placeholder="El Rancho announcement"></label><label>Message<textarea id="body" maxlength="4000" placeholder="Write your announcement…"></textarea></label></div><button class="primary" id="post">Post to Discord</button></section><section class="card"><h2>App commands</h2><p class="notice">These are the slash commands currently published by your bot. Use them in Discord with <b>/</b>; this page controls bot operations and safe server posts.</p><div id="commandList" class="command-list"></div></section></main><script>const csrf=${csrf};let busy=false,last=null;const $=id=>document.getElementById(id);function msg(v){$('message').textContent=v||''}async function call(path,opt={}){const r=await fetch(path,opt);const d=await r.json();if(!d.success)throw new Error(d.message||'Request failed.');return d}function populate(data){last=data;const b=data.bot||{};$('state').textContent=b.connected?'ONLINE':String(b.state||'OFFLINE').toUpperCase();$('guilds').textContent=String(b.guildCount||0);$('commands').textContent=String(b.commandCount||0);$('bot').textContent=b.message||'Bot status is ready.';$('sync').textContent='SECURE';['botStart','botStop','botSync'].forEach(id=>$(id).disabled=!b.available);const g=$('guild'),keep=g.value;g.replaceChildren(...(data.guilds||[]).map(x=>new Option(x.name,x.id)));if([...g.options].some(x=>x.value===keep))g.value=keep;channels();const list=$('commandList');list.replaceChildren(...(data.commands||[]).map(name=>{const c=document.createElement('code');c.textContent='/'+name;return c}))}function channels(){const g=(last?.guilds||[]).find(x=>x.id===$('guild').value)||(last?.guilds||[])[0],c=$('channel');c.replaceChildren(...(g?.channels||[]).map(x=>new Option('#'+x.name,x.id)));$('post').disabled=!c.options.length}async function load(silent=false){if(busy)return;try{const d=await call('/api/status',{cache:'no-store'});populate(d);if(!silent)msg('Synced just now.')}catch(e){$('sync').textContent='RECONNECTING';if(!silent)msg(e.message||'Connection lost. Keep CoreShift open.')}}async function act(action,payload={}){if(busy)return;busy=true;try{if(action==='bot-stop'&&!confirm('Stop the Discord bot?'))return;const d=await call('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-CS-Mobile':csrf,Origin:location.origin},body:JSON.stringify({action,...payload})});msg(d.message||'Done.')}catch(e){msg(e.message||'Action failed.')}finally{busy=false;load(true)}}document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>act(b.dataset.action));$('refresh').onclick=()=>load();$('guild').onchange=channels;$('postType').onchange=()=>{$('customPost').hidden=$('postType').value!=='announcement'};$('post').onclick=()=>act('bot-post',{guildId:$('guild').value,channelId:$('channel').value,type:$('postType').value,title:$('title').value, message:$('body').value});setInterval(()=>{if(!document.hidden)load(true)},3000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)load(true)});load()</script>`;
}

module.exports = { registerMobileControl, isPrivateAddress };
