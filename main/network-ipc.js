'use strict';

const dns = require('dns').promises;

const CHANNELS = ['network:ping', 'network:info', 'network:flushDns'];

function registerNetworkIpc({ ipcMain, execFile, systeminformation }) {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);

  ipcMain.handle('network:ping', async (_event, payload) => {
    try {
      const host = normalizeHost(payload?.host);
      const count = Math.min(12, Math.max(4, Number(payload?.count) || 6));
      const lookup = await dns.lookup(host, { all: true }).catch(() => []);
      const result = await runPing(execFile, host, count);
      return { success: true, host, addresses: lookup.map(item => item.address), ...result };
    } catch (error) { return { success: false, message: error.message }; }
  });

  ipcMain.handle('network:info', async () => {
    try {
      const interfaces = await systeminformation.networkInterfaces();
      const adapters = interfaces
        .filter(item => item && item.ip4 && !item.internal && (item.default || item.operstate === 'up'))
        .sort((left, right) => Number(right.default) - Number(left.default))
        .map(item => ({ iface: item.iface, name: item.ifaceName || item.iface, ip4: item.ip4, mac: item.mac, speed: Number(item.speed) || 0, type: item.type || 'network' }));
      return { success: true, adapters };
    } catch (error) { return { success: false, message: error.message }; }
  });

  ipcMain.handle('network:flushDns', () => new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ success: false, message: 'DNS cache cleanup currently requires Windows.' });
    execFile('ipconfig.exe', ['/flushdns'], { windowsHide: true, timeout: 10000 }, error => {
      resolve(error ? { success: false, message: 'Windows could not flush the DNS resolver cache.' } : { success: true, message: 'Windows DNS resolver cache cleared.' });
    });
  }));
}

function runPing(execFile, host, count) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Latency Lab currently requires Windows ping tools.'));
  return new Promise((resolve, reject) => {
    execFile('ping.exe', ['-4', '-n', String(count), '-w', '1400', host], { windowsHide: true, timeout: count * 1800 + 3000, maxBuffer: 256 * 1024 }, (error, stdout = '') => {
      const output = String(stdout);
      if (!output.trim()) return reject(new Error(error?.message || 'The ping test returned no results.'));
      if (/could not find host|name or service not known/i.test(output)) return reject(new Error('That host could not be resolved.'));
      const samples = [...output.matchAll(/time\s*([=<])\s*(\d+)\s*ms/gi)].map(match => match[1] === '<' ? 0.5 : Number(match[2]));
      const sent = count;
      const received = samples.length;
      const loss = Math.max(0, Math.min(100, ((sent - received) / sent) * 100));
      if (!received) return resolve({ samples: [], sent, received, loss: 100, minimum: null, maximum: null, average: null, jitter: null, grade: 'Offline' });
      const minimum = Math.min(...samples);
      const maximum = Math.max(...samples);
      const average = samples.reduce((sum, value) => sum + value, 0) / received;
      const differences = samples.slice(1).map((value, index) => Math.abs(value - samples[index]));
      const jitter = differences.length ? differences.reduce((sum, value) => sum + value, 0) / differences.length : 0;
      resolve({ samples, sent, received, loss, minimum, maximum, average, jitter, grade: connectionGrade(average, jitter, loss) });
    });
  });
}

function connectionGrade(average, jitter, loss) {
  if (loss === 0 && average < 35 && jitter < 8) return 'Excellent';
  if (loss <= 1 && average < 70 && jitter < 15) return 'Good';
  if (loss <= 3 && average < 120 && jitter < 30) return 'Fair';
  return 'Poor';
}

function normalizeHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/:\d+$/, '');
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/i.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) throw new Error('Enter a valid hostname or IPv4 address.');
  return host;
}

module.exports = { registerNetworkIpc };
