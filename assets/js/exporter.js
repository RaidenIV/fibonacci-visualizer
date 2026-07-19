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
    this.visualizerSnapshot = null;
    this.offlineMkvBusy = false;
    this.mkvFileHandle = null;
    this.mkvFileName = "";
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
    this.offlineMkvBusy = false;
    this.mkvFileHandle = null;
    this.exportMode = this.state.get("exportFormat") === "mkv" ? "mkv" : "mp4";
    const { start, end, duration } = this.getRange();
    this.rangeStart = start;
    this.rangeEnd = end;
    const audio = this.audioEngine.audio;
    this.playbackSnapshot = {
      currentTime: audio.currentTime,
      paused: audio.paused,
      loop: audio.loop,
      metrics: this.audioEngine.metrics,
    };
    this.captureVisualizerSnapshot();

    const { width, height } = this.getResolution();
    const fps = Number(this.state.get("exportFps")) || 60;
    const bitrate = Number(this.state.get("exportBitrate")) * 1_000_000;
    this.mkvFileName = `${sanitizeFileName(this.state.get("exportFileName"))}-${dateStamp()}.mkv`;

    if (this.exportMode === "mkv" && duration > 0 && "showSaveFilePicker" in window) {
      const estimatedBytes = duration * (bitrate + 192_000) / 8;
      if (estimatedBytes >= 96 * 1024 * 1024) {
        try {
          this.mkvFileHandle = await window.showSaveFilePicker({
            suggestedName: this.mkvFileName,
            types: [{ description: "Matroska video", accept: { "video/x-matroska": [".mkv"] } }],
          });
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          console.warn("Direct-to-disk MKV output is unavailable; falling back to memory output.", error);
          this.mkvFileHandle = null;
        }
      }
    }

    this.prepareRenderTarget(width, height);

    try {
      if (this.exportMode === "mkv") {
        await this.startMkv(width, height, fps, duration);
        if (this.audioEngine.file && duration > 0) {
          audio.pause();
          audio.loop = false;
          this.offlineMkvBusy = true;
          this.audioEngine.resetOfflineAnalysis();
        }
        this.mkv.capturePromise = this.captureMkvFrames();
        return;
      }

      await this.startMp4(width, height, fps, duration);
      if (this.audioEngine.file) {
        audio.loop = false;
        audio.currentTime = this.rangeStart;
        await this.audioEngine.play();
      }
    } catch (error) {
      this.cancelled = true;
      this.active = false;
      if (this.mkv) {
        try {
          this.mkv.videoSource.close();
          this.mkv.audioSource?.close();
          if (["pending", "started"].includes(this.mkv.output.state)) await this.mkv.output.cancel();
        } catch { /* The encoder may not have fully initialized. */ }
      } else if (this.recorder?.state && this.recorder.state !== "inactive") {
        this.recorder.stop();
      }
      await this.restorePlayback();
      this.cleanup();
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

  isOfflineMkvExporting() {
    return this.offlineMkvBusy;
  }

  nextEventLoopTurn() {
    return new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  withTimeout(promise, timeoutMs, message) {
    let timeoutId = 0;
    const timeout = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
  }

  captureVisualizerSnapshot() {
    const visualizer = this.visualizer;
    this.visualizerSnapshot = {
      rotation: visualizer.rotation,
      currentPointCount: visualizer.currentPointCount,
      audioMultiplier: visualizer.audioMultiplier,
      bandLevels: { ...visualizer.bandLevels },
      uniformTime: visualizer.uniforms.uTime.value,
      uniformRotation: visualizer.uniforms.uRotation.value,
      uniformCount: visualizer.uniforms.uCount.value,
      uniformAudioMultiplier: visualizer.uniforms.uAudioMultiplier.value,
      uniformBass: visualizer.uniforms.uBass.value,
      uniformMid: visualizer.uniforms.uMid.value,
      uniformTreble: visualizer.uniforms.uTreble.value,
    };
  }

  restoreVisualizerSnapshot() {
    const snapshot = this.visualizerSnapshot;
    if (!snapshot) return;
    const visualizer = this.visualizer;
    visualizer.rotation = snapshot.rotation;
    visualizer.currentPointCount = snapshot.currentPointCount;
    visualizer.audioMultiplier = snapshot.audioMultiplier;
    visualizer.bandLevels = { ...snapshot.bandLevels };
    visualizer.uniforms.uTime.value = snapshot.uniformTime;
    visualizer.uniforms.uRotation.value = snapshot.uniformRotation;
    visualizer.uniforms.uCount.value = snapshot.uniformCount;
    visualizer.uniforms.uAudioMultiplier.value = snapshot.uniformAudioMultiplier;
    visualizer.uniforms.uBass.value = snapshot.uniformBass;
    visualizer.uniforms.uMid.value = snapshot.uniformMid;
    visualizer.uniforms.uTreble.value = snapshot.uniformTreble;
    visualizer.field.geometry.setDrawRange(0, Math.max(1, snapshot.currentPointCount - 1));
    this.visualizerSnapshot = null;
  }

  createExportMeta(metrics, currentTime, fps) {
    const stats = this.visualizer.getStats();
    return {
      ...(this.latestMeta || {}),
      fps,
      points: stats.points,
      drawCalls: stats.drawCalls,
      pixelRatio: stats.pixelRatio,
      mode: "EXPORT",
      fileName: this.audioEngine.file?.name || "NO AUDIO FILE",
      fftSize: this.audioEngine.analyser?.fftSize || 2048,
      currentTime,
      duration: this.audioEngine.getDuration(),
      metrics,
    };
  }

  async startMkv(width, height, fps, duration) {
    if (!window.VideoEncoder || !window.VideoFrame) {
      throw new Error("MKV export requires WebCodecs support in a current Chromium or Firefox browser.");
    }
    const {
      Output,
      MkvOutputFormat,
      BufferTarget,
      StreamTarget,
      CanvasSource,
      AudioBufferSource,
      getFirstEncodableVideoCodec,
      getFirstEncodableAudioCodec,
    } = await this.loadMediabunnyModule();

    const bitrate = Number(this.state.get("exportBitrate")) * 1_000_000;
    const highLoadExport = width * height >= 3840 * 2160 && fps >= 50;
    const codecPreferences = highLoadExport
      ? ["vp9", "avc", "av1", "vp8"]
      : ["avc", "vp9", "vp8", "av1"];
    const selectedVideoCodec = await getFirstEncodableVideoCodec(codecPreferences, { width, height, bitrate });
    if (!selectedVideoCodec) throw new Error("No supported MKV video codec was found for this resolution and frame rate.");

    const selectedAudioCodec = this.audioEngine.decodedBuffer
      ? await getFirstEncodableAudioCodec(["opus", "aac"], { numberOfChannels: 2, sampleRate: 48000, bitrate: 192000 })
      : null;

    let target;
    let streamedToDisk = false;
    if (this.mkvFileHandle) {
      const writable = await this.mkvFileHandle.createWritable();
      target = new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 });
      streamedToDisk = true;
    } else {
      target = new BufferTarget();
    }

    const output = new Output({ format: new MkvOutputFormat(), target });
    const videoSource = new CanvasSource(this.compositeCanvas, {
      codec: selectedVideoCodec,
      bitrate,
      bitrateMode: "variable",
      latencyMode: "quality",
      keyFrameInterval: 2,
      hardwareAcceleration: "no-preference",
      contentHint: "detail",
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
      streamedToDisk,
      audioEncodingPromise: Promise.resolve(),
      audioEncodingError: null,
      audioEncodedUntil: 0,
      audioClosed: !audioSource,
      videoClosed: false,
    };
    this.extension = "mkv";
    this.active = true;
    this.startedAt = performance.now();
    this.dispatchEvent(new CustomEvent("start", {
      detail: { width, height, fps, duration, format: "MKV", realtime: !(duration > 0), codec: selectedVideoCodec },
    }));
  }

  async captureMkvFrames() {
    if (!this.mkv) return;
    if (this.mkv.totalFrames > 0 && this.audioEngine.decodedBuffer) {
      return this.captureOfflineMkvFrames();
    }
    return this.captureRealtimeMkvFrames();
  }

  async addMkvFrame(frameIndex, totalFrames, timestamp, duration) {
    const mkv = this.mkv;
    if (!mkv) return;
    const progress = totalFrames > 0 ? Math.min(0.9, ((frameIndex + 1) / totalFrames) * 0.9) : 0;
    let heartbeatCount = 0;
    const heartbeat = window.setInterval(() => {
      heartbeatCount += 1;
      this.dispatchEvent(new CustomEvent("progress", {
        detail: {
          progress,
          elapsed: frameIndex / mkv.fps,
          duration: totalFrames > 0 ? totalFrames / mkv.fps : 0,
          currentTime: this.rangeStart + frameIndex / mkv.fps,
          message: `Encoder working on frame ${frameIndex + 1}${totalFrames > 0 ? ` of ${totalFrames}` : ""}${heartbeatCount > 1 ? ` · ${heartbeatCount * 3}s` : ""}`,
        },
      }));
    }, 3000);

    try {
      await this.withTimeout(
        mkv.videoSource.add(timestamp, duration, {
          keyFrame: frameIndex % Math.max(1, mkv.fps * 2) === 0,
        }),
        90_000,
        `The ${mkv.selectedVideoCodec.toUpperCase()} encoder stopped responding while processing frame ${frameIndex + 1}. Retry with a lower frame rate or resolution.`,
      );
    } finally {
      window.clearInterval(heartbeat);
    }
  }

  async queueMkvAudioThrough(capturedDuration) {
    const mkv = this.mkv;
    if (!mkv?.audioSource || mkv.audioClosed || !this.audioEngine.decodedBuffer) return;
    const maximumDuration = Number.isFinite(this.rangeEnd)
      ? Math.max(0, this.rangeEnd - this.rangeStart)
      : Math.max(0, capturedDuration);
    const targetDuration = Math.min(maximumDuration, Math.max(0, capturedDuration));
    const chunkDuration = 5;

    while (mkv.audioEncodedUntil + 1e-4 < targetDuration) {
      const segmentStart = mkv.audioEncodedUntil;
      const segmentEnd = Math.min(targetDuration, segmentStart + chunkDuration);
      const segment = this.createAudioSegment(this.rangeStart + segmentStart, this.rangeStart + segmentEnd);
      mkv.audioEncodedUntil = segmentEnd;
      if (!segment) continue;
      mkv.audioEncodingPromise = mkv.audioEncodingPromise
        .then(() => mkv.audioSource.add(segment))
        .catch((error) => {
          mkv.audioEncodingError = error;
        });
      await this.withTimeout(
        mkv.audioEncodingPromise,
        120_000,
        `MKV audio encoding stopped responding near ${segmentEnd.toFixed(1)} seconds.`,
      );
      if (mkv.audioEncodingError) throw mkv.audioEncodingError;
    }
  }

  async captureOfflineMkvFrames() {
    const mkv = this.mkv;
    if (!mkv) return;
    const frameDuration = 1 / mkv.fps;
    const totalFrames = mkv.totalFrames;

    try {
      for (let frameIndex = 0; frameIndex < totalFrames && this.active && this.mkv === mkv; frameIndex += 1) {
        const elapsed = frameIndex * frameDuration;
        const audioTime = Math.min(this.rangeEnd, this.rangeStart + elapsed);
        const metrics = this.audioEngine.sampleMetricsAt(audioTime, frameDuration);
        this.visualizer.update(frameDuration, elapsed, metrics);
        const meta = this.createExportMeta(metrics, audioTime, mkv.fps);
        this.latestMetrics = metrics;
        this.latestMeta = meta;
        if (!this.renderComposite(metrics, meta)) throw new Error("The export frame could not be rendered.");

        await this.nextEventLoopTurn();
        if (!this.active || this.cancelled) break;
        await this.addMkvFrame(frameIndex, totalFrames, frameIndex / mkv.fps, frameDuration);
        mkv.frameIndex = frameIndex + 1;

        const encodedDuration = mkv.frameIndex / mkv.fps;
        const audioChunkInterval = Math.max(1, Math.round(mkv.fps * 5));
        if (mkv.audioSource && (mkv.frameIndex % audioChunkInterval === 0 || mkv.frameIndex >= totalFrames)) {
          await this.queueMkvAudioThrough(encodedDuration);
        }
        const progress = Math.min(0.9, (mkv.frameIndex / totalFrames) * 0.9);
        this.dispatchEvent(new CustomEvent("progress", {
          detail: {
            progress,
            elapsed: encodedDuration,
            duration: totalFrames / mkv.fps,
            currentTime: audioTime,
            message: `Encoded frame ${mkv.frameIndex} of ${totalFrames} · ${mkv.selectedVideoCodec.toUpperCase()}`,
          },
        }));
        await this.nextEventLoopTurn();
      }

      if (!this.cancelled && mkv.frameIndex >= totalFrames) {
        this.active = false;
        window.setTimeout(() => { void this.finalizeMkv(); }, 0);
      }
    } catch (error) {
      this.cancelled = true;
      this.active = false;
      this.dispatchEvent(new CustomEvent("error", { detail: { message: error.message || "MKV export failed." } }));
      window.setTimeout(() => { void this.finalizeMkv(); }, 0);
    }
  }

  async captureRealtimeMkvFrames() {
    try {
      while (this.active && this.mkv) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (!this.active || !this.mkv) break;
        const elapsed = (performance.now() - this.startedAt) / 1000;
        const targetFrame = Math.floor(elapsed * this.mkv.fps);
        if (this.mkv.frameIndex > targetFrame) continue;
        if (!this.renderComposite()) continue;
        const frameIndex = this.mkv.frameIndex;
        await this.addMkvFrame(frameIndex, 0, frameIndex / this.mkv.fps, 1 / this.mkv.fps);
        this.mkv.frameIndex += 1;
        this.dispatchEvent(new CustomEvent("progress", { detail: { progress: 0, elapsed, duration: 0, currentTime: elapsed } }));
      }
    } catch (error) {
      this.cancelled = true;
      this.active = false;
      this.dispatchEvent(new CustomEvent("error", { detail: { message: error.message || "MKV export failed." } }));
      window.setTimeout(() => { void this.finalizeMkv(); }, 0);
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
        try { if (!mkv.videoClosed) mkv.videoSource.close(); } catch { /* Encoder already stopped. */ }
        try { mkv.audioSource?.close(); } catch { /* Audio source already stopped. */ }
        if (["pending", "started"].includes(mkv.output.state)) {
          await this.withTimeout(mkv.output.cancel(), 30_000, "MKV cancellation timed out.");
        }
      } else {
        if (!mkv.videoClosed) {
          mkv.videoSource.close();
          mkv.videoClosed = true;
        }
        this.dispatchEvent(new CustomEvent("progress", {
          detail: { progress: 0.92, elapsed: mkv.frameIndex / mkv.fps, duration: mkv.totalFrames / mkv.fps, message: "Encoding synchronized audio…" },
        }));
        await this.queueMkvAudioThrough(mkv.frameIndex / mkv.fps);
        await this.withTimeout(mkv.audioEncodingPromise, 180_000, "MKV audio encoding timed out.");
        if (mkv.audioEncodingError) throw mkv.audioEncodingError;
        if (mkv.audioSource && !mkv.audioClosed) {
          mkv.audioSource.close();
          mkv.audioClosed = true;
        }

        this.dispatchEvent(new CustomEvent("progress", {
          detail: { progress: 0.98, elapsed: mkv.frameIndex / mkv.fps, duration: mkv.totalFrames / mkv.fps, message: "Finalizing MKV container…" },
        }));
        await this.withTimeout(mkv.output.finalize(), 180_000, "MKV finalization timed out.");

        if (!mkv.streamedToDisk) {
          if (!mkv.target.buffer) throw new Error("MKV finalization returned no data.");
          const blob = new Blob([mkv.target.buffer], { type: "video/x-matroska" });
          downloadBlob(blob, this.mkvFileName || `${sanitizeFileName(this.state.get("exportFileName"))}-${dateStamp()}.mkv`);
        }
        this.dispatchEvent(new CustomEvent("progress", {
          detail: { progress: 1, elapsed: mkv.frameIndex / mkv.fps, duration: mkv.totalFrames / mkv.fps, message: mkv.streamedToDisk ? "MKV saved directly to disk." : "MKV export complete." },
        }));
      }

      await this.restorePlayback();
      this.cleanup();
      this.dispatchEvent(new CustomEvent("finish", { detail: { cancelled: this.cancelled } }));
    } catch (error) {
      try {
        if (["pending", "started"].includes(mkv.output.state)) await mkv.output.cancel();
      } catch { /* Preserve the original export error. */ }
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
    this.restoreVisualizerSnapshot();
    if (!this.playbackSnapshot) return;
    this.audioEngine.resetOfflineAnalysis();
    this.audioEngine.metrics = this.playbackSnapshot.metrics || this.audioEngine.createEmptyMetrics();
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
    this.visualizerSnapshot = null;
    this.offlineMkvBusy = false;
    this.mkvFileHandle = null;
    this.mkvFileName = "";
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
