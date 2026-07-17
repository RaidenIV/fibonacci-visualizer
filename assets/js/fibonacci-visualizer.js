import { MAX_POINTS, QUALITY_PRESETS } from "./config.js";
import { createPaletteTexture } from "./palettes.js";
import { clamp } from "./utils.js";

const VIRTUAL_HEIGHT = 600;
const PYTHON_BASE_SCALE = 4;
const PYTHON_POINT_GROWTH = 1000;
const PYTHON_ROTATION_STEP = 0.02;
const PYTHON_FRAME_RATE = 17;
const RMS_TO_PYTHON_MULTIPLIER = 32768 / 3750 / 1.6;

const vertexShader = `
  precision highp float;
  attribute float aIndex;
  uniform float uCount;
  uniform float uRotation;
  uniform float uGoldenAngle;
  uniform float uSpacing;
  uniform float uPointSize;
  uniform float uWarp;
  uniform float uAudioMultiplier;
  uniform float uAudioScale;
  uniform float uAudioSize;
  uniform float uAudioRotation;
  uniform float uReactionMode;
  uniform float uBass;
  uniform float uMid;
  uniform float uTreble;
  uniform float uTime;
  uniform float uViewportScale;
  varying float vIndex;

  void main() {
    float index = aIndex + 1.0;
    float normalized = index / max(uCount, 1.0);
    float unifiedAudio = uAudioMultiplier * (1.0 - uReactionMode);
    float dynamicAngle = uGoldenAngle + unifiedAudio * (1.0 / 128.0);
    float angle = index * dynamicAngle + uRotation;
    float scale = PYTHON_BASE_SCALE_PLACEHOLDER * uSpacing + unifiedAudio * uAudioScale;
    float radius = scale * sqrt(index) * (1.0 + uWarp * sin(unifiedAudio * index / 50.0));
    float pointBoost = unifiedAudio * uAudioSize * 5.0;

    if (uReactionMode > 0.5) {
      float lowBand = 1.0 - step(0.333333, normalized);
      float highBand = step(0.666667, normalized);
      float midBand = 1.0 - lowBand - highBand;
      float low = clamp(uBass, 0.0, 2.5);
      float mid = clamp(uMid, 0.0, 2.5);
      float high = clamp(uTreble, 0.0, 2.5);

      // Low frequencies drive the inner field with broad clockwise rotation
      // and a strong breathing expansion.
      float lowAngle = low * (0.48 + 0.06 * sin(uTime * 1.25));
      float lowRadius = 1.0 + low * 0.15 * uAudioScale;

      // Mid frequencies counter-rotate the middle field and create a
      // travelling radial ripple through the spiral.
      float midPhase = index * 0.072 + uTime * 2.15;
      float midAngle = -mid * 0.36 + sin(midPhase) * mid * 0.12;
      float midRadius = 1.0 + sin(midPhase) * mid * 0.105 * uAudioScale;

      // High frequencies shimmer through the outer field with fast orbital
      // motion and a tighter radial vibration.
      float highPhase = index * 0.235 + uTime * 7.5;
      float highAngle = sin(highPhase) * high * 0.22;
      float highRadius = 1.0 + cos(highPhase * 1.17) * high * 0.055 * uAudioScale;

      angle += (lowBand * lowAngle + midBand * midAngle + highBand * highAngle) * uAudioRotation;
      radius *= max(0.15, lowBand * lowRadius + midBand * midRadius + highBand * highRadius);
      radius += highBand * sin(highPhase * 1.63) * high * 2.4 * uAudioScale;
      pointBoost = (lowBand * low * 1.35 + midBand * mid * 2.1 + highBand * high * 3.2) * uAudioSize;
    }

    vec2 position = vec2(cos(angle), -sin(angle)) * radius;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 0.0, 1.0);
    gl_PointSize = max(1.0, 2.0 * floor(uPointSize + pointBoost) * uViewportScale);
    vIndex = normalized;
  }
`.replace("PYTHON_BASE_SCALE_PLACEHOLDER", PYTHON_BASE_SCALE.toFixed(1));

const fragmentShader = `
  precision highp float;
  uniform sampler2D uPalette;
  uniform float uTime;
  uniform float uColorCycle;
  uniform float uOpacity;
  uniform float uShape;
  varying float vIndex;

  void main() {
    vec2 uv = gl_PointCoord;
    vec2 p = vec2(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);

    if (uShape < 0.5) {
      if (dot(p, p) > 1.0) discard;
    } else if (uShape < 1.5) {
      if (max(abs(p.x), abs(p.y)) > 1.0) discard;
    } else {
      if (p.y < -1.0 || p.y > 1.0 - 2.0 * abs(p.x)) discard;
    }

    float palettePosition = fract(vIndex + uTime * uColorCycle);
    vec3 color = texture2D(uPalette, vec2(palettePosition, 0.5)).rgb;
    gl_FragColor = vec4(color, uOpacity);
  }
`;

export class FibonacciVisualizer {
  constructor(canvas, frame, state) {
    const THREE = window.THREE;
    if (!THREE) throw new Error("Three.js failed to load.");
    this.THREE = THREE;
    this.canvas = canvas;
    this.frame = frame;
    this.state = state;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.OrthographicCamera(-400, 400, 300, -300, 0.1, 10);
    this.camera.position.set(0, 0, 1);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.rotation = 0;
    this.currentPointCount = state.get("pointCount");
    this.audioMultiplier = 0;
    this.bandLevels = { bass: 0, mid: 0, treble: 0 };
    this.lastWidth = 0;
    this.lastHeight = 0;
    this.paletteTexture = createPaletteTexture(THREE, state.get("palette"));
    this.buildField();
    this.applyAllSettings();
    this.resize(true);
  }

  buildField() {
    const { THREE } = this;
    const geometry = new THREE.BufferGeometry();
    const indices = new Float32Array(MAX_POINTS);
    for (let index = 0; index < MAX_POINTS; index += 1) indices[index] = index;
    geometry.setAttribute("aIndex", new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, Math.max(1, this.state.get("pointCount") - 1));

    this.uniforms = {
      uCount: { value: this.state.get("pointCount") },
      uTime: { value: 0 },
      uRotation: { value: 0 },
      uGoldenAngle: { value: THREE.MathUtils.degToRad(this.state.get("goldenAngle")) },
      uSpacing: { value: this.state.get("spacing") },
      uPointSize: { value: this.state.get("pointSize") },
      uWarp: { value: this.state.get("warp") },
      uAudioMultiplier: { value: 0 },
      uAudioScale: { value: this.state.get("audioScale") },
      uAudioSize: { value: this.state.get("audioSize") },
      uAudioRotation: { value: this.state.get("audioRotation") },
      uReactionMode: { value: this.state.get("reactionMode") === "bands" ? 1 : 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uViewportScale: { value: 1 },
      uPalette: { value: this.paletteTexture },
      uColorCycle: { value: this.state.get("colorCycle") },
      uOpacity: { value: this.state.get("opacity") },
      uShape: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
    });
    this.field = new THREE.Points(geometry, this.material);
    this.field.frustumCulled = false;
    this.scene.add(this.field);
  }

  applyAllSettings() {
    for (const [key, value] of Object.entries(this.state.settings)) this.applySetting(key, value);
  }

  applySetting(key, value) {
    const THREE = this.THREE;
    switch (key) {
      case "pointCount": this.uniforms.uCount.value = value; break;
      case "spacing": this.uniforms.uSpacing.value = value; break;
      case "pointSize": this.uniforms.uPointSize.value = value; break;
      case "goldenAngle": this.uniforms.uGoldenAngle.value = THREE.MathUtils.degToRad(value); break;
      case "warp": this.uniforms.uWarp.value = value; break;
      case "audioScale": this.uniforms.uAudioScale.value = value; break;
      case "audioSize": this.uniforms.uAudioSize.value = value; break;
      case "audioRotation": this.uniforms.uAudioRotation.value = value; break;
      case "reactionMode": this.uniforms.uReactionMode.value = value === "bands" ? 1 : 0; break;
      case "colorCycle": this.uniforms.uColorCycle.value = value; break;
      case "opacity": this.uniforms.uOpacity.value = value; break;
      case "shape": this.uniforms.uShape.value = value === "square" ? 1 : value === "triangle" ? 2 : 0; break;
      case "palette": {
        const nextTexture = createPaletteTexture(THREE, value);
        this.uniforms.uPalette.value = nextTexture;
        this.paletteTexture.dispose();
        this.paletteTexture = nextTexture;
        break;
      }
      case "additive":
        this.material.blending = value ? THREE.AdditiveBlending : THREE.NormalBlending;
        this.material.needsUpdate = true;
        break;
      case "quality": this.applyQuality(value); break;
      default: break;
    }
  }

  applyQuality(name) {
    const preset = QUALITY_PRESETS[name] || QUALITY_PRESETS.balanced;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, preset.pixelRatio));
    this.resize(true);
  }

  update(delta, elapsed, metrics) {
    const settings = this.state.settings;
    const quality = QUALITY_PRESETS[settings.quality] || QUALITY_PRESETS.balanced;
    this.audioMultiplier = clamp((metrics.rms || 0) * RMS_TO_PYTHON_MULTIPLIER, 0, 5);
    const densityBoost = Math.floor(this.audioMultiplier * PYTHON_POINT_GROWTH * settings.audioDensity);
    this.currentPointCount = Math.min(
      MAX_POINTS,
      quality.pointLimit,
      Math.max(1, Math.floor(settings.pointCount + densityBoost)),
    );
    this.field.geometry.setDrawRange(0, Math.max(1, this.currentPointCount - 1));

    const bandFollow = 1 - Math.exp(-delta * 12);
    this.bandLevels.bass += (clamp(metrics.bass || 0, 0, 2.5) - this.bandLevels.bass) * bandFollow;
    this.bandLevels.mid += (clamp(metrics.mid || 0, 0, 2.5) - this.bandLevels.mid) * bandFollow;
    this.bandLevels.treble += (clamp(metrics.treble || 0, 0, 2.5) - this.bandLevels.treble) * bandFollow;

    this.rotation += delta * settings.rotationSpeed;
    if (settings.reactionMode !== "bands") {
      this.rotation += this.audioMultiplier * PYTHON_ROTATION_STEP * PYTHON_FRAME_RATE * delta * settings.audioRotation;
    }

    this.uniforms.uCount.value = this.currentPointCount;
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uRotation.value = this.rotation;
    this.uniforms.uAudioMultiplier.value = this.audioMultiplier;
    this.uniforms.uBass.value = this.bandLevels.bass;
    this.uniforms.uMid.value = this.bandLevels.mid;
    this.uniforms.uTreble.value = this.bandLevels.treble;
  }

  render() {
    this.uniforms.uViewportScale.value = this.screenViewportScale || 1;
    this.renderer.render(this.scene, this.camera);
  }

  renderWithRenderer(renderer, camera) {
    const previousScale = this.uniforms.uViewportScale.value;
    const drawingBufferSize = new this.THREE.Vector2();
    renderer.getDrawingBufferSize(drawingBufferSize);
    this.uniforms.uViewportScale.value = drawingBufferSize.y / VIRTUAL_HEIGHT;
    renderer.render(this.scene, camera);
    this.uniforms.uViewportScale.value = previousScale;
  }

  configureCameraForSize(camera, width, height) {
    const aspect = Math.max(0.001, width / Math.max(1, height));
    const virtualWidth = VIRTUAL_HEIGHT * aspect;
    camera.left = -virtualWidth / 2;
    camera.right = virtualWidth / 2;
    camera.top = VIRTUAL_HEIGHT / 2;
    camera.bottom = -VIRTUAL_HEIGHT / 2;
    camera.near = 0.1;
    camera.far = 10;
    camera.position.set(0, 0, 1);
    camera.updateProjectionMatrix();
  }

  resize(force = false) {
    const width = Math.max(1, this.frame.clientWidth);
    const height = Math.max(1, this.frame.clientHeight);
    if (!force && width === this.lastWidth && height === this.lastHeight) return;
    this.lastWidth = width;
    this.lastHeight = height;
    this.renderer.setSize(width, height, false);
    this.configureCameraForSize(this.camera, width, height);
    const drawingBufferSize = new this.THREE.Vector2();
    this.renderer.getDrawingBufferSize(drawingBufferSize);
    this.screenViewportScale = drawingBufferSize.y / VIRTUAL_HEIGHT;
    this.uniforms.uViewportScale.value = this.screenViewportScale;
  }

  setCameraPreset() {
    this.fitView();
  }

  fitView() {
    this.rotation = 0;
    this.configureCameraForSize(this.camera, this.lastWidth || this.frame.clientWidth, this.lastHeight || this.frame.clientHeight);
  }

  clearWaveform() {
    this.rotation = 0;
    this.audioMultiplier = 0;
    this.bandLevels.bass = 0;
    this.bandLevels.mid = 0;
    this.bandLevels.treble = 0;
    this.uniforms.uRotation.value = 0;
    this.uniforms.uAudioMultiplier.value = 0;
    this.uniforms.uBass.value = 0;
    this.uniforms.uMid.value = 0;
    this.uniforms.uTreble.value = 0;
  }

  getStats() {
    return {
      points: Math.max(1, this.currentPointCount - 1),
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      pixelRatio: this.renderer.getPixelRatio(),
      audioMultiplier: this.audioMultiplier,
    };
  }

  dispose() {
    this.field.geometry.dispose();
    this.material.dispose();
    this.paletteTexture.dispose();
    this.renderer.dispose();
  }
}
