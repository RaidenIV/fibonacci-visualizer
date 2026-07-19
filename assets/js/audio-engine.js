import { clamp, lerp } from "./utils.js";

export class AudioEngine extends EventTarget {
  constructor(audioElement, state) {
    super();
    this.audio = audioElement;
    this.state = state;
    this.context = null;
    this.source = null;
    this.gain = null;
    this.analyser = null;
    this.recordDestination = null;
    this.frequencyData = new Uint8Array(1024);
    this.waveformData = new Uint8Array(2048);
    this.waveformData.fill(128);
    this.objectUrl = "";
    this.file = null;
    this.decodedBuffer = null;
    this.waveformPeaks = null;
    this.averageEnergy = 0.08;
    this.lastBeatAt = 0;
    this.demoPhase = 0;
    this.metrics = this.createEmptyMetrics();
    this.loopStart = 0;
    this.loopEnd = 0;
    this.loopEnabled = false;
    this.loopBpm = 120;
    this.loopBars = 4;
    this.previewLoop = null;
    this.offlineFftSize = 2048;
    this.offlineFftReal = new Float64Array(this.offlineFftSize);
    this.offlineFftImag = new Float64Array(this.offlineFftSize);
    this.offlineWindow = new Float64Array(this.offlineFftSize);
    for (let index = 0; index < this.offlineFftSize; index += 1) {
      this.offlineWindow[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (this.offlineFftSize - 1));
    }
    this.offlineAverageEnergy = 0.08;
    this.offlineLastBeatAt = -Infinity;
    this.loopWrapPending = false;
    this.bindAudioEvents();
  }

  createEmptyMetrics() {
    return { energy: 0, rms: 0, peak: 0, bass: 0, mid: 0, treble: 0, centroid: 0, beat: 0, frequencyData: this.frequencyData, waveformData: this.waveformData };
  }

  bindAudioEvents() {
    this.audio.addEventListener("play", () => this.dispatchEvent(new Event("playback")));
    this.audio.addEventListener("pause", () => this.dispatchEvent(new Event("playback")));
    this.audio.addEventListener("ended", () => this.dispatchEvent(new Event("playback")));
    this.audio.addEventListener("timeupdate", () => this.dispatchEvent(new Event("time")));
    this.audio.addEventListener("loadedmetadata", () => this.dispatchEvent(new Event("metadata")));
  }

  async ensureGraph() {
    if (this.context) {
      if (this.context.state === "suspended") await this.context.resume();
      return;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio API is unavailable in this browser.");
    this.context = new AudioContextClass();
    this.source = this.context.createMediaElementSource(this.audio);
    this.gain = this.context.createGain();
    this.analyser = this.context.createAnalyser();
    this.recordDestination = this.context.createMediaStreamDestination();
    this.analyser.fftSize = 2048;
    this.analyser.minDecibels = -95;
    this.analyser.maxDecibels = -10;
    this.analyser.smoothingTimeConstant = this.state.get("smoothing");
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
    this.waveformData = new Uint8Array(this.analyser.fftSize);
    this.waveformData.fill(128);
    // Match the reference signal path: analyse the full-strength source first,
    // then apply volume and mute only to speaker and recording output.
    this.source.connect(this.analyser);
    this.analyser.connect(this.gain);
    this.gain.connect(this.context.destination);
    this.gain.connect(this.recordDestination);
    this.applyOutputLevel(this.state.get("volume"), this.state.get("muted"));
  }

  async loadFile(file) {
    const supportedExtension = /\.(wav|mp3|m4a|aac|flac|ogg|opus)$/i.test(file?.name || "");
    if (!(file instanceof File) || (!file.type.startsWith("audio/") && !supportedExtension)) {
      throw new Error("Choose a supported audio file.");
    }

    this.file = file;
    this.decodedBuffer = null;
    this.waveformPeaks = null;
    this.previewLoop = null;
    this.loopEnabled = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.loopBpm = 120;
    this.loopBars = 4;
    this.resetOfflineAnalysis();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.audio.pause();
    this.audio.loop = false;

    const metadataReady = new Promise((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("The browser could not decode this audio file.")); };
      const cleanup = () => {
        this.audio.removeEventListener("loadedmetadata", onReady);
        this.audio.removeEventListener("error", onError);
      };
      this.audio.addEventListener("loadedmetadata", onReady, { once: true });
      this.audio.addEventListener("error", onError, { once: true });
    });

    this.audio.src = this.objectUrl;
    this.audio.load();
    await metadataReady;
    await this.ensureGraph();

    try {
      const bytes = await file.arrayBuffer();
      this.decodedBuffer = await this.context.decodeAudioData(bytes.slice(0));
      this.waveformPeaks = this.buildWaveformPeaks(this.decodedBuffer);
    } catch (error) {
      this.file = null;
      this.audio.removeAttribute("src");
      this.audio.load();
      throw new Error(`Audio analysis failed: ${error.message}`);
    }

    this.loopStart = 0;
    this.loopEnd = this.getDuration();
    this.state.set("loopTrack", false);
    this.clearWaveform({ notify: false });
    this.dispatchEvent(new CustomEvent("file", { detail: file }));
    this.dispatchEvent(new Event("loopchange"));
  }

  async togglePlayback() {
    if (!this.file) return;
    await this.ensureGraph();
    if (this.audio.paused) {
      const loop = this.getActiveLoopRange();
      if (loop && (this.audio.currentTime < loop.start || this.audio.currentTime >= loop.end)) {
        this.audio.currentTime = loop.start;
      }
      await this.audio.play();
    } else {
      this.audio.pause();
    }
  }

  async play() {
    if (!this.file) return;
    await this.ensureGraph();
    await this.audio.play();
  }

  pause() {
    this.audio.pause();
  }

  stop() {
    this.audio.pause();
    const loop = this.getActiveLoopRange();
    this.audio.currentTime = loop?.start || 0;
    this.dispatchEvent(new Event("time"));
  }

  seek(seconds) {
    if (!this.file || !Number.isFinite(this.audio.duration)) return;
    this.audio.currentTime = clamp(seconds, 0, this.audio.duration);
  }

  applyOutputLevel(volume = this.state.get("volume"), muted = this.state.get("muted")) {
    const outputLevel = Boolean(muted) ? 0 : clamp(Number(volume), 0, 1);
    if (this.gain && this.context) {
      this.gain.gain.setTargetAtTime(outputLevel, this.context.currentTime, 0.01);
    }
    // Keep the media element neutral so the analyser always receives the
    // unattenuated source signal, exactly like the reference project.
    this.audio.volume = 1;
    this.audio.muted = false;
  }

  setVolume(value) {
    this.applyOutputLevel(value, this.state.get("muted"));
  }

  setMuted(value) {
    this.applyOutputLevel(this.state.get("volume"), value);
  }

  getDuration() {
    const duration = this.decodedBuffer?.duration || this.audio.duration || 0;
    return Number.isFinite(duration) ? duration : 0;
  }

  getLoopState() {
    const duration = this.getDuration();
    const start = clamp(this.loopStart || 0, 0, duration);
    const end = clamp(this.loopEnd || duration, start, duration);
    return {
      ready: Boolean(this.decodedBuffer && duration > 0),
      enabled: Boolean(this.loopEnabled),
      start,
      end,
      duration: Math.max(0, end - start),
      trackDuration: duration,
      partial: Boolean(this.loopEnabled && end - start > 0.01 && end - start < duration - 0.01),
    };
  }

  setLoop(enabled) {
    this.loopEnabled = Boolean(enabled && this.file);
    const loop = this.getLoopState();
    this.audio.loop = Boolean(loop.enabled && !loop.partial);
    this.dispatchEvent(new Event("loopchange"));
  }

  setLoopRange(start, end, enabled = true) {
    const duration = this.getDuration();
    if (!duration) return;
    const nextStart = clamp(Number(start) || 0, 0, duration);
    const nextEnd = clamp(Number(end) || duration, nextStart, duration);
    this.loopStart = nextStart;
    this.loopEnd = nextEnd;
    this.loopEnabled = Boolean(enabled && nextEnd - nextStart > 0.01);
    this.audio.loop = Boolean(this.loopEnabled && nextEnd - nextStart >= duration - 0.01);
    this.state.set("loopTrack", this.loopEnabled);
    if (this.loopEnabled && (this.audio.currentTime < nextStart || this.audio.currentTime >= nextEnd)) {
      this.audio.currentTime = nextStart;
    }
    this.dispatchEvent(new Event("loopchange"));
  }

  clearLoop() {
    const duration = this.getDuration();
    this.loopStart = 0;
    this.loopEnd = duration;
    this.loopEnabled = false;
    this.audio.loop = false;
    this.state.set("loopTrack", false);
    this.dispatchEvent(new Event("loopchange"));
  }

  setPreviewLoop(start, end, enabled = true) {
    const duration = this.getDuration();
    if (!duration || !enabled) {
      this.previewLoop = null;
      return;
    }
    const nextStart = clamp(Number(start) || 0, 0, duration);
    const nextEnd = clamp(Number(end) || duration, nextStart, duration);
    this.previewLoop = nextEnd - nextStart > 0.01 ? { start: nextStart, end: nextEnd } : null;
    this.audio.loop = false;
  }

  clearPreviewLoop() {
    this.previewLoop = null;
    const loop = this.getLoopState();
    this.audio.loop = Boolean(loop.enabled && !loop.partial);
  }

  getActiveLoopRange() {
    if (this.previewLoop) return this.previewLoop;
    const loop = this.getLoopState();
    return loop.enabled ? { start: loop.start, end: loop.end } : null;
  }

  enforceLoop() {
    const range = this.getActiveLoopRange();
    if (!range || this.audio.paused || this.loopWrapPending) return;
    if (this.audio.currentTime < range.start - 0.03 || this.audio.currentTime >= range.end - 0.012) {
      const overflow = this.audio.currentTime >= range.end ? Math.max(0, this.audio.currentTime - range.end) : 0;
      const target = clamp(range.start + overflow, range.start, Math.max(range.start, range.end - 0.001));
      this.loopWrapPending = true;
      this.audio.currentTime = target;
      window.setTimeout(() => { this.loopWrapPending = false; }, 0);
    }
  }

  buildWaveformPeaks(buffer, peakCount = 4096) {
    if (!buffer || buffer.length <= 0) return null;
    const peaks = new Float32Array(peakCount);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    const samplesPerPeak = Math.max(1, buffer.length / peakCount);
    for (let peakIndex = 0; peakIndex < peakCount; peakIndex += 1) {
      const start = Math.floor(peakIndex * samplesPerPeak);
      const end = Math.min(buffer.length, Math.max(start + 1, Math.floor((peakIndex + 1) * samplesPerPeak)));
      const stride = Math.max(1, Math.floor((end - start) / 160));
      let peak = 0;
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += stride) {
        for (const channel of channels) peak = Math.max(peak, Math.abs(channel[sampleIndex] || 0));
      }
      peaks[peakIndex] = peak;
    }
    return peaks;
  }

  clearWaveform({ notify = true } = {}) {
    this.frequencyData.fill(0);
    this.waveformData.fill(128);
    this.averageEnergy = 0.08;
    this.lastBeatAt = 0;
    this.metrics = this.createEmptyMetrics();
    if (notify) this.dispatchEvent(new Event("waveformclear"));
  }

  setSmoothing(value) {
    if (this.analyser) this.analyser.smoothingTimeConstant = clamp(Number(value), 0, 0.99);
  }

  getRecordStream() {
    return this.recordDestination?.stream || null;
  }

  update(delta, elapsed) {
    this.enforceLoop();
    const hasActiveAudio = Boolean(this.file && this.analyser && !this.audio.paused);
    if (!hasActiveAudio) {
      this.metrics = this.state.get("demoMode") && !this.file ? this.updateDemo(delta, elapsed) : this.createEmptyMetrics();
      return this.metrics;
    }

    this.analyser.getByteFrequencyData(this.frequencyData);
    this.analyser.getByteTimeDomainData(this.waveformData);
    const sensitivity = this.state.get("sensitivity");
    const sampleRate = this.context.sampleRate;
    const binHz = sampleRate / this.analyser.fftSize;
    const averageBand = (lowHz, highHz) => {
      const start = Math.max(0, Math.floor(lowHz / binHz));
      const end = Math.min(this.frequencyData.length, Math.ceil(highHz / binHz));
      let sum = 0;
      for (let index = start; index < end; index += 1) sum += this.frequencyData[index] / 255;
      return end > start ? sum / (end - start) : 0;
    };

    let energy = 0;
    let weighted = 0;
    let weightTotal = 0;
    let peak = 0;
    for (let index = 0; index < this.frequencyData.length; index += 1) {
      const value = this.frequencyData[index] / 255;
      energy += value;
      peak = Math.max(peak, value);
      weighted += index * value;
      weightTotal += value;
    }
    energy = (energy / this.frequencyData.length) * sensitivity;
    let squareSum = 0;
    for (let index = 0; index < this.waveformData.length; index += 1) {
      const value = (this.waveformData[index] - 128) / 128;
      squareSum += value * value;
    }
    const rms = Math.sqrt(squareSum / this.waveformData.length) * sensitivity;
    this.averageEnergy = lerp(this.averageEnergy, energy, 0.025);
    const now = performance.now() / 1000;
    const beatDetected = energy > this.averageEnergy * 1.42 && energy > 0.09 && now - this.lastBeatAt > 0.17;
    if (beatDetected) this.lastBeatAt = now;
    const previousBeat = this.metrics.beat || 0;
    const beat = beatDetected ? 1 : Math.max(0, previousBeat - delta * 4.8);

    this.metrics = {
      energy: clamp(energy, 0, 2.5),
      rms: clamp(rms, 0, 2.5),
      peak,
      bass: clamp(averageBand(20, 250) * sensitivity, 0, 2.5),
      mid: clamp(averageBand(250, 2000) * sensitivity, 0, 2.5),
      treble: clamp(averageBand(2000, 16000) * sensitivity, 0, 2.5),
      centroid: weightTotal ? weighted / weightTotal / this.frequencyData.length : 0,
      beat,
      frequencyData: this.frequencyData,
      waveformData: this.waveformData,
    };
    return this.metrics;
  }

  updateDemo(delta, elapsed) {
    this.demoPhase += delta;
    const pulse = (Math.sin(elapsed * 2.15) + 1) * 0.5;
    const bass = 0.18 + Math.pow(pulse, 5) * 0.72;
    const mid = 0.2 + (Math.sin(elapsed * 1.17 + 1.4) + 1) * 0.17;
    const treble = 0.12 + (Math.sin(elapsed * 3.7 + 0.2) + 1) * 0.12;
    const beat = pulse > 0.965 ? 1 : Math.max(0, (this.metrics.beat || 0) - delta * 4.2);
    for (let index = 0; index < this.frequencyData.length; index += 1) {
      const falloff = Math.exp(-index / 180);
      const ripple = 0.55 + 0.45 * Math.sin(index * 0.045 + elapsed * 4);
      this.frequencyData[index] = Math.round(clamp((bass * falloff + mid * 0.35 * ripple + treble * 0.18) * 255, 0, 255));
    }
    for (let index = 0; index < this.waveformData.length; index += 1) {
      const phase = index / this.waveformData.length * Math.PI * 12;
      this.waveformData[index] = Math.round(128 + Math.sin(phase + elapsed * 5) * (20 + bass * 34));
    }
    return {
      energy: (bass + mid + treble) / 3,
      rms: bass * 0.62,
      peak: Math.max(bass, mid, treble),
      bass, mid, treble, centroid: 0.36 + treble * 0.18, beat,
      frequencyData: this.frequencyData,
      waveformData: this.waveformData,
    };
  }


  resetOfflineAnalysis() {
    this.offlineAverageEnergy = 0.08;
    this.offlineLastBeatAt = -Infinity;
    this.frequencyData.fill(0);
    this.waveformData.fill(128);
    this.metrics = this.createEmptyMetrics();
  }

  fftInPlace(real, imag) {
    const length = real.length;
    for (let index = 1, reversed = 0; index < length; index += 1) {
      let bit = length >> 1;
      for (; reversed & bit; bit >>= 1) reversed ^= bit;
      reversed ^= bit;
      if (index < reversed) {
        const realValue = real[index];
        real[index] = real[reversed];
        real[reversed] = realValue;
        const imaginaryValue = imag[index];
        imag[index] = imag[reversed];
        imag[reversed] = imaginaryValue;
      }
    }

    for (let size = 2; size <= length; size <<= 1) {
      const angle = (-2 * Math.PI) / size;
      const phaseReal = Math.cos(angle);
      const phaseImaginary = Math.sin(angle);
      for (let start = 0; start < length; start += size) {
        let currentReal = 1;
        let currentImaginary = 0;
        const half = size >> 1;
        for (let offset = 0; offset < half; offset += 1) {
          const evenIndex = start + offset;
          const oddIndex = evenIndex + half;
          const oddReal = real[oddIndex] * currentReal - imag[oddIndex] * currentImaginary;
          const oddImaginary = real[oddIndex] * currentImaginary + imag[oddIndex] * currentReal;
          const evenReal = real[evenIndex];
          const evenImaginary = imag[evenIndex];
          real[evenIndex] = evenReal + oddReal;
          imag[evenIndex] = evenImaginary + oddImaginary;
          real[oddIndex] = evenReal - oddReal;
          imag[oddIndex] = evenImaginary - oddImaginary;
          const nextReal = currentReal * phaseReal - currentImaginary * phaseImaginary;
          currentImaginary = currentReal * phaseImaginary + currentImaginary * phaseReal;
          currentReal = nextReal;
        }
      }
    }
  }

  sampleMetricsAt(timeSeconds, delta = 1 / 60) {
    const buffer = this.decodedBuffer;
    if (!buffer || buffer.length <= 0) return this.createEmptyMetrics();

    const fftSize = this.offlineFftSize;
    const sampleRate = buffer.sampleRate;
    const centerSample = Math.floor(clamp(Number(timeSeconds) || 0, 0, buffer.duration) * sampleRate);
    const startSample = centerSample - (fftSize >> 1);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    const sensitivity = Number(this.state.get("sensitivity")) || 1;
    let squareSum = 0;
    let peak = 0;

    for (let index = 0; index < fftSize; index += 1) {
      const sourceIndex = startSample + index;
      let mixed = 0;
      if (sourceIndex >= 0 && sourceIndex < buffer.length) {
        for (const channel of channels) mixed += (channel[sourceIndex] || 0) / channels.length;
      }
      squareSum += mixed * mixed;
      peak = Math.max(peak, Math.abs(mixed));
      this.waveformData[index] = Math.round(clamp(128 + mixed * 127, 0, 255));
      this.offlineFftReal[index] = mixed * this.offlineWindow[index];
      this.offlineFftImag[index] = 0;
    }

    this.fftInPlace(this.offlineFftReal, this.offlineFftImag);
    const binCount = Math.min(this.frequencyData.length, fftSize >> 1);
    const binHz = sampleRate / fftSize;
    let energy = 0;
    let weighted = 0;
    let weightTotal = 0;
    const bandAccumulator = { bass: 0, mid: 0, treble: 0 };
    const bandCounts = { bass: 0, mid: 0, treble: 0 };

    for (let index = 0; index < binCount; index += 1) {
      const magnitude = Math.hypot(this.offlineFftReal[index], this.offlineFftImag[index]) / (fftSize * 0.5);
      const decibels = 20 * Math.log10(Math.max(1e-10, magnitude));
      const normalized = clamp((decibels + 95) / 85, 0, 1);
      const byteValue = Math.round(normalized * 255);
      this.frequencyData[index] = byteValue;
      energy += normalized;
      weighted += index * normalized;
      weightTotal += normalized;
      const frequency = index * binHz;
      if (frequency >= 20 && frequency < 250) {
        bandAccumulator.bass += normalized;
        bandCounts.bass += 1;
      } else if (frequency < 2000) {
        bandAccumulator.mid += normalized;
        bandCounts.mid += 1;
      } else if (frequency < 16000) {
        bandAccumulator.treble += normalized;
        bandCounts.treble += 1;
      }
    }
    for (let index = binCount; index < this.frequencyData.length; index += 1) this.frequencyData[index] = 0;

    energy = (energy / Math.max(1, binCount)) * sensitivity;
    const rms = Math.sqrt(squareSum / fftSize) * sensitivity;
    this.offlineAverageEnergy = lerp(this.offlineAverageEnergy, energy, 0.025);
    const beatDetected = energy > this.offlineAverageEnergy * 1.42 && energy > 0.09 && timeSeconds - this.offlineLastBeatAt > 0.17;
    if (beatDetected) this.offlineLastBeatAt = timeSeconds;
    const previousBeat = this.metrics.beat || 0;
    const beat = beatDetected ? 1 : Math.max(0, previousBeat - delta * 4.8);

    this.metrics = {
      energy: clamp(energy, 0, 2.5),
      rms: clamp(rms, 0, 2.5),
      peak: clamp(peak * sensitivity, 0, 2.5),
      bass: clamp((bandAccumulator.bass / Math.max(1, bandCounts.bass)) * sensitivity, 0, 2.5),
      mid: clamp((bandAccumulator.mid / Math.max(1, bandCounts.mid)) * sensitivity, 0, 2.5),
      treble: clamp((bandAccumulator.treble / Math.max(1, bandCounts.treble)) * sensitivity, 0, 2.5),
      centroid: weightTotal ? weighted / weightTotal / Math.max(1, binCount) : 0,
      beat,
      frequencyData: this.frequencyData,
      waveformData: this.waveformData,
    };
    return this.metrics;
  }

  destroy() {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.context?.close();
  }
}
