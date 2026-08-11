'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const CHANNELS = [
  'booster:state',
  'booster:config:save',
  'booster:apply',
  'booster:restore',
  'booster:game:choose',
  'booster:game:launch',
  'booster:processes',
  'system:boost',
  'system:cleanRam',
  'system:applyFpsOptions'
];

const DEFAULT_CONFIG = Object.freeze({
  autoBoost: false,
  gamePath: '',
  powerPlan: true,
  cpuCores: true,
  cpuIdle: false,
  gameMode: true,
  gameDvr: true,
  trimRam: true,
  clearClipboard: false,
  stickyKeys: false,
  searchAssistant: false,
  backgroundApps: false,
  problemReports: false,
  diagnostics: false,
  quietNotifications: false
});

const BOOLEAN_KEYS = Object.keys(DEFAULT_CONFIG).filter(key => typeof DEFAULT_CONFIG[key] === 'boolean');
const REGISTRY_OPTIONS = Object.freeze({
  gameMode: [
    { path: 'HKCU:\\Software\\Microsoft\\GameBar', name: 'AutoGameModeEnabled', type: 'DWord', value: 1 }
  ],
  gameDvr: [
    { path: 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR', name: 'AppCaptureEnabled', type: 'DWord', value: 0 },
    { path: 'HKCU:\\System\\GameConfigStore', name: 'GameDVR_Enabled', type: 'DWord', value: 0 }
  ],
  stickyKeys: [
    { path: 'HKCU:\\Control Panel\\Accessibility\\StickyKeys', name: 'Flags', type: 'String', value: '506' }
  ],
  searchAssistant: [
    { path: 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\Windows Search', name: 'AllowCortana', type: 'DWord', value: 0 }
  ],
  backgroundApps: [
    { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications', name: 'GlobalUserDisabled', type: 'DWord', value: 1 }
  ],
  problemReports: [
    { path: 'HKCU:\\Software\\Microsoft\\Windows\\Windows Error Reporting', name: 'Disabled', type: 'DWord', value: 1 }
  ],
  diagnostics: [
    { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Privacy', name: 'TailoredExperiencesWithDiagnosticDataEnabled', type: 'DWord', value: 0 }
  ],
  quietNotifications: [
    { path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications', name: 'ToastEnabled', type: 'DWord', value: 0 }
  ]
});

function registerBoosterIpc({ ipcMain, dialog, clipboard, execFile, spawn, systeminformation, getSettings, saveSettings, getMainWindow }) {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);

  let config = sanitizeConfig(getSettings()?.booster);
  let session = freshSession();
  let autoTimer = null;
  let autoGameMissingChecks = 0;

  function handle(channel, operation) {
    ipcMain.handle(channel, async (_event, payload) => {
      try { return await operation(payload); }
      catch (error) { return { success: false, message: cleanError(error) }; }
    });
  }

  function persistConfig(next) {
    config = sanitizeConfig(next);
    const settings = getSettings();
    saveSettings({ ...settings, booster: config });
    configureAutoTimer();
    return config;
  }

  function publicState() {
    return {
      success: true,
      config,
      session: {
        active: session.active,
        autoApplied: session.autoApplied,
        appliedOptions: [...session.appliedOptions],
        itemsOptimized: session.itemsOptimized,
        releasedBytes: session.releasedBytes,
        availableGainBytes: session.availableGainBytes,
        processCount: session.processCount,
        gameDetected: session.gameDetected,
        lastAppliedAt: session.lastAppliedAt,
        lastMessage: session.lastMessage
      }
    };
  }

  async function applyBoost(payload = {}) {
    if (process.platform !== 'win32') throw new Error('CoreShift FPS Boost requires Windows.');
    const selected = sanitizeConfig({ ...config, ...(payload.config || payload) });
    if (payload.save !== false) persistConfig(selected);
    const applied = [];
    const warnings = [];
    await restoreDisabledOptions(selected, warnings);

    if (selected.powerPlan || selected.cpuCores || selected.cpuIdle) {
      const powerResult = await applyTemporaryPowerPlan(selected);
      if (powerResult.success) {
        if (selected.powerPlan) applied.push('Temporary gaming power plan');
        if (selected.cpuCores) applied.push('CPU core parking minimized');
        if (selected.cpuIdle) applied.push('Low-latency CPU idle policy');
        if (powerResult.warnings?.length) warnings.push(...powerResult.warnings);
      } else warnings.push(powerResult.message);
    }

    for (const [option, specs] of Object.entries(REGISTRY_OPTIONS)) {
      if (!selected[option]) continue;
      let succeeded = true;
      for (const spec of specs) {
        const key = registryKey(spec);
        if (!session.registryBackup.has(key)) {
          const backup = await readRegistryValue(spec);
          if (backup.readError) { succeeded = false; warnings.push(`Windows could not back up ${optionLabel(option)}, so CoreShift left it unchanged.`); continue; }
          session.registryBackup.set(key, backup);
        }
        const result = await writeRegistryValue(spec);
        if (!result.success) { succeeded = false; warnings.push(result.message); }
      }
      if (succeeded) applied.push(optionLabel(option));
    }

    if (selected.clearClipboard) {
      clipboard.clear();
      applied.push('Clipboard cleared');
    }

    let ramResult = null;
    if (selected.trimRam) {
      ramResult = await cleanRam();
      if (ramResult.success) applied.push(`RAM trimmed across ${ramResult.processCount} processes`);
      else warnings.push(ramResult.message);
    }

    session.active = applied.length > 0;
    session.appliedOptions = applied;
    session.itemsOptimized = applied.length;
    session.releasedBytes = ramResult?.releasedBytes || 0;
    session.availableGainBytes = ramResult?.availableGainBytes || 0;
    session.processCount = ramResult?.processCount || 0;
    session.lastAppliedAt = new Date().toISOString();
    session.lastMessage = warnings.length
      ? `${applied.length} optimizations applied. ${warnings.join(' ')}`
      : `${applied.length} reversible gaming optimizations are active.`;
    if (payload.autoApplied) session.autoApplied = true;
    return { ...publicState(), message: session.lastMessage, warnings };
  }

  async function applyTemporaryPowerPlan(selected) {
    if (!session.originalPowerScheme) {
      const current = await powerCfg(['/getactivescheme']);
      session.originalPowerScheme = extractGuid(current.stdout);
      if (!session.originalPowerScheme) return { success: false, message: 'Windows did not report the current power scheme.' };
    }
    if (!session.temporaryPowerScheme) {
      const duplicate = await powerCfg(['/duplicatescheme', session.originalPowerScheme]);
      session.temporaryPowerScheme = extractGuid(duplicate.stdout);
      if (duplicate.error || !session.temporaryPowerScheme) return { success: false, message: 'Windows could not create a temporary gaming power scheme.' };
      await powerCfg(['/changename', session.temporaryPowerScheme, 'CoreShift Gaming Temporary', 'Restored automatically when CoreShift closes']);
    }
    const scheme = session.temporaryPowerScheme;
    const commands = [];
    if (selected.powerPlan) {
      commands.push(['/setacvalueindex', scheme, 'SUB_PROCESSOR', 'PROCTHROTTLEMIN', '100']);
      commands.push(['/setacvalueindex', scheme, 'SUB_PROCESSOR', 'PROCTHROTTLEMAX', '100']);
    }
    if (selected.cpuCores) {
      commands.push(['/setacvalueindex', scheme, 'SUB_PROCESSOR', 'CPMINCORES', '100']);
      commands.push(['/setacvalueindex', scheme, 'SUB_PROCESSOR', 'CPMAXCORES', '100']);
    }
    if (selected.cpuIdle) commands.push(['/setacvalueindex', scheme, 'SUB_PROCESSOR', 'IDLEDISABLE', '1']);
    const warnings = [];
    for (const args of commands) {
      const result = await powerCfg(args);
      if (result.error) warnings.push(`Windows did not support the power setting ${args[3] || args[2]}.`);
    }
    const activated = await powerCfg(['/setactive', scheme]);
    return activated.error
      ? { success: false, message: 'Windows could not activate the temporary CoreShift power scheme.' }
      : { success: true, warnings };
  }

  async function restoreDisabledOptions(selected, warnings) {
    for (const [option, specs] of Object.entries(REGISTRY_OPTIONS)) {
      if (selected[option]) continue;
      for (const spec of specs) {
        const key = registryKey(spec);
        const backup = session.registryBackup.get(key);
        if (!backup) continue;
        const result = await restoreRegistryValue(spec, backup);
        if (result.success) session.registryBackup.delete(key);
        else warnings.push(result.message);
      }
    }
    if (!selected.powerPlan && !selected.cpuCores && !selected.cpuIdle && session.temporaryPowerScheme) {
      if (session.originalPowerScheme) await powerCfg(['/setactive', session.originalPowerScheme]);
      await powerCfg(['/delete', session.temporaryPowerScheme]);
      session.temporaryPowerScheme = '';
      session.originalPowerScheme = '';
    }
  }

  async function restoreBoost({ silent = false } = {}) {
    const errors = [];
    for (const [key, backup] of session.registryBackup) {
      const spec = backup.spec || parseRegistryKey(key);
      const result = await restoreRegistryValue(spec, backup);
      if (!result.success) errors.push(result.message);
    }
    if (session.originalPowerScheme) {
      const restored = await powerCfg(['/setactive', session.originalPowerScheme]);
      if (restored.error) errors.push('Windows could not restore the previous power scheme.');
    }
    if (session.temporaryPowerScheme) await powerCfg(['/delete', session.temporaryPowerScheme]);
    const lastMessage = errors.length ? `Restore finished with ${errors.length} warning(s).` : 'Previous Windows gaming settings were restored.';
    session = { ...freshSession(), lastMessage };
    if (!silent || errors.length) return { ...publicState(), success: errors.length === 0, message: lastMessage, warnings: errors };
    return publicState();
  }

  async function cleanRam() {
    if (process.platform !== 'win32') return { success: false, message: 'RAM cleanup is only available on Windows.' };
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CoreShiftMemoryTools { [DllImport(\"psapi.dll\")] public static extern bool EmptyWorkingSet(IntPtr h); }'",
      `$appPid=${process.pid}`,
      "$protected='^(System|Registry|smss|csrss|wininit|services|lsass|dwm|explorer|audiodg|MsMpEng|CoreShift|electron)$'",
      "$before=[int64](Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory*1KB",
      "$released=[int64]0; $count=0",
      "Get-Process | ForEach-Object { try { if ($_.Id -ne $PID -and $_.Id -ne $appPid -and $_.ProcessName -notmatch $protected) { $old=[int64]$_.WorkingSet64; if ([CoreShiftMemoryTools]::EmptyWorkingSet($_.Handle)) { $_.Refresh(); $delta=[Math]::Max(0,$old-[int64]$_.WorkingSet64); $released+=$delta; $count++ } } } catch {} }",
      "Start-Sleep -Milliseconds 200",
      "$after=[int64](Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory*1KB",
      "[pscustomobject]@{processCount=$count;releasedBytes=$released;availableGainBytes=[Math]::Max(0,$after-$before)} | ConvertTo-Json -Compress"
    ].join('; ');
    const result = await powershell(script);
    if (result.error) return { success: false, processCount: 0, releasedBytes: 0, availableGainBytes: 0, message: 'Windows could not trim background working memory.' };
    try {
      const parsed = JSON.parse(String(result.stdout || '').trim());
      const releasedBytes = Math.max(0, Number(parsed.releasedBytes) || 0);
      const availableGainBytes = Math.max(0, Number(parsed.availableGainBytes) || 0);
      const processCount = Math.max(0, Number(parsed.processCount) || 0);
      return { success: true, processCount, releasedBytes, availableGainBytes, message: `Released ${formatBytes(releasedBytes)} of background working memory from ${processCount} processes.` };
    } catch {
      return { success: false, processCount: 0, releasedBytes: 0, availableGainBytes: 0, message: 'Windows returned an unreadable RAM cleanup result.' };
    }
  }

  async function chooseGame() {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Choose a game executable',
      properties: ['openFile'],
      filters: [{ name: 'Windows games', extensions: ['exe'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true, config };
    const gamePath = validateGamePath(result.filePaths[0]);
    const saved = persistConfig({ ...config, gamePath });
    return { success: true, config: saved, gameName: path.basename(gamePath, '.exe'), message: `${path.basename(gamePath)} saved as the Auto-Boost game.` };
  }

  async function launchGame() {
    const gamePath = validateGamePath(config.gamePath);
    const boostResult = await applyBoost({ config, save: false });
    const child = spawn(gamePath, [], { cwd: path.dirname(gamePath), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    session.gameDetected = path.basename(gamePath, '.exe');
    return { success: true, message: `${path.basename(gamePath)} launched with CoreShift Boost.`, boost: boostResult };
  }

  async function listProcesses() {
    const result = await systeminformation.processes();
    const protectedNames = /^(system|registry|idle|memory compression|secure system)$/i;
    const rows = (result.list || [])
      .filter(item => item.pid > 4 && !protectedNames.test(String(item.name || '')))
      .sort((a, b) => (Number(b.memRss) || 0) - (Number(a.memRss) || 0))
      .slice(0, 12)
      .map(item => ({ pid: item.pid, name: item.name || 'Process', memoryMb: Math.max(0, Number(item.memRss) || 0) / 1024, cpu: Math.max(0, Number(item.cpu) || 0) }));
    return { success: true, rows };
  }

  function configureAutoTimer() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    if (!config.autoBoost || !config.gamePath) return;
    autoTimer = setInterval(checkAutoBoost, 10000);
    autoTimer.unref?.();
    setTimeout(checkAutoBoost, 1000);
  }

  async function checkAutoBoost() {
    try {
      if (!config.autoBoost || !config.gamePath) return;
      const target = path.basename(config.gamePath, '.exe').toLowerCase();
      const processes = await systeminformation.processes();
      const running = (processes.list || []).some(item => String(item.name || '').replace(/\.exe$/i, '').toLowerCase() === target);
      session.gameDetected = running ? target : '';
      if (running) {
        autoGameMissingChecks = 0;
        if (!session.active) await applyBoost({ config, save: false, autoApplied: true });
      } else if (session.autoApplied && ++autoGameMissingChecks >= 2) {
        await restoreBoost({ silent: true });
        autoGameMissingChecks = 0;
      }
    } catch { /* Auto-Boost retries on the next interval. */ }
  }

  function restoreOnExit() {
    if (process.platform !== 'win32') return;
    try {
      if (session.registryBackup.size) {
        const scripts = [];
        for (const [key, backup] of session.registryBackup) scripts.push(registryRestoreScript(backup.spec || parseRegistryKey(key), backup));
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', scripts.join('; ')], { timeout: 6000, windowsHide: true, stdio: 'ignore' });
      }
      if (session.originalPowerScheme) execFileSync('powercfg.exe', ['/setactive', session.originalPowerScheme], { timeout: 4000, windowsHide: true, stdio: 'ignore' });
      if (session.temporaryPowerScheme) execFileSync('powercfg.exe', ['/delete', session.temporaryPowerScheme], { timeout: 4000, windowsHide: true, stdio: 'ignore' });
    } catch { /* Windows may already be shutting down. */ }
  }

  handle('booster:state', async () => publicState());
  handle('booster:config:save', async payload => ({ success: true, config: persistConfig(payload), message: 'Booster options saved locally on this PC.' }));
  handle('booster:apply', applyBoost);
  handle('booster:restore', () => restoreBoost());
  handle('booster:game:choose', chooseGame);
  handle('booster:game:launch', launchGame);
  handle('booster:processes', listProcesses);
  handle('system:cleanRam', async () => {
    const result = await cleanRam();
    if (result.success) {
      session.releasedBytes = result.releasedBytes;
      session.availableGainBytes = result.availableGainBytes;
      session.processCount = result.processCount;
      session.itemsOptimized = result.processCount ? Math.max(1, session.itemsOptimized) : session.itemsOptimized;
      session.lastMessage = result.message;
    }
    return result;
  });
  handle('system:boost', () => applyBoost({ config: { ...config, powerPlan: true }, save: false }));
  handle('system:applyFpsOptions', options => applyBoost({ config: { ...config, gameMode: Boolean(options?.gameMode), gameDvr: Boolean(options?.gameDvr), trimRam: Boolean(options?.trimRam), powerPlan: false }, save: false }));

  configureAutoTimer();
  return {
    getState: publicState,
    apply: () => applyBoost({ config, save: false }),
    restore: () => restoreBoost(),
    restoreOnExit,
    dispose() { if (autoTimer) clearInterval(autoTimer); autoTimer = null; }
  };

  function powerCfg(args) {
    return new Promise(resolve => execFile('powercfg.exe', args, { windowsHide: true }, (error, stdout) => resolve({ error, stdout: stdout || '' })));
  }

  function powershell(script) {
    return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout: stdout || '', stderr: stderr || '' })));
  }

  async function readRegistryValue(spec) {
    const p = psLiteral(spec.path);
    const n = psLiteral(spec.name);
    const script = `$p=${p};$n=${n};$exists=$false;$value=$null;$kind='${spec.type}';if(Test-Path -LiteralPath $p){$item=Get-ItemProperty -LiteralPath $p -Name $n -ErrorAction SilentlyContinue;if($null -ne $item){$exists=$true;$value=$item.$n;try{$kind=(Get-Item -LiteralPath $p).GetValueKind($n).ToString()}catch{}}};[pscustomobject]@{exists=$exists;value=$value;type=$kind}|ConvertTo-Json -Compress`;
    const result = await powershell(script);
    if (result.error) return { exists: false, value: null, type: spec.type, spec, readError: true };
    try { return { ...JSON.parse(String(result.stdout || '').trim()), spec }; }
    catch { return { exists: false, value: null, type: spec.type, spec, readError: true }; }
  }

  async function writeRegistryValue(spec) {
    const script = `$p=${psLiteral(spec.path)};$n=${psLiteral(spec.name)};New-Item -Path $p -Force|Out-Null;New-ItemProperty -Path $p -Name $n -PropertyType ${spec.type} -Value ${psLiteral(spec.value)} -Force|Out-Null`;
    const result = await powershell(script);
    return result.error ? { success: false, message: `Windows could not apply ${optionLabelForSpec(spec)}.` } : { success: true };
  }

  async function restoreRegistryValue(spec, backup) {
    const result = await powershell(registryRestoreScript(spec, backup));
    return result.error ? { success: false, message: `Windows could not restore ${optionLabelForSpec(spec)}.` } : { success: true };
  }
}

function sanitizeConfig(input = {}) {
  const output = { ...DEFAULT_CONFIG };
  for (const key of BOOLEAN_KEYS) if (typeof input?.[key] === 'boolean') output[key] = input[key];
  const gamePath = String(input?.gamePath || '').trim();
  output.gamePath = gamePath.length <= 4096 ? gamePath : '';
  if (!output.gamePath) output.autoBoost = false;
  return output;
}

function freshSession() {
  return { active: false, autoApplied: false, originalPowerScheme: '', temporaryPowerScheme: '', registryBackup: new Map(), appliedOptions: [], itemsOptimized: 0, releasedBytes: 0, availableGainBytes: 0, processCount: 0, gameDetected: '', lastAppliedAt: '', lastMessage: 'No boost is active.' };
}

function validateGamePath(value) {
  const resolved = path.resolve(String(value || ''));
  if (path.extname(resolved).toLowerCase() !== '.exe' || !fs.existsSync(resolved)) throw new Error('Choose an existing Windows .exe game file first.');
  return resolved;
}

function extractGuid(value) {
  return String(value || '').match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)?.[0] || '';
}

function registryKey(spec) { return `${spec.path}\u0000${spec.name}`; }
function parseRegistryKey(key) { const [registryPath, name] = String(key).split('\u0000'); return { path: registryPath, name, type: 'String' }; }
function psLiteral(value) { return `'${String(value ?? '').replace(/'/g, "''")}'`; }

function registryRestoreScript(spec, backup) {
  const p = psLiteral(spec.path);
  const n = psLiteral(spec.name);
  if (!backup.exists) return `$p=${p};$n=${n};if(Test-Path -LiteralPath $p){Remove-ItemProperty -LiteralPath $p -Name $n -ErrorAction SilentlyContinue}`;
  const type = ['DWord', 'QWord', 'String', 'ExpandString', 'MultiString', 'Binary'].includes(backup.type) ? backup.type : spec.type;
  return `$p=${p};$n=${n};New-Item -Path $p -Force|Out-Null;New-ItemProperty -Path $p -Name $n -PropertyType ${type} -Value ${psLiteral(backup.value)} -Force|Out-Null`;
}

function optionLabel(key) {
  return ({ gameMode: 'Windows Game Mode', gameDvr: 'Game DVR disabled', stickyKeys: 'Sticky Keys shortcut disabled', searchAssistant: 'Legacy search assistant disabled', backgroundApps: 'Background apps restricted', problemReports: 'Problem reporting paused', diagnostics: 'Diagnostic personalization reduced', quietNotifications: 'Notification toasts silenced' })[key] || key;
}

function optionLabelForSpec(spec) { return spec.name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(); }
function formatBytes(bytes) { return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : `${Math.max(0, bytes / 1048576).toFixed(0)} MB`; }
function cleanError(error) { return String(error?.message || 'Booster operation failed.').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500); }

module.exports = { registerBoosterIpc, sanitizeConfig, DEFAULT_CONFIG, CHANNELS, extractGuid };
