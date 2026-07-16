import { StateStore } from "./state.js";
import { AudioEngine } from "./audio-engine.js";
import { FibonacciVisualizer } from "./fibonacci-visualizer.js";
import { HudRenderer } from "./hud.js";
import { Exporter } from "./exporter.js";
import { UIController } from "./ui.js";
import { QUALITY_PRESETS } from "./config.js";

class FibonacciAudioFieldApp {
  constructor() {
    this.state = new StateStore();
    this.audioEngine = new AudioEngine(document.getElementById("audio"), this.state);
    this.visualizer = new FibonacciVisualizer(document.getElementById("webglCanvas"), document.getElementById("viewportFrame"), this.state);
    this.hud = new HudRenderer(document.getElementById("hudCanvas"), this.state);
    this.exporter = new Exporter(this.visualizer, this.hud, this.audioEngine, this.state);
    this.ui = new UIController(this.state, this.audioEngine, this.visualizer, this.exporter);
    this.startedAt = performance.now();
    this.lastFrameAt = this.startedAt;
    this.fps = 60;
    this.lastUiUpdateAt = 0;
    this.metrics = this.audioEngine.createEmptyMetrics();
    this.bindState();
    this.bindLifecycle();
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  bindState() {
    const apply = (key, value) => {
      this.visualizer.applySetting(key, value);
      this.ui.syncControl(key, value);
      if (key === "smoothing") this.audioEngine.setSmoothing(value);
      if (key === "volume") this.audioEngine.setVolume(value);
      if (key === "muted") this.audioEngine.setMuted(value);
      if (key === "loopTrack") this.audioEngine.setLoop(value);
    };
    this.state.addEventListener("change", (event) => apply(event.detail.key, event.detail.value));
    this.state.addEventListener("patch", (event) => { for (const [key, value] of Object.entries(event.detail)) apply(key, value); });
    this.state.addEventListener("reset", (event) => { for (const [key, value] of Object.entries(event.detail)) apply(key, value); });
    this.audioEngine.setLoop(this.state.get("loopTrack"));
    this.audioEngine.setVolume(this.state.get("volume"));
    this.audioEngine.setMuted(this.state.get("muted"));
    this.ui.addEventListener("export-png", () => this.exporter.exportPng(this.metrics, this.getMeta()));
    this.ui.addEventListener("clear-waveform", () => this.visualizer.clearWaveform());
  }

  bindLifecycle() {
    const resize = () => this.visualizer.resize(true);
    window.addEventListener("resize", resize);
    document.addEventListener("fullscreenchange", resize);
    const observer = new ResizeObserver(resize);
    observer.observe(document.getElementById("viewportFrame"));
    window.addEventListener("beforeunload", () => {
      this.audioEngine.destroy();
      this.visualizer.dispose();
    });
    this.visualizer.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.ui.toast("WebGL context lost. Reload the page if it does not recover.", "error");
    });
    this.visualizer.canvas.addEventListener("webglcontextrestored", () => this.ui.toast("WebGL context restored.", "success"));
  }

  getMeta() {
    const stats = this.visualizer.getStats();
    const audio = this.audioEngine.audio;
    return {
      fps: this.fps,
      points: stats.points,
      drawCalls: stats.drawCalls,
      pixelRatio: stats.pixelRatio,
      mode: this.audioEngine.file ? (!audio.paused && !audio.ended ? "PLAYING" : "PAUSED") : this.state.get("demoMode") ? "DEMO" : "STATIC",
      fileName: this.audioEngine.file?.name || (this.state.get("demoMode") ? "SYNTHETIC DEMO SIGNAL" : "NO AUDIO FILE"),
      fftSize: this.audioEngine.analyser?.fftSize || 2048,
      currentTime: this.audioEngine.file ? audio.currentTime : 0,
      duration: this.audioEngine.file ? audio.duration : 0,
    };
  }

  animate(now) {
    requestAnimationFrame(this.animate);
    const delta = Math.min(0.05, Math.max(0.001, (now - this.lastFrameAt) / 1000));
    const elapsed = (now - this.startedAt) / 1000;
    this.lastFrameAt = now;
    const instantaneousFps = 1 / delta;
    this.fps += (instantaneousFps - this.fps) * 0.08;
    this.metrics = this.audioEngine.update(delta, elapsed);
    this.visualizer.resize();
    this.visualizer.update(delta, elapsed, this.metrics);
    this.visualizer.render();
    const meta = this.getMeta();
    this.hud.updateFps(now);
    const hudPreset = QUALITY_PRESETS[this.state.get("quality")] || QUALITY_PRESETS.balanced;
    if (now - this.hud.lastDrawAt >= 1000 / hudPreset.hudFps) this.hud.draw(this.metrics, meta, now);
    this.exporter.renderFrame(this.metrics, meta);
    if (now - this.lastUiUpdateAt > 200) {
      this.ui.updateRuntime(meta);
      this.lastUiUpdateAt = now;
    }
  }
}

try {
  window.fibonacciAudioField = new FibonacciAudioFieldApp();
} catch (error) {
  console.error(error);
  const message = document.createElement("div");
  message.className = "fatal-error";
  message.innerHTML = `<strong>FIBONACCI FIELD COULD NOT START</strong><span>${error.message}</span><small>Open this project through a local web server instead of directly from the file system.</small>`;
  document.body.appendChild(message);
}
