import { clamp, formatTime } from "./utils.js";

const formatPrecise = (seconds) => {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${(safe - minutes * 60).toFixed(3).padStart(6, "0")}`;
};

export class LoopEditor {
  constructor(audioEngine, state, toast) {
    this.audioEngine = audioEngine;
    this.audio = audioEngine.audio;
    this.state = state;
    this.toast = toast;
    this.overlay = null;
    this.elements = {};
    this.isOpen = false;
    this.wasPlaying = false;
    this.savedTime = 0;
    this.draftStart = 0;
    this.draftEnd = 0;
    this.draftEnabled = true;
    this.previewLoopOn = true;
    this.forceStart = true;
    this.bpm = 125;
    this.bars = 4;
    this.zoom = 1;
    this.viewStart = 0;
    this.dragMode = null;
    this.animationFrame = 0;
    this.bindDocumentEvents();
  }

  bindDocumentEvents() {
    document.addEventListener("keydown", (event) => {
      if (!this.isOpen || event.key !== "Escape") return;
      event.preventDefault();
      this.close(false);
    });
  }

  ensureModal() {
    if (this.overlay) return;
    const overlay = document.createElement("div");
    overlay.id = "loop-modal-overlay";
    overlay.hidden = true;
    overlay.innerHTML = `
      <section class="loop-modal-panel" id="loop-panel" role="dialog" aria-modal="true" aria-labelledby="loop-modal-title">
        <div class="loop-header">
          <div><div class="loop-title" id="loop-modal-title">Loop Editor</div><div class="loop-title-sub">Select and preview a precise audio loop</div></div>
          <button class="loop-close-btn" id="popup-close-btn" type="button" aria-label="Close loop editor">×</button>
        </div>
        <div class="loop-wave-section">
          <div class="loop-wave-header">
            <div class="loop-section-label">Waveform Selection</div>
            <div class="loop-zoom-controls">
              <button class="loop-zoom-btn" id="popup-zoom-out" type="button" aria-label="Zoom out">−</button>
              <span class="loop-zoom-level" id="popup-zoom-level">1×</span>
              <button class="loop-zoom-btn" id="popup-zoom-in" type="button" aria-label="Zoom in">+</button>
              <button class="loop-zoom-btn loop-fit-btn" id="popup-zoom-fit" type="button">FIT</button>
            </div>
          </div>
          <div class="loop-waveform-wrap" id="popup-wave-wrap">
            <div class="loop-wave-clip"><canvas id="popup-wave-canvas"></canvas></div>
            <div id="popup-playhead"></div>
            <div class="popup-lhandle" id="popup-start-handle"><span class="popup-handle-tag" id="popup-start-tag">0:00.000</span><span class="popup-handle-knob"></span></div>
            <div class="popup-lhandle" id="popup-end-handle"><span class="popup-handle-tag" id="popup-end-tag">0:00.000</span><span class="popup-handle-knob"></span></div>
            <div class="loop-analyzing" id="popup-analyzing"><div class="loop-dots"><span></span><span></span><span></span></div><div class="loop-analyzing-text">Analysing audio…</div></div>
          </div>
          <div class="loop-minimap-wrap" id="popup-minimap-wrap"><canvas id="popup-minimap-canvas"></canvas></div>
          <div class="loop-progress-wrap" id="popup-progress-wrap"><div class="loop-progress-fill" id="popup-progress-fill"></div></div>
          <div class="loop-time-row"><span class="loop-time-mono" id="popup-t-current">0:00.000</span><span class="loop-time-mono" id="popup-t-total">0:00.000</span></div>
        </div>
        <div class="loop-controls-section">
          <div class="loop-ctrl-block">
            <div class="loop-transport-row">
              <button class="loop-tbtn" id="popup-play-btn" type="button">▶ Play</button>
              <button class="loop-tbtn" id="popup-stop-btn" type="button">■ Stop</button>
              <div class="loop-pill"><div class="loop-pill-switch on" id="popup-loop-switch" role="switch" aria-checked="true" tabindex="0"></div><span class="loop-pill-label">Loop</span></div>
            </div>
            <div class="loop-option-row"><label class="loop-check-label"><input type="checkbox" id="popup-force-start-toggle" class="loop-check-input" checked><span class="loop-check-box"></span><span class="loop-check-text">Always start preview from loop start</span></label></div>
            <div class="loop-volume-row"><button class="loop-vol-btn" id="popup-mute-btn" type="button" aria-label="Mute preview">🔊</button><input class="loop-vol-slider" id="popup-vol-slider" type="range" min="0" max="100" value="100"><span class="loop-vol-pct" id="popup-vol-pct">100%</span></div>
          </div>
          <div class="loop-ctrl-block loop-bpm-block">
            <div class="loop-section-label">Detected Tempo</div>
            <div class="loop-bpm-row"><input class="loop-bpm-input" id="popup-bpm-input" type="number" min="40" max="300" value="125"><span class="loop-bpm-unit">BPM</span></div>
            <div class="loop-bpm-hint">Click to edit · Enter to confirm</div>
          </div>
          <div class="loop-ctrl-block loop-bars-block">
            <div class="loop-section-label">Loop Length</div>
            <div class="loop-bars-row"><button class="loop-bar-btn" id="popup-bars-decr" type="button">−</button><input class="loop-bars-val" id="popup-bars-val" type="number" min="1" max="999" value="4"><span class="loop-bars-unit">bars</span><button class="loop-bar-btn" id="popup-bars-incr" type="button">+</button></div>
            <div class="loop-time-info" id="popup-loop-time-info">—</div>
          </div>
        </div>
        <div class="loop-status-bar"><span class="loop-stat">Rate: <b id="popup-stat-rate">—</b></span><span class="loop-stat">Duration: <b id="popup-stat-dur">—</b></span><span class="loop-stat">Loop: <b id="popup-stat-loop">—</b></span><span class="loop-stat">Beat: <b id="popup-stat-beat">—</b></span></div>
        <div class="loop-action-row"><button class="loop-action-btn loop-cancel-btn" id="popup-cancel-btn" type="button">Cancel</button><button class="loop-action-btn loop-clear-btn" id="popup-clear-btn" type="button">Clear Loop</button><button class="loop-action-btn loop-apply-btn" id="popup-apply-btn" type="button">Apply Loop</button></div>
      </section>`;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    const ids = ["popup-close-btn","popup-wave-wrap","popup-wave-canvas","popup-minimap-wrap","popup-minimap-canvas","popup-playhead","popup-start-handle","popup-end-handle","popup-start-tag","popup-end-tag","popup-analyzing","popup-progress-wrap","popup-progress-fill","popup-t-current","popup-t-total","popup-play-btn","popup-stop-btn","popup-loop-switch","popup-force-start-toggle","popup-mute-btn","popup-vol-slider","popup-vol-pct","popup-bpm-input","popup-bars-decr","popup-bars-val","popup-bars-incr","popup-loop-time-info","popup-stat-rate","popup-stat-dur","popup-stat-loop","popup-stat-beat","popup-cancel-btn","popup-clear-btn","popup-apply-btn","popup-zoom-out","popup-zoom-in","popup-zoom-fit","popup-zoom-level"];
    for (const id of ids) this.elements[id] = overlay.querySelector(`#${id}`);
    this.bindModalEvents();
  }

  bindModalEvents() {
    const e = this.elements;
    e["popup-close-btn"].addEventListener("click", () => this.close(false));
    e["popup-cancel-btn"].addEventListener("click", () => this.close(false));
    e["popup-apply-btn"].addEventListener("click", () => this.close(true));
    this.overlay.addEventListener("pointerdown", (event) => { if (event.target === this.overlay) this.close(false); });

    e["popup-play-btn"].addEventListener("click", () => this.togglePreview());
    e["popup-stop-btn"].addEventListener("click", () => this.stopPreview());
    e["popup-loop-switch"].addEventListener("click", () => this.togglePreviewLoop());
    e["popup-loop-switch"].addEventListener("keydown", (event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); this.togglePreviewLoop(); } });
    e["popup-force-start-toggle"].addEventListener("change", () => { this.forceStart = e["popup-force-start-toggle"].checked; });

    e["popup-vol-slider"].addEventListener("input", () => {
      const volume = Number(e["popup-vol-slider"].value) / 100;
      this.state.set("volume", volume);
      e["popup-vol-pct"].textContent = `${Math.round(volume * 100)}%`;
      e["popup-mute-btn"].textContent = volume <= 0 ? "🔇" : "🔊";
    });
    e["popup-mute-btn"].addEventListener("click", () => {
      const muted = Number(e["popup-vol-slider"].value) > 0;
      e["popup-vol-slider"].value = muted ? "0" : String(Math.round(this.state.get("volume") * 100) || 80);
      e["popup-vol-slider"].dispatchEvent(new Event("input"));
    });

    e["popup-bpm-input"].addEventListener("change", () => {
      this.bpm = clamp(Number(e["popup-bpm-input"].value) || 125, 40, 300);
      e["popup-bpm-input"].value = String(Math.round(this.bpm));
      this.applyBarsToSelection();
    });
    e["popup-bars-val"].addEventListener("change", () => {
      this.bars = clamp(Math.round(Number(e["popup-bars-val"].value) || 1), 1, 999);
      e["popup-bars-val"].value = String(this.bars);
      this.applyBarsToSelection();
    });
    e["popup-bars-decr"].addEventListener("click", () => { this.bars = Math.max(1, this.bars - 1); e["popup-bars-val"].value = String(this.bars); this.applyBarsToSelection(); });
    e["popup-bars-incr"].addEventListener("click", () => { this.bars = Math.min(999, this.bars + 1); e["popup-bars-val"].value = String(this.bars); this.applyBarsToSelection(); });

    e["popup-clear-btn"].addEventListener("click", () => {
      this.draftEnabled = false;
      this.draftStart = 0;
      this.draftEnd = this.audioEngine.getDuration();
      this.stopPreview();
      this.updateSelection();
    });

    e["popup-zoom-in"].addEventListener("click", () => this.setZoom(this.zoom * 2));
    e["popup-zoom-out"].addEventListener("click", () => this.setZoom(this.zoom / 2));
    e["popup-zoom-fit"].addEventListener("click", () => this.setZoom(1));

    this.bindHandleDrag(e["popup-start-handle"], "start");
    this.bindHandleDrag(e["popup-end-handle"], "end");
    e["popup-wave-wrap"].addEventListener("pointerdown", (event) => {
      if (event.target.closest(".popup-lhandle")) return;
      const time = this.timeFromPointer(event, e["popup-wave-wrap"]);
      const toStart = Math.abs(time - this.draftStart);
      const toEnd = Math.abs(time - this.draftEnd);
      if (toStart <= toEnd) this.draftStart = Math.min(time, this.draftEnd - 0.01);
      else this.draftEnd = Math.max(time, this.draftStart + 0.01);
      this.draftEnabled = true;
      this.updateSelection();
    });
    e["popup-progress-wrap"].addEventListener("pointerdown", (event) => {
      const rect = e["popup-progress-wrap"].getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      this.audio.currentTime = ratio * this.audioEngine.getDuration();
      this.updatePlayhead();
    });
    e["popup-minimap-wrap"].addEventListener("pointerdown", (event) => {
      if (this.zoom <= 1) return;
      const rect = e["popup-minimap-wrap"].getBoundingClientRect();
      const center = clamp((event.clientX - rect.left) / rect.width, 0, 1) * this.audioEngine.getDuration();
      const viewDuration = this.audioEngine.getDuration() / this.zoom;
      this.viewStart = clamp(center - viewDuration / 2, 0, this.audioEngine.getDuration() - viewDuration);
      this.drawAll();
    });
  }

  bindHandleDrag(handle, mode) {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.dragMode = mode;
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (this.dragMode !== mode || !handle.hasPointerCapture(event.pointerId)) return;
      const time = this.timeFromPointer(event, this.elements["popup-wave-wrap"]);
      if (mode === "start") this.draftStart = Math.min(time, this.draftEnd - 0.01);
      else this.draftEnd = Math.max(time, this.draftStart + 0.01);
      this.draftEnabled = true;
      this.updateSelection();
    });
    const end = (event) => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      this.dragMode = null;
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  async open() {
    if (!this.audioEngine.decodedBuffer) {
      this.toast("Load and analyze an audio file before opening the loop editor.", "error");
      return;
    }
    this.ensureModal();
    const loop = this.audioEngine.getLoopState();
    this.wasPlaying = !this.audio.paused;
    this.savedTime = this.audio.currentTime;
    this.audio.pause();
    this.audioEngine.clearPreviewLoop();
    this.draftEnabled = loop.enabled;
    this.draftStart = loop.enabled ? loop.start : 0;
    this.draftEnd = loop.enabled && loop.duration > 0.01 ? loop.end : Math.min(loop.trackDuration, 8);
    this.previewLoopOn = true;
    this.forceStart = true;
    this.zoom = 1;
    this.viewStart = 0;
    this.bars = 4;
    this.isOpen = true;
    this.overlay.hidden = false;
    document.body.classList.add("loop-editor-open");

    const e = this.elements;
    e["popup-loop-switch"].classList.add("on");
    e["popup-loop-switch"].setAttribute("aria-checked", "true");
    e["popup-force-start-toggle"].checked = true;
    e["popup-vol-slider"].value = String(Math.round(this.state.get("volume") * 100));
    e["popup-vol-pct"].textContent = `${Math.round(this.state.get("volume") * 100)}%`;
    e["popup-t-total"].textContent = formatPrecise(loop.trackDuration);
    e["popup-stat-rate"].textContent = `${this.audioEngine.decodedBuffer.sampleRate.toLocaleString()} Hz`;
    e["popup-stat-dur"].textContent = formatPrecise(loop.trackDuration);
    e["popup-analyzing"].classList.add("show");
    this.updateSelection();
    requestAnimationFrame(() => this.drawAll());

    await new Promise((resolve) => requestAnimationFrame(resolve));
    this.bpm = this.detectTempo(this.audioEngine.decodedBuffer);
    if (!this.isOpen) return;
    e["popup-bpm-input"].value = String(Math.round(this.bpm));
    e["popup-stat-beat"].textContent = `${Math.round(this.bpm)} BPM`;
    if (!loop.enabled) this.applyBarsToSelection();
    e["popup-analyzing"].classList.remove("show");
    e["popup-play-btn"].focus();
    this.animationFrame = requestAnimationFrame(() => this.animate());
  }

  async close(apply) {
    if (!this.isOpen) return;
    this.isOpen = false;
    cancelAnimationFrame(this.animationFrame);
    this.audio.pause();
    this.audioEngine.clearPreviewLoop();
    if (apply) {
      if (this.draftEnabled) this.audioEngine.setLoopRange(this.draftStart, this.draftEnd, true);
      else this.audioEngine.clearLoop();
      const loop = this.audioEngine.getLoopState();
      this.audio.currentTime = loop.enabled ? loop.start : clamp(this.savedTime, 0, loop.trackDuration);
      this.toast(loop.enabled ? "Audio loop applied." : "Audio loop cleared.", "success");
    } else {
      this.audio.currentTime = this.savedTime;
    }
    this.overlay.hidden = true;
    document.body.classList.remove("loop-editor-open");
    if (this.wasPlaying) this.audioEngine.play().catch(() => {});
  }

  async togglePreview() {
    if (!this.audio.paused) {
      this.audio.pause();
      return;
    }
    if (this.forceStart || this.audio.currentTime < this.draftStart || this.audio.currentTime >= this.draftEnd) this.audio.currentTime = this.draftStart;
    this.audioEngine.setPreviewLoop(this.draftStart, this.draftEnd, this.previewLoopOn);
    await this.audioEngine.play();
  }

  stopPreview() {
    this.audio.pause();
    this.audio.currentTime = this.draftStart;
    this.updatePlayhead();
  }

  togglePreviewLoop() {
    this.previewLoopOn = !this.previewLoopOn;
    const toggle = this.elements["popup-loop-switch"];
    toggle.classList.toggle("on", this.previewLoopOn);
    toggle.setAttribute("aria-checked", String(this.previewLoopOn));
    this.audioEngine.setPreviewLoop(this.draftStart, this.draftEnd, this.previewLoopOn);
  }

  applyBarsToSelection() {
    const duration = this.audioEngine.getDuration();
    const loopLength = (60 / this.bpm) * 4 * this.bars;
    this.draftEnd = Math.min(duration, this.draftStart + loopLength);
    if (this.draftEnd - this.draftStart < 0.01) this.draftStart = Math.max(0, this.draftEnd - 0.01);
    this.draftEnabled = true;
    this.updateSelection();
  }

  setZoom(value) {
    const duration = this.audioEngine.getDuration();
    const center = this.viewStart + duration / this.zoom / 2;
    this.zoom = clamp(value, 1, 16);
    const viewDuration = duration / this.zoom;
    this.viewStart = clamp(center - viewDuration / 2, 0, Math.max(0, duration - viewDuration));
    this.elements["popup-zoom-level"].textContent = `${this.zoom}×`;
    this.drawAll();
  }

  timeFromPointer(event, element) {
    const rect = element.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const viewDuration = this.audioEngine.getDuration() / this.zoom;
    return clamp(this.viewStart + ratio * viewDuration, 0, this.audioEngine.getDuration());
  }

  updateSelection() {
    const duration = this.audioEngine.getDuration();
    this.draftStart = clamp(this.draftStart, 0, duration);
    this.draftEnd = clamp(this.draftEnd, this.draftStart, duration);
    this.audioEngine.setPreviewLoop(this.draftStart, this.draftEnd, this.previewLoopOn && this.isOpen);
    const e = this.elements;
    e["popup-start-tag"].textContent = formatPrecise(this.draftStart);
    e["popup-end-tag"].textContent = formatPrecise(this.draftEnd);
    e["popup-loop-time-info"].textContent = this.draftEnabled ? `${this.draftStart.toFixed(2)}s → ${this.draftEnd.toFixed(2)}s · ${(this.draftEnd - this.draftStart).toFixed(3)}s` : "Loop disabled";
    e["popup-stat-loop"].textContent = this.draftEnabled ? `${this.draftStart.toFixed(2)}s – ${this.draftEnd.toFixed(2)}s` : "Off";
    e["popup-apply-btn"].textContent = this.draftEnabled ? "Apply Loop" : "Clear Loop";
    this.drawAll();
  }

  drawAll() {
    if (!this.isOpen) return;
    this.drawWaveform(this.elements["popup-wave-canvas"], false);
    this.drawWaveform(this.elements["popup-minimap-canvas"], true);
    this.updateHandles();
    this.updatePlayhead();
  }

  prepareCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return { ctx: canvas.getContext("2d"), width, height, ratio };
  }

  drawWaveform(canvas, minimap) {
    const peaks = this.audioEngine.waveformPeaks;
    if (!peaks) return;
    const { ctx, width, height } = this.prepareCanvas(canvas);
    const duration = this.audioEngine.getDuration();
    const startTime = minimap ? 0 : this.viewStart;
    const visibleDuration = minimap ? duration : duration / this.zoom;
    const endTime = startTime + visibleDuration;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = minimap ? "rgba(0,3,14,.92)" : "rgba(0,4,18,.96)";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(255,255,255,.06)";
    ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();

    const startIndex = Math.floor(startTime / duration * peaks.length);
    const endIndex = Math.ceil(endTime / duration * peaks.length);
    ctx.strokeStyle = "rgba(120,170,255,.76)";
    ctx.lineWidth = minimap ? 1 : 1.25;
    ctx.beginPath();
    for (let x = 0; x < width; x += 1) {
      const index = clamp(Math.floor(startIndex + x / width * (endIndex - startIndex)), 0, peaks.length - 1);
      const amplitude = peaks[index] || 0;
      const half = amplitude * height * 0.43;
      ctx.moveTo(x + 0.5, height / 2 - half);
      ctx.lineTo(x + 0.5, height / 2 + half);
    }
    ctx.stroke();

    const selectionStart = (this.draftStart - startTime) / visibleDuration * width;
    const selectionEnd = (this.draftEnd - startTime) / visibleDuration * width;
    ctx.fillStyle = this.draftEnabled ? "rgba(59,130,246,.17)" : "rgba(255,255,255,.04)";
    ctx.fillRect(selectionStart, 0, selectionEnd - selectionStart, height);
    if (minimap && this.zoom > 1) {
      ctx.strokeStyle = "rgba(255,255,255,.45)";
      ctx.strokeRect(this.viewStart / duration * width, 1, visibleDuration / duration * width, height - 2);
    }
  }

  updateHandles() {
    const duration = this.audioEngine.getDuration();
    const visibleDuration = duration / this.zoom;
    const startRatio = (this.draftStart - this.viewStart) / visibleDuration;
    const endRatio = (this.draftEnd - this.viewStart) / visibleDuration;
    const startHandle = this.elements["popup-start-handle"];
    const endHandle = this.elements["popup-end-handle"];
    startHandle.style.left = `${startRatio * 100}%`;
    endHandle.style.left = `${endRatio * 100}%`;
    startHandle.style.display = startRatio >= 0 && startRatio <= 1 ? "block" : "none";
    endHandle.style.display = endRatio >= 0 && endRatio <= 1 ? "block" : "none";
  }

  updatePlayhead() {
    if (!this.isOpen) return;
    const duration = this.audioEngine.getDuration();
    const current = this.audio.currentTime || 0;
    const viewDuration = duration / this.zoom;
    const ratio = (current - this.viewStart) / viewDuration;
    const playhead = this.elements["popup-playhead"];
    playhead.style.left = `${ratio * 100}%`;
    playhead.style.display = ratio >= 0 && ratio <= 1 ? "block" : "none";
    this.elements["popup-progress-fill"].style.width = `${duration ? current / duration * 100 : 0}%`;
    this.elements["popup-t-current"].textContent = formatPrecise(current);
    this.elements["popup-play-btn"].innerHTML = this.audio.paused ? "▶ Play" : "⏸ Pause";
    this.elements["popup-play-btn"].classList.toggle("playing", !this.audio.paused);
  }

  animate() {
    if (!this.isOpen) return;
    this.updatePlayhead();
    this.animationFrame = requestAnimationFrame(() => this.animate());
  }

  detectTempo(buffer) {
    try {
      const source = buffer.getChannelData(0);
      const targetRate = 200;
      const step = Math.max(1, Math.floor(buffer.sampleRate / targetRate));
      const sampleCount = Math.min(Math.floor(source.length / step), targetRate * 90);
      if (sampleCount < targetRate * 4) return 125;
      const envelope = new Float32Array(sampleCount);
      let mean = 0;
      for (let index = 0; index < sampleCount; index += 1) {
        const start = index * step;
        let sum = 0;
        for (let offset = 0; offset < step; offset += 1) sum += Math.abs(source[start + offset] || 0);
        envelope[index] = sum / step;
        mean += envelope[index];
      }
      mean /= sampleCount;
      for (let index = 0; index < sampleCount; index += 1) envelope[index] = Math.max(0, envelope[index] - mean);
      let bestBpm = 125;
      let bestScore = -Infinity;
      for (let bpm = 60; bpm <= 190; bpm += 1) {
        const lag = Math.round(targetRate * 60 / bpm);
        let score = 0;
        for (let index = lag; index < sampleCount; index += 2) score += envelope[index] * envelope[index - lag];
        if (score > bestScore) { bestScore = score; bestBpm = bpm; }
      }
      while (bestBpm < 80) bestBpm *= 2;
      while (bestBpm > 170) bestBpm /= 2;
      return clamp(Math.round(bestBpm), 40, 300);
    } catch {
      return 125;
    }
  }
}
