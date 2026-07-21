# Fibonacci Audio Field

A modular Three.js rewrite of the supplied Pygame Fibonacci/phyllotaxis visualizer. The original algorithm—golden-angle placement, square-root radial growth, audio-driven rotation, density, scale, warp, point size, and colormap—is retained and expanded into a real-time browser application.

## Highlights

- Real-time Web Audio API FFT analysis with bass, mid, treble, RMS, peak, spectral centroid, and beat detection.
- One-draw-call GPU field. Fibonacci positions, motion, depth, sizing, and palette lookup are calculated in shaders rather than by creating thousands of JavaScript objects per frame.
- Circle, square, and triangle point sprites.
- Local audio loading through file picker or drag and drop.
- Orbit camera controls, camera presets, responsive/16:9/9:16/1:1 viewports, grid, safe area, and fullscreen mode.
- Technical HUD with FFT bars, band meters, FPS, point count, draw calls, and playback time.
- Real-time video export through `MediaRecorder`, including the loaded audio where supported.
- PNG export at current, 1080p, 1440p, or 4K resolution.
- JSON settings import/export, persistent local settings, reset, and four visual presets.
- Synthetic demo signal, so the visualizer remains active before an audio file is loaded.

## Run Locally

ES modules require a local web server. From the project folder, use one of these commands:

```bash
python -m http.server 8080
```

or

```bash
npx serve .
```

Then open `http://localhost:8080`.

## Controls

- Left drag: rotate camera
- Right drag: pan camera
- Mouse wheel: zoom
- Spacebar: play/pause
- H: toggle HUD
- G: toggle grid
- F: fullscreen

## Video Export Notes

Video export is real-time. A 3-minute song takes approximately 3 minutes to record. Browser codec support varies:

- Chromium browsers generally support WebM and may support MP4 depending on the installed browser build and operating system.
- Firefox generally supports WebM.
- Safari support depends on version and platform.

The exporter automatically chooses a supported codec when **Auto** is selected. High-resolution export requires substantial GPU memory; reduce the quality preset or point count if 4K export stutters.

## Project Structure

```text
index.html
style.css
assets/js/
  app.js                  Application bootstrap and animation loop
  audio-engine.js         Audio loading, Web Audio graph, FFT analysis, demo signal
  config.js               Defaults, quality, visual, and camera presets
  exporter.js             PNG, settings, and real-time video export
  fibonacci-visualizer.js Three.js renderer and GPU shader field
  hud.js                  On-screen and exported technical HUD
  palettes.js             Palette LUT generation
  state.js                Persistent settings store and import/export
  ui.js                   Sidebar, transport, shortcuts, and runtime UI
  utils.js                Shared formatting and download helpers
vendor/
  three.global.js
  controls/OrbitControls.global.js
```

## Privacy

Audio files are processed locally in the browser. No upload endpoint or analytics service is included.
