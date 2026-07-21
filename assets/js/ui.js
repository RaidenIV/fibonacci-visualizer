import { LoopEditor } from "./loop-editor.js?v=20260720-2356-2";
import { clamp, createToast, formatBytes, formatTime, getExtension } from "./utils.js";

const CONTROL_FORMATS = {
  pointCount: (v) => Number(v).toLocaleString(), spacing: (v) => Number(v).toFixed(2), pointSize: (v) => Number(v).toFixed(1),
  goldenAngle: (v) => `${Number(v).toFixed(2)}°`, warp: (v) => Number(v).toFixed(2), depth: (v) => Number(v).toFixed(1),
  depthFrequency: (v) => Number(v).toFixed(3), sensitivity: (v) => `${Number(v).toFixed(2)}×`, smoothing: (v) => `${Math.round(v * 100)}%`,
  audioScale: (v) => `${Number(v).toFixed(2)}×`, audioDensity: (v) => `${Math.round(v * 100)}%`, audioSize: (v) => `${Number(v).toFixed(2)}×`,
  audioRotation: (v) => `${Number(v).toFixed(2)}×`, audioDepth: (v) => `${Number(v).toFixed(2)}×`, rotationSpeed: (v) => Number(v).toFixed(2),
  colorCycle: (v) => Number(v).toFixed(2), opacity: (v) => `${Math.round(v * 100)}%`, volume: (v) => `${Math.round(v * 100)}%`, fov: (v) => `${Math.round(v)}°`,
};

const BOOLEAN_KEYS = new Set(["loopTrack", "demoMode", "muted", "additive", "autoOrbit", "showGrid", "showHud", "showSafeArea"]);
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
    this.initializeCollapsibleSections();
    this.bindControls();
    this.syncAll();
  }

  collectElements() {
    const ids = ["appShell","sidebar","closeSidebar","sidebarToggleIcon","audioFile","audioStatus","audioFileLabel","trackName","trackDuration","trackFormat","trackSize","fileDrop","dropOverlay","audio","playPause","clearWaveform","loopButton","loopStatus","seek","currentTime","totalTime","viewportFrame","safeArea","rendererInfo","drawCalls","gpuPoints","pixelRatio","qualityBadge","exportVideo","exportPng","exportSettings","importSettings","resetSettings","recordingStatus","exportProgress","exportProgressLabel","exportProgressValue","exportProgressBar","exportProgressMeta","exportResolution","exportFps","exportFormat","exportBitrate","exportRange","exportFileName","videoExportOverlay","videoExportOverlayTitle","videoExportOverlayDetail","videoExportOverlayProgress","videoExportOverlayProgressText","videoExportOverlayMeta","videoExportCancel","toastStack"];
    const elements = {};
    for (const id of ids) elements[id] = document.getElementById(id);
    return elements;
  }

  initializeCollapsibleSections() {
    document.querySelectorAll(".sidebar details.panel").forEach((panel, index) => {
      const summary = panel.querySelector(":scope > summary");
      const body = panel.querySelector(":scope > .panel__body");
      if (!summary || !body) return;

      const initiallyExpanded = panel.hasAttribute("open");
      let inner = body.querySelector(":scope > .panel__body-inner");
      if (!inner) {
        inner = document.createElement("div");
        inner.className = "panel__body-inner";
        while (body.firstChild) inner.appendChild(body.firstChild);
        body.appendChild(inner);
      }

      const contentId = `sidebar-panel-${index + 1}`;
      body.id = contentId;
      panel.open = true;
      panel.classList.toggle("is-collapsed", !initiallyExpanded);
      summary.setAttribute("aria-controls", contentId);
      summary.setAttribute("aria-expanded", String(initiallyExpanded));
      body.setAttribute("aria-hidden", String(!initiallyExpanded));

      summary.addEventListener("click", (event) => {
        event.preventDefault();
        const expanded = panel.classList.contains("is-collapsed");
        panel.classList.toggle("is-collapsed", !expanded);
        summary.setAttribute("aria-expanded", String(expanded));
        body.setAttribute("aria-hidden", String(!expanded));
      });
    });
  }

  toggleSidebar() {
    const collapsed = this.elements.appShell.classList.toggle("sidebar-collapsed");
    const expanded = !collapsed;
    const label = collapsed ? "Expand sidebar" : "Collapse sidebar";

    this.elements.closeSidebar.setAttribute("aria-expanded", String(expanded));
    this.elements.closeSidebar.setAttribute("aria-label", label);
    this.elements.closeSidebar.title = label;
    this.elements.sidebarToggleIcon.textContent = collapsed ? "›" : "‹";

    requestAnimationFrame(() => this.visualizer.resize(true));
    window.setTimeout(() => this.visualizer.resize(true), 190);
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
      const wrapper = editor.closest(".range-value-editor");
      if (wrapper && wrapper.dataset.enhanced !== "true") {
        const label = editor.getAttribute("aria-label") || "Value";
        const decrementButton = document.createElement("button");
        decrementButton.type = "button";
        decrementButton.className = "range-value-stepper";
        decrementButton.textContent = "−";
        decrementButton.setAttribute("aria-label", `Decrease ${label}`);
        decrementButton.title = `Decrease ${label}`;

        const incrementButton = document.createElement("button");
        incrementButton.type = "button";
        incrementButton.className = "range-value-stepper";
        incrementButton.textContent = "+";
        incrementButton.setAttribute("aria-label", `Increase ${label}`);
        incrementButton.title = `Increase ${label}`;

        wrapper.appendChild(decrementButton);
        wrapper.appendChild(incrementButton);
        wrapper.dataset.enhanced = "true";

        const stepValue = (direction) => {
          if (direction < 0) editor.stepDown();
          else editor.stepUp();
          editor.dispatchEvent(new Event("input", { bubbles: true }));
          editor.dispatchEvent(new Event("change", { bubbles: true }));
        };
        decrementButton.addEventListener("click", () => stepValue(-1));
        incrementButton.addEventListener("click", () => stepValue(1));
        editor.addEventListener("focus", () => requestAnimationFrame(() => editor.select()));
        editor.addEventListener("wheel", () => editor.blur(), { passive: true });
      }
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
    this.elements.seek.addEventListener("input", () => {
      const playbackWindow = this.getPlaybackWindow();
      this.audioEngine.seek(playbackWindow.start + Number(this.elements.seek.value));
      this.syncPlayback();
    });
    this.elements.closeSidebar.addEventListener("click", () => this.toggleSidebar());
    document.querySelectorAll("[data-camera]").forEach((button) => button.addEventListener("click", () => this.visualizer.setCameraPreset(button.dataset.camera)));
    document.querySelectorAll("[data-preset]").forEach((button) => button.addEventListener("click", () => this.state.applyPreset(button.dataset.preset)));

    this.elements.exportVideo.addEventListener("click", () => this.toggleVideoExport());
    this.elements.videoExportCancel.addEventListener("click", () => this.cancelVideoExport());
    this.exporter.addEventListener("error", (event) => this.showExportError(event.detail?.message || "Video export failed."));
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
      if (this.exporter.isExporting()) return;
      if (event.target.matches("input, select, textarea")) return;
      if (event.code === "Space") { event.preventDefault(); this.audioEngine.togglePlayback().catch((error) => this.toast(error.message, "error")); }
      if (event.key.toLowerCase() === "h") this.state.set("showHud", !this.state.get("showHud"));
      if (event.key.toLowerCase() === "f") this.toggleFullscreen();
      if (event.key.toLowerCase() === "g") this.state.set("showGrid", !this.state.get("showGrid"));
    });
  }

  async loadSelectedFile(file) {
    if (!file || this.exporter.isExporting()) return;
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

  getPlaybackWindow() {
    const trackDuration = this.audioEngine.getDuration();
    const loop = this.audioEngine.getLoopState();
    if (loop.enabled && loop.duration > 0.01) {
      return { start: loop.start, end: loop.end, duration: loop.duration, looped: true };
    }
    return { start: 0, end: trackDuration, duration: trackDuration, looped: false };
  }

  toggleVideoExport() {
    if (this.exporter.isExporting()) {
      this.cancelVideoExport();
      return;
    }
    this.exporter.start().catch((error) => {
      if (error?.name !== "AbortError") this.toast(error.message || "Video export failed.", "error");
    });
  }

  cancelVideoExport() {
    if (!this.exporter.isExporting()) return;
    this.elements.videoExportCancel.disabled = true;
    this.elements.videoExportCancel.textContent = "CANCELLING…";
    this.elements.videoExportOverlayDetail.textContent = "Cancelling export…";
    this.elements.exportVideo.disabled = true;
    this.elements.exportVideo.textContent = "CANCELLING…";
    this.exporter.stop(true);
  }

  setExportControlsDisabled(disabled) {
    for (const element of [
      this.elements.exportPng,
      this.elements.exportSettings,
      this.elements.importSettings,
      this.elements.resetSettings,
      this.elements.exportResolution,
      this.elements.exportFps,
      this.elements.exportFormat,
      this.elements.exportBitrate,
      this.elements.exportRange,
      this.elements.exportFileName,
    ]) {
      if (element) element.disabled = disabled;
    }
  }

  syncPlayback() {
    const audio = this.audioEngine.audio;
    const hasAudio = Boolean(this.audioEngine.file);
    const playbackWindow = this.getPlaybackWindow();
    const relativeTime = hasAudio
      ? clamp((Number(audio.currentTime) || 0) - playbackWindow.start, 0, Math.max(0, playbackWindow.duration))
      : 0;

    this.elements.playPause.disabled = !hasAudio || this.exporter.isExporting();
    this.elements.clearWaveform.disabled = !hasAudio || this.exporter.isExporting();
    this.elements.seek.disabled = !hasAudio || this.exporter.isExporting();
    this.elements.playPause.textContent = hasAudio && !audio.paused ? "Pause" : "Play";
    this.elements.audioStatus.textContent = hasAudio ? (!audio.paused ? "PLAYING" : "READY") : this.state.get("demoMode") ? "DEMO" : "IDLE";
    this.elements.currentTime.textContent = formatTime(relativeTime);
    this.elements.totalTime.textContent = formatTime(hasAudio ? playbackWindow.duration : 0);
    this.elements.seek.max = Math.max(0.001, playbackWindow.duration || 0.001);
    if (!this.elements.seek.matches(":active")) this.elements.seek.value = relativeTime;
    this.syncLoop();
  }

  syncLoop() {
    const loop = this.audioEngine.getLoopState();
    this.elements.loopButton.disabled = !loop.ready || this.exporter.isExporting();
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
    this.elements.recordingStatus.textContent = "EXPORTING";
    this.elements.exportVideo.textContent = "CANCEL EXPORT";
    this.elements.exportVideo.classList.add("is-recording");
    this.elements.exportVideo.disabled = false;
    this.elements.exportProgress.hidden = false;
    this.elements.exportProgressLabel.textContent = `${detail.format || "VIDEO"} // ${detail.width}×${detail.height} @ ${detail.fps} FPS`;
    const rangeLabel = detail.rangeSource === "loop"
      ? "ACTIVE LOOP"
      : detail.rangeSource === "current"
        ? "CURRENT TIME → END"
        : "FULL TRACK";
    this.elements.exportProgressMeta.textContent = `Rendering ${formatTime(detail.duration)} frame by frame · ${rangeLabel}.`;
    this.elements.exportProgressValue.textContent = "0%";
    this.elements.exportProgressBar.value = 0;

    this.setExportControlsDisabled(true);
    this.elements.viewportFrame.classList.add("is-exporting");
    this.elements.videoExportOverlay.hidden = false;
    this.elements.videoExportOverlayTitle.textContent = `EXPORTING ${detail.format || "VIDEO"}`;
    this.elements.videoExportOverlayDetail.textContent = `Preparing encoder · 0%`;
    this.elements.videoExportOverlayProgress.value = 0;
    this.elements.videoExportOverlayProgressText.textContent = "0%";
    this.elements.videoExportOverlayMeta.textContent = `${detail.width}×${detail.height} · ${detail.fps} FPS · ${rangeLabel}`;
    this.elements.videoExportCancel.disabled = false;
    this.elements.videoExportCancel.textContent = "CANCEL EXPORT";
    this.elements.videoExportOverlay.style.backgroundImage = detail.previewFrame ? `url(${JSON.stringify(detail.previewFrame)})` : "none";
    this.syncPlayback();
  }

  showExportProgress(detail) {
    const percent = detail.duration > 0 ? Math.round(clamp(detail.progress, 0, 1) * 100) : 0;
    const percentText = detail.duration > 0 ? `${percent}%` : formatTime(detail.elapsed);
    const message = detail.message || (detail.duration > 0
      ? `${formatTime(detail.elapsed)} encoded // ${formatTime(Math.max(0, detail.duration - detail.elapsed))} remaining`
      : `${formatTime(detail.elapsed)} captured`);

    this.elements.exportProgressValue.textContent = percentText;
    this.elements.exportProgressBar.value = percent;
    this.elements.exportProgressMeta.textContent = message;
    this.elements.videoExportOverlayProgress.value = percent;
    this.elements.videoExportOverlayProgressText.textContent = percentText;
    this.elements.videoExportOverlayDetail.textContent = `${message} · ${percentText}`;
  }

  showExportError(message) {
    this.elements.videoExportOverlayTitle.textContent = "EXPORT ERROR";
    this.elements.videoExportOverlayDetail.textContent = message;
    this.toast(message, "error");
  }

  showExportFinish(detail) {
    this.elements.recordingStatus.textContent = "READY";
    this.elements.exportVideo.textContent = "START VIDEO EXPORT";
    this.elements.exportVideo.classList.remove("is-recording");
    this.elements.exportVideo.disabled = false;
    this.elements.exportProgress.hidden = true;
    this.setExportControlsDisabled(false);
    this.elements.viewportFrame.classList.remove("is-exporting");
    this.elements.videoExportOverlay.hidden = true;
    this.elements.videoExportOverlay.style.backgroundImage = "none";
    this.elements.videoExportCancel.disabled = false;
    this.elements.videoExportCancel.textContent = "CANCEL EXPORT";
    this.syncPlayback();
    if (!detail.failed) {
      this.toast(detail.cancelled ? "Video export cancelled." : "Video export complete.", detail.cancelled ? "info" : "success");
    }
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
