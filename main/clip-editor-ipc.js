'use strict';

const { spawn } = require('child_process');
const ffmpegStaticPath = require('ffmpeg-static');

const CHANNELS = ['clips:import', 'clips:export', 'clips:mergeReplay', 'clips:cancelExport'];
const exportProcesses = new Map();
const VIDEO_EXTENSIONS = new Set(['.webm', '.mp4', '.mov', '.m4v', '.mkv', '.avi', '.wmv']);

function registerClipEditorIpc({ ipcMain, app, fs, path, dialog, getMainWindow }) {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);

  function clipsFolder() {
    return path.join(app.getPath('videos'), 'CoreShift Clips');
  }

  function resolveClip(filePath) {
    const folder = path.resolve(clipsFolder());
    const resolved = path.resolve(String(filePath || ''));
    if (path.dirname(resolved) !== folder || !VIDEO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) throw new Error('That clip is outside the CoreShift Clips folder or uses an unsupported format.');
    return resolved;
  }

  function ffmpegPath() {
    return app.isPackaged ? ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked') : ffmpegStaticPath;
  }

  ipcMain.handle('clips:import', async event => {
    let outputPath = '';
    try {
      const result = await dialog.showOpenDialog(getMainWindow?.(), {
        title: 'Choose a video to edit in CoreShift',
        properties: ['openFile'],
        filters: [
          { name: 'Video clips', extensions: ['webm', 'mp4', 'mov', 'm4v', 'mkv', 'avi', 'wmv'] },
          { name: 'All files', extensions: ['*'] }
        ]
      });
      if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true, message: 'Video import cancelled.' };
      const sourcePath = path.resolve(result.filePaths[0]);
      const extension = path.extname(sourcePath).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(extension)) throw new Error('Choose a WebM, MP4, MOV, M4V, MKV, AVI, or WMV video.');
      const stats = await fs.promises.stat(sourcePath);
      if (!stats.isFile() || !stats.size) throw new Error('The selected video is empty or unavailable.');
      if (stats.size > 4 * 1024 * 1024 * 1024) throw new Error('Imported videos are limited to 4 GB.');
      const folder = clipsFolder();
      await fs.promises.mkdir(folder, { recursive: true });
      if (path.dirname(sourcePath) === path.resolve(folder)) return { success: true, filePath: sourcePath, name: path.basename(sourcePath), message: 'That video is already in your CoreShift library.' };
      const directFormats = new Set(['.webm', '.mp4', '.mov', '.m4v']);
      if (directFormats.has(extension)) {
        outputPath = uniqueImportedPath(path, fs, folder, sourcePath);
        await fs.promises.copyFile(sourcePath, outputPath);
        if (!event.sender.isDestroyed()) event.sender.send('clips:exportProgress', { percent: 100, message: 'Video imported. Opening the editor…' });
      } else {
        outputPath = uniqueOutputPath(path, fs, folder, 'imported-' + path.basename(sourcePath, extension));
        if (!event.sender.isDestroyed()) event.sender.send('clips:exportProgress', { percent: 0, message: 'Converting ' + extension.slice(1).toUpperCase() + ' for the CoreShift editor…' });
        const args = ['-hide_banner', '-y', '-i', sourcePath, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '5', '-crf', '28', '-b:v', '0', '-c:a', 'libopus', '-b:a', '160k', '-progress', 'pipe:1', '-nostats', outputPath];
        await runFfmpeg({ binary: ffmpegPath(), args, key: event.sender.id, event, duration: 0 });
      }
      await writeMetadata(fs, outputPath, { kind: 'imported', originalName: path.basename(sourcePath), importedAt: new Date().toISOString() });
      return { success: true, filePath: outputPath, name: path.basename(outputPath), message: 'Video imported. Click it anytime to edit.' };
    } catch (error) {
      if (outputPath) await fs.promises.rm(outputPath, { force: true }).catch(() => {});
      return { success: false, message: cleanError(error) };
    }
  });

  ipcMain.handle('clips:export', async (event, payload) => {
    let captionFile = '';
    let outputPath = '';
    try {
      const inputPath = resolveClip(payload?.filePath);
      const options = cleanExportOptions(payload);
      const folder = clipsFolder();
      await fs.promises.mkdir(folder, { recursive: true });
      outputPath = uniqueOutputPath(path, fs, folder, options.name || 'edited-clip');
      if (options.caption) {
        captionFile = path.join(folder, '.caption-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.txt');
        await fs.promises.writeFile(captionFile, options.caption, 'utf8');
      }
      const args = buildExportArgs(inputPath, outputPath, captionFile, options);
      await runFfmpeg({
        binary: ffmpegPath(),
        args,
        key: event.sender.id,
        event,
        duration: options.end - options.start
      });
      await writeMetadata(fs, outputPath, {
        kind: 'edited',
        source: path.basename(inputPath),
        fps: options.fps,
        resolution: options.resolution,
        aspect: options.aspect,
        filter: options.filter,
        createdAt: new Date().toISOString()
      });
      return { success: true, filePath: outputPath, name: path.basename(outputPath), message: 'Edited clip exported successfully.' };
    } catch (error) {
      if (outputPath) await fs.promises.rm(outputPath, { force: true }).catch(() => {});
      return { success: false, message: cleanError(error) };
    } finally {
      if (captionFile) await fs.promises.rm(captionFile, { force: true }).catch(() => {});
    }
  });

  ipcMain.handle('clips:mergeReplay', async (event, payload) => {
    let tempFolder = '';
    let outputPath = '';
    try {
      const segments = Array.isArray(payload?.segments) ? payload.segments : [];
      if (!segments.length || segments.length > 30) throw new Error('The replay buffer did not contain valid segments.');
      const buffers = segments.map(segment => Buffer.from(segment));
      const totalSize = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
      if (!totalSize || totalSize > 750 * 1024 * 1024) throw new Error('The replay buffer is empty or larger than 750 MB.');
      const duration = clamp(payload?.duration, 5, 180, 30);
      const folder = clipsFolder();
      await fs.promises.mkdir(folder, { recursive: true });
      tempFolder = path.join(folder, '.replay-' + Date.now() + '-' + Math.random().toString(16).slice(2));
      await fs.promises.mkdir(tempFolder, { recursive: true });
      const lines = [];
      for (let index = 0; index < buffers.length; index += 1) {
        const segmentPath = path.join(tempFolder, 'segment-' + String(index).padStart(3, '0') + '.webm');
        await fs.promises.writeFile(segmentPath, buffers[index]);
        lines.push("file '" + segmentPath.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'");
      }
      const listPath = path.join(tempFolder, 'segments.txt');
      await fs.promises.writeFile(listPath, lines.join('\n'), 'utf8');
      outputPath = uniqueOutputPath(path, fs, folder, payload?.name || 'replay-' + duration + 's');
      const args = ['-hide_banner', '-y', '-sseof', '-' + duration, '-f', 'concat', '-safe', '0', '-i', listPath, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', outputPath];
      try {
        await runFfmpeg({ binary: ffmpegPath(), args, key: event.sender.id, event, duration });
      } catch {
        const fallback = ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6', '-b:v', '12M', '-c:a', 'libopus', '-b:a', '160k', '-t', String(duration), outputPath];
        await runFfmpeg({ binary: ffmpegPath(), args: fallback, key: event.sender.id, event, duration });
      }
      await writeMetadata(fs, outputPath, { kind: 'replay', duration, createdAt: new Date().toISOString() });
      return { success: true, filePath: outputPath, name: path.basename(outputPath), message: 'Replay saved to the CoreShift Clips folder.' };
    } catch (error) {
      if (outputPath) await fs.promises.rm(outputPath, { force: true }).catch(() => {});
      return { success: false, message: cleanError(error) };
    } finally {
      if (tempFolder) await fs.promises.rm(tempFolder, { recursive: true, force: true }).catch(() => {});
    }
  });

  ipcMain.handle('clips:cancelExport', event => {
    const process = exportProcesses.get(event.sender.id);
    if (!process) return { success: false, message: 'No clip export is running.' };
    process.kill();
    exportProcesses.delete(event.sender.id);
    return { success: true, message: 'Clip export cancelled.' };
  });
}

function cleanExportOptions(payload) {
  const start = Math.max(0, Number(payload?.start) || 0);
  const end = Math.max(start + 0.1, Number(payload?.end) || start + 0.1);
  if (end - start > 7200) throw new Error('An edited clip cannot be longer than two hours.');
  return {
    start,
    end,
    name: cleanName(payload?.name || 'edited-clip'),
    aspect: ['original', '16:9', '9:16', '1:1', '4:3'].includes(payload?.aspect) ? payload.aspect : 'original',
    resolution: ['source', '720', '1080', '1440', '2160'].includes(String(payload?.resolution)) ? String(payload.resolution) : 'source',
    fps: [15, 24, 30, 45, 60, 90, 120, 144].includes(Number(payload?.fps)) ? Number(payload.fps) : 60,
    bitrate: clamp(payload?.bitrate, 2000000, 80000000, 16000000),
    quality: ['fast', 'balanced', 'quality'].includes(payload?.quality) ? payload.quality : 'balanced',
    filter: ['clean', 'vibrant', 'cinematic', 'mono', 'warm', 'cool'].includes(payload?.filter) ? payload.filter : 'clean',
    brightness: clamp(payload?.brightness, -100, 100, 0) / 100,
    contrast: clamp(payload?.contrast, 50, 200, 100) / 100,
    saturation: clamp(payload?.saturation, 0, 250, 100) / 100,
    rotation: [0, 90, 180, 270].includes(Number(payload?.rotation)) ? Number(payload.rotation) : 0,
    flip: Boolean(payload?.flip),
    caption: String(payload?.caption || '').replace(/[\r\n\u0000]+/g, ' ').trim().slice(0, 160),
    captionPosition: ['top', 'center', 'bottom'].includes(payload?.captionPosition) ? payload.captionPosition : 'bottom',
    mute: Boolean(payload?.mute),
    volume: clamp(payload?.volume, 0, 200, 100) / 100
  };
}

function buildExportArgs(inputPath, outputPath, captionFile, options) {
  const args = ['-hide_banner', '-y', '-ss', options.start.toFixed(3), '-to', options.end.toFixed(3), '-i', inputPath, '-map', '0:v:0', '-map', '0:a?'];
  const filters = [];
  if (options.rotation === 90) filters.push('transpose=1');
  if (options.rotation === 180) filters.push('hflip,vflip');
  if (options.rotation === 270) filters.push('transpose=2');
  if (options.flip) filters.push('hflip');
  const ratios = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3 };
  if (ratios[options.aspect]) {
    const ratio = ratios[options.aspect].toFixed(8);
    filters.push('crop=if(gt(a\\,' + ratio + ')\\,ih*' + ratio + '\\,iw):if(gt(a\\,' + ratio + ')\\,ih\\,iw/' + ratio + ')');
  }
  if (options.resolution !== 'source') filters.push('scale=-2:' + options.resolution + ':flags=lanczos');
  const color = filterAdjustments(options.filter);
  const brightness = clamp(options.brightness + color.brightness, -1, 1, 0);
  const contrast = clamp(options.contrast + color.contrast, 0.1, 3, 1);
  const saturation = clamp(options.saturation + color.saturation, 0, 3, 1);
  filters.push('eq=brightness=' + brightness.toFixed(2) + ':contrast=' + contrast.toFixed(2) + ':saturation=' + saturation.toFixed(2));
  if (color.extra) filters.push(color.extra);
  filters.push('fps=' + options.fps);
  if (captionFile) {
    const escapedFile = captionFile.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const y = options.captionPosition === 'top' ? 'h*0.07' : options.captionPosition === 'center' ? '(h-text_h)/2' : 'h-text_h-h*0.07';
    filters.push("drawtext=fontfile='C\\:/Windows/Fonts/segoeuib.ttf':textfile='" + escapedFile + "':fontcolor=white:fontsize=h/22:borderw=2:bordercolor=black@0.9:box=1:boxcolor=black@0.38:boxborderw=12:x=(w-text_w)/2:y=" + y);
  }
  args.push('-vf', filters.join(','));
  const cpuUsed = options.quality === 'fast' ? '6' : options.quality === 'quality' ? '2' : '4';
  args.push('-c:v', 'libvpx-vp9', '-deadline', options.quality === 'quality' ? 'good' : 'realtime', '-cpu-used', cpuUsed, '-row-mt', '1', '-b:v', String(options.bitrate));
  if (options.mute) args.push('-an');
  else {
    if (Math.abs(options.volume - 1) > 0.01) args.push('-af', 'volume=' + options.volume.toFixed(2));
    args.push('-c:a', 'libopus', '-b:a', '160k');
  }
  args.push('-progress', 'pipe:1', '-nostats', outputPath);
  return args;
}

function filterAdjustments(filter) {
  if (filter === 'vibrant') return { brightness: 0.02, contrast: 0.12, saturation: 0.35, extra: '' };
  if (filter === 'cinematic') return { brightness: -0.03, contrast: 0.18, saturation: -0.08, extra: 'colorbalance=rs=.04:bs=-.04' };
  if (filter === 'mono') return { brightness: 0, contrast: 0.08, saturation: -1, extra: 'hue=s=0' };
  if (filter === 'warm') return { brightness: 0.02, contrast: 0.05, saturation: 0.1, extra: 'colorbalance=rs=.09:gs=.02:bs=-.07' };
  if (filter === 'cool') return { brightness: 0, contrast: 0.05, saturation: 0.08, extra: 'colorbalance=rs=-.05:bs=.09' };
  return { brightness: 0, contrast: 0, saturation: 0, extra: '' };
}

function runFfmpeg({ binary, args, key, event, duration }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    exportProcesses.set(key, child);
    let errorOutput = '';
    let progressBuffer = '';
    child.stdout.on('data', chunk => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || '';
      for (const line of lines) {
        const match = line.match(/^out_time_(?:ms|us)=(\d+)/);
        if (!match || !duration) continue;
        const seconds = Number(match[1]) / 1000000;
        const percent = Math.max(0, Math.min(99, seconds / duration * 100));
        if (!event.sender.isDestroyed()) event.sender.send('clips:exportProgress', { percent, message: 'Rendering edited clip… ' + Math.round(percent) + '%' });
      }
    });
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-12000); });
    child.once('error', error => {
      exportProcesses.delete(key);
      reject(error);
    });
    child.once('close', code => {
      exportProcesses.delete(key);
      if (code === 0) {
        if (!event.sender.isDestroyed()) event.sender.send('clips:exportProgress', { percent: 100, message: 'Finalizing clip…' });
        resolve();
      } else reject(new Error(extractFfmpegError(errorOutput, code)));
    });
  });
}

function extractFfmpegError(output, code) {
  const lines = String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const useful = lines.reverse().find(line => /error|invalid|failed|unknown|could not|no such/i.test(line));
  return useful || 'The video engine stopped with code ' + code + '.';
}

function uniqueOutputPath(path, fs, folder, requestedName) {
  const base = cleanName(requestedName);
  let output = path.join(folder, base + '-' + timestamp() + '.webm');
  let suffix = 2;
  while (fs.existsSync(output)) output = path.join(folder, base + '-' + timestamp() + '-' + suffix++ + '.webm');
  return output;
}

function uniqueImportedPath(path, fs, folder, sourcePath) {
  const extension = path.extname(sourcePath).toLowerCase();
  const base = cleanName(path.basename(sourcePath, extension));
  let output = path.join(folder, base + '-imported-' + timestamp() + extension);
  let suffix = 2;
  while (fs.existsSync(output)) output = path.join(folder, base + '-imported-' + timestamp() + '-' + suffix++ + extension);
  return output;
}

async function writeMetadata(fs, outputPath, metadata) {
  await fs.promises.writeFile(outputPath + '.json', JSON.stringify(metadata, null, 2), 'utf8').catch(() => {});
}

function cleanName(value) {
  return String(value || 'clip').replace(/\.webm$/i, '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 80) || 'clip';
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function cleanError(error) {
  return String(error?.message || error || 'Clip operation failed.').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500);
}

module.exports = { registerClipEditorIpc };
