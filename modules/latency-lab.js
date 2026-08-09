(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  let initialized = false;
  let busy = false;
  let monitorTimer = null;
  let savedTargets = [];
  let history = [];
  let sessionLog = [];
  let lastResult = null;

  function cleanTargets(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(item => item && typeof item.name === 'string' && typeof item.host === 'string')
      .slice(0, 30)
      .map(item => ({ id: String(item.id || crypto.randomUUID()), name: item.name.trim().slice(0, 40), host: item.host.trim().slice(0, 253) }))
      .filter(item => item.name && item.host);
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value || '');
    return div.innerHTML;
  }

  function notify(message) {
    if (typeof window.coreShiftToast === 'function') window.coreShiftToast(message);
  }

  function formatMs(value) {
    return Number.isFinite(value) ? Math.round(value * 10) / 10 + ' ms' : '—';
  }

  function setStatus(text, mode) {
    const node = $('#latencyStatus');
    if (!node) return;
    node.textContent = text;
    node.className = 'latency-status' + (mode ? ' ' + mode : '');
  }

  async function persistTargets() {
    await window.coreShiftAPI.saveSettings({ latencyTargets: savedTargets });
  }

  function renderTargets() {
    const target = $('#latencySavedTargets');
    if (!target) return;
    target.innerHTML = savedTargets.length ? savedTargets.map(item =>
      '<div class="latency-target">' +
        '<div><b>' + escapeHtml(item.name) + '</b><small>' + escapeHtml(item.host) + '</small></div>' +
        '<button type="button" data-latency-use="' + escapeHtml(item.id) + '">TEST</button>' +
        '<button type="button" class="danger" data-latency-remove="' + escapeHtml(item.id) + '" aria-label="Remove target">×</button>' +
      '</div>'
    ).join('') : '<div class="latency-empty">Save your game regions, servers, or DNS targets here.</div>';
  }

  function renderLog() {
    const target = $('#latencyLog');
    if (!target) return;
    target.innerHTML = sessionLog.length ? sessionLog.map(item =>
      '<div class="latency-log-row">' +
        '<div><b>' + escapeHtml(item.host) + '</b><small>' + escapeHtml(item.time) + ' · ' + escapeHtml(item.grade) + ' · ' + item.loss.toFixed(1) + '% loss</small></div>' +
        '<strong>' + (Number.isFinite(item.average) ? formatMs(item.average) : 'OFFLINE') + '</strong>' +
      '</div>'
    ).join('') : '<div class="latency-empty">Run a test to begin the session log.</div>';
  }

  function renderMetrics(result) {
    $('#latencyAverage').textContent = formatMs(result.average);
    $('#latencyJitter').textContent = formatMs(result.jitter);
    $('#latencyLoss').textContent = result.loss.toFixed(1) + '%';
    $('#latencyGrade').textContent = String(result.grade || 'Unknown').toUpperCase();
    $('#latencyRange').textContent = Number.isFinite(result.minimum) ? formatMs(result.minimum) + ' min · ' + formatMs(result.maximum) + ' max' : 'No replies received';
    const resolved = result.addresses && result.addresses.length ? result.addresses.join(', ') : result.host;
    $('#latencyResolved').textContent = result.host + (resolved && resolved !== result.host ? ' → ' + resolved : '');
  }

  function drawChart() {
    const canvas = $('#latencyChart');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.max(500, Math.round(rect.width * ratio));
    canvas.height = Math.max(220, Math.round(rect.height * ratio));
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const pad = 34 * ratio;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(126,151,177,.13)';
    ctx.lineWidth = ratio;
    ctx.font = 9 * ratio + 'px sans-serif';
    ctx.fillStyle = 'rgba(140,158,178,.62)';
    for (let line = 0; line < 5; line += 1) {
      const y = pad + (height - pad * 2) * line / 4;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(width - pad, y);
      ctx.stroke();
    }
    if (!history.length) {
      ctx.textAlign = 'center';
      ctx.fillText('Your rolling latency graph will appear here', width / 2, height / 2);
      $('#latencySampleCount').textContent = '0 SAMPLES';
      return;
    }
    const maxValue = Math.max(50, ...history) * 1.2;
    const points = history.map((value, index) => ({
      x: pad + (width - pad * 2) * (history.length === 1 ? 1 : index / (history.length - 1)),
      y: height - pad - (height - pad * 2) * Math.min(1, value / maxValue)
    }));
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#b7ff35';
    const gradient = ctx.createLinearGradient(0, pad, 0, height - pad);
    gradient.addColorStop(0, accent + '55');
    gradient.addColorStop(1, accent + '00');
    ctx.beginPath();
    ctx.moveTo(points[0].x, height - pad);
    points.forEach(point => ctx.lineTo(point.x, point.y));
    ctx.lineTo(points[points.length - 1].x, height - pad);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.beginPath();
    points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2 * ratio;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 9 * ratio;
    ctx.stroke();
    ctx.shadowBlur = 0;
    const latest = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(latest.x, latest.y, 4 * ratio, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    $('#latencySampleCount').textContent = history.length + (history.length === 1 ? ' SAMPLE' : ' SAMPLES');
  }

  async function runTest(options) {
    const quiet = Boolean(options && options.quiet);
    if (busy) return;
    const host = $('#latencyHost').value.trim();
    if (!host) {
      notify('Enter a server address or hostname.');
      return;
    }
    busy = true;
    $('#latencyTestBtn').disabled = true;
    $('#latencyTestBtn').textContent = 'Testing connection…';
    setStatus(monitorTimer ? 'LIVE TEST RUNNING' : 'TESTING CONNECTION', monitorTimer ? 'live' : 'testing');
    try {
      const result = await window.coreShiftAPI.testLatency({ host, count: 4 });
      if (!result || !result.success) throw new Error(result && result.message ? result.message : 'The latency test could not start.');
      lastResult = result;
      result.samples.forEach(sample => history.push(sample));
      history = history.slice(-60);
      sessionLog.unshift({
        host: result.host,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        grade: result.grade,
        average: result.average,
        loss: result.loss
      });
      sessionLog = sessionLog.slice(0, 20);
      renderMetrics(result);
      renderLog();
      drawChart();
      setStatus(monitorTimer ? 'LIVE MONITOR ACTIVE' : String(result.grade).toUpperCase() + ' CONNECTION', monitorTimer ? 'live' : '');
      if (!quiet) notify('Connection test complete: ' + result.grade + '.');
    } catch (error) {
      setStatus(monitorTimer ? 'MONITOR RETRYING' : 'TEST FAILED', monitorTimer ? 'live' : '');
      if (!quiet) notify(error.message);
    } finally {
      busy = false;
      $('#latencyTestBtn').disabled = false;
      $('#latencyTestBtn').textContent = 'Run connection test';
    }
  }

  function stopMonitor(showNotice) {
    const button = $('#latencyMonitorBtn');
    if (!monitorTimer) return;
    clearInterval(monitorTimer);
    monitorTimer = null;
    button.textContent = 'Start live monitor';
    setStatus(navigator.onLine ? 'MONITOR STOPPED' : 'NETWORK OFFLINE', '');
    if (showNotice) notify('Live latency monitor stopped.');
  }

  function toggleMonitor() {
    if (monitorTimer) {
      stopMonitor(true);
      return;
    }
    if (!navigator.onLine) {
      notify('Connect to the internet before starting the live monitor.');
      return;
    }
    const button = $('#latencyMonitorBtn');
    button.textContent = 'Stop live monitor';
    setStatus('LIVE MONITOR ACTIVE', 'live');
    runTest({ quiet: true });
    monitorTimer = setInterval(() => runTest({ quiet: true }), 10000);
    notify('Live latency monitor started.');
  }

  async function loadAdapter() {
    const box = $('#latencyAdapter');
    if (!box) return;
    const result = await window.coreShiftAPI.getNetworkInfo();
    if (!result || !result.success) {
      box.textContent = result && result.message ? result.message : 'Adapter information is unavailable.';
      return;
    }
    const adapter = result.adapters && result.adapters[0];
    box.innerHTML = adapter ?
      '<b>' + escapeHtml(adapter.name || adapter.iface) + '</b><span>' + escapeHtml(adapter.type) + ' · ' + escapeHtml(adapter.ip4) + '</span>' +
      (adapter.speed ? escapeHtml(adapter.speed) + ' Mbps negotiated speed' : 'Windows did not report the link speed.') :
      '<b>No active adapter found</b>Connect to Ethernet or Wi-Fi, then reopen Latency Lab.';
  }

  async function flushDns() {
    const status = $('#latencyToolStatus');
    status.textContent = 'Asking Windows to clear the DNS resolver cache…';
    const result = await window.coreShiftAPI.flushDnsCache();
    status.textContent = result && result.message ? result.message : 'DNS cleanup finished.';
    notify(status.textContent);
  }

  async function copyReport() {
    if (!lastResult) {
      notify('Run a connection test before copying a report.');
      return;
    }
    const result = lastResult;
    const report = [
      'CoreShift Latency Lab Report',
      'Target: ' + result.host,
      'Resolved: ' + ((result.addresses || []).join(', ') || 'Not reported'),
      'Average: ' + formatMs(result.average),
      'Minimum: ' + formatMs(result.minimum),
      'Maximum: ' + formatMs(result.maximum),
      'Jitter: ' + formatMs(result.jitter),
      'Packet loss: ' + result.loss.toFixed(1) + '%',
      'Grade: ' + result.grade,
      'Captured: ' + new Date().toLocaleString()
    ].join('\n');
    try {
      await navigator.clipboard.writeText(report);
      notify('Latency report copied.');
    } catch {
      const area = document.createElement('textarea');
      area.value = report;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      notify('Latency report copied.');
    }
  }

  function bind() {
    $('#latencyTestBtn').addEventListener('click', () => runTest());
    $('#latencyMonitorBtn').addEventListener('click', toggleMonitor);
    $('#flushDnsBtn').addEventListener('click', flushDns);
    $('#copyLatencyReportBtn').addEventListener('click', copyReport);
    $('#latencyHost').addEventListener('keydown', event => {
      if (event.key === 'Enter') runTest();
    });
    document.querySelectorAll('[data-latency-host]').forEach(button => button.addEventListener('click', () => {
      $('#latencyHost').value = button.dataset.latencyHost;
      runTest();
    }));
    $('#latencySaveForm').addEventListener('submit', async event => {
      event.preventDefault();
      const name = $('#latencyTargetName').value.trim();
      const host = $('#latencyTargetHost').value.trim();
      if (!name || !host) return;
      savedTargets.unshift({ id: crypto.randomUUID(), name, host });
      savedTargets = cleanTargets(savedTargets);
      event.target.reset();
      renderTargets();
      await persistTargets();
      notify('Latency target saved.');
    });
    $('#latencySavedTargets').addEventListener('click', async event => {
      const use = event.target.closest('[data-latency-use]');
      const remove = event.target.closest('[data-latency-remove]');
      if (use) {
        const item = savedTargets.find(target => target.id === use.dataset.latencyUse);
        if (item) {
          $('#latencyHost').value = item.host;
          runTest();
        }
      }
      if (remove) {
        savedTargets = savedTargets.filter(target => target.id !== remove.dataset.latencyRemove);
        renderTargets();
        await persistTargets();
        notify('Latency target removed.');
      }
    });
    window.addEventListener('resize', drawChart);
    window.addEventListener('offline', () => stopMonitor(false));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopMonitor(false);
    });
  }

  window.LatencyLab = {
    async init() {
      if (initialized) return;
      initialized = true;
      const settings = await window.coreShiftAPI.getSettings();
      savedTargets = cleanTargets(settings.latencyTargets);
      renderTargets();
      renderLog();
      bind();
      await loadAdapter();
      requestAnimationFrame(drawChart);
    },
    onShow() {
      loadAdapter();
      requestAnimationFrame(drawChart);
    },
    onHide() {
      stopMonitor(false);
    }
  };
})();
