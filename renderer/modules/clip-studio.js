(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const state = {
    initialized: false,
    clips: [],
    selected: null,
    objectUrl: '',
    stream: null,
    rawStreams: [],
    audioContext: null,
    recorder: null,
    chunks: [],
    captureMode: '',
    captureStartedAt: 0,
    captureClock: null,
    replayActive: false,
    replaySegments: [],
    replaySegmentTimer: null,
    replaySavePending: false,
    replaySaving: false,
    exporting: false,
    playingSelection: false,
    settings: {}
  };
  const toast = message => window.coreShiftToast?.(message);

  async function init() {
    if (state.initialized) return;
    state.initialized = true;
    bindCapture();
    bindEditor();
    bindHotkeys();
    window.coreShiftAPI.onClipExportProgress(renderExportProgress);
    window.coreShiftAPI.onSaveReplayHotkey(() => saveReplayBuffer());
    const settings = await window.coreShiftAPI.getSettings();
    state.settings = sanitizeSettings(settings.clipStudio || {});
    applySettings();
    await refreshSources();
    await refresh();
    updateCaptureUi();
  }

  function bindCapture() {
    $('#recordBtn').addEventListener('click', toggleFullRecording);
    $('#replayBufferBtn').addEventListener('click', toggleReplayBuffer);
    $('#saveReplayBtn').addEventListener('click', saveReplayBuffer);
    $('#openFolderBtn').addEventListener('click', openFolder);
    $('#refreshSourcesBtn').addEventListener('click', refreshSources);
    const ids = ['clipSourceSelect', 'clipResolutionSelect', 'clipFpsSelect', 'bitrateSelect', 'clipReplayLength', 'clipReplaySegment', 'clipAudioToggle', 'clipMicToggle', 'clipSystemVolume', 'clipMicVolume'];
    ids.forEach(id => $('#' + id).addEventListener('change', persistCaptureSettings));
    $('#clipSystemVolume').addEventListener('input', updateMixerReadouts);
    $('#clipMicVolume').addEventListener('input', updateMixerReadouts);
  }

  function bindEditor() {
    $('#refreshClipsBtn').addEventListener('click', () => refresh());
    $('#clipImportBtn').addEventListener('click', importClip);
    $('#clipEditSelectedBtn').addEventListener('click', openSelectedEditor);
    $('#clipSearch').addEventListener('input', renderLibrary);
    $('#clipList').addEventListener('click', handleLibraryAction);
    $('#clipPreview').addEventListener('loadedmetadata', configureTimeline);
    $('#clipPreview').addEventListener('timeupdate', updatePlayhead);
    $('#clipPreview').addEventListener('pause', () => {
      if ($('#clipPlaySelectionBtn')) $('#clipPlaySelectionBtn').textContent = '▶ Play selection';
    });
    $('#clipStartRange').addEventListener('input', updateStart);
    $('#clipEndRange').addEventListener('input', updateEnd);
    $('#clipSetStartBtn').addEventListener('click', setStartAtPlayhead);
    $('#clipSetEndBtn').addEventListener('click', setEndAtPlayhead);
    $('#clipResetRangeBtn').addEventListener('click', resetRange);
    $('#clipFrameBackBtn').addEventListener('click', () => stepFrame(-1));
    $('#clipFrameForwardBtn').addEventListener('click', () => stepFrame(1));
    $('#clipPlaySelectionBtn').addEventListener('click', playSelection);
    $('#clipPlaybackSpeed').addEventListener('change', event => { $('#clipPreview').playbackRate = Number(event.target.value) || 1; });
    $('#clipEditorVolume').addEventListener('input', updateEditorAudio);
    $('#clipEditorMute').addEventListener('change', updateEditorAudio);
    ['clipFilterSelect', 'clipBrightness', 'clipContrast', 'clipSaturation', 'clipRotationSelect', 'clipFlipToggle'].forEach(id => $('#' + id).addEventListener('input', updatePreviewLook));
    $('#clipCaptionText').addEventListener('input', updateCaptionPreview);
    $('#clipCaptionPosition').addEventListener('change', updateCaptionPreview);
    $('#clipSaveHighlightBtn').addEventListener('click', exportClip);
    $('#clipCancelExportBtn').addEventListener('click', cancelExport);
  }

  function bindHotkeys() {
    document.addEventListener('keydown', event => {
      const clipsVisible = $('#panel-clips')?.classList.contains('visible');
      if (!clipsVisible || !state.selected || event.target.matches('input,select,textarea')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        playSelection();
      } else if (event.key === '[') setStartAtPlayhead();
      else if (event.key === ']') setEndAtPlayhead();
      else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        stepFrame(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        stepFrame(1);
      }
    });
  }

  function sanitizeSettings(raw) {
    return {
      sourceId: String(raw.sourceId || ''),
      resolution: ['source', '1280x720', '1920x1080', '2560x1440', '3840x2160'].includes(raw.resolution) ? raw.resolution : '1920x1080',
      fps: [15, 24, 30, 45, 60, 90, 120, 144].includes(Number(raw.fps)) ? Number(raw.fps) : 60,
      bitrate: Math.min(50000000, Math.max(6000000, Number(raw.bitrate) || 16000000)),
      replayLength: [15, 30, 45, 60, 90, 120].includes(Number(raw.replayLength)) ? Number(raw.replayLength) : 30,
      replaySegment: [5, 10, 15].includes(Number(raw.replaySegment)) ? Number(raw.replaySegment) : 10,
      systemAudio: raw.systemAudio !== false,
      microphone: Boolean(raw.microphone),
      systemVolume: Math.min(150, Math.max(0, Number(raw.systemVolume) || 100)),
      micVolume: Math.min(200, Math.max(0, Number(raw.micVolume) || 100))
    };
  }

  function applySettings() {
    $('#clipResolutionSelect').value = state.settings.resolution;
    $('#clipFpsSelect').value = String(state.settings.fps);
    $('#bitrateSelect').value = String(state.settings.bitrate);
    $('#clipReplayLength').value = String(state.settings.replayLength);
    $('#clipReplaySegment').value = String(state.settings.replaySegment);
    $('#clipAudioToggle').checked = state.settings.systemAudio;
    $('#clipMicToggle').checked = state.settings.microphone;
    $('#clipSystemVolume').value = String(state.settings.systemVolume);
    $('#clipMicVolume').value = String(state.settings.micVolume);
    updateMixerReadouts();
  }

  async function persistCaptureSettings() {
    state.settings = sanitizeSettings({
      sourceId: $('#clipSourceSelect').value,
      resolution: $('#clipResolutionSelect').value,
      fps: Number($('#clipFpsSelect').value),
      bitrate: Number($('#bitrateSelect').value),
      replayLength: Number($('#clipReplayLength').value),
      replaySegment: Number($('#clipReplaySegment').value),
      systemAudio: $('#clipAudioToggle').checked,
      microphone: $('#clipMicToggle').checked,
      systemVolume: Number($('#clipSystemVolume').value),
      micVolume: Number($('#clipMicVolume').value)
    });
    await window.coreShiftAPI.saveSettings({ clipStudio: state.settings });
  }

  function updateMixerReadouts() {
    $('#clipSystemVolumeOut').textContent = $('#clipSystemVolume').value + '%';
    $('#clipMicVolumeOut').textContent = $('#clipMicVolume').value + '%';
  }

  async function refreshSources() {
    const select = $('#clipSourceSelect');
    select.innerHTML = '<option value="">Detecting displays…</option>';
    try {
      const sources = await window.coreShiftAPI.getCaptureSources();
      select.replaceChildren();
      sources.forEach(source => {
        const option = document.createElement('option');
        option.value = source.id;
        option.textContent = (source.id.startsWith('screen:') ? 'DISPLAY · ' : 'WINDOW · ') + source.name;
        select.append(option);
      });
      const preferred = sources.find(source => source.id === state.settings.sourceId) || sources.find(source => source.id.startsWith('screen:')) || sources[0];
      if (preferred) select.value = preferred.id;
      state.settings.sourceId = select.value;
      persistCaptureSettings();
    } catch (error) {
      select.innerHTML = '<option value="">No capture source detected</option>';
      setCaptureStatus('Display detection failed: ' + error.message);
    }
  }

  async function createCaptureStream() {
    const sourceId = $('#clipSourceSelect').value;
    if (!sourceId) throw new Error('Choose a capture source.');
    const fps = Number($('#clipFpsSelect').value);
    const dimensions = $('#clipResolutionSelect').value.split('x').map(Number);
    const mandatory = { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: fps };
    if (dimensions.length === 2 && dimensions.every(Number.isFinite)) {
      mandatory.maxWidth = dimensions[0];
      mandatory.maxHeight = dimensions[1];
    }
    const wantsSystemAudio = $('#clipAudioToggle').checked;
    const desktop = await navigator.mediaDevices.getUserMedia({
      audio: wantsSystemAudio ? { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } } : false,
      video: { mandatory }
    });
    state.rawStreams = [desktop];
    let microphone = null;
    if ($('#clipMicToggle').checked) {
      try {
        microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false });
        state.rawStreams.push(microphone);
      } catch (error) {
        setCaptureStatus('Microphone unavailable; continuing without it. ' + error.message);
      }
    }
    const audioStreams = [];
    if (desktop.getAudioTracks().length) audioStreams.push({ stream: new MediaStream(desktop.getAudioTracks()), gain: Number($('#clipSystemVolume').value) / 100 });
    if (microphone?.getAudioTracks().length) audioStreams.push({ stream: microphone, gain: Number($('#clipMicVolume').value) / 100 });
    let audioTrack = null;
    if (audioStreams.length) {
      state.audioContext = new AudioContext();
      const destination = state.audioContext.createMediaStreamDestination();
      for (const input of audioStreams) {
        const source = state.audioContext.createMediaStreamSource(input.stream);
        const gain = state.audioContext.createGain();
        gain.gain.value = input.gain;
        source.connect(gain).connect(destination);
      }
      audioTrack = destination.stream.getAudioTracks()[0] || null;
    }
    state.stream = new MediaStream([...desktop.getVideoTracks(), ...(audioTrack ? [audioTrack] : [])]);
    const trackSettings = desktop.getVideoTracks()[0]?.getSettings?.() || {};
    const actual = (trackSettings.width || 'native') + '×' + (trackSettings.height || 'native') + ' at up to ' + (trackSettings.frameRate || fps) + ' FPS';
    setCaptureStatus('Active capture mode: ' + actual + '.');
    return state.stream;
  }

  function recorderOptions() {
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
    return { mimeType, videoBitsPerSecond: Number($('#bitrateSelect').value), audioBitsPerSecond: 160000 };
  }

  async function toggleFullRecording() {
    if (state.exporting || state.replaySaving) return toast('Wait for the current clip operation to finish.');
    if (state.captureMode === 'record' && state.recorder?.state === 'recording') {
      state.recorder.stop();
      return;
    }
    if (state.replayActive) return toast('Stop the replay buffer before starting a full recording.');
    try {
      await createCaptureStream();
      state.captureMode = 'record';
      state.chunks = [];
      state.recorder = new MediaRecorder(state.stream, recorderOptions());
      state.recorder.addEventListener('dataavailable', event => { if (event.data.size) state.chunks.push(event.data); });
      state.recorder.addEventListener('stop', finishFullRecording, { once: true });
      state.recorder.start(1000);
      startCaptureClock();
      updateCaptureUi();
      toast('Full recording started.');
    } catch (error) {
      toast('Capture failed: ' + error.message);
      resetCaptureResources();
    }
  }

  async function finishFullRecording() {
    const mimeType = state.recorder?.mimeType || 'video/webm';
    const blob = new Blob(state.chunks, { type: mimeType });
    const metadata = captureMetadata('recording');
    resetCaptureResources();
    if (!blob.size) return toast('The recording did not contain video data.');
    setCaptureStatus('Saving full recording…');
    const result = await window.coreShiftAPI.saveClip(await blob.arrayBuffer(), { name: 'recording-' + metadata.fps + 'fps', metadata });
    if (!result.success) return toast(result.message || 'The clip could not be saved.');
    toast('Recording saved to the CoreShift Clips folder.');
    setCaptureStatus('Recording saved: ' + result.name);
    await refresh(result.filePath);
  }

  async function toggleReplayBuffer() {
    if (state.replayActive) {
      stopReplayBuffer();
      return;
    }
    if (state.captureMode === 'record') return toast('Stop the full recording before enabling instant replay.');
    try {
      await createCaptureStream();
      state.captureMode = 'replay';
      state.replayActive = true;
      state.replaySegments = [];
      state.replaySavePending = false;
      startCaptureClock();
      startReplaySegment();
      updateCaptureUi();
      toast('Instant replay buffer started. Press Ctrl + Shift + S to save.');
    } catch (error) {
      toast('Replay buffer failed: ' + error.message);
      resetCaptureResources();
    }
  }

  function startReplaySegment() {
    if (!state.replayActive || !state.stream) return;
    state.chunks = [];
    const recorder = new MediaRecorder(state.stream, recorderOptions());
    state.recorder = recorder;
    recorder.addEventListener('dataavailable', event => { if (event.data.size) state.chunks.push(event.data); });
    recorder.addEventListener('stop', () => finishReplaySegment(recorder), { once: true });
    recorder.start(1000);
    clearTimeout(state.replaySegmentTimer);
    state.replaySegmentTimer = setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, Number($('#clipReplaySegment').value) * 1000);
  }

  async function finishReplaySegment(recorder) {
    clearTimeout(state.replaySegmentTimer);
    const chunks = state.chunks.slice();
    const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
    if (blob.size) state.replaySegments.push(blob);
    const maxSegments = Math.ceil(Number($('#clipReplayLength').value) / Number($('#clipReplaySegment').value)) + 2;
    state.replaySegments = state.replaySegments.slice(-maxSegments);
    const shouldSave = state.replaySavePending;
    state.replaySavePending = false;
    if (state.replayActive) startReplaySegment();
    else resetCaptureResources();
    if (shouldSave) await exportReplaySegments();
  }

  function stopReplayBuffer() {
    state.replayActive = false;
    state.replaySavePending = false;
    clearTimeout(state.replaySegmentTimer);
    if (state.recorder?.state === 'recording') state.recorder.stop();
    else resetCaptureResources();
    updateCaptureUi();
    toast('Instant replay buffer stopped.');
  }

  function saveReplayBuffer() {
    if (!state.replayActive || !state.recorder || state.recorder.state !== 'recording') {
      toast('Start the replay buffer before saving a replay.');
      return;
    }
    if (state.replaySaving || state.replaySavePending) return toast('A replay is already being saved.');
    state.replaySavePending = true;
    $('#clipReplayStatus').textContent = 'Finalizing the current replay segment…';
    state.recorder.stop();
  }

  async function exportReplaySegments() {
    if (!state.replaySegments.length) return toast('The replay buffer has not collected enough video yet.');
    state.replaySaving = true;
    updateCaptureUi();
    try {
      const segmentBuffers = [];
      for (const blob of state.replaySegments) segmentBuffers.push(await blob.arrayBuffer());
      const duration = Number($('#clipReplayLength').value);
      $('#clipReplayStatus').textContent = 'Assembling the last ' + duration + ' seconds…';
      const result = await window.coreShiftAPI.mergeReplay({ segments: segmentBuffers, duration, name: 'replay-last-' + duration + 's' });
      if (!result.success) throw new Error(result.message || 'Replay save failed.');
      toast('Instant replay saved.');
      $('#clipReplayStatus').textContent = 'Saved ' + result.name + '. Buffer continues running.';
      await refresh(result.filePath);
    } catch (error) {
      toast('Replay save failed: ' + error.message);
      $('#clipReplayStatus').textContent = error.message;
    } finally {
      state.replaySaving = false;
      updateCaptureUi();
    }
  }

  function captureMetadata(kind) {
    const settings = state.stream?.getVideoTracks?.()[0]?.getSettings?.() || {};
    return {
      kind,
      fps: Number(settings.frameRate) || Number($('#clipFpsSelect').value),
      width: Number(settings.width) || null,
      height: Number(settings.height) || null,
      bitrate: Number($('#bitrateSelect').value),
      systemAudio: $('#clipAudioToggle').checked,
      microphone: $('#clipMicToggle').checked,
      createdAt: new Date().toISOString()
    };
  }

  function resetCaptureResources() {
    clearTimeout(state.replaySegmentTimer);
    stopCaptureClock();
    state.rawStreams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    state.stream?.getTracks().forEach(track => track.stop());
    state.audioContext?.close?.().catch(() => {});
    state.rawStreams = [];
    state.stream = null;
    state.audioContext = null;
    state.recorder = null;
    state.chunks = [];
    state.captureMode = '';
    state.replayActive = false;
    state.replaySegments = [];
    updateCaptureUi();
  }

  function startCaptureClock() {
    stopCaptureClock();
    state.captureStartedAt = Date.now();
    state.captureClock = setInterval(updateCaptureClock, 500);
    updateCaptureClock();
  }

  function stopCaptureClock() {
    clearInterval(state.captureClock);
    state.captureClock = null;
    $('#clipCaptureTimer').textContent = '00:00:00';
  }

  function updateCaptureClock() {
    const elapsed = Math.max(0, Date.now() - state.captureStartedAt) / 1000;
    $('#clipCaptureTimer').textContent = formatClock(elapsed);
  }

  function updateCaptureUi() {
    const recording = state.captureMode === 'record' && state.recorder?.state === 'recording';
    const replay = state.replayActive;
    $('#recordBtn').classList.toggle('recording', recording);
    $('#recordBtn').innerHTML = recording ? '<i></i> Stop & save recording' : '<i></i> Start full recording';
    $('#recordBtn').disabled = replay || state.replaySaving;
    $('#replayBufferBtn').textContent = replay ? 'Stop replay buffer' : 'Start replay buffer';
    $('#replayBufferBtn').disabled = recording || state.replaySaving;
    $('#saveReplayBtn').disabled = !replay || state.replaySaving || state.replaySavePending;
    $('#saveReplayBtn').textContent = state.replaySaving ? 'Saving replay…' : 'Save last replay';
    const engine = $('.clip-engine-state');
    engine.classList.toggle('recording', recording || replay);
    $('#clipCaptureState').textContent = recording ? 'FULL RECORDING' : replay ? 'REPLAY BUFFER LIVE' : 'CAPTURE READY';
    if (replay && !state.replaySaving && !state.replaySavePending) {
      $('#clipReplayStatus').textContent = 'Buffering the last ' + $('#clipReplayLength').value + ' seconds · Ctrl + Shift + S to save.';
    } else if (!replay && !state.replaySaving) $('#clipReplayStatus').textContent = 'Replay buffer is stopped.';
    document.querySelectorAll('.clip-capture-settings select,.clip-capture-settings input').forEach(control => { control.disabled = recording || replay; });
  }

  async function openFolder() {
    const result = await window.coreShiftAPI.openClipsFolder();
    toast(result.success ? 'Clip folder opened.' : result.message);
  }

  async function refresh(selectPath = '') {
    const result = await window.coreShiftAPI.listClips();
    if (!result.success) return toast(result.message || 'Clip library could not be loaded.');
    state.clips = result.clips || [];
    renderLibrary();
    const target = state.clips.find(clip => clip.filePath === selectPath) || (state.selected && state.clips.find(clip => clip.filePath === state.selected.filePath));
    if (target && (!state.selected || target.filePath !== state.selected.filePath || selectPath)) await selectClip(target);
  }

  async function importClip() {
    if (state.exporting || state.replaySaving) return toast('Wait for the current clip operation to finish.');
    const button = $('#clipImportBtn');
    button.disabled = true;
    button.textContent = 'Choosing video…';
    setEditorStatus('Choose a video from your PC to add to the edit library.');
    try {
      const result = await window.coreShiftAPI.importClip();
      if (result.canceled) {
        setEditorStatus('Video import cancelled.');
        return;
      }
      if (!result.success) throw new Error(result.message || 'The video could not be imported.');
      toast(result.message);
      await refresh(result.filePath);
      openSelectedEditor();
    } catch (error) {
      setEditorStatus('Import failed: ' + error.message);
      toast('Import failed: ' + error.message);
    } finally {
      button.disabled = false;
      button.textContent = '+ Choose video to edit';
    }
  }

  function openSelectedEditor() {
    if (!state.selected) return toast('Choose a clip from the library first.');
    $('.clip-editor-card.ultra')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#clipPreview').focus();
  }

  function renderLibrary() {
    const list = $('#clipList');
    const query = $('#clipSearch').value.trim().toLowerCase();
    const clips = state.clips.filter(clip => clip.name.toLowerCase().includes(query));
    $('#clipLibraryCount').textContent = state.clips.length + (state.clips.length === 1 ? ' CLIP' : ' CLIPS');
    if (!clips.length) {
      list.innerHTML = '<div class="empty"><i>◉</i><b>' + (query ? 'No matching clips' : 'Your clip library is empty') + '</b><small>' + (query ? 'Try a different search.' : 'Record or save a replay to begin editing.') + '</small></div>';
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const clip of clips) {
      const item = document.createElement('article');
      item.className = 'clip-item' + (state.selected?.filePath === clip.filePath ? ' selected' : '');
      const thumbnail = document.createElement('div');
      thumbnail.className = 'clip-thumb';
      thumbnail.textContent = '▶';
      const copy = document.createElement('div');
      const title = document.createElement('b');
      title.textContent = clip.name;
      const detail = document.createElement('small');
      const metadata = clip.metadata || {};
      const mode = metadata.fps ? metadata.fps + ' FPS · ' : metadata.kind === 'replay' ? 'REPLAY · ' : '';
      detail.textContent = mode + formatBytes(clip.size) + ' · ' + new Date(clip.modified).toLocaleString();
      copy.append(title, detail);
      const actions = document.createElement('div');
      actions.className = 'clip-item-actions';
      actions.append(actionButton('OPEN', 'edit', clip.filePath), actionButton('DELETE', 'delete', clip.filePath));
      item.append(thumbnail, copy, actions);
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', 'Open ' + clip.name + ' in Clip Studio');
      item.addEventListener('click', event => {
        if (!event.target.closest('button')) selectClip(clip).then(openSelectedEditor);
      });
      item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectClip(clip).then(openSelectedEditor);
        }
      });
      fragment.append(item);
    }
    list.replaceChildren(fragment);
  }

  function actionButton(label, action, filePath) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.clipAction = action;
    button.dataset.clipPath = filePath;
    return button;
  }

  async function handleLibraryAction(event) {
    const button = event.target.closest('[data-clip-action]');
    if (!button) return;
    const clip = state.clips.find(item => item.filePath === button.dataset.clipPath);
    if (!clip) return;
    if (button.dataset.clipAction === 'edit') {
      await selectClip(clip);
      openSelectedEditor();
    }
    if (button.dataset.clipAction === 'delete' && confirm('Delete “' + clip.name + '”?')) {
      const result = await window.coreShiftAPI.deleteClip(clip.filePath);
      toast(result.message || 'Clip deletion failed.');
      if (result.success) {
        if (state.selected?.filePath === clip.filePath) clearEditor();
        await refresh();
      }
    }
  }

  async function selectClip(clip) {
    if (state.exporting) return toast('Cancel or finish the current export before switching clips.');
    setEditorStatus('Loading clip into the edit bay…');
    const result = await window.coreShiftAPI.readClip(clip.filePath);
    if (!result.success) return setEditorStatus(result.message || 'The clip could not be opened.');
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.selected = clip;
    const video = $('#clipPreview');
    state.objectUrl = '';
    video.src = result.fileUrl;
    video.hidden = false;
    $('#clipEditorEmpty').hidden = true;
    $('#clipEditorName').textContent = clip.name;
    $('#clipEditSelectedBtn').disabled = false;
    $('#clipExportName').value = clip.name.replace(/\.webm$/i, '') + '-edited';
    if (clip.metadata?.fps) $('#clipExportFps').value = String(clip.metadata.fps);
    resetEditorEffects();
    setEditorStatus('Loading duration, dimensions, and timeline…');
    renderLibrary();
  }

  function configureTimeline() {
    const video = $('#clipPreview');
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return setEditorStatus('This clip does not expose an editable duration.');
    const start = $('#clipStartRange');
    const end = $('#clipEndRange');
    start.max = String(duration);
    start.value = '0';
    end.max = String(duration);
    end.value = String(duration);
    editorControls().forEach(control => { control.disabled = false; });
    $('#clipEditorDuration').textContent = formatTime(duration, false);
    $('#clipExportResolution').value = video.videoHeight > 1080 ? String(Math.min(2160, video.videoHeight)) : '1080';
    updateRangeOutputs();
    updatePreviewLook();
    updateCaptionPreview();
    setEditorStatus('Set IN and OUT points, customize the look, then export. Shortcuts: [ IN · ] OUT · arrows frame-step · space preview.');
  }

  function editorControls() {
    return ['clipStartRange', 'clipEndRange', 'clipSetStartBtn', 'clipSetEndBtn', 'clipResetRangeBtn', 'clipFrameBackBtn', 'clipFrameForwardBtn', 'clipPlaySelectionBtn', 'clipPlaybackSpeed', 'clipAspectSelect', 'clipRotationSelect', 'clipFlipToggle', 'clipFilterSelect', 'clipBrightness', 'clipContrast', 'clipSaturation', 'clipEditorVolume', 'clipEditorMute', 'clipCaptionText', 'clipCaptionPosition', 'clipExportName', 'clipExportResolution', 'clipExportFps', 'clipExportQuality', 'clipExportBitrate', 'clipSaveHighlightBtn'].map(id => $('#' + id)).filter(Boolean);
  }

  function updateStart() {
    const start = $('#clipStartRange');
    const end = $('#clipEndRange');
    if (Number(start.value) >= Number(end.value) - 0.05) start.value = String(Math.max(0, Number(end.value) - 0.05));
    $('#clipPreview').currentTime = Number(start.value);
    updateRangeOutputs();
  }

  function updateEnd() {
    const start = $('#clipStartRange');
    const end = $('#clipEndRange');
    if (Number(end.value) <= Number(start.value) + 0.05) end.value = String(Math.min(Number(end.max), Number(start.value) + 0.05));
    $('#clipPreview').currentTime = Number(end.value);
    updateRangeOutputs();
  }

  function setStartAtPlayhead() {
    const video = $('#clipPreview');
    $('#clipStartRange').value = String(Math.max(0, Math.min(video.currentTime, Number($('#clipEndRange').value) - 0.05)));
    updateRangeOutputs();
  }

  function setEndAtPlayhead() {
    const video = $('#clipPreview');
    $('#clipEndRange').value = String(Math.min(video.duration, Math.max(video.currentTime, Number($('#clipStartRange').value) + 0.05)));
    updateRangeOutputs();
  }

  function resetRange() {
    $('#clipStartRange').value = '0';
    $('#clipEndRange').value = String($('#clipPreview').duration || 1);
    updateRangeOutputs();
  }

  function updateRangeOutputs() {
    const start = Number($('#clipStartRange').value);
    const end = Number($('#clipEndRange').value);
    $('#clipStartOutput').textContent = formatTime(start, true);
    $('#clipEndOutput').textContent = formatTime(end, true);
    $('#clipSelectionDuration').textContent = Math.max(0, end - start).toFixed(2) + ' SEC SELECTED';
  }

  function updatePlayhead() {
    const video = $('#clipPreview');
    $('#clipPlayhead').textContent = formatTime(video.currentTime, true);
    if (state.playingSelection && video.currentTime >= Number($('#clipEndRange').value)) {
      state.playingSelection = false;
      video.pause();
      video.currentTime = Number($('#clipStartRange').value);
    }
  }

  async function playSelection() {
    if (!state.selected) return;
    const video = $('#clipPreview');
    if (!video.paused) {
      state.playingSelection = false;
      video.pause();
      return;
    }
    if (video.currentTime < Number($('#clipStartRange').value) || video.currentTime >= Number($('#clipEndRange').value)) video.currentTime = Number($('#clipStartRange').value);
    state.playingSelection = true;
    $('#clipPlaySelectionBtn').textContent = 'Ⅱ Pause';
    await video.play().catch(error => toast(error.message));
  }

  function stepFrame(direction) {
    if (!state.selected) return;
    const video = $('#clipPreview');
    video.pause();
    state.playingSelection = false;
    const fps = Number($('#clipExportFps').value) || Number(state.selected.metadata?.fps) || 60;
    video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + direction / fps));
  }

  function updateEditorAudio() {
    const volume = Number($('#clipEditorVolume').value);
    $('#clipEditorVolumeOut').textContent = volume + '%';
    const video = $('#clipPreview');
    video.muted = $('#clipEditorMute').checked;
    video.volume = Math.min(1, volume / 100);
  }

  function updatePreviewLook() {
    const brightness = Number($('#clipBrightness').value);
    const contrast = Number($('#clipContrast').value);
    const saturation = Number($('#clipSaturation').value);
    $('#clipBrightnessOut').textContent = String(brightness);
    $('#clipContrastOut').textContent = String(contrast);
    $('#clipSaturationOut').textContent = String(saturation);
    const preset = previewPreset($('#clipFilterSelect').value);
    const filters = [
      'brightness(' + Math.max(0, 100 + brightness + preset.brightness) + '%)',
      'contrast(' + Math.max(0, contrast + preset.contrast) + '%)',
      'saturate(' + Math.max(0, saturation + preset.saturation) + '%)'
    ];
    if (preset.extra) filters.push(preset.extra);
    const stage = $('.clip-preview-stage');
    stage.style.setProperty('--clip-preview-filter', filters.join(' '));
    const rotation = Number($('#clipRotationSelect').value);
    const flip = $('#clipFlipToggle').checked ? -1 : 1;
    stage.style.setProperty('--clip-preview-transform', 'rotate(' + rotation + 'deg) scaleX(' + flip + ')');
    const aspect = $('#clipAspectSelect').value;
    const ratios = { '16:9': '16 / 9', '9:16': '9 / 16', '1:1': '1 / 1', '4:3': '4 / 3' };
    stage.style.aspectRatio = ratios[aspect] || '';
    $('#clipPreview').style.objectFit = aspect === 'original' ? 'contain' : 'cover';
  }

  function previewPreset(value) {
    if (value === 'vibrant') return { brightness: 2, contrast: 12, saturation: 35, extra: '' };
    if (value === 'cinematic') return { brightness: -3, contrast: 18, saturation: -8, extra: 'sepia(8%)' };
    if (value === 'mono') return { brightness: 0, contrast: 8, saturation: -100, extra: 'grayscale(100%)' };
    if (value === 'warm') return { brightness: 2, contrast: 5, saturation: 10, extra: 'sepia(16%)' };
    if (value === 'cool') return { brightness: 0, contrast: 5, saturation: 8, extra: 'hue-rotate(175deg) hue-rotate(-165deg)' };
    return { brightness: 0, contrast: 0, saturation: 0, extra: '' };
  }

  function updateCaptionPreview() {
    const node = $('#clipCaptionPreview');
    const text = $('#clipCaptionText').value.trim();
    node.textContent = text;
    node.hidden = !text || !state.selected;
    node.className = 'clip-caption-preview ' + $('#clipCaptionPosition').value;
  }

  function resetEditorEffects() {
    $('#clipAspectSelect').value = 'original';
    $('#clipRotationSelect').value = '0';
    $('#clipFlipToggle').checked = false;
    $('#clipFilterSelect').value = 'clean';
    $('#clipBrightness').value = '0';
    $('#clipContrast').value = '100';
    $('#clipSaturation').value = '100';
    $('#clipEditorVolume').value = '100';
    $('#clipEditorMute').checked = false;
    $('#clipCaptionText').value = '';
    $('#clipCaptionPosition').value = 'bottom';
    $('#clipPlaybackSpeed').value = '1';
    $('#clipPreview').playbackRate = 1;
    updateEditorAudio();
  }

  async function exportClip() {
    if (!state.selected || state.exporting) return;
    const start = Number($('#clipStartRange').value);
    const end = Number($('#clipEndRange').value);
    if (end - start < 0.1) return toast('Choose at least 0.1 seconds for the edited clip.');
    const name = $('#clipExportName').value.trim();
    if (!name) return toast('Enter a name for the exported clip.');
    state.exporting = true;
    $('#clipSaveHighlightBtn').disabled = true;
    $('#clipCancelExportBtn').hidden = false;
    renderExportProgress({ percent: 0, message: 'Starting the local FFmpeg render engine…' });
    const payload = {
      filePath: state.selected.filePath,
      start,
      end,
      name,
      aspect: $('#clipAspectSelect').value,
      rotation: Number($('#clipRotationSelect').value),
      flip: $('#clipFlipToggle').checked,
      filter: $('#clipFilterSelect').value,
      brightness: Number($('#clipBrightness').value),
      contrast: Number($('#clipContrast').value),
      saturation: Number($('#clipSaturation').value),
      mute: $('#clipEditorMute').checked,
      volume: Number($('#clipEditorVolume').value),
      caption: $('#clipCaptionText').value,
      captionPosition: $('#clipCaptionPosition').value,
      resolution: $('#clipExportResolution').value,
      fps: Number($('#clipExportFps').value),
      quality: $('#clipExportQuality').value,
      bitrate: Number($('#clipExportBitrate').value)
    };
    try {
      const result = await window.coreShiftAPI.exportClip(payload);
      if (!result.success) throw new Error(result.message || 'Clip export failed.');
      renderExportProgress({ percent: 100, message: 'Export complete: ' + result.name });
      toast('Edited clip exported successfully.');
      await refresh(result.filePath);
    } catch (error) {
      renderExportProgress({ percent: 0, message: 'Export failed: ' + error.message });
      toast('Export failed.');
    } finally {
      state.exporting = false;
      $('#clipSaveHighlightBtn').disabled = false;
      $('#clipCancelExportBtn').hidden = true;
    }
  }

  async function cancelExport() {
    const result = await window.coreShiftAPI.cancelClipExport();
    if (result.success) {
      state.exporting = false;
      $('#clipSaveHighlightBtn').disabled = false;
      $('#clipCancelExportBtn').hidden = true;
      renderExportProgress({ percent: 0, message: 'Export cancelled. The original clip was not changed.' });
    }
    toast(result.message);
  }

  function renderExportProgress(progress) {
    $('#clipExportProgressBar').style.width = Math.max(0, Math.min(100, Number(progress?.percent) || 0)) + '%';
    if (progress?.message) setEditorStatus(progress.message);
  }

  function clearEditor() {
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = '';
    state.selected = null;
    $('#clipEditSelectedBtn').disabled = true;
    const video = $('#clipPreview');
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.hidden = true;
    $('#clipEditorEmpty').hidden = false;
    $('#clipCaptionPreview').hidden = true;
    $('#clipEditorName').textContent = 'Select a saved clip';
    $('#clipEditorDuration').textContent = '00:00';
    editorControls().forEach(control => { control.disabled = true; });
    updateRangeOutputs();
  }

  function setCaptureStatus(message) { $('#clipCaptureStatus').textContent = message; }
  function setEditorStatus(message) { $('#clipEditorStatus').textContent = message; }
  function formatBytes(bytes) { return bytes < 1048576 ? (bytes / 1024).toFixed(0) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB'; }
  function formatClock(seconds) {
    const safe = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor(safe % 3600 / 60);
    const remainder = safe % 60;
    return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(remainder).padStart(2, '0');
  }
  function formatTime(seconds, precise) {
    const safe = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(safe / 60);
    const remainder = safe - minutes * 60;
    return String(minutes).padStart(2, '0') + ':' + (precise ? remainder.toFixed(3).padStart(6, '0') : String(Math.floor(remainder)).padStart(2, '0'));
  }

  window.CoreShiftClipStudio = Object.freeze({ init, refresh });
})();
