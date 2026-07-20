import { clamp } from "./utils.js";

function createBinaryTowerLoopController(audioEngine, appState) {
  const audio = audioEngine.audio;
  const state = {};
  Object.defineProperties(state, {
    hasAudio: { get: () => Boolean(audioEngine.file) },
    decodedAudioBuffer: { get: () => audioEngine.decodedBuffer },
    volume: { get: () => clamp(Number(appState.get("volume")) * 100, 0, 100) },
    muted: { get: () => Boolean(appState.get("muted")) },
    audioLoop: {
      get: () => Boolean(audioEngine.loopEnabled),
      set: (value) => audioEngine.setLoop(Boolean(value)),
    },
    loopStart: {
      get: () => Number(audioEngine.loopStart) || 0,
      set: (value) => { audioEngine.loopStart = Number(value) || 0; },
    },
    loopEnd: {
      get: () => Number(audioEngine.loopEnd) || audioEngine.getDuration(),
      set: (value) => { audioEngine.loopEnd = Number(value) || audioEngine.getDuration(); },
    },
    loopBpm: {
      get: () => Number(audioEngine.loopBpm) || 120,
      set: (value) => { audioEngine.loopBpm = clamp(Number(value) || 120, 40, 300); },
    },
    loopBars: {
      get: () => Math.max(1, Math.round(Number(audioEngine.loopBars) || 4)),
      set: (value) => { audioEngine.loopBars = Math.max(1, Math.round(Number(value) || 4)); },
    },
    loopSnap: {
      get: () => true,
      set: () => {},
    },
  });

const controller = (() => {
  // ── BPM Detective popup — fully integrated with the main visualizer ──

  // ── Popup-local state ──
  let popupOpen      = false;
  let popupCtx       = null;
  let popupGain      = null;
  let popupBuffer    = null;
  let popupSource    = null;
  let popupIsPlaying = false;
  let popupLoopOn    = true;
  let popupVolume    = 80;
  let popupMuted     = false;
  let popupOffset    = 0;
  let popupCtxStart  = 0;
  let popupBpm       = 120;
  let popupLoopBars  = 4;
  let popupLoopStart = 0;
  let popupLoopEnd   = 4;
  let popupZoomStart = 0;
  let popupZoomEnd   = 1;
  let popupPeaks     = null;
  let popupAnimRaf   = null;
  let popupResizeObs = null;
  let popupForceRestartFromLoopStart = true;
  let popupDocMouseMoveHandler = null;
  let popupDocMouseUpHandler = null;
  let popupDocKeydownHandler = null;
  // Canvas dims
  let cW = 0, cH = 0, mmW = 0, mmH = 0;
  // Drag state
  let dragging = null, dragX0 = 0, dragVal0 = 0, dragMoved = false;
  let dragLoopDuration = 0, dragLoopStart0 = 0;
  let mmDrag = false, mmX0 = 0, mmZS0 = 0, mmZE0 = 0;

  // ── Entry point ──
  function openLoopPopup() {
      if (popupOpen || !state.hasAudio || !state.decodedAudioBuffer) return;
      popupOpen = true;
      popupIsPlaying = false;
      popupSource = null;
      popupVolume = clamp(state.volume, 0, 100);
      popupMuted = Boolean(state.muted);
      popupBpm = clamp(state.loopBpm || 120, 40, 300);
      popupLoopBars = Math.max(1, Math.round(state.loopBars || 4));

      if (audio) {
          try { audio.pause(); } catch (_) {}
      }
      const mainPlayBtn = document.getElementById('playPause');
      if (mainPlayBtn) {
          mainPlayBtn.textContent = '▶ Play';
      }

      const overlay = document.createElement('div');
      overlay.id = 'loop-modal-overlay';
      overlay.tabIndex = -1;
      overlay.innerHTML = buildPopupHTML();
      document.body.appendChild(overlay);
      overlay.focus();

      // Wire up all popup events
      wirePopupEvents(overlay);
      const popupQuery = id => overlay.querySelector("#" + id);
      popupQuery("popup-vol-slider").value = String(popupVolume);
      popupQuery("popup-vol-pct").textContent = `${popupVolume}%`;
      refreshVolSlider(popupQuery);
      updateVolIcon(popupQuery);
      popupQuery("popup-bars-val").value = String(popupLoopBars);

      // Load and decode audio from state
      initPopupAudio(state.decodedAudioBuffer);
  }

  // ── HTML builder ──
  function buildPopupHTML() {
      return `
  <div class="loop-modal-panel" id="loop-panel">
    <div class="loop-header">
      <div class="loop-title">Loop Region</div>
      <button class="loop-close-btn" id="popup-close-btn" title="Close">✕</button>
    </div>

    <div class="loop-wave-section">
      <div class="loop-wave-header">
        <span class="loop-section-label">Waveform · Loop Region</span>
        <div class="loop-zoom-controls">
          <button class="loop-zoom-btn" id="popup-zoom-out">−</button>
          <span class="loop-zoom-level" id="popup-zoom-level">1×</span>
          <button class="loop-zoom-btn" id="popup-zoom-in">+</button>
          <button class="loop-zoom-btn loop-fit-btn" id="popup-zoom-fit">FIT</button>
        </div>
      </div>

      <div class="loop-waveform-wrap" id="popup-wave-wrap">
        <div class="loop-wave-clip">
          <canvas id="popup-wave-canvas"></canvas>
          <div id="popup-playhead"></div>
        </div>
        <div class="popup-lhandle" id="popup-h-left" style="left:0%">
          <div class="popup-handle-tag" id="popup-tag-left">0.00s</div>
          <div class="popup-handle-knob"></div>
        </div>
        <div class="popup-lhandle" id="popup-h-right" style="left:50%">
          <div class="popup-handle-tag" id="popup-tag-right">4.00s</div>
          <div class="popup-handle-knob"></div>
        </div>
        <div class="loop-analyzing" id="popup-analyzing">
          <div class="loop-dots"><span></span><span></span><span></span></div>
          <div class="loop-analyzing-text">Analysing audio…</div>
        </div>
      </div>

      <div class="loop-minimap-wrap" id="popup-minimap-wrap">
        <canvas id="popup-minimap-canvas"></canvas>
      </div>

      <div class="loop-progress-wrap" id="popup-progress-wrap">
        <div class="loop-progress-fill" id="popup-progress-fill"></div>
      </div>
      <div class="loop-time-row">
        <span class="loop-time-mono" id="popup-t-current">0:00.000</span>
        <span class="loop-time-mono" id="popup-t-total">0:00.000</span>
      </div>
    </div>

    <div class="loop-controls-section">
      <div class="loop-ctrl-block">
        <div class="loop-transport-row">
          <button class="loop-tbtn" id="popup-play-btn" disabled>▶ Play</button>
          <button class="loop-tbtn" id="popup-stop-btn" disabled>■ Stop</button>
          <div class="loop-pill">
            <div class="loop-pill-switch on" id="popup-loop-switch"></div>
            <span class="loop-pill-label">Loop</span>
          </div>
        </div>
        <div class="loop-option-row">
          <label class="loop-check-label">
            <input type="checkbox" id="popup-force-start-toggle" class="loop-check-input" checked>
            <span class="loop-check-box"></span>
            <span class="loop-check-text">Always start preview from loop start</span>
          </label>
        </div>
        <div class="loop-volume-row">
          <button class="loop-vol-btn" id="popup-mute-btn">🔊</button>
          <input class="loop-vol-slider" id="popup-vol-slider" type="range" min="0" max="100" value="80">
          <span class="loop-vol-pct" id="popup-vol-pct">80%</span>
        </div>
      </div>

      <div class="loop-ctrl-block loop-bpm-block">
        <div class="loop-section-label">Detected Tempo</div>
        <div class="loop-bpm-row">
          <input class="loop-bpm-input" id="popup-bpm-input" type="number" min="40" max="300" placeholder="—" disabled>
          <span class="loop-bpm-unit">BPM</span>
        </div>
        <div class="loop-bpm-hint">Click to edit · Enter to confirm</div>
      </div>

      <div class="loop-ctrl-block loop-bars-block">
        <div class="loop-section-label">Loop Length</div>
        <div class="loop-bars-row">
          <div class="value-editor has-suffix loop-bars-editor">
            <input class="value-input loop-bars-val" id="popup-bars-val" type="number" min="1" max="999" value="4" aria-label="Loop Length in Bars Value">
            <span class="value-suffix loop-bars-unit" aria-hidden="true">Bars</span>
            <button class="value-stepper loop-bars-stepper" id="popup-bars-decr" type="button" aria-label="Decrease Loop Length">−</button>
            <button class="value-stepper loop-bars-stepper" id="popup-bars-incr" type="button" aria-label="Increase Loop Length">+</button>
          </div>
        </div>
        <div class="loop-time-info" id="popup-loop-time-info">—</div>
      </div>
    </div>

    <div class="loop-status-bar">
      <span class="loop-stat">Rate: <b id="popup-stat-rate">—</b></span>
      <span class="loop-stat">Duration: <b id="popup-stat-dur">—</b></span>
      <span class="loop-stat">Loop: <b id="popup-stat-loop">—</b></span>
      <span class="loop-stat">Beat: <b id="popup-stat-beat">—</b></span>
    </div>

    <div class="loop-action-row">
      <button class="loop-action-btn loop-cancel-btn" id="popup-cancel-btn">Cancel</button>
      <button class="loop-action-btn loop-clear-btn" id="popup-clear-btn">Clear Loop</button>
      <button class="loop-action-btn loop-apply-btn" id="popup-apply-btn" disabled>Apply Loop</button>
    </div>
  </div>`;
  }

  // ── Wire all popup events ──
  function wirePopupEvents(overlay) {
      const $ = id => overlay.querySelector('#' + id);

      // Close
      $('popup-close-btn').addEventListener('click', closePopup);
      $('popup-cancel-btn').addEventListener('click', closePopup);

      // Clear loop
      $('popup-clear-btn').addEventListener('click', () => {
          clearAudioLoop();
          closePopup();
      });

      // Apply loop
      $('popup-apply-btn').addEventListener('click', () => {
          applyAudioLoop(popupLoopStart, popupLoopEnd);
          state.loopBpm = popupBpm;
          const btn = document.getElementById('loopButton');
          if (btn) {
              btn.textContent = 'Loop';
              btn.classList.add('loop-active');
          }
          closePopup();
      });

      // Transport
      $('popup-play-btn').addEventListener('click', () => popupIsPlaying ? popupPause() : popupPlay($));
      $('popup-stop-btn').addEventListener('click', () => popupStop($));
      $('popup-loop-switch').addEventListener('click', () => {
          popupLoopOn = !popupLoopOn;
          $('popup-loop-switch').classList.toggle('on', popupLoopOn);
          if (popupSource && popupIsPlaying) { popupSource.loop = popupLoopOn; if (popupLoopOn) { popupSource.loopStart = popupLoopStart; popupSource.loopEnd = popupLoopEnd; } }
      });
      $('popup-force-start-toggle').checked = popupForceRestartFromLoopStart;
      $('popup-force-start-toggle').addEventListener('change', () => {
          popupForceRestartFromLoopStart = $('popup-force-start-toggle').checked;
      });

      // Volume
      $('popup-vol-slider').addEventListener('input', () => {
          popupVolume = +$('popup-vol-slider').value;
          $('popup-vol-pct').textContent = popupVolume + '%';
          if (!popupMuted && popupGain) popupGain.gain.value = popupMuted ? 0 : popupVolume / 100;
          refreshVolSlider($);
      });
      $('popup-mute-btn').addEventListener('click', () => {
          popupMuted = !popupMuted;
          if (popupGain) popupGain.gain.value = popupMuted ? 0 : popupVolume / 100;
          updateVolIcon($);
      });

      // BPM
      $('popup-bpm-input').addEventListener('blur', () => commitBPM($));
      $('popup-bpm-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('popup-bpm-input').blur(); });

      // Bars
      $('popup-bars-val').addEventListener('blur', () => commitBars($));
      $('popup-bars-val').addEventListener('keydown', e => { if (e.key === 'Enter') $('popup-bars-val').blur(); });
      $('popup-bars-decr').addEventListener('click', () => {
          popupLoopBars = Math.max(1, popupLoopBars - 1);
          $('popup-bars-val').value = popupLoopBars;
          applyLoopChange($);
      });
      $('popup-bars-incr').addEventListener('click', () => {
          const maxBars = getMaxLoopBars();
          popupLoopBars = Math.min(maxBars, popupLoopBars + 1);
          $('popup-bars-val').value = popupLoopBars;
          applyLoopChange($);
      });

      // Zoom
      $('popup-zoom-in').addEventListener('click',  () => zoomAtX(cW / 2, 2, $));
      $('popup-zoom-out').addEventListener('click', () => zoomAtX(cW / 2, 0.5, $));
      $('popup-zoom-fit').addEventListener('click', () => { if (popupBuffer) setZoomWindow(0, popupBuffer.duration, $); });

      // Wave click to seek
      $('popup-wave-wrap').addEventListener('click', e => {
          if (dragMoved) { dragMoved = false; return; }
          if (!popupBuffer) return;
          const rect = $('popup-wave-wrap').getBoundingClientRect();
          seekTo(xToTime(e.clientX - rect.left), $);
      });

      // Wheel zoom
      $('popup-wave-wrap').addEventListener('wheel', e => {
          if (!popupBuffer) return;
          e.preventDefault();
          const rect = $('popup-wave-wrap').getBoundingClientRect();
          zoomAtX(e.clientX - rect.left, e.deltaY < 0 ? 1.6 : 0.625, $);
      }, { passive: false });

      // Progress click
      $('popup-progress-wrap').addEventListener('click', e => {
          if (!popupBuffer) return;
          const r = $('popup-progress-wrap').getBoundingClientRect();
          seekTo(((e.clientX - r.left) / r.width) * popupBuffer.duration, $);
      });

      // Handle drag — left
      $('popup-h-left').addEventListener('mousedown', e => { startHandleDrag('left', e, $); });
      $('popup-h-right').addEventListener('mousedown', e => { startHandleDrag('right', e, $); });
      $('popup-h-left').addEventListener('click', e => e.stopPropagation());
      $('popup-h-right').addEventListener('click', e => e.stopPropagation());

      // Minimap drag
      $('popup-minimap-wrap').addEventListener('mousedown', e => {
          if (!popupBuffer) return;
          const rect = $('popup-minimap-wrap').getBoundingClientRect();
          const x = e.clientX - rect.left;
          const vL = (popupZoomStart / popupBuffer.duration) * mmW;
          const vR = (popupZoomEnd   / popupBuffer.duration) * mmW;
          if (x < vL - 8 || x > vR + 8) {
              const ct = (x / mmW) * popupBuffer.duration, hw = (popupZoomEnd - popupZoomStart) / 2;
              setZoomWindow(ct - hw, ct + hw, $);
          }
          mmDrag = true; mmX0 = e.clientX; mmZS0 = popupZoomStart; mmZE0 = popupZoomEnd;
          e.preventDefault();
      });

      // Global handlers while popup is open
      popupDocMouseMoveHandler = e => onMouseMove(e, $);
      popupDocMouseUpHandler = () => onMouseUp($);
      document.addEventListener('mousemove', popupDocMouseMoveHandler);
      document.addEventListener('mouseup', popupDocMouseUpHandler);

      popupDocKeydownHandler = e => {
          if (!popupOpen) return;
          const active = document.activeElement;
          const editingInput = active && (active.id === 'popup-bpm-input' || active.id === 'popup-bars-val');
          if (editingInput && e.key !== 'Escape') return;

          if (e.key === ' ' || e.code === 'Space') {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              popupIsPlaying ? popupPause() : popupPlay($);
              return;
          }
          if (e.key === '+' || e.key === '=') {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              zoomAtX(cW / 2, 2, $);
              return;
          }
          if (e.key === '-') {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              zoomAtX(cW / 2, 0.5, $);
              return;
          }
          if (e.key === '0' && popupBuffer) {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              setZoomWindow(0, popupBuffer.duration, $);
              return;
          }
          if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              closePopup();
          }
      };
      document.addEventListener('keydown', popupDocKeydownHandler, true);

      // Canvas resize observer
      popupResizeObs = new ResizeObserver(() => resizeCanvases($));
      popupResizeObs.observe(overlay.querySelector('#loop-panel'));
      setTimeout(() => resizeCanvases($), 60);
  }

  // ── Canvas resize ──
  function resizeCanvases($) {
      const wWrap = $('popup-wave-wrap');
      const mmWrap = $('popup-minimap-wrap');
      if (!wWrap || !mmWrap) return;
      const dpr = window.devicePixelRatio || 1;
      const wr = wWrap.getBoundingClientRect();
      const mr = mmWrap.getBoundingClientRect();
      cW = wr.width; cH = wr.height;
      const wc = $('popup-wave-canvas');
      wc.width = cW * dpr; wc.height = cH * dpr;
      wc.style.width = cW + 'px'; wc.style.height = cH + 'px';
      const wCtx = wc.getContext('2d'); wCtx.scale(dpr, dpr);
      mmW = mr.width; mmH = mr.height;
      const mc = $('popup-minimap-canvas');
      mc.width = mmW * dpr; mc.height = mmH * dpr;
      mc.style.width = mmW + 'px'; mc.style.height = mmH + 'px';
      const mCtx = mc.getContext('2d'); mCtx.scale(dpr, dpr);
      if (popupBuffer) buildPeaks();
      updateHandles($);
      renderWaveform($); renderMinimap($);
  }

  // ── Init audio ──
  async function initPopupAudio(buffer) {
      const overlay = document.getElementById('loop-modal-overlay');
      if (!overlay) return;
      const $ = id => overlay.querySelector('#' + id);
      $('popup-analyzing').classList.add('show');

      try {
          popupCtx = new (window.AudioContext || window.webkitAudioContext)();
          popupGain = popupCtx.createGain();
          popupGain.gain.value = popupVolume / 100;
          popupGain.connect(popupCtx.destination);

          popupBuffer = buffer;

          $('popup-stat-rate').textContent = popupBuffer.sampleRate + ' Hz';
          $('popup-stat-dur').textContent  = fmtDur(popupBuffer.duration);
          $('popup-t-total').textContent   = fmtTime(popupBuffer.duration);

          // BPM detection
          popupBpm = await getLoopBpmDetection(popupBuffer);
          $('popup-bpm-input').value = popupBpm;
          $('popup-bpm-input').disabled = false;
          $('popup-stat-beat').textContent = (60 / popupBpm).toFixed(3) + 's';

          // If existing loop in state, use it
          if (state.audioLoop && state.loopEnd > state.loopStart) {
              popupLoopStart = state.loopStart;
              popupLoopEnd   = state.loopEnd;
              if (state.loopBpm > 0) {
                  popupBpm = state.loopBpm;
                  $('popup-bpm-input').value = popupBpm;
                  const bd = (60 / popupBpm) * 4;
                  popupLoopBars = Math.max(1, Math.round((popupLoopEnd - popupLoopStart) / bd));
                  $('popup-bars-val').value = popupLoopBars;
              }
          } else {
              popupLoopStart = 0;
              updateLoopEnd($);
          }

          popupZoomStart = 0;
          popupZoomEnd   = popupBuffer.duration;
          updateZoomDisplay($);

          buildPeaks();
          renderWaveform($); renderMinimap($);
          syncBarsLimit($);
          updateHandles($); updateLoopInfo($);

          $('popup-play-btn').disabled = false;
          $('popup-stop-btn').disabled = false;
          $('popup-apply-btn').disabled = false;
          popupOffset = popupLoopStart;

      } catch (err) {
          console.error('Popup audio init error:', err);
          $('popup-analyzing').querySelector('.loop-analyzing-text').textContent = 'Error decoding audio.';
          return;
      }
      $('popup-analyzing').classList.remove('show');
  }

  // ── Peaks ──
  function buildPeaks() {
      if (!popupBuffer || cW < 1) return;
      const N = Math.ceil(cW * 4);
      popupPeaks = new Float32Array(N);
      const ch = popupBuffer.getChannelData(0);
      const blk = Math.floor(popupBuffer.length / N);
      for (let i = 0; i < N; i++) {
          let pk = 0, off = i * blk;
          for (let j = 0; j < blk; j++) { const a = Math.abs(ch[off + j] || 0); if (a > pk) pk = a; }
          popupPeaks[i] = pk;
      }
  }

  // ── Coordinates ──
  const timeToX = t => (popupZoomEnd > popupZoomStart) ? ((t - popupZoomStart) / (popupZoomEnd - popupZoomStart)) * cW : 0;
  const xToTime = x => (popupZoomEnd > popupZoomStart) ? popupZoomStart + (x / cW) * (popupZoomEnd - popupZoomStart) : 0;

  // ── Waveform render ──
  function renderWaveform($) {
      const wc = document.getElementById('popup-wave-canvas');
      if (!wc) return;
      const ctx = wc.getContext('2d');
      ctx.clearRect(0, 0, cW, cH);
      ctx.fillStyle = '#080808'; ctx.fillRect(0, 0, cW, cH);
      ctx.strokeStyle = 'rgba(255,255,255,0.055)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, cH / 2); ctx.lineTo(cW, cH / 2); ctx.stroke();

      if (!popupPeaks || !popupBuffer) {
          ctx.fillStyle = 'rgba(140,140,140,0.80)'; ctx.font = '12px monospace'; ctx.textAlign = 'center';
          ctx.fillText('Loading…', cW / 2, cH / 2 + 4); return;
      }

      const lsX = timeToX(popupLoopStart), leX = timeToX(popupLoopEnd);
      ctx.fillStyle = 'rgba(255,42,26,0.09)'; ctx.fillRect(lsX, 0, leX - lsX, cH);

      // Beat grid
      if (popupBpm > 0) {
          const bd = 60 / popupBpm;
          let first = Math.floor(popupZoomStart / bd) * bd, bi = Math.round(first / bd);
          for (let t = first; t < popupZoomEnd; t += bd, bi++) {
              const x = timeToX(t), isBar = (bi % 4 === 0);
              ctx.strokeStyle = isBar ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
              ctx.lineWidth = isBar ? 0.8 : 0.5;
              ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cH); ctx.stroke();
              if (isBar) {
                  ctx.fillStyle = 'rgba(140,140,140,0.70)'; ctx.font = '8px monospace'; ctx.textAlign = 'left';
                  ctx.fillText(Math.round(t / (bd * 4)) + 1, x + 2, 10);
              }
          }
      }

      // Waveform
      const N = popupPeaks.length, dur = popupBuffer.duration;
      const p0 = Math.floor((popupZoomStart / dur) * N), p1 = Math.ceil((popupZoomEnd / dur) * N);
      const sl = p1 - p0;
      for (let i = 0; i < cW; i++) {
          const pi = p0 + Math.round((i / cW) * sl);
          const pk = popupPeaks[Math.min(pi, N - 1)] || 0;
          const h = pk * cH * 0.88, y = (cH - h) / 2;
          const t = xToTime(i), inL = (t >= popupLoopStart && t <= popupLoopEnd);
          ctx.fillStyle = inL
              ? `rgba(255,${Math.round(82 + pk * 80)},${Math.round(58 + pk * 48)},${0.62 + pk * 0.34})`
              : `rgba(120,120,120,${0.22 + pk * 0.45})`;
          ctx.fillRect(i, y, 1, Math.max(0.5, h));
      }

      // Loop boundary lines
      ctx.strokeStyle = 'rgba(255,42,26,0.92)'; ctx.lineWidth = 1;
      [lsX, leX].forEach(x => { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cH); ctx.stroke(); });
  }

  // ── Minimap render ──
  function renderMinimap($) {
      const mc = document.getElementById('popup-minimap-canvas');
      if (!mc) return;
      const ctx = mc.getContext('2d');
      ctx.clearRect(0, 0, mmW, mmH);
      ctx.fillStyle = '#080808'; ctx.fillRect(0, 0, mmW, mmH);
      if (!popupPeaks || !popupBuffer) return;

      const N = popupPeaks.length, dur = popupBuffer.duration;
      for (let i = 0; i < mmW; i++) {
          const pi = Math.round((i / mmW) * N);
          const pk = popupPeaks[Math.min(pi, N - 1)] || 0;
          const h = pk * mmH * 0.85, y = (mmH - h) / 2;
          const t = (i / mmW) * dur, inL = (t >= popupLoopStart && t <= popupLoopEnd);
          ctx.fillStyle = inL ? `rgba(255,42,26,${0.35 + pk * 0.5})` : `rgba(130,130,130,${0.18 + pk * 0.42})`;
          ctx.fillRect(i, y, 1, Math.max(0.5, h));
      }

      const vL = (popupZoomStart / dur) * mmW, vR = (popupZoomEnd / dur) * mmW;
      ctx.fillStyle = 'rgba(255,255,255,0.045)'; ctx.fillRect(vL, 0, vR - vL, mmH);
      ctx.strokeStyle = 'rgba(255,255,255,0.42)'; ctx.lineWidth = 1;
      ctx.strokeRect(vL + 0.5, 0.5, Math.max(1, vR - vL - 1), mmH - 1);

      if (popupOffset > 0) {
          const px = (popupOffset / dur) * mmW;
          ctx.strokeStyle = 'rgba(255,255,255,0.68)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, mmH); ctx.stroke();
      }
  }

  // ── Zoom ──
  function updateZoomDisplay($) {
      if (!popupBuffer) { $('popup-zoom-level').textContent = '1×'; return; }
      const z = popupBuffer.duration / (popupZoomEnd - popupZoomStart);
      $('popup-zoom-level').textContent = (z < 10 ? z.toFixed(1) : z.toFixed(0)) + '×';
  }

  function setZoomWindow(s, e, $) {
      if (!popupBuffer) return;
      const dur = popupBuffer.duration, minW = dur / 64;
      let sz = Math.max(minW, e - s);
      let ns = Math.max(0, s), ne = Math.min(dur, ns + sz);
      if (ne >= dur) { ne = dur; ns = Math.max(0, ne - sz); }
      popupZoomStart = ns; popupZoomEnd = ne;
      updateZoomDisplay($); updateHandles($); renderWaveform($); renderMinimap($);
  }

  function zoomAtX(canvasX, factor, $) {
      if (!popupBuffer) return;
      const anchor = xToTime(canvasX);
      const newW = Math.max(popupBuffer.duration / 64, Math.min(popupBuffer.duration, (popupZoomEnd - popupZoomStart) / factor));
      const rel = (anchor - popupZoomStart) / (popupZoomEnd - popupZoomStart);
      setZoomWindow(anchor - rel * newW, anchor - rel * newW + newW, $);
  }

  // ── Handles ──
  function updateHandles($) {
      if (!popupBuffer) return;
      $('popup-h-left').style.left  = (timeToX(popupLoopStart) / cW * 100).toFixed(3) + '%';
      $('popup-h-right').style.left = (timeToX(popupLoopEnd)   / cW * 100).toFixed(3) + '%';
      $('popup-tag-left').textContent  = fmtTime(popupLoopStart);
      $('popup-tag-right').textContent = fmtTime(popupLoopEnd);
  }

  function startHandleDrag(side, e, $) {
      dragging = side; dragMoved = false;
      dragX0 = (e.touches ? e.touches[0] : e).clientX;
      dragVal0 = popupLoopStart;
      dragLoopStart0 = popupLoopStart;
      dragLoopDuration = Math.max(0, popupLoopEnd - popupLoopStart);
      e.preventDefault(); e.stopPropagation();
  }

  function onMouseMove(e, $) {
      if (mmDrag && popupBuffer) {
          const dx = e.clientX - mmX0, dur = popupBuffer.duration;
          const dt = (dx / mmW) * dur;
          let ns = mmZS0 + dt, ne = mmZE0 + dt;
          if (ns < 0) { ne -= ns; ns = 0; }
          if (ne > dur) { ns -= (ne - dur); ne = dur; } ns = Math.max(0, ns);
          popupZoomStart = ns; popupZoomEnd = ne;
          updateZoomDisplay($); updateHandles($); renderWaveform($); renderMinimap($);
          return;
      }
      if (!dragging || !popupBuffer) return;
      dragMoved = true;
      const cx = (e.touches ? e.touches[0] : e).clientX;
      const wWrap = document.getElementById('popup-wave-wrap');
      if (!wWrap) return;
      const rect = wWrap.getBoundingClientRect();
      const dt = ((cx - dragX0) / rect.width) * (popupZoomEnd - popupZoomStart);
      const beat = popupBpm > 0 ? 60 / popupBpm : 0;
      const loopDuration = Math.max(0, dragLoopDuration || (popupLoopEnd - popupLoopStart));
      let ns = dragLoopStart0 + dt;
      if (beat > 0) ns = Math.round(ns / beat) * beat;
      const maxStart = Math.max(0, popupBuffer.duration - loopDuration);
      ns = Math.max(0, Math.min(ns, maxStart));
      popupLoopStart = ns;
      popupLoopEnd = Math.min(popupBuffer.duration, popupLoopStart + loopDuration);
      updateHandles($); renderWaveform($); renderMinimap($); updateLoopInfo($);
      if (popupIsPlaying && popupSource && popupLoopOn) {
          popupSource.loopStart = popupLoopStart; popupSource.loopEnd = popupLoopEnd;
      }
  }

  function onMouseUp($) {
      if (dragging) {
          if (dragMoved && popupIsPlaying) { popupPause(); popupPlay($); }
          dragging = null;
      } else { dragMoved = false; }
      mmDrag = false;
  }

  // ── Loop info ──
  function updateLoopInfo($) {
      if (!popupBuffer) return;
      $('popup-loop-time-info').textContent = `${popupLoopStart.toFixed(2)}s → ${popupLoopEnd.toFixed(2)}s · ${(popupLoopEnd - popupLoopStart).toFixed(3)}s`;
      $('popup-stat-loop').textContent = `${popupLoopStart.toFixed(2)}s – ${popupLoopEnd.toFixed(2)}s`;
  }

  function getLoopBarDuration() {
      return popupBpm > 0 ? (60 / popupBpm) * 4 : 0;
  }

  function getMaxLoopBars() {
      if (!popupBuffer) return 999;
      const barDur = getLoopBarDuration();
      if (barDur <= 0) return 999;
      return Math.max(1, Math.floor(((popupBuffer.duration - popupLoopStart) / barDur) + 1e-6));
  }

  function syncBarsLimit($) {
      const maxBars = getMaxLoopBars();
      const barsInput = $('popup-bars-val');
      popupLoopBars = Math.max(1, Math.min(popupLoopBars, maxBars));
      if (barsInput) {
          barsInput.max = String(maxBars);
          barsInput.value = popupLoopBars;
      }
      const decrBtn = $('popup-bars-decr');
      const incrBtn = $('popup-bars-incr');
      if (decrBtn) decrBtn.disabled = popupLoopBars <= 1;
      if (incrBtn) incrBtn.disabled = popupLoopBars >= maxBars;
      return maxBars;
  }

  function updateLoopEnd($) {
      if (!popupBuffer || popupBpm <= 0) return;
      syncBarsLimit($);
      const desiredDuration = Math.min(getLoopBarDuration() * popupLoopBars, popupBuffer.duration);
      if (popupLoopStart + desiredDuration > popupBuffer.duration) {
          popupLoopStart = Math.max(0, popupBuffer.duration - desiredDuration);
      }
      popupLoopEnd = Math.min(popupLoopStart + desiredDuration, popupBuffer.duration);
  }

  function applyLoopChange($) {
      updateLoopEnd($);
      syncBarsLimit($);
      updateHandles($); renderWaveform($); renderMinimap($); updateLoopInfo($);
      if (popupIsPlaying) { popupPause(); popupPlay($); }
  }

  function commitBPM($) {
      const v = +$('popup-bpm-input').value;
      if (v >= 40 && v <= 300) {
          popupBpm = v;
          $('popup-stat-beat').textContent = (60 / popupBpm).toFixed(3) + 's';
          applyLoopChange($);
      } else { $('popup-bpm-input').value = popupBpm; }
  }

  function commitBars($) {
      const maxBars = getMaxLoopBars();
      const v = parseInt($('popup-bars-val').value);
      if (!Number.isNaN(v) && v >= 1) {
          popupLoopBars = Math.min(maxBars, v);
          applyLoopChange($);
      } else {
          $('popup-bars-val').value = popupLoopBars;
      }
  }

  // ── Playback ──
  function popupPlay($) {
      if (!popupBuffer || !popupCtx) return;
      if (popupCtx.state === 'suspended') popupCtx.resume();
      if (popupForceRestartFromLoopStart) popupOffset = popupLoopStart;
      if (popupLoopOn && (popupOffset < popupLoopStart || popupOffset >= popupLoopEnd)) popupOffset = popupLoopStart;
      popupSource = popupCtx.createBufferSource();
      popupSource.buffer = popupBuffer;
      popupSource.connect(popupGain);
      if (popupLoopOn) { popupSource.loop = true; popupSource.loopStart = popupLoopStart; popupSource.loopEnd = popupLoopEnd; }
      popupSource.start(0, popupOffset);
      popupCtxStart = popupCtx.currentTime - popupOffset;
      popupIsPlaying = true;
      $('popup-play-btn').innerHTML = '⏸ Pause'; $('popup-play-btn').classList.add('playing');
      document.getElementById('popup-playhead').style.display = 'block';
      popupSource.onended = () => {
          if (!popupLoopOn && popupIsPlaying) {
              popupIsPlaying = false;
              $('popup-play-btn').innerHTML = '▶ Play'; $('popup-play-btn').classList.remove('playing');
          }
      };
      if (popupAnimRaf) cancelAnimationFrame(popupAnimRaf);
      popupAnimRaf = requestAnimationFrame(ts => animLoop(ts, $));
  }

  function popupPause() {
      if (!popupIsPlaying) return;
      popupOffset = getLiveTime();
      if (popupSource) { popupSource.onended = null; try { popupSource.stop(); } catch (_) {} popupSource = null; }
      popupIsPlaying = false;
      const el = document.getElementById('popup-play-btn');
      if (el) { el.innerHTML = '▶ Play'; el.classList.remove('playing'); }
      if (popupAnimRaf) { cancelAnimationFrame(popupAnimRaf); popupAnimRaf = null; }
  }

  function popupStop($) {
      if (popupSource) { popupSource.onended = null; try { popupSource.stop(); } catch (_) {} popupSource = null; }
      popupIsPlaying = false;
      $('popup-play-btn').innerHTML = '▶ Play'; $('popup-play-btn').classList.remove('playing');
      if (popupAnimRaf) { cancelAnimationFrame(popupAnimRaf); popupAnimRaf = null; }
      popupOffset = popupLoopOn ? popupLoopStart : 0;
      updatePlayheadUI($, popupOffset); renderMinimap($);
      document.getElementById('popup-playhead').style.display = 'none';
  }

  function seekTo(t, $) {
      const was = popupIsPlaying; if (was) popupPause();
      popupOffset = Math.max(0, Math.min(t, popupBuffer ? popupBuffer.duration : 0));
      updatePlayheadUI($, popupOffset); renderMinimap($);
      if (was) popupPlay($);
  }

  function getLiveTime() {
      if (!popupIsPlaying || !popupCtx || !popupBuffer) return popupOffset;
      const el = popupCtx.currentTime - popupCtxStart;
      if (popupLoopOn) { const ld = popupLoopEnd - popupLoopStart; if (ld > 0) return popupLoopStart + ((el - popupLoopStart) % ld + ld) % ld; }
      return Math.min(el, popupBuffer.duration);
  }

  function updatePlayheadUI($, t) {
      if (!popupBuffer) return;
      const pct = t / popupBuffer.duration;
      document.getElementById('popup-progress-fill').style.width = (pct * 100) + '%';
      document.getElementById('popup-t-current').textContent = fmtTime(t);
      const px = timeToX(t);
      const ph = document.getElementById('popup-playhead');
      ph.style.left = px + 'px';
      ph.style.display = (px >= 0 && px <= cW) ? 'block' : 'none';
  }

  let lastMmTs = 0;
  function animLoop(ts, $) {
      if (!popupIsPlaying) return;
      const t = getLiveTime(); updatePlayheadUI($, t);
      if (ts - lastMmTs > 66) { renderMinimap($); lastMmTs = ts; }
      popupAnimRaf = requestAnimationFrame(ts2 => animLoop(ts2, $));
  }

  // ── Volume helpers ──
  function refreshVolSlider($) {
      const s = $('popup-vol-slider');
      s.style.background = `linear-gradient(90deg,rgba(255,42,26,0.92) ${popupVolume}%,rgba(255,255,255,0.12) ${popupVolume}%)`;
  }
  function updateVolIcon($) {
      const btn = $('popup-mute-btn');
      btn.textContent = popupMuted || popupVolume === 0 ? '🔇' : popupVolume < 40 ? '🔈' : popupVolume < 75 ? '🔉' : '🔊';
  }

  // ── Close popup ──
  function closePopup() {
      if (popupAnimRaf) { cancelAnimationFrame(popupAnimRaf); popupAnimRaf = null; }
      if (popupSource)  { try { popupSource.stop(); } catch (_) {} popupSource = null; }
      if (popupCtx)     { try { popupCtx.close(); }  catch (_) {} popupCtx = null; }
      if (popupResizeObs) { popupResizeObs.disconnect(); popupResizeObs = null; }
      if (popupDocMouseMoveHandler) { document.removeEventListener('mousemove', popupDocMouseMoveHandler); popupDocMouseMoveHandler = null; }
      if (popupDocMouseUpHandler) { document.removeEventListener('mouseup', popupDocMouseUpHandler); popupDocMouseUpHandler = null; }
      if (popupDocKeydownHandler) { document.removeEventListener('keydown', popupDocKeydownHandler, true); popupDocKeydownHandler = null; }
      const overlay = document.getElementById('loop-modal-overlay');
      if (overlay) overlay.remove();
      popupOpen = false; popupIsPlaying = false; popupBuffer = null; popupPeaks = null;
      document.getElementById("loopButton")?.focus();
  }

  // ── Formatters ──
  const fmtTime = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
  const fmtDur  = s => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;


  // Host application bridge: apply/clear the popup selection on the main audio
  // element and update the same state used by playback and video export.
  function updateMainLoopButton() {
      const button = document.getElementById('loopButton');
      if (!button) return;
      const loop = audioEngine.getLoopState();
      button.disabled = !loop.ready;
      button.classList.toggle('loop-active', loop.enabled);
      button.textContent = 'Loop';
      button.setAttribute('aria-pressed', String(loop.enabled));
  }

  function applyAudioLoop(start, end) {
      const duration = state.decodedAudioBuffer?.duration || audio.duration || 0;
      if (!(duration > 0)) return;
      const nextStart = clamp(Number(start) || 0, 0, duration);
      const nextEnd = clamp(Number(end) || duration, nextStart, duration);
      audioEngine.loopBpm = clamp(Number(popupBpm) || state.loopBpm || 120, 40, 300);
      audioEngine.loopBars = Math.max(1, Math.round(Number(popupLoopBars) || 1));
      audioEngine.setLoopRange(nextStart, nextEnd, nextEnd > nextStart);
      updateMainLoopButton();
  }

  function clearAudioLoop() {
      audioEngine.clearLoop();
      updateMainLoopButton();
  }
  return { open: openLoopPopup, close: closePopup, syncButton: updateMainLoopButton };
})();
  return controller;
}

export class LoopEditor {
  constructor(audioEngine, state) {
    this.controller = createBinaryTowerLoopController(audioEngine, state);
  }

  open() {
    return this.controller.open();
  }

  close() {
    return this.controller.close();
  }

  syncButton() {
    return this.controller.syncButton();
  }
}
