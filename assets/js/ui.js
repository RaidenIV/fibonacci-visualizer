import { LoopEditor } from "./loop-editor.js";
import { clamp, createToast, formatBytes, formatTime, getExtension } from "./utils.js";

const CONTROL_FORMATS = {
  pointCount: (v) => Number(v).toLocaleString(), spacing: (v) => Number(v).toFixed(2), pointSize: (v) => Number(v).toFixed(1),
  goldenAngle: (v) => `${Number(v).toFixed(2)}°`, warp: (v) => Number(v).toFixed(2), depth: (v) => Number(v).toFixed(1),
  depthFrequency: (v) => Number(v).toFixed(3), sensitivity: (v) => `${Number(v).toFixed(2)}×`, smoothing: (v) => `${Math.round(v * 100)}%`,
  audioScale: (v) => `${Number(v).toFixed(2)}×`, audioDensity: (v) => `${Math.round(v * 100)}%`, audioSize: (v) => `${Number(v).toFixed(2)}×`,
  audioRotation: (v) => `${Number(v).toFixed(2)}×`, audioDepth: (v) => `${Number(v).toFixed(2)}×`, rotationSpeed: (v) => Number(v).toFixed(2),
  colorCycle: (v) => Number(v).toFixed(2), opacity: (v) => `${Math.round(v * 100)}%`, volume: (v) => `${Math.round(v * 100)}%`, fov: (v) => `${Math.round(v)}°`,
};

const BOOLEAN_KEYS = new Set(["loopTrack", "demoMode", "additive", "autoOrbit", "showGrid", "showHud", "showSafeArea"]);
const NUMBER_KEYS = new Set(["pointCount", "spacing", "pointSize", "goldenAngle", "warp", "depth", "depthFrequency", "sensitivity", "smoothing", "audioScale", "audioDensity", "audioSize", "audioRotation", "audioDepth", "rotationSpeed", "colorCycle", "opacity", "volume", "fov", "exportFps", "exportBitrate"]);

export class UIController extends EventTarget {
  constructor(state, audioEngine, visualizer, exporter) {
    super();
    this.state = state;
    this.audioEngine = audioEngine;
    this.visualizer = visualizer;
    this.exporter = exporter;
    this.elements = this.collectElements();
    this.loopEditor = new LoopEditor(audioEngine, state, (message, tone) => this.toast(message, tone));
    this.bindControls();
    this.syncAll();
  }

  collectElements() {
    const ids = ["appShell","sidebar","closeSidebar","audioFile","audioStatus","audioFileLabel","trackName","trackDuration","trackFormat","trackSize","fileDrop","dropOverlay","audio","playPause","clearWaveform","loopButton","loopStatus","seek","currentTime","totalTime","viewportFrame","safeArea","rendererInfo","drawCalls","gpuPoints","pixelRatio","qualityBadge","exportVideo","exportPng","exportSettings","importSettings","resetSettings","recordingStatus","exportProgress","exportProgressLabel","exportProgressValue","exportProgressBar","exportProgressMeta","toastStack"];
    const elements = {};
    for (const id of ids) elements[id] = document.getElementById(id);
    return elements;
  }

  bindControls() {
    for (const key of Object.keys(this.state.settings)) {
      const element = document.getElementById(key);
      if (!element) continue;
      const eventName = element.matches('input[type="range"]') ? "input" : "change";
      element.addEventListener(eventName, () => {
        let value = BOOLEAN_KEYS.has(key) ? element.checked : NUMBER_KEYS.has(key) ? Number(element.value) : element.value;
        this.state.set(key, value);
        this.updateOutput(key, value);
      });
    }

    document.querySelectorAll(".range-value-input[data-range-id]").forEach((editor) => {
      const commit = () => {
        const key = editor.dataset.rangeId;
        const range = document.getElementById(key);
        if (!range) return;
        const multiplier = Number(editor.dataset.displayMultiplier || 1);
        const displayedMin = Number(editor.min);
        const displayedMax = Number(editor.max);
        let displayed = Number(editor.value);
        if (!Number.isFinite(displayed)) {
          this.updateOutput(key, this.state.get(key));
          return;
        }
        displayed = clamp(displayed, displayedMin, displayedMax);
        const editorStep = Number(editor.step);
        if (Number.isFinite(editorStep) && editorStep > 0) {
          displayed = Math.round((displayed - displayedMin) / editorStep) * editorStep + displayedMin;
        }
        const value = displayed / multiplier;
        this.state.set(key, value);
        this.updateOutput(key, value);
      };
      editor.addEventListener("change", commit);
      editor.addEventListener("blur", commit);
      editor.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          editor.blur();
        }
      });
    });

    this.elements.audioFile.addEventListener("change", () => this.loadSelectedFile(this.elements.audioFile.files?.[0]));
    this.elements.fileDrop.addEventListener("dragover", (event) => { event.preventDefault(); this.elements.fileDrop.classList.add("is-dragging"); });
    this.elements.fileDrop.addEventListener("dragleave", () => this.elements.fileDrop.classList.remove("is-dragging"));
    this.elements.fileDrop.addEventListener("drop", (event) => {
      event.preventDefault(); this.elements.fileDrop.classList.remove("is-dragging"); this.loadSelectedFile(event.dataTransfer.files?.[0]);
    });
    for (const eventName of ["dragenter", "dragover"]) window.addEventListener(eventName, (event) => { event.preventDefault(); this.elements.dropOverlay.classList.add("is-active"); });
    window.addEventListener("dragleave", (event) => { if (!event.relatedTarget) this.elements.dropOverlay.classList.remove("is-active"); });
    window.addEventListener("drop", (event) => {
      event.preventDefault(); this.elements.dropOverlay.classList.remove("is-active");
      const file = event.dataTransfer.files?.[0]; if (file) this.loadSelectedFile(file);
    });

    this.elements.playPause.addEventListener("click", () => this.audioEngine.togglePlayback().catch((error) => this.toast(error.message, "error")));
    this.elements.clearWaveform.addEventListener("click", () => {
      this.audioEngine.clearWaveform();
      this.dispatchEvent(new Event("clear-waveform"));
      this.toast("Waveform history cleared.");
    });
    this.elements.loopButton.addEventListener("click", () => this.loopEditor.open());
    this.elements.seek.addEventListener("input", () => this.audioEngine.seek(Number(this.elements.seek.value)));
    this.elements.closeSidebar.addEventListener("click", () => this.elements.appShell.classList.add("sidebar-hidden"));
    document.querySelectorAll("[data-camera]").forEach((button) => button.addEventListener("click", () => this.visualizer.setCameraPreset(button.dataset.camera)));
    document.querySelectorAll("[data-preset]").forEach((button) => button.addEventListener("click", () => { this.state.applyPreset(button.dataset.preset); this.toast(`${button.dataset.preset.toUpperCase()} preset loaded.`); }));

    this.elements.exportVideo.addEventListener("click", () => this.exporter.start().catch((error) => this.toast(error.message, "error")));
    this.exporter.addEventListener("error", (event) => this.toast(event.detail?.message || "Video export failed.", "error"));
    this.elements.exportPng.addEventListener("click", () => this.dispatchEvent(new Event("export-png")));
    this.elements.exportSettings.addEventListener("click", () => this.exportSettings());
    this.elements.importSettings.addEventListener("change", () => this.importSettings(this.elements.importSettings.files?.[0]));
    this.elements.resetSettings.addEventListener("click", () => { this.state.reset(); this.toast("Settings reset."); });

    this.audioEngine.addEventListener("file", (event) => this.updateTrack(event.detail));
    this.audioEngine.addEventListener("playback", () => this.syncPlayback());
    this.audioEngine.addEventListener("metadata", () => this.syncPlayback());
    this.audioEngine.addEventListener("loopchange", () => this.syncLoop());
    this.exporter.addEventListener("start", (event) => this.showExportStart(event.detail));
    this.exporter.addEventListener("progress", (event) => this.showExportProgress(event.detail));
    this.exporter.addEventListener("finish", (event) => this.showExportFinish(event.detail));

    document.addEventListener("keydown", (event) => {
      if (event.target.matches("input, select, textarea")) return;
      if (event.code === "Space") { event.preventDefault(); this.audioEngine.togglePlayback().catch((error) => this.toast(error.message, "error")); }
      if (event.key.toLowerCase() === "h") this.state.set("showHud", !this.state.get("showHud"));
      if (event.key.toLowerCase() === "f") this.toggleFullscreen();
      if (event.key.toLowerCase() === "g") this.state.set("showGrid", !this.state.get("showGrid"));
    });
  }

  async loadSelectedFile(file) {
    if (!file) return;
    this.elements.audioStatus.textContent = "LOADING";
    try {
      await this.audioEngine.loadFile(file);
      this.state.set("demoMode", false);
      this.toast(`Loaded ${file.name}.`, "success");
    } catch (error) {
      this.elements.audioStatus.textContent = "ERROR";
      this.toast(error.message, "error");
    }
  }

  syncAll() {
    for (const [key, value] of Object.entries(this.state.settings)) this.syncControl(key, value);
    this.syncViewportFormat();
    this.syncPlayback();
    this.syncLoop();
  }

  syncControl(key, value) {
    const element = document.getElementById(key);
    if (element) {
      if (BOOLEAN_KEYS.has(key)) element.checked = Boolean(value);
      else element.value = String(value);
    }
    this.updateOutput(key, value);
    if (key === "viewportFormat") this.syncViewportFormat();
    if (key === "showSafeArea") this.elements.safeArea.hidden = !value;
    if (key === "quality") {
      this.elements.qualityBadge.textContent = String(value).toUpperCase();
    }
  }

  updateOutput(key, value) {
    const output = document.getElementById(`${key}Value`);
    if (!output) return;
    if (output.matches("input.range-value-input")) {
      const multiplier = Number(output.dataset.displayMultiplier || 1);
      const decimals = Math.max(0, Number(output.dataset.decimals || 0));
      const displayed = Number(value) * multiplier;
      if (document.activeElement !== output) output.value = Number.isFinite(displayed) ? displayed.toFixed(decimals) : "0";
      return;
    }
    if (CONTROL_FORMATS[key]) output.textContent = CONTROL_FORMATS[key](value);
  }

  syncViewportFormat() {
    this.elements.viewportFrame.dataset.format = this.state.get("viewportFormat");
    requestAnimationFrame(() => this.visualizer.resize(true));
  }

  syncPlayback() {
    const audio = this.audioEngine.audio;
    const hasAudio = Boolean(this.audioEngine.file);
    this.elements.playPause.disabled = !hasAudio;
    this.elements.clearWaveform.disabled = !hasAudio;
    this.elements.seek.disabled = !hasAudio;
    this.elements.playPause.textContent = hasAudio && !audio.paused ? "Pause" : "Play";
    this.elements.audioStatus.textContent = hasAudio ? (!audio.paused ? "PLAYING" : "READY") : this.state.get("demoMode") ? "DEMO" : "IDLE";
    this.elements.currentTime.textContent = formatTime(hasAudio ? audio.currentTime : 0);
    this.elements.totalTime.textContent = formatTime(hasAudio ? audio.duration : 0);
    this.elements.seek.max = Number.isFinite(audio.duration) ? audio.duration : 1;
    if (!this.elements.seek.matches(":active")) this.elements.seek.value = hasAudio ? audio.currentTime : 0;
    this.syncLoop();
  }

  syncLoop() {
    const loop = this.audioEngine.getLoopState();
    this.elements.loopButton.disabled = !loop.ready;
    this.elements.loopButton.classList.toggle("loop-active", loop.enabled);
    this.elements.loopButton.setAttribute("aria-pressed", String(loop.enabled));
    if (!loop.ready) {
      this.elements.loopStatus.textContent = "Load and analyze audio to create a loop.";
      this.elements.loopStatus.dataset.tone = "idle";
    } else if (!loop.enabled) {
      this.elements.loopStatus.textContent = "Loop off.";
      this.elements.loopStatus.dataset.tone = "idle";
    } else if (loop.partial) {
      this.elements.loopStatus.textContent = `Loop on · ${formatTime(loop.start)}–${formatTime(loop.end)} · ${loop.duration.toFixed(2)} s`;
      this.elements.loopStatus.dataset.tone = "active";
    } else {
      this.elements.loopStatus.textContent = "Full-track loop enabled.";
      this.elements.loopStatus.dataset.tone = "active";
    }
  }

  updateTrack(file) {
    this.elements.trackName.textContent = file.name;
    this.elements.trackDuration.textContent = formatTime(this.audioEngine.audio.duration);
    this.elements.trackFormat.textContent = getExtension(file.name);
    this.elements.trackSize.textContent = formatBytes(file.size);
    this.elements.audioFileLabel.textContent = "REPLACE AUDIO FILE";
    this.elements.dropOverlay.classList.add("has-audio");
    this.syncPlayback();
  }

  updateRuntime(meta) {
    this.syncPlayback();
    this.elements.drawCalls.textContent = String(meta.drawCalls);
    this.elements.gpuPoints.textContent = meta.points.toLocaleString();
    this.elements.pixelRatio.textContent = `${meta.pixelRatio.toFixed(2)}×`;
  }

  showExportStart(detail) {
    this.elements.recordingStatus.textContent = "RECORDING";
    this.elements.exportVideo.textContent = "STOP & SAVE VIDEO";
    this.elements.exportVideo.classList.add("is-recording");
    this.elements.exportProgress.hidden = false;
    this.elements.exportProgressLabel.textContent = `${detail.format || "VIDEO"} // ${detail.width}×${detail.height} @ ${detail.fps} FPS`;
    this.elements.exportProgressMeta.textContent = detail.duration > 0 ? `Capturing ${formatTime(detail.duration)} in real time.` : "Capturing until stopped.";
  }

  showExportProgress(detail) {
    const percent = detail.duration > 0 ? Math.round(detail.progress * 100) : 0;
    this.elements.exportProgressValue.textContent = detail.duration > 0 ? `${percent}%` : formatTime(detail.elapsed);
    this.elements.exportProgressBar.value = percent;
    this.elements.exportProgressMeta.textContent = detail.duration > 0 ? `${formatTime(detail.elapsed)} elapsed // ${formatTime(Math.max(0, detail.duration - detail.elapsed))} remaining` : `${formatTime(detail.elapsed)} captured`;
  }

  showExportFinish(detail) {
    this.elements.recordingStatus.textContent = "READY";
    this.elements.exportVideo.textContent = "START VIDEO EXPORT";
    this.elements.exportVideo.classList.remove("is-recording");
    this.elements.exportProgress.hidden = true;
    this.toast(detail.cancelled ? "Video export cancelled." : "Video export complete.", detail.cancelled ? "info" : "success");
  }

  exportSettings() {
    const blob = new Blob([JSON.stringify(this.state.exportPayload(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "fibonacci-audio-field-settings.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async importSettings(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      this.state.importPayload(payload);
      this.toast("Settings imported.", "success");
    } catch (error) {
      this.toast(error.message || "Settings import failed.", "error");
    } finally {
      this.elements.importSettings.value = "";
    }
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) this.elements.viewportFrame.requestFullscreen().catch((error) => this.toast(error.message, "error"));
    else document.exitFullscreen();
  }

  toast(message, tone = "info") {
    createToast(this.elements.toastStack, message, tone);
  }
}
