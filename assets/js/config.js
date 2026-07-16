export const MAX_POINTS = 8000;
export const SETTINGS_VERSION = 2;

export const DEFAULTS = Object.freeze({
  shape: "circle",
  pointCount: 300,
  spacing: 1,
  pointSize: 2,
  goldenAngle: 137.5,
  warp: 0.3,
  depth: 0,
  depthFrequency: 0.045,
  sensitivity: 1.6,
  smoothing: 0.78,
  audioScale: 1,
  audioDensity: 1,
  audioSize: 1,
  audioRotation: 1,
  audioDepth: 0,
  rotationSpeed: 0,
  palette: "cmrmapReverse",
  colorCycle: 0,
  opacity: 1,
  additive: false,
  volume: 1,
  muted: false,
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
  exportFormat: "mp4",
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
    shape: "circle", pointCount: 300, spacing: 1, pointSize: 2, goldenAngle: 137.5,
    warp: 0.3, depth: 0, sensitivity: 1.6, audioScale: 1, audioDensity: 1,
    audioSize: 1, audioRotation: 1, audioDepth: 0, rotationSpeed: 0,
    palette: "cmrmapReverse", colorCycle: 0, opacity: 1, additive: false,
  },
  calm: {
    pointCount: 500, spacing: 0.92, pointSize: 1.8, warp: 0.16, depth: 0,
    sensitivity: 1, audioScale: 0.55, audioDensity: 0.3, audioSize: 0.45,
    audioRotation: 0.35, audioDepth: 0, rotationSpeed: 0.03, palette: "ice",
    colorCycle: 0.02, opacity: 0.84, additive: false,
  },
  reactive: {
    pointCount: 900, spacing: 0.78, pointSize: 2.4, warp: 0.55, depth: 0,
    sensitivity: 2.25, audioScale: 1.8, audioDensity: 1, audioSize: 1.65,
    audioRotation: 1.9, audioDepth: 0, rotationSpeed: 0.08, palette: "inferno",
    colorCycle: 0.1, opacity: 0.95, additive: true,
  },
  tunnel: {
    pointCount: 1800, spacing: 0.62, pointSize: 1.7, warp: 0.2, depth: 0,
    sensitivity: 1.8, audioScale: 0.75, audioDensity: 0.55,
    audioSize: 0.85, audioRotation: 1.5, audioDepth: 0, rotationSpeed: -0.08,
    palette: "plasma", colorCycle: -0.06, opacity: 0.8, additive: true,
  },
});
