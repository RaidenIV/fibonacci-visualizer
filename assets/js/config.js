export const MAX_POINTS = 8000;
export const SETTINGS_VERSION = 1;

export const DEFAULTS = Object.freeze({
  shape: "circle",
  pointCount: 2400,
  spacing: 0.82,
  pointSize: 2.4,
  goldenAngle: 137.5,
  warp: 0.3,
  depth: 8,
  depthFrequency: 0.045,
  sensitivity: 1.6,
  smoothing: 0.78,
  audioScale: 1.15,
  audioDensity: 0.7,
  audioSize: 1.4,
  audioRotation: 1.25,
  audioDepth: 1,
  rotationSpeed: 0.12,
  palette: "cmrmapReverse",
  colorCycle: 0.06,
  opacity: 0.92,
  additive: true,
  volume: 1,
  loopTrack: false,
  demoMode: true,
  viewportFormat: "responsive",
  fov: 45,
  autoOrbit: false,
  showGrid: false,
  showHud: true,
  showSafeArea: false,
  quality: "balanced",
  exportResolution: "current",
  exportFps: 60,
  exportFormat: "auto",
  exportBitrate: 16,
  exportRange: "current",
  exportFileName: "fibonacci-audio-field",
});

export const QUALITY_PRESETS = Object.freeze({
  performance: { pixelRatio: 1, pointLimit: 3200, hudFps: 20 },
  balanced: { pixelRatio: 1.5, pointLimit: 5600, hudFps: 30 },
  high: { pixelRatio: 2, pointLimit: 7200, hudFps: 45 },
  maximum: { pixelRatio: 2.5, pointLimit: MAX_POINTS, hudFps: 60 },
});

export const VISUAL_PRESETS = Object.freeze({
  original: {
    shape: "circle", pointCount: 300, spacing: 1.25, pointSize: 2.2, goldenAngle: 137.5,
    warp: 0.3, depth: 0, sensitivity: 1.35, audioScale: 1, audioDensity: 1,
    audioSize: 1.8, audioRotation: 1.1, audioDepth: 0, rotationSpeed: 0.12,
    palette: "cmrmapReverse", colorCycle: 0, opacity: 1, additive: false,
  },
  calm: {
    pointCount: 1800, spacing: 0.9, pointSize: 2, warp: 0.12, depth: 4,
    sensitivity: 1, audioScale: 0.55, audioDensity: 0.25, audioSize: 0.55,
    audioRotation: 0.35, audioDepth: 0.4, rotationSpeed: 0.06, palette: "ice",
    colorCycle: 0.025, opacity: 0.82, additive: true,
  },
  reactive: {
    pointCount: 3200, spacing: 0.72, pointSize: 2.8, warp: 0.55, depth: 12,
    sensitivity: 2.25, audioScale: 1.8, audioDensity: 0.95, audioSize: 2.4,
    audioRotation: 2.15, audioDepth: 2, rotationSpeed: 0.16, palette: "inferno",
    colorCycle: 0.13, opacity: 0.95, additive: true,
  },
  tunnel: {
    pointCount: 5200, spacing: 0.55, pointSize: 2.1, warp: 0.2, depth: 28,
    depthFrequency: 0.075, sensitivity: 1.8, audioScale: 0.75, audioDensity: 0.5,
    audioSize: 1.2, audioRotation: 1.6, audioDepth: 2.8, rotationSpeed: -0.1,
    palette: "plasma", colorCycle: -0.08, opacity: 0.78, additive: true,
  },
});

export const CAMERA_PRESETS = Object.freeze({
  front: { position: [0, 0, 132], target: [0, 0, 0] },
  tilt: { position: [0, 58, 118], target: [0, 0, 0] },
  iso: { position: [92, 72, 96], target: [0, 0, 0] },
  top: { position: [0, 145, 0.01], target: [0, 0, 0] },
});
