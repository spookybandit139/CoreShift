'use strict';

const CHANNELS = ['discord:connect', 'discord:disconnect', 'discord:status'];
const OPCODE = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function registerDiscordPresence({ ipcMain, net, BrowserWindow, app }) {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  let socket = null;
  let receiveBuffer = Buffer.alloc(0);
  let retryTimer = null;
  let enabled = false;
  let configuration = null;
  let activityStartedAt = Math.floor(Date.now() / 1000);
  let activityNonce = null;
  let status = { connected: false, published: false, enabled: false, message: 'Discord presence is disabled.' };

  function broadcast(next) {
    status = { ...status, ...next, enabled };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('discord:statusChanged', status);
    }
    return status;
  }

  function closeSocket() {
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
      socket = null;
    }
    receiveBuffer = Buffer.alloc(0);
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry() {
    clearRetry();
    if (!enabled || !configuration) return;
    retryTimer = setTimeout(() => connectToDiscord().catch(() => {}), 15000);
  }

  function frame(opcode, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(opcode, 0);
    header.writeInt32LE(body.length, 4);
    return Buffer.concat([header, body]);
  }

  function write(opcode, payload) {
    if (!socket || socket.destroyed || !socket.writable) return false;
    socket.write(frame(opcode, payload));
    return true;
  }

  function sendActivity() {
    if (!configuration) return;
    const activity = {
      type: 0,
      details: configuration.details,
      state: configuration.state,
      timestamps: { start: activityStartedAt },
      instance: false
    };
    activityNonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    write(OPCODE.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity },
      nonce: activityNonce
    });
    broadcast({ connected: true, published: false, message: 'Discord connected. Waiting for activity confirmation...' });
  }

  function processFrames(chunk) {
    receiveBuffer = Buffer.concat([receiveBuffer, chunk]);
    while (receiveBuffer.length >= 8) {
      const opcode = receiveBuffer.readInt32LE(0);
      const length = receiveBuffer.readInt32LE(4);
      if (length < 0 || length > 1024 * 1024) {
        closeSocket();
        broadcast({ connected: false, message: 'Discord returned an invalid RPC frame.' });
        scheduleRetry();
        return;
      }
      if (receiveBuffer.length < 8 + length) return;
      const payloadBuffer = receiveBuffer.subarray(8, 8 + length);
      receiveBuffer = receiveBuffer.subarray(8 + length);
      let payload = {};
      try { payload = JSON.parse(payloadBuffer.toString('utf8')); } catch {}
      if (opcode === OPCODE.PING) write(OPCODE.PONG, payload);
      if (opcode === OPCODE.CLOSE) {
        closeSocket();
        broadcast({ connected: false, published: false, message: payload?.message || 'Discord closed the Rich Presence connection.' });
        scheduleRetry();
        return;
      }
      if (opcode === OPCODE.FRAME && payload?.evt === 'READY') {
        sendActivity();
      }
      if (opcode === OPCODE.FRAME && payload?.evt === 'ERROR') {
        const errorMessage = cleanLine(payload?.data?.message || payload?.message, 180) || 'Discord rejected the Rich Presence request.';
        broadcast({ connected: true, published: false, message: `Discord error: ${errorMessage}` });
      }
      if (opcode === OPCODE.FRAME && payload?.cmd === 'SET_ACTIVITY' && payload?.nonce === activityNonce && !payload?.evt) {
        const publishedName = cleanLine(payload?.data?.name, 64) || 'CoreShift';
        broadcast({ connected: true, published: true, message: `${publishedName} is now published to your Discord profile.` });
      }
    }
  }

  function openPipe(pipePath) {
    return new Promise((resolve, reject) => {
      const candidate = net.createConnection(pipePath);
      const timeout = setTimeout(() => {
        candidate.destroy();
        reject(new Error('Discord RPC connection timed out.'));
      }, 900);
      candidate.once('connect', () => { clearTimeout(timeout); resolve(candidate); });
      candidate.once('error', error => { clearTimeout(timeout); candidate.destroy(); reject(error); });
    });
  }

  async function findDiscordPipe() {
    if (process.platform !== 'win32') throw new Error('Discord Rich Presence currently requires Windows in CoreShift.');
    for (let index = 0; index < 10; index += 1) {
      try { return await openPipe(`\\\\?\\pipe\\discord-ipc-${index}`); } catch {}
    }
    throw new Error('Discord Desktop is not running. CoreShift will retry automatically.');
  }

  async function connectToDiscord() {
    clearRetry();
    closeSocket();
    broadcast({ connected: false, published: false, message: 'Connecting to Discord Desktop…' });
    try {
      socket = await findDiscordPipe();
      receiveBuffer = Buffer.alloc(0);
      socket.on('data', processFrames);
      socket.on('error', () => {
        closeSocket();
        broadcast({ connected: false, published: false, message: 'Discord Rich Presence disconnected. Retrying…' });
        scheduleRetry();
      });
      socket.on('close', () => {
        if (!socket) return;
        closeSocket();
        broadcast({ connected: false, published: false, message: 'Discord Rich Presence disconnected. Retrying…' });
        scheduleRetry();
      });
      write(OPCODE.HANDSHAKE, { v: 1, client_id: configuration.clientId });
      return broadcast({ connected: true, published: false, message: 'Connected to Discord. Publishing CoreShift activity…' });
    } catch (error) {
      closeSocket();
      const next = broadcast({ connected: false, published: false, message: error.message });
      scheduleRetry();
      return next;
    }
  }

  ipcMain.handle('discord:connect', async (_event, payload) => {
    const clientId = String(payload?.clientId || '').trim();
    if (!/^\d{17,20}$/.test(clientId)) return { success: false, message: 'Enter a valid Discord Application ID.' };
    configuration = {
      clientId,
      details: cleanLine(payload?.details, 128) || 'Using the CoreShift Desktop Suite',
      state: cleanLine(payload?.state, 128) || 'Game Control Center'
    };
    enabled = true;
    activityStartedAt = Math.floor(Date.now() / 1000);
    const next = await connectToDiscord();
    return { success: next.connected, ...next };
  });

  ipcMain.handle('discord:disconnect', async () => {
    enabled = false;
    clearRetry();
    if (socket && configuration) {
      write(OPCODE.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: String(Date.now()) });
    }
    closeSocket();
    configuration = null;
    return { success: true, ...broadcast({ connected: false, published: false, message: 'Discord Rich Presence is disabled.' }) };
  });

  ipcMain.handle('discord:status', () => ({ success: true, ...status }));
  app.on('before-quit', () => { enabled = false; clearRetry(); closeSocket(); });
}

function cleanLine(value, maximum) {
  return String(value || '').replace(/[\r\n\u0000-\u001f]+/g, ' ').trim().slice(0, maximum);
}

module.exports = { registerDiscordPresence };
