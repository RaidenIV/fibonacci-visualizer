import { dateStamp, downloadBlob, sanitizeFileName } from "./utils.js";

export class Exporter extends EventTarget {
  constructor(visualizer, hud, audioEngine, state) {
    super();
    this.visualizer = visualizer;
    this.hud = hud;
    this.audioEngine = audioEngine;
    this.state = state;
    this.active = false;
    this.finalizing = false;
    this.cancelled = false;
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
    this.extension = "mp4";
    this.exportMode = "mp4";
    this.mediabunnyModule = null;
    this.mkv = null;
    this.latestMetrics = null;
    this.latestMeta = null;
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

  getMp4MimeType() {
    const candidates = ["video/mp4;codecs=h264,aac", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"];
    const supported = candidates.find((type) => window.MediaRecorder?.isTypeSupported?.(type));
    if (!supported) throw new Error("MP4 recording is not supported by this browser. Select MKV instead.");
    return supported;
  }

  getRange() {
    const audio = this.audioEngine.audio;
    const hasAudio = Boolean(this.audioEngine.file);
    const duration = hasAudio && Number.isFinite(audio.duration) ? audio.duration : 0;
    const start = hasAudio && this.state.get("exportRange") === "full" ? 0 : hasAudio ? audio.currentTime : 0;
    const end = hasAudio ? duration : Number.POSITIVE_INFINITY;
    if (hasAudio && end - start < 0.05) throw new Error("Move the playhead earlier or choose Full Track before exporting.");
    return { start, end, duration: Number.isFinite(end) ? end - start : 0 };
  }

  prepareRenderTarget(width, height) {
    const THREE = window.THREE;
    const renderCanvas = document.createElement("canvas");
    renderCanvas.width = width;
    renderCanvas.height = height;
    this.exportRenderer = new THREE.WebGLRenderer({
      canvas: renderCanvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    this.exportRenderer.outputColorSpace = THREE.SRGBColorSpace;
    this.exportRenderer.setPixelRatio(1);
    this.exportRenderer.setSize(width, height, false);
    this.exportCamera = this.visualizer.camera.clone();
    this.visualizer.configureCameraForSize(this.exportCamera, width, height);
    this.compositeCanvas = document.createElement("canvas");
    this.compositeCanvas.width = width;
    this.compositeCanvas.height = height;
    this.compositeContext = this.compositeCanvas.getContext("2d", { alpha: false });
  }

  renderComposite(metrics = this.latestMetrics, meta = this.latestMeta) {
    if (!this.exportRenderer || !this.compositeCanvas || !metrics || !meta) return false;
    const width = this.compositeCanvas.width;
    const height = this.compositeCanvas.height;
    this.exportCamera.copy(this.visualizer.camera);
    this.visualizer.configureCameraForSize(this.exportCamera, width, height);
    this.visualizer.renderWithRenderer(this.exportRenderer, this.exportCamera);
    this.compositeContext.drawImage(this.exportRenderer.domElement, 0, 0, width, height);
    if (this.state.get("showHud")) this.hud.drawToContext(this.compositeContext, width, height, metrics, meta, false);
    return true;
  }

  async start() {
    if (this.finalizing) return;
    if (this.active) {
      this.stop(false);
      return;
    }
    this.cancelled = false;
    this.finalizing = false;
    this.exportMode = this.state.get("exportFormat") === "mkv" ? "mkv" : "mp4";
    const { start, end, duration } = this.getRange();
    this.rangeStart = start;
    this.rangeEnd = end;
    const audio = this.audioEngine.audio;
    this.playbackSnapshot = { currentTime: audio.currentTime, paused: audio.paused, loop: audio.loop };
    const { width, height } = this.getResolution();
    const fps = Number(this.state.get("exportFps")) || 60;
    this.prepareRenderTarget(width, height);

    try {
      if (this.exportMode === "mkv") await this.startMkv(width, height, fps, duration);
      else await this.startMp4(width, height, fps, duration);

      if (this.audioEngine.file) {
        audio.loop = false;
        audio.currentTime = this.rangeStart;
        await this.audioEngine.play();
      }
      if (this.exportMode === "mkv" && this.mkv) this.mkv.capturePromise = this.captureMkvFrames();
    } catch (error) {
      this.cancelled = true;
      this.active = false;
      if (this.mkv) {
        try {
          this.mkv.videoSource.close();
          this.mkv.audioSource?.close();
          await this.mkv.output.cancel();
        } catch { /* The encoder may not have fully initialized. */ }
        await this.restorePlayback();
        this.cleanup();
      } else if (this.recorder?.state && this.recorder.state !== "inactive") {
        this.recorder.stop();
      } else {
        await this.restorePlayback();
        this.cleanup();
      }
      throw error;
    }
  }

  async startMp4(width, height, fps, duration) {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      throw new Error("MP4 recording is not supported by this browser. Select MKV instead.");
    }
    const bitrate = Number(this.state.get("exportBitrate")) * 1_000_000;
    this.mimeType = this.getMp4MimeType();
    this.extension = "mp4";
    this.stream = this.compositeCanvas.captureStream(fps);
    const audioStream = this.audioEngine.getRecordStream();
    if (this.audioEngine.file && audioStream) {
      for (const track of audioStream.getAudioTracks()) this.stream.addTrack(track.clone());
    }
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: bitrate,
      audioBitsPerSecond: 192000,
    });
    this.recorder.addEventListener("dataavailable", (event) => { if (event.data.size) this.chunks.push(event.data); });
    this.recorder.addEventListener("stop", () => { void this.finalizeMp4(); });
    this.recorder.start(1000);
    this.active = true;
    this.startedAt = performance.now();
    this.dispatchEvent(new CustomEvent("start", { detail: { width, height, fps, duration, format: "MP4" } }));
  }

  async loadMediabunnyModule() {
    if (!this.mediabunnyModule) {
      this.mediabunnyModule = await import("https://cdn.jsdelivr.net/npm/mediabunny@1.49.0/+esm");
    }
    return this.mediabunnyModule;
  }

  async startMkv(width, height, fps, duration) {
    if (!window.VideoEncoder || !window.VideoFrame) {
      throw new Error("MKV export requires WebCodecs support in a current Chromium or Firefox browser.");
    }
    const {
      Output,
      MkvOutputFormat,
      BufferTarget,
      CanvasSource,
      AudioBufferSource,
      getFirstEncodableVideoCodec,
      getFirstEncodableAudioCodec,
    } = await this.loadMediabunnyModule();
    const bitrate = Number(this.state.get("exportBitrate")) * 1_000_000;
    const selectedVideoCodec = await getFirstEncodableVideoCodec(["avc", "vp9", "vp8", "av1"], { width, height, bitrate });
    if (!selectedVideoCodec) throw new Error("No supported MKV video codec was found for this resolution.");
    const selectedAudioCodec = this.audioEngine.decodedBuffer
      ? await getFirstEncodableAudioCodec(["opus", "aac"], { numberOfChannels: 2, sampleRate: 48000, bitrate: 192000 })
      : null;
    const target = new BufferTarget();
    const output = new Output({ format: new MkvOutputFormat(), target });
    const videoSource = new CanvasSource(this.compositeCanvas, {
      codec: selectedVideoCodec,
      bitrate,
      bitrateMode: "variable",
      latencyMode: "quality",
      keyFrameInterval: 2,
      hardwareAcceleration: "no-preference",
    });
    const audioSource = selectedAudioCodec
      ? new AudioBufferSource({ codec: selectedAudioCodec, bitrate: 192000, transform: { numberOfChannels: 2, sampleRate: 48000 } })
      : null;
    output.addVideoTrack(videoSource, { frameRate: fps });
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();

    this.mkv = {
      output,
      target,
      videoSource,
      audioSource,
      selectedVideoCodec,
      selectedAudioCodec,
      fps,
      frameIndex: 0,
      totalFrames: duration > 0 ? Math.max(1, Math.ceil(duration * fps)) : 0,
    };
    this.extension = "mkv";
    this.active = true;
    this.startedAt = performance.now();
    this.dispatchEvent(new CustomEvent("start", { detail: { width, height, fps, duration, format: "MKV" } }));
  }

  async captureMkvFrames() {
    try {
      while (this.active && this.mkv) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (!this.active || !this.mkv) break;
        const audio = this.audioEngine.audio;
        const elapsed = this.audioEngine.file
          ? Math.max(0, audio.currentTime - this.rangeStart)
          : (performance.now() - this.startedAt) / 1000;
        const targetFrame = Math.floor(elapsed * this.mkv.fps);
        if (this.mkv.frameIndex > targetFrame) continue;
        const catchUpCount = Math.min(4, targetFrame - this.mkv.frameIndex + 1);
        for (let index = 0; index < catchUpCount && this.active; index += 1) {
          if (!this.renderComposite()) continue;
          const frameIndex = this.mkv.frameIndex;
          await this.mkv.videoSource.add(frameIndex / this.mkv.fps, 1 / this.mkv.fps, {
            keyFrame: frameIndex % Math.max(1, this.mkv.fps * 2) === 0,
          });
          this.mkv.frameIndex += 1;
        }
        const exportDuration = Number.isFinite(this.rangeEnd) ? this.rangeEnd - this.rangeStart : 0;
        const progress = exportDuration > 0 ? Math.min(1, elapsed / exportDuration) : 0;
        this.dispatchEvent(new CustomEvent("progress", { detail: { progress, elapsed, duration: exportDuration, currentTime: audio.currentTime } }));
        if (Number.isFinite(this.rangeEnd) && audio.currentTime >= this.rangeEnd - 0.035) this.stop(false);
      }
    } catch (error) {
      this.dispatchEvent(new CustomEvent("error", { detail: { message: error.message || "MKV export failed." } }));
      this.stop(true);
    }
  }

  renderFrame(metrics, meta) {
    this.latestMetrics = metrics;
    this.latestMeta = meta;
    if (!this.active || this.exportMode !== "mp4" || !this.exportRenderer) return;
    this.renderComposite(metrics, meta);
    const elapsed = (performance.now() - this.startedAt) / 1000;
    const duration = Number.isFinite(this.rangeEnd) ? this.rangeEnd - this.rangeStart : 0;
    const progress = duration > 0 ? Math.min(1, (this.audioEngine.audio.currentTime - this.rangeStart) / duration) : 0;
    this.dispatchEvent(new CustomEvent("progress", { detail: { progress, elapsed, duration, currentTime: this.audioEngine.audio.currentTime } }));
    if (Number.isFinite(this.rangeEnd) && this.audioEngine.audio.currentTime >= this.rangeEnd - 0.035) this.stop(false);
  }

  stop(cancelled = false) {
    if ((!this.active && !this.finalizing) || this.finalizing) return;
    this.cancelled = cancelled;
    this.active = false;
    if (this.exportMode === "mkv") {
      void this.finalizeMkv();
      return;
    }
    if (this.recorder?.state !== "inactive") this.recorder.stop();
  }

  createAudioSegment(start, end) {
    const source = this.audioEngine.decodedBuffer;
    if (!source) return null;
    const sampleRate = source.sampleRate;
    const startFrame = Math.max(0, Math.min(source.length, Math.floor(start * sampleRate)));
    const endFrame = Math.max(startFrame + 1, Math.min(source.length, Math.ceil(end * sampleRate)));
    const frameCount = endFrame - startFrame;
    const segment = new AudioBuffer({ length: frameCount, numberOfChannels: Math.max(1, source.numberOfChannels), sampleRate });
    const gain = this.state.get("muted") ? 0 : Math.max(0, Math.min(1, Number(this.state.get("volume")) || 0));
    for (let channelIndex = 0; channelIndex < segment.numberOfChannels; channelIndex += 1) {
      const sourceChannel = source.getChannelData(Math.min(channelIndex, source.numberOfChannels - 1));
      const destination = segment.getChannelData(channelIndex);
      for (let index = 0; index < frameCount; index += 1) destination[index] = (sourceChannel[startFrame + index] || 0) * gain;
    }
    return segment;
  }

  async finalizeMkv() {
    if (this.finalizing || !this.mkv) return;
    this.finalizing = true;
    const mkv = this.mkv;
    try {
      await mkv.capturePromise;
      if (this.cancelled) {
        mkv.videoSource.close();
        mkv.audioSource?.close();
        await mkv.output.cancel();
      } else {
        mkv.videoSource.close();
        if (mkv.audioSource && this.audioEngine.decodedBuffer) {
          const capturedDuration = Math.max(1 / mkv.fps, mkv.frameIndex / mkv.fps);
          const audioEnd = Math.min(this.rangeEnd, this.rangeStart + capturedDuration);
          const segment = this.createAudioSegment(this.rangeStart, audioEnd);
          if (segment) await mkv.audioSource.add(segment);
          mkv.audioSource.close();
        }
        await mkv.output.finalize();
        if (!mkv.target.buffer) throw new Error("MKV finalization returned no data.");
        const blob = new Blob([mkv.target.buffer], { type: "video/x-matroska" });
        downloadBlob(blob, `${sanitizeFileName(this.state.get("exportFileName"))}-${dateStamp()}.mkv`);
      }
      await this.restorePlayback();
      this.cleanup();
      this.dispatchEvent(new CustomEvent("finish", { detail: { cancelled: this.cancelled } }));
    } catch (error) {
      await this.restorePlayback();
      this.cleanup();
      this.dispatchEvent(new CustomEvent("error", { detail: { message: error.message || "MKV export failed." } }));
      this.dispatchEvent(new CustomEvent("finish", { detail: { cancelled: true } }));
    } finally {
      this.finalizing = false;
    }
  }

  async finalizeMp4() {
    if (this.finalizing) return;
    this.finalizing = true;
    try {
      await this.restorePlayback();
      if (!this.cancelled && this.chunks.length) {
        const blob = new Blob(this.chunks, { type: this.mimeType });
        downloadBlob(blob, `${sanitizeFileName(this.state.get("exportFileName"))}-${dateStamp()}.mp4`);
      }
      this.cleanup();
      this.dispatchEvent(new CustomEvent("finish", { detail: { cancelled: this.cancelled } }));
    } finally {
      this.finalizing = false;
    }
  }

  async restorePlayback() {
    const audio = this.audioEngine.audio;
    if (!this.playbackSnapshot) return;
    audio.pause();
    audio.loop = this.playbackSnapshot.loop;
    if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(this.playbackSnapshot.currentTime, audio.duration);
    if (!this.playbackSnapshot.paused) {
      try { await this.audioEngine.play(); } catch { /* Browser gesture rules may block automatic resume. */ }
    }
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
    this.mkv = null;
    this.playbackSnapshot = null;
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
