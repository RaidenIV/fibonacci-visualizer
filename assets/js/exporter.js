import { dateStamp, downloadBlob, sanitizeFileName } from "./utils.js";

const AUDIO_BITRATE = 192_000;
const VIDEO_PROGRESS_LIMIT = 0.9;

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
    this.failureError = null;
    this.exportRenderer = null;
    this.exportCamera = null;
    this.compositeCanvas = null;
    this.compositeContext = null;
    this.startedAt = 0;
    this.rangeStart = 0;
    this.rangeEnd = 0;
    this.rangeSource = "track";
    this.playbackSnapshot = null;
    this.visualizerSnapshot = null;
    this.latestMetrics = null;
    this.latestMeta = null;
    this.exportMode = "mp4";
    this.mediabunnyModule = null;
    this.mp4MuxerModule = null;
    this.mkv = null;
    this.mp4 = null;
    this.capturePromise = null;
    this.mkvFileHandle = null;
    this.mkvFileName = "";
    this.previewFrame = "";
  }

  isExporting() {
    return this.active || this.finalizing;
  }

  getResolution() {
    const selected = String(this.state.get("exportResolution"));
    const format = this.state.get("viewportFormat");
    const even = (value) => Math.max(2, Math.floor(value / 2) * 2);
    if (selected === "current") {
      return {
        width: even(this.visualizer.renderer.domElement.width),
        height: even(this.visualizer.renderer.domElement.height),
      };
    }
    const shortEdge = Number(selected === "1080" ? 1080 : selected === "1440" ? 1440 : 2160);
    const longEdge = Math.round(shortEdge * 16 / 9);
    if (format === "portrait") return { width: even(shortEdge), height: even(longEdge) };
    if (format === "square") return { width: even(shortEdge), height: even(shortEdge) };
    return { width: even(longEdge), height: even(shortEdge) };
  }

  getRange() {
    const hasAudio = Boolean(this.audioEngine.file && this.audioEngine.decodedBuffer);
    const trackDuration = hasAudio ? this.audioEngine.getDuration() : 0;
    if (!hasAudio || trackDuration <= 0) {
      throw new Error("Load and finish analyzing an audio file before exporting video.");
    }

    const loop = this.audioEngine.getLoopState();
    if (loop.enabled && loop.duration > 0.01) {
      return {
        start: loop.start,
        end: loop.end,
        duration: loop.duration,
        source: loop.partial ? "loop" : "track-loop",
      };
    }

    const audio = this.audioEngine.audio;
    const start = this.state.get("exportRange") === "full"
      ? 0
      : Math.max(0, Math.min(trackDuration, Number(audio.currentTime) || 0));
    const end = trackDuration;
    if (end - start < 0.05) {
      throw new Error("Move the playhead earlier or choose Full Track before exporting.");
    }
    return { start, end, duration: end - start, source: start > 0 ? "current" : "track" };
  }

  capturePreviewFrame() {
    try {
      const webglCanvas = this.visualizer.renderer.domElement;
      const hudCanvas = this.hud.canvas;
      const width = Math.max(2, webglCanvas.width || 2);
      const height = Math.max(2, webglCanvas.height || 2);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#000";
      context.fillRect(0, 0, width, height);
      context.drawImage(webglCanvas, 0, 0, width, height);
      if (this.state.get("showHud") && hudCanvas?.width && hudCanvas?.height) {
        context.drawImage(hudCanvas, 0, 0, width, height);
      }
      return canvas.toDataURL("image/jpeg", 0.88);
    } catch (error) {
      console.warn("Could not capture the frozen export preview.", error);
      return "";
    }
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
    if (this.state.get("showHud")) {
      this.hud.drawToContext(this.compositeContext, width, height, metrics, meta, false);
    }
    return true;
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

  async start() {
    if (this.finalizing) return;
    if (this.active) {
      this.stop(true);
      return;
    }

    this.cancelled = false;
    this.failureError = null;
    this.finalizing = false;
    this.mkvFileHandle = null;
    this.exportMode = this.state.get("exportFormat") === "mkv" ? "mkv" : "mp4";

    const range = this.getRange();
    this.rangeStart = range.start;
    this.rangeEnd = range.end;
    this.rangeSource = range.source;
    this.previewFrame = this.capturePreviewFrame();

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
    const bitrate = Math.max(1, Number(this.state.get("exportBitrate")) || 16) * 1_000_000;
    this.mkvFileName = `${sanitizeFileName(this.state.get("exportFileName"))}-${dateStamp()}.mkv`;

    // Freeze the live viewport and expose the export modal before loading
    // encoders or opening the optional save picker. This mirrors Binary
    // Tower: the normal animation loop never runs in parallel with export.
    this.active = true;
    this.startedAt = performance.now();
    audio.pause();
    audio.loop = false;
    this.audioEngine.resetOfflineAnalysis();
    this.dispatchEvent(new CustomEvent("start", {
      detail: {
        width,
        height,
        fps,
        duration: range.duration,
        format: this.exportMode.toUpperCase(),
        realtime: false,
        rangeSource: this.rangeSource,
        previewFrame: this.previewFrame,
      },
    }));

    try {
      if (this.exportMode === "mkv" && "showSaveFilePicker" in window) {
        const estimatedBytes = range.duration * (bitrate + AUDIO_BITRATE) / 8;
        if (estimatedBytes >= 96 * 1024 * 1024) {
          try {
            this.mkvFileHandle = await window.showSaveFilePicker({
              suggestedName: this.mkvFileName,
              types: [{ description: "Matroska video", accept: { "video/x-matroska": [".mkv"] } }],
            });
          } catch (error) {
            if (error?.name === "AbortError") throw error;
            console.warn("Direct-to-disk MKV output is unavailable; using memory output.", error);
            this.mkvFileHandle = null;
          }
        }
      }

      if (this.cancelled || !this.active) {
        throw new DOMException("Video export cancelled.", "AbortError");
      }

      this.prepareRenderTarget(width, height);
      if (this.exportMode === "mkv") await this.startMkv(width, height, fps, range.duration, bitrate);
      else await this.startMp4(width, height, fps, range.duration, bitrate);

      if (this.cancelled || !this.active) {
        throw new DOMException("Video export cancelled.", "AbortError");
      }

      this.capturePromise = this.exportMode === "mkv"
        ? this.captureOfflineMkvFrames()
        : this.captureOfflineMp4Frames();
    } catch (error) {
      const wasCancelled = this.cancelled || error?.name === "AbortError";
      this.failureError = wasCancelled ? null : error;
      this.cancelled = true;
      this.active = false;

      try {
        if (this.mkv && ["pending", "started"].includes(this.mkv.output.state)) {
          await this.mkv.output.cancel();
        }
      } catch {
        // Preserve the setup error; cancellation is best effort.
      }

      await this.completeExport(true, this.failureError);
    }
  }

  async loadMediabunnyModule() {
    if (!this.mediabunnyModule) {
      this.mediabunnyModule = await import("https://cdn.jsdelivr.net/npm/mediabunny@1.49.0/+esm");
    }
    return this.mediabunnyModule;
  }

  async loadMp4MuxerModule() {
    if (!this.mp4MuxerModule) {
      this.mp4MuxerModule = await import("https://cdn.jsdelivr.net/npm/mp4-muxer@5/+esm");
    }
    return this.mp4MuxerModule;
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

  async chooseSupportedAvcConfig(width, height, bitrate, fps) {
    if (!window.VideoEncoder || !window.VideoFrame) {
      throw new Error("MP4 export requires WebCodecs support in a current Chromium browser.");
    }
    const codecs = ["avc1.640033", "avc1.64002A", "avc1.4D402A", "avc1.42001F"];
    const profiles = [
      { latencyMode: "quality", bitrateMode: "variable", hardwareAcceleration: "no-preference" },
      { latencyMode: "quality", hardwareAcceleration: "no-preference" },
      { bitrateMode: "variable", hardwareAcceleration: "no-preference" },
    ];
    for (const codec of codecs) {
      for (const profile of profiles) {
        const config = {
          codec,
          width,
          height,
          bitrate,
          framerate: fps,
          ...profile,
          avc: { format: "avc" },
        };
        try {
          const support = await VideoEncoder.isConfigSupported(config);
          if (support.supported) return support.config || config;
        } catch (error) {
          console.warn(`Unsupported AVC configuration ${codec}.`, error);
        }
      }
    }
    throw new Error("The selected MP4 resolution, bitrate, or frame rate is not supported by this browser.");
  }

  async startMp4(width, height, fps, duration, bitrate) {
    const { Muxer, ArrayBufferTarget } = await this.loadMp4MuxerModule();
    const videoConfig = await this.chooseSupportedAvcConfig(width, height, bitrate, fps);
    const sourceBuffer = this.audioEngine.decodedBuffer;
    let audioConfig = null;
    if (window.AudioEncoder && window.AudioData && sourceBuffer) {
      const requested = {
        codec: "mp4a.40.2",
        sampleRate: sourceBuffer.sampleRate,
        numberOfChannels: 2,
        bitrate: AUDIO_BITRATE,
      };
      try {
        const support = await AudioEncoder.isConfigSupported(requested);
        if (support.supported) audioConfig = support.config || requested;
      } catch (error) {
        console.warn("AAC encoder support check failed; exporting MP4 without audio.", error);
      }
    }

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: "avc", width, height },
      ...(audioConfig ? {
        audio: {
          codec: "aac",
          sampleRate: audioConfig.sampleRate,
          numberOfChannels: audioConfig.numberOfChannels,
        },
      } : {}),
      fastStart: "in-memory",
      firstTimestampBehavior: "offset",
    });

    let encoderError = null;
    let encodedVideoFrameCount = 0;
    const videoEncoder = new VideoEncoder({
      output: (chunk, metadata) => {
        encodedVideoFrameCount += 1;
        muxer.addVideoChunk(chunk, metadata);
      },
      error: (error) => { encoderError = error; },
    });
    videoEncoder.configure(videoConfig);

    this.mp4 = {
      muxer,
      target,
      videoEncoder,
      videoConfig,
      audioConfig,
      encoderError: () => encoderError,
      encodedVideoFrameCount: () => encodedVideoFrameCount,
      fps,
      totalFrames: Math.max(1, Math.ceil(duration * fps)),
      frameIndex: 0,
    };
  }

  async startMkv(width, height, fps, duration, bitrate) {
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

    const highLoadExport = width * height >= 3840 * 2160 && fps >= 50;
    const codecPreferences = highLoadExport
      ? ["vp9", "avc", "av1", "vp8"]
      : ["avc", "vp9", "vp8", "av1"];
    const selectedVideoCodec = await getFirstEncodableVideoCodec(codecPreferences, { width, height, bitrate });
    if (!selectedVideoCodec) throw new Error("No supported MKV video codec was found for this export configuration.");

    const selectedAudioCodec = this.audioEngine.decodedBuffer
      ? await getFirstEncodableAudioCodec(["opus", "aac"], { numberOfChannels: 2, sampleRate: 48_000, bitrate: AUDIO_BITRATE })
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
      ? new AudioBufferSource({
        codec: selectedAudioCodec,
        bitrate: AUDIO_BITRATE,
        transform: { numberOfChannels: 2, sampleRate: 48_000 },
      })
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
      totalFrames: Math.max(1, Math.ceil(duration * fps)),
      streamedToDisk,
      audioEncodingPromise: Promise.resolve(),
      audioEncodingError: null,
      audioEncodedUntil: 0,
      audioClosed: !audioSource,
      videoClosed: false,
    };
  }

  getFrameData(frameIndex, fps) {
    const frameDuration = 1 / fps;
    const elapsed = frameIndex * frameDuration;
    const audioTime = Math.min(this.rangeEnd, this.rangeStart + elapsed);
    const metrics = this.audioEngine.sampleMetricsAt(audioTime, frameDuration);
    this.visualizer.update(frameDuration, elapsed, metrics);
    const meta = this.createExportMeta(metrics, audioTime, fps);
    this.latestMetrics = metrics;
    this.latestMeta = meta;
    if (!this.renderComposite(metrics, meta)) throw new Error("The export frame could not be rendered.");
    return { frameDuration, elapsed, audioTime, metrics, meta };
  }

  dispatchFrameProgress(frameIndex, totalFrames, fps, message) {
    const encodedFrames = frameIndex + 1;
    const progress = Math.min(VIDEO_PROGRESS_LIMIT, (encodedFrames / totalFrames) * VIDEO_PROGRESS_LIMIT);
    this.dispatchEvent(new CustomEvent("progress", {
      detail: {
        progress,
        elapsed: encodedFrames / fps,
        duration: totalFrames / fps,
        currentTime: Math.min(this.rangeEnd, this.rangeStart + encodedFrames / fps),
        message,
      },
    }));
  }

  async waitForVideoEncoderQueue(encoder, maximumQueueSize = 1) {
    const startedAt = performance.now();
    while (encoder.encodeQueueSize > maximumQueueSize) {
      if (!this.active || this.cancelled) return;
      if (performance.now() - startedAt > 90_000) {
        throw new Error("The video encoder stopped responding. Retry with a lower resolution or frame rate.");
      }
      await this.nextEventLoopTurn();
    }
  }

  async captureOfflineMp4Frames() {
    const mp4 = this.mp4;
    if (!mp4) return;
    try {
      for (let frameIndex = 0; frameIndex < mp4.totalFrames && this.active && !this.cancelled; frameIndex += 1) {
        const { frameDuration } = this.getFrameData(frameIndex, mp4.fps);
        await this.nextEventLoopTurn();
        if (!this.active || this.cancelled) break;
        const encoderError = mp4.encoderError();
        if (encoderError) throw encoderError;

        const timestamp = Math.round((frameIndex * 1_000_000) / mp4.fps);
        const nextTimestamp = Math.round(((frameIndex + 1) * 1_000_000) / mp4.fps);
        const frame = new VideoFrame(this.compositeCanvas, {
          timestamp,
          duration: Math.max(1, nextTimestamp - timestamp),
        });
        mp4.videoEncoder.encode(frame, {
          keyFrame: frameIndex % Math.max(1, mp4.fps * 2) === 0,
        });
        frame.close();
        await this.waitForVideoEncoderQueue(mp4.videoEncoder, 1);
        mp4.frameIndex = frameIndex + 1;
        this.dispatchFrameProgress(
          frameIndex,
          mp4.totalFrames,
          mp4.fps,
          `Encoded frame ${mp4.frameIndex} of ${mp4.totalFrames} · H.264`,
        );
        await this.nextEventLoopTurn();
      }

      if (this.cancelled || !this.active) {
        await this.finalizeMp4();
        return;
      }

      this.active = false;
      this.finalizing = true;
      this.dispatchEvent(new CustomEvent("progress", {
        detail: { progress: 0.91, elapsed: mp4.frameIndex / mp4.fps, duration: mp4.totalFrames / mp4.fps, message: "Flushing H.264 encoder…" },
      }));
      await this.withTimeout(mp4.videoEncoder.flush(), 180_000, "MP4 video encoder flush timed out.");
      if (this.cancelled) {
        this.finalizing = false;
        await this.finalizeMp4();
        return;
      }
      const encoderError = mp4.encoderError();
      if (encoderError) throw encoderError;
      if (mp4.encodedVideoFrameCount() !== mp4.totalFrames) {
        throw new Error(`The video encoder returned ${mp4.encodedVideoFrameCount()} of ${mp4.totalFrames} frames.`);
      }

      if (mp4.audioConfig) {
        this.dispatchEvent(new CustomEvent("progress", {
          detail: { progress: 0.93, elapsed: mp4.frameIndex / mp4.fps, duration: mp4.totalFrames / mp4.fps, message: "Encoding synchronized audio…" },
        }));
        await this.encodeMp4Audio(mp4);
      }
      if (this.cancelled) {
        this.finalizing = false;
        await this.finalizeMp4();
        return;
      }

      this.dispatchEvent(new CustomEvent("progress", {
        detail: { progress: 0.98, elapsed: mp4.frameIndex / mp4.fps, duration: mp4.totalFrames / mp4.fps, message: "Finalizing MP4 container…" },
      }));
      mp4.muxer.finalize();
      const blob = new Blob([mp4.target.buffer], { type: "video/mp4" });
      downloadBlob(blob, `${sanitizeFileName(this.state.get("exportFileName"))}-${dateStamp()}.mp4`);
      this.dispatchEvent(new CustomEvent("progress", {
        detail: { progress: 1, elapsed: mp4.frameIndex / mp4.fps, duration: mp4.totalFrames / mp4.fps, message: "MP4 export complete." },
      }));
      await this.completeExport(false);
    } catch (error) {
      if (!this.cancelled) this.failureError = error;
      this.cancelled = true;
      this.active = false;
      this.finalizing = false;
      await this.finalizeMp4();
    }
  }

  async encodeMp4Audio(mp4) {
    const source = this.audioEngine.decodedBuffer;
    if (!source || !mp4.audioConfig) return;
    let encodingError = null;
    const encoder = new AudioEncoder({
      output: (chunk, metadata) => mp4.muxer.addAudioChunk(chunk, metadata),
      error: (error) => { encodingError = error; },
    });
    encoder.configure(mp4.audioConfig);
    mp4.audioEncoder = encoder;

    const sampleRate = source.sampleRate;
    const channels = 2;
    const sourceLeft = source.getChannelData(0);
    const sourceRight = source.numberOfChannels > 1 ? source.getChannelData(1) : sourceLeft;
    const gain = this.state.get("muted") ? 0 : Math.max(0, Math.min(1, Number(this.state.get("volume")) || 0));
    const startFrame = Math.max(0, Math.min(source.length, Math.floor(this.rangeStart * sampleRate)));
    const endFrame = Math.max(startFrame, Math.min(source.length, Math.ceil(this.rangeEnd * sampleRate)));
    const totalFrames = endFrame - startFrame;
    const chunkSize = 2048;

    try {
      for (let offset = 0; offset < totalFrames && !this.cancelled; offset += chunkSize) {
        if (encodingError) throw encodingError;
        const frameCount = Math.min(chunkSize, totalFrames - offset);
        const planar = new Float32Array(frameCount * channels);
        for (let index = 0; index < frameCount; index += 1) {
          const sourceIndex = startFrame + offset + index;
          planar[index] = (sourceLeft[sourceIndex] || 0) * gain;
          planar[frameCount + index] = (sourceRight[sourceIndex] || 0) * gain;
        }
        const audioData = new AudioData({
          format: "f32-planar",
          sampleRate,
          numberOfFrames: frameCount,
          numberOfChannels: channels,
          timestamp: Math.round((offset / sampleRate) * 1_000_000),
          data: planar,
        });
        encoder.encode(audioData);
        audioData.close();
        while (encoder.encodeQueueSize > 8 && !this.cancelled) await this.nextEventLoopTurn();
      }
      if (!this.cancelled) await this.withTimeout(encoder.flush(), 180_000, "MP4 audio encoding timed out.");
      if (encodingError) throw encodingError;
    } finally {
      try { if (encoder.state !== "closed") encoder.close(); } catch { /* Encoder may already be reset. */ }
      mp4.audioEncoder = null;
    }
  }

  async addMkvFrame(frameIndex, totalFrames, timestamp, duration) {
    const mkv = this.mkv;
    if (!mkv) return;
    const progress = Math.min(VIDEO_PROGRESS_LIMIT, ((frameIndex + 1) / totalFrames) * VIDEO_PROGRESS_LIMIT);
    let heartbeatCount = 0;
    const heartbeat = window.setInterval(() => {
      heartbeatCount += 1;
      this.dispatchEvent(new CustomEvent("progress", {
        detail: {
          progress,
          elapsed: frameIndex / mkv.fps,
          duration: totalFrames / mkv.fps,
          currentTime: this.rangeStart + frameIndex / mkv.fps,
          message: `Encoder working on frame ${frameIndex + 1} of ${totalFrames}${heartbeatCount > 1 ? ` · ${heartbeatCount * 3}s` : ""}`,
        },
      }));
    }, 3000);
    try {
      await this.withTimeout(
        mkv.videoSource.add(timestamp, duration, {
          keyFrame: frameIndex % Math.max(1, mkv.fps * 2) === 0,
        }),
        90_000,
        `The ${mkv.selectedVideoCodec.toUpperCase()} encoder stopped responding on frame ${frameIndex + 1}.`,
      );
    } finally {
      window.clearInterval(heartbeat);
    }
  }

  async queueMkvAudioThrough(capturedDuration) {
    const mkv = this.mkv;
    if (!mkv?.audioSource || mkv.audioClosed || !this.audioEngine.decodedBuffer) return;
    const maximumDuration = Math.max(0, this.rangeEnd - this.rangeStart);
    const targetDuration = Math.min(maximumDuration, Math.max(0, capturedDuration));
    const chunkDuration = 5;
    while (mkv.audioEncodedUntil + 1e-4 < targetDuration && !this.cancelled) {
      const segmentStart = mkv.audioEncodedUntil;
      const segmentEnd = Math.min(targetDuration, segmentStart + chunkDuration);
      const segment = this.createAudioSegment(this.rangeStart + segmentStart, this.rangeStart + segmentEnd);
      mkv.audioEncodedUntil = segmentEnd;
      if (!segment) continue;
      mkv.audioEncodingPromise = mkv.audioEncodingPromise
        .then(() => mkv.audioSource.add(segment))
        .catch((error) => { mkv.audioEncodingError = error; });
      await this.withTimeout(mkv.audioEncodingPromise, 120_000, `MKV audio encoding stopped near ${segmentEnd.toFixed(1)} seconds.`);
      if (mkv.audioEncodingError) throw mkv.audioEncodingError;
    }
  }

  async captureOfflineMkvFrames() {
    const mkv = this.mkv;
    if (!mkv) return;
    try {
      for (let frameIndex = 0; frameIndex < mkv.totalFrames && this.active && !this.cancelled; frameIndex += 1) {
        const frameDuration = 1 / mkv.fps;
        this.getFrameData(frameIndex, mkv.fps);
        await this.nextEventLoopTurn();
        if (!this.active || this.cancelled) break;
        await this.addMkvFrame(frameIndex, mkv.totalFrames, frameIndex / mkv.fps, frameDuration);
        mkv.frameIndex = frameIndex + 1;

        const encodedDuration = mkv.frameIndex / mkv.fps;
        const audioChunkInterval = Math.max(1, Math.round(mkv.fps * 5));
        if (mkv.audioSource && (mkv.frameIndex % audioChunkInterval === 0 || mkv.frameIndex >= mkv.totalFrames)) {
          await this.queueMkvAudioThrough(encodedDuration);
        }
        this.dispatchFrameProgress(
          frameIndex,
          mkv.totalFrames,
          mkv.fps,
          `Encoded frame ${mkv.frameIndex} of ${mkv.totalFrames} · ${mkv.selectedVideoCodec.toUpperCase()}`,
        );
        await this.nextEventLoopTurn();
      }

      window.setTimeout(() => { void this.finalizeMkv(); }, 0);
    } catch (error) {
      if (!this.cancelled) this.failureError = error;
      this.cancelled = true;
      this.active = false;
      window.setTimeout(() => { void this.finalizeMkv(); }, 0);
    }
  }

  createAudioSegment(start, end) {
    const source = this.audioEngine.decodedBuffer;
    if (!source) return null;
    const sampleRate = source.sampleRate;
    const startFrame = Math.max(0, Math.min(source.length, Math.floor(start * sampleRate)));
    const endFrame = Math.max(startFrame + 1, Math.min(source.length, Math.ceil(end * sampleRate)));
    const frameCount = endFrame - startFrame;
    const segment = new AudioBuffer({
      length: frameCount,
      numberOfChannels: Math.max(1, source.numberOfChannels),
      sampleRate,
    });
    const gain = this.state.get("muted") ? 0 : Math.max(0, Math.min(1, Number(this.state.get("volume")) || 0));
    for (let channelIndex = 0; channelIndex < segment.numberOfChannels; channelIndex += 1) {
      const sourceChannel = source.getChannelData(Math.min(channelIndex, source.numberOfChannels - 1));
      const destination = segment.getChannelData(channelIndex);
      for (let index = 0; index < frameCount; index += 1) {
        destination[index] = (sourceChannel[startFrame + index] || 0) * gain;
      }
    }
    return segment;
  }

  async finalizeMkv() {
    if (this.finalizing || !this.mkv) return;
    this.finalizing = true;
    const mkv = this.mkv;
    try {
      if (this.capturePromise) await this.capturePromise;
      if (this.cancelled) {
        try { if (!mkv.videoClosed) mkv.videoSource.close(); } catch { /* Already closed. */ }
        try { if (!mkv.audioClosed) mkv.audioSource?.close(); } catch { /* Already closed. */ }
        if (["pending", "started"].includes(mkv.output.state)) {
          await this.withTimeout(mkv.output.cancel(), 30_000, "MKV cancellation timed out.");
        }
        await this.completeExport(true, this.failureError);
        return;
      }

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
      if (this.cancelled) {
        if (["pending", "started"].includes(mkv.output.state)) await mkv.output.cancel();
        await this.completeExport(true, this.failureError);
        return;
      }
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
      await this.completeExport(false);
    } catch (error) {
      try {
        if (["pending", "started"].includes(mkv.output.state)) await mkv.output.cancel();
      } catch { /* Preserve the original error. */ }
      await this.completeExport(true, error);
    }
  }

  async finalizeMp4() {
    if (this.finalizing) return;
    this.finalizing = true;
    const mp4 = this.mp4;
    try {
      if (mp4?.videoEncoder && mp4.videoEncoder.state !== "closed") {
        try { mp4.videoEncoder.reset(); } catch { /* Encoder may already be unconfigured. */ }
      }
      if (mp4?.audioEncoder && mp4.audioEncoder.state !== "closed") {
        try { mp4.audioEncoder.reset(); } catch { /* Encoder may already be unconfigured. */ }
      }
    } finally {
      await this.completeExport(true, this.failureError);
    }
  }

  stop(cancelled = true) {
    if (!this.isExporting()) return;
    this.cancelled = Boolean(cancelled);
    this.active = false;
    if (this.mp4?.videoEncoder?.state === "configured") {
      try { this.mp4.videoEncoder.reset(); } catch { /* Cancellation is best effort. */ }
    }
    if (this.mp4?.audioEncoder?.state === "configured") {
      try { this.mp4.audioEncoder.reset(); } catch { /* Cancellation is best effort. */ }
    }
    if (this.exportMode === "mkv") {
      const mkv = this.mkv;
      if (mkv) {
        try {
          if (!mkv.videoClosed) {
            mkv.videoSource.close();
            mkv.videoClosed = true;
          }
        } catch { /* Cancellation is best effort. */ }
        try {
          if (mkv.audioSource && !mkv.audioClosed) {
            mkv.audioSource.close();
            mkv.audioClosed = true;
          }
        } catch { /* Cancellation is best effort. */ }
        if (["pending", "started"].includes(mkv.output.state)) {
          void mkv.output.cancel().catch(() => {});
        }
      }
      void this.finalizeMkv();
    }
  }

  async completeExport(cancelled, error = null) {
    const failure = error || this.failureError;
    await this.restorePlayback();
    this.cleanup();
    this.finalizing = false;
    if (failure) {
      this.dispatchEvent(new CustomEvent("error", { detail: { message: failure.message || "Video export failed." } }));
    }
    this.dispatchEvent(new CustomEvent("finish", {
      detail: { cancelled: Boolean(cancelled), failed: Boolean(failure) },
    }));
  }

  async restorePlayback() {
    const audio = this.audioEngine.audio;
    this.restoreVisualizerSnapshot();
    if (!this.playbackSnapshot) return;
    this.audioEngine.resetOfflineAnalysis();
    this.audioEngine.metrics = this.playbackSnapshot.metrics || this.audioEngine.createEmptyMetrics();
    audio.pause();
    audio.loop = this.playbackSnapshot.loop;
    if (Number.isFinite(audio.duration)) {
      audio.currentTime = Math.min(this.playbackSnapshot.currentTime, audio.duration);
    }
    if (!this.playbackSnapshot.paused) {
      try { await this.audioEngine.play(); } catch { /* Browser gesture rules may block automatic resume. */ }
    }
  }

  cleanup() {
    try {
      if (this.mp4?.videoEncoder && this.mp4.videoEncoder.state !== "closed") this.mp4.videoEncoder.close();
    } catch { /* Already closed or reset. */ }
    try {
      if (this.mp4?.audioEncoder && this.mp4.audioEncoder.state !== "closed") this.mp4.audioEncoder.close();
    } catch { /* Already closed or reset. */ }
    this.exportRenderer?.dispose();
    this.exportRenderer = null;
    this.exportCamera = null;
    this.compositeCanvas = null;
    this.compositeContext = null;
    this.mkv = null;
    this.mp4 = null;
    this.capturePromise = null;
    this.playbackSnapshot = null;
    this.visualizerSnapshot = null;
    this.mkvFileHandle = null;
    this.mkvFileName = "";
    this.previewFrame = "";
    this.active = false;
    this.cancelled = false;
    this.failureError = null;
  }

  exportPng(metrics, meta) {
    if (this.isExporting()) return;
    const { width, height } = this.getResolution();
    const THREE = window.THREE;
    const renderCanvas = document.createElement("canvas");
    const renderer = new THREE.WebGLRenderer({
      canvas: renderCanvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
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
