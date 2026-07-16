import { dateStamp, downloadBlob, sanitizeFileName } from "./utils.js";

export class Exporter extends EventTarget {
  constructor(visualizer, hud, audioEngine, state) {
    super();
    this.visualizer = visualizer;
    this.hud = hud;
    this.audioEngine = audioEngine;
    this.state = state;
    this.active = false;
    this.recorder = null;
    this.chunks = [];
    this.exportRenderer = null;
    this.exportCamera = null;
    this.compositeCanvas = null;
    this.compositeContext = null;
    this.stream = null;
    this.startedAt = 0;
    this.rangeStart = 0;
    this.rangeEnd = 0;
    this.playbackSnapshot = null;
    this.mimeType = "";
    this.extension = "webm";
  }

  getResolution() {
    const selected = String(this.state.get("exportResolution"));
    const format = this.state.get("viewportFormat");
    const even = (value) => Math.max(2, Math.floor(value / 2) * 2);
    if (selected === "current") {
      return { width: even(this.visualizer.renderer.domElement.width), height: even(this.visualizer.renderer.domElement.height) };
    }
    const shortEdge = Number(selected === "1080" ? 1080 : selected === "1440" ? 1440 : 2160);
    const longEdge = Math.round(shortEdge * 16 / 9);
    if (format === "portrait") return { width: even(shortEdge), height: even(longEdge) };
    if (format === "square") return { width: even(shortEdge), height: even(shortEdge) };
    return { width: even(longEdge), height: even(shortEdge) };
  }

  getMimeType() {
    const requested = this.state.get("exportFormat");
    const candidates = requested === "mp4"
      ? ["video/mp4;codecs=h264,aac", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"]
      : requested === "webm"
        ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
        : ["video/mp4;codecs=h264,aac", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const supported = candidates.find((type) => window.MediaRecorder?.isTypeSupported?.(type));
    if (!supported) throw new Error("No supported MediaRecorder video format was found.");
    this.extension = supported.startsWith("video/mp4") ? "mp4" : "webm";
    return supported;
  }

  async start() {
    if (this.active) return this.stop(false);
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      throw new Error("Real-time video export is not supported by this browser.");
    }
    this.cancelled = false;
    const audio = this.audioEngine.audio;
    const hasAudio = Boolean(this.audioEngine.file);
    const duration = hasAudio && Number.isFinite(audio.duration) ? audio.duration : 0;
    this.rangeStart = hasAudio && this.state.get("exportRange") === "full" ? 0 : hasAudio ? audio.currentTime : 0;
    this.rangeEnd = hasAudio ? duration : Number.POSITIVE_INFINITY;
    if (hasAudio && this.rangeEnd - this.rangeStart < 0.05) throw new Error("Move the playhead earlier or choose Full Track before exporting.");
    this.playbackSnapshot = { currentTime: audio.currentTime, paused: audio.paused, loop: audio.loop };
    const { width, height } = this.getResolution();
    const fps = Number(this.state.get("exportFps")) || 60;
    const bitrate = Number(this.state.get("exportBitrate")) * 1_000_000;
    this.mimeType = this.getMimeType();

    const THREE = window.THREE;
    const renderCanvas = document.createElement("canvas");
    renderCanvas.width = width;
    renderCanvas.height = height;
    this.exportRenderer = new THREE.WebGLRenderer({ canvas: renderCanvas, antialias: true, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: true });
    this.exportRenderer.outputColorSpace = THREE.SRGBColorSpace;
    this.exportRenderer.setPixelRatio(1);
    this.exportRenderer.setSize(width, height, false);
    this.exportCamera = this.visualizer.camera.clone();
    this.visualizer.configureCameraForSize(this.exportCamera, width, height);
    this.compositeCanvas = document.createElement("canvas");
    this.compositeCanvas.width = width;
    this.compositeCanvas.height = height;
    this.compositeContext = this.compositeCanvas.getContext("2d", { alpha: false });
    this.stream = this.compositeCanvas.captureStream(fps);
    const audioStream = this.audioEngine.getRecordStream();
    if (hasAudio && audioStream) {
      for (const track of audioStream.getAudioTracks()) this.stream.addTrack(track.clone());
    }
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, { mimeType: this.mimeType, videoBitsPerSecond: bitrate, audioBitsPerSecond: 192000 });
    this.recorder.addEventListener("dataavailable", (event) => { if (event.data.size) this.chunks.push(event.data); });
    this.recorder.addEventListener("stop", () => this.finalize());
    this.recorder.start(1000);
    this.active = true;
    this.startedAt = performance.now();
    if (hasAudio) {
      audio.loop = false;
      audio.currentTime = this.rangeStart;
      await this.audioEngine.play();
    }
    const exportDuration = Number.isFinite(this.rangeEnd) ? this.rangeEnd - this.rangeStart : 0;
    this.dispatchEvent(new CustomEvent("start", { detail: { width, height, fps, duration: exportDuration } }));
  }

  renderFrame(metrics, meta) {
    if (!this.active || !this.exportRenderer) return;
    const width = this.compositeCanvas.width;
    const height = this.compositeCanvas.height;
    this.exportCamera.copy(this.visualizer.camera);
    this.visualizer.configureCameraForSize(this.exportCamera, width, height);
    this.visualizer.renderWithRenderer(this.exportRenderer, this.exportCamera);
    this.compositeContext.drawImage(this.exportRenderer.domElement, 0, 0, width, height);
    if (this.state.get("showHud")) this.hud.drawToContext(this.compositeContext, width, height, metrics, meta, false);
    const elapsed = (performance.now() - this.startedAt) / 1000;
    const duration = Number.isFinite(this.rangeEnd) ? this.rangeEnd - this.rangeStart : 0;
    const progress = duration > 0 ? Math.min(1, (this.audioEngine.audio.currentTime - this.rangeStart) / duration) : 0;
    this.dispatchEvent(new CustomEvent("progress", { detail: { progress, elapsed, duration, currentTime: this.audioEngine.audio.currentTime } }));
    if (Number.isFinite(this.rangeEnd) && this.audioEngine.audio.currentTime >= this.rangeEnd - 0.035) this.stop(false);
  }

  stop(cancelled = false) {
    if (!this.active) return;
    this.cancelled = cancelled;
    this.active = false;
    if (this.recorder?.state !== "inactive") this.recorder.stop();
  }

  async finalize() {
    const audio = this.audioEngine.audio;
    if (this.playbackSnapshot) {
      audio.pause();
      audio.loop = this.playbackSnapshot.loop;
      if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(this.playbackSnapshot.currentTime, audio.duration);
      if (!this.playbackSnapshot.paused) {
        try { await this.audioEngine.play(); } catch { /* Browser gesture rules may block automatic resume. */ }
      }
    }
    if (!this.cancelled && this.chunks.length) {
      const blob = new Blob(this.chunks, { type: this.mimeType });
      downloadBlob(blob, `${sanitizeFileName(this.state.get("exportFileName"))}-${dateStamp()}.${this.extension}`);
    }
    this.cleanup();
    this.dispatchEvent(new CustomEvent("finish", { detail: { cancelled: this.cancelled } }));
  }

  cleanup() {
    for (const track of this.stream?.getTracks?.() || []) track.stop();
    this.exportRenderer?.dispose();
    this.exportRenderer = null;
    this.exportCamera = null;
    this.compositeCanvas = null;
    this.compositeContext = null;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }

  exportPng(metrics, meta) {
    const { width, height } = this.getResolution();
    const THREE = window.THREE;
    const renderCanvas = document.createElement("canvas");
    const renderer = new THREE.WebGLRenderer({ canvas: renderCanvas, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    const camera = this.visualizer.camera.clone();
    this.visualizer.configureCameraForSize(camera, width, height);
    this.visualizer.renderWithRenderer(renderer, camera);
    const composite = document.createElement("canvas");
    composite.width = width;
    composite.height = height;
    const context = composite.getContext("2d", { alpha: false });
    context.drawImage(renderCanvas, 0, 0, width, height);
    if (this.state.get("showHud")) this.hud.drawToContext(context, width, height, metrics, meta, false);
    composite.toBlob((blob) => {
      if (blob) downloadBlob(blob, `${sanitizeFileName(this.state.get("exportFileName"))}-${dateStamp()}.png`);
      renderer.dispose();
    }, "image/png");
  }
}
