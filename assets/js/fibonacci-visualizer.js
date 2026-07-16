import { CAMERA_PRESETS, MAX_POINTS, QUALITY_PRESETS } from "./config.js";
import { clamp } from "./utils.js";
import { createPaletteTexture } from "./palettes.js";

const vertexShader = `
  precision highp float;
  attribute float aIndex;
  uniform float uCount;
  uniform float uTime;
  uniform float uRotation;
  uniform float uGoldenAngle;
  uniform float uSpacing;
  uniform float uPointSize;
  uniform float uWarp;
  uniform float uDepth;
  uniform float uDepthFrequency;
  uniform float uEnergy;
  uniform float uBass;
  uniform float uMid;
  uniform float uTreble;
  uniform float uBeat;
  uniform float uAudioScale;
  uniform float uAudioSize;
  uniform float uAudioDepth;
  varying float vIndex;
  varying float vEnergy;

  void main() {
    float i = aIndex + 1.0;
    float normalized = i / max(1.0, uCount);
    float dynamicAngle = uGoldenAngle + uEnergy * 0.0078125 + uTreble * 0.003;
    float angle = i * dynamicAngle + uRotation + sin(uTime * 0.19 + i * 0.0009) * uMid * 0.14;
    float scale = uSpacing * (1.0 + uEnergy * uAudioScale);
    float radialWarp = 1.0 + uWarp * sin(uEnergy * i / 50.0 + uTime * 0.55) + uBeat * 0.055;
    float radius = scale * sqrt(i) * radialWarp;
    float depthWave = sin(i * uDepthFrequency + uTime * (0.32 + uTreble * 0.2));
    float spiralWave = cos(angle * 2.0 + uTime * 0.22) * uMid * 0.22;
    float z = (depthWave + spiralWave) * uDepth * (1.0 + uBass * uAudioDepth);
    vec3 transformed = vec3(radius * cos(angle), radius * sin(angle), z);
    vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float perspectiveScale = 360.0 / max(1.0, -mvPosition.z);
    float sizePulse = 1.0 + uEnergy * uAudioSize + uBeat * 0.45;
    gl_PointSize = clamp(uPointSize * sizePulse * perspectiveScale, 1.0, 84.0);
    vIndex = normalized;
    vEnergy = uEnergy;
  }
`;

const fragmentShader = `
  precision highp float;
  uniform sampler2D uPalette;
  uniform float uTime;
  uniform float uColorCycle;
  uniform float uOpacity;
  uniform float uShape;
  uniform float uBeat;
  varying float vIndex;
  varying float vEnergy;

  void main() {
    vec2 uv = gl_PointCoord;
    vec2 p = vec2(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0);
    float edge = 1.0;
    if (uShape < 0.5) {
      float distanceFromCenter = length(p);
      if (distanceFromCenter > 1.0) discard;
      edge = smoothstep(1.0, 0.72, distanceFromCenter);
    } else if (uShape < 1.5) {
      float maxAxis = max(abs(p.x), abs(p.y));
      edge = smoothstep(1.0, 0.78, maxAxis);
    } else {
      if (p.y < -1.0 || p.y > 1.0 - 2.0 * abs(p.x)) discard;
      float sideDistance = (1.0 - p.y) * 0.5 - abs(p.x);
      float baseDistance = p.y + 1.0;
      edge = smoothstep(0.0, 0.16, min(sideDistance, baseDistance));
    }
    float palettePosition = fract(vIndex + uTime * uColorCycle + vEnergy * 0.08);
    vec3 color = texture2D(uPalette, vec2(palettePosition, 0.5)).rgb;
    color *= 0.88 + vEnergy * 0.32 + uBeat * 0.18;
    float alpha = uOpacity * mix(0.58, 1.0, edge);
    gl_FragColor = vec4(color, alpha);
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
    this.scene.background = new THREE.Color(0x030303);
    this.camera = new THREE.PerspectiveCamera(state.get("fov"), 1, 0.1, 1200);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.controls = new THREE.OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.065;
    this.controls.enablePan = true;
    this.controls.minDistance = 25;
    this.controls.maxDistance = 420;
    this.controls.target.set(0, 0, 0);
    this.rotation = 0;
    this.currentPointCount = state.get("pointCount");
    this.lastWidth = 0;
    this.lastHeight = 0;
    this.paletteTexture = createPaletteTexture(THREE, state.get("palette"));
    this.buildField();
    this.buildGrid();
    this.setCameraPreset("front", false);
    this.applyAllSettings();
  }

  buildField() {
    const { THREE } = this;
    const geometry = new THREE.BufferGeometry();
    const indices = new Float32Array(MAX_POINTS);
    for (let index = 0; index < MAX_POINTS; index += 1) indices[index] = index;
    geometry.setAttribute("aIndex", new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, this.state.get("pointCount"));
    this.uniforms = {
      uCount: { value: this.state.get("pointCount") }, uTime: { value: 0 }, uRotation: { value: 0 },
      uGoldenAngle: { value: THREE.MathUtils.degToRad(this.state.get("goldenAngle")) }, uSpacing: { value: this.state.get("spacing") },
      uPointSize: { value: this.state.get("pointSize") }, uWarp: { value: this.state.get("warp") }, uDepth: { value: this.state.get("depth") },
      uDepthFrequency: { value: this.state.get("depthFrequency") }, uEnergy: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 },
      uTreble: { value: 0 }, uBeat: { value: 0 }, uAudioScale: { value: this.state.get("audioScale") },
      uAudioSize: { value: this.state.get("audioSize") }, uAudioDepth: { value: this.state.get("audioDepth") },
      uPalette: { value: this.paletteTexture }, uColorCycle: { value: this.state.get("colorCycle") },
      uOpacity: { value: this.state.get("opacity") }, uShape: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false,
      depthTest: true, blending: THREE.AdditiveBlending,
    });
    this.field = new THREE.Points(geometry, this.material);
    this.field.frustumCulled = false;
    this.scene.add(this.field);
  }

  buildGrid() {
    const { THREE } = this;
    this.grid = new THREE.GridHelper(180, 24, 0x353535, 0x151515);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.38;
    this.grid.visible = this.state.get("showGrid");
    this.scene.add(this.grid);
    const ambient = new THREE.AmbientLight(0xffffff, 0.2);
    this.scene.add(ambient);
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
      case "depth": this.uniforms.uDepth.value = value; break;
      case "depthFrequency": this.uniforms.uDepthFrequency.value = value; break;
      case "audioScale": this.uniforms.uAudioScale.value = value; break;
      case "audioSize": this.uniforms.uAudioSize.value = value; break;
      case "audioDepth": this.uniforms.uAudioDepth.value = value; break;
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
      case "showGrid": this.grid.visible = value; break;
      case "fov": this.camera.fov = value; this.camera.updateProjectionMatrix(); break;
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
    const energy = clamp(metrics.energy, 0, 2.5);
    const densityBoost = Math.round(energy * settings.audioDensity * 3400);
    this.currentPointCount = Math.min(MAX_POINTS, quality.pointLimit, Math.max(1, settings.pointCount + densityBoost));
    this.field.geometry.setDrawRange(0, this.currentPointCount);
    this.rotation += delta * (settings.rotationSpeed + energy * settings.audioRotation * 0.24);
    this.uniforms.uCount.value = this.currentPointCount;
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uRotation.value = this.rotation;
    this.uniforms.uEnergy.value = energy;
    this.uniforms.uBass.value = metrics.bass;
    this.uniforms.uMid.value = metrics.mid;
    this.uniforms.uTreble.value = metrics.treble;
    this.uniforms.uBeat.value = metrics.beat;
    if (settings.autoOrbit) {
      const radius = 132;
      const phase = elapsed * 0.08;
      this.camera.position.x = Math.sin(phase) * radius;
      this.camera.position.z = Math.cos(phase) * radius;
      this.camera.position.y = 42 + Math.sin(phase * 0.7) * 20;
      this.camera.lookAt(this.controls.target);
    }
    this.controls.enabled = !settings.autoOrbit;
    this.controls.update();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  resize(force = false) {
    const width = Math.max(1, this.frame.clientWidth);
    const height = Math.max(1, this.frame.clientHeight);
    if (!force && width === this.lastWidth && height === this.lastHeight) return;
    this.lastWidth = width;
    this.lastHeight = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setCameraPreset(name, animate = true) {
    const preset = CAMERA_PRESETS[name] || CAMERA_PRESETS.front;
    const startPosition = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const endPosition = new this.THREE.Vector3(...preset.position);
    const endTarget = new this.THREE.Vector3(...preset.target);
    if (!animate) {
      this.camera.position.copy(endPosition);
      this.controls.target.copy(endTarget);
      this.controls.update();
      return;
    }
    const startedAt = performance.now();
    const duration = 420;
    const step = () => {
      const t = clamp((performance.now() - startedAt) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(startPosition, endPosition, eased);
      this.controls.target.lerpVectors(startTarget, endTarget, eased);
      this.controls.update();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  fitView() {
    this.setCameraPreset("front");
  }

  getStats() {
    return {
      points: this.currentPointCount,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      pixelRatio: this.renderer.getPixelRatio(),
    };
  }

  dispose() {
    this.field.geometry.dispose();
    this.material.dispose();
    this.paletteTexture.dispose();
    this.renderer.dispose();
  }
}
