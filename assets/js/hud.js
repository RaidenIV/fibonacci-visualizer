import { clamp } from "./utils.js";

const HUD_FONT = '"Cozette", "CozetteVector", ui-monospace, SFMono-Regular, Consolas, monospace';

function truncateFileName(fileName, maximumLength) {
  const normalized = String(fileName || "NO AUDIO FILE").toUpperCase();
  if (normalized.length <= maximumLength) return normalized;
  const extensionIndex = normalized.lastIndexOf(".");
  const extension = extensionIndex > 0 ? normalized.slice(extensionIndex) : "";
  const baseLength = Math.max(4, maximumLength - extension.length - 1);
  return `${normalized.slice(0, baseLength)}…${extension}`;
}

function formatSettingName(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .toUpperCase();
}

export class HudRenderer {
  constructor(canvas, state) {
    this.canvas = canvas;
    this.state = state;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this.lastWidth = 0;
    this.lastHeight = 0;
    this.fps = 0;
    this.frameCounter = 0;
    this.lastFpsAt = performance.now();
    this.lastDrawAt = 0;
  }

  updateFps(now) {
    this.frameCounter += 1;
    const elapsed = now - this.lastFpsAt;
    if (elapsed >= 500) {
      this.fps = this.frameCounter / (elapsed / 1000);
      this.frameCounter = 0;
      this.lastFpsAt = now;
    }
    return this.fps;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (width === this.lastWidth && height === this.lastHeight) return;
    this.lastWidth = width;
    this.lastHeight = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  draw(metrics, meta, now = performance.now()) {
    this.resize();
    const width = this.canvas.width;
    const height = this.canvas.height;
    this.ctx.clearRect(0, 0, width, height);
    if (!this.state.get("showHud")) return;
    this.drawToContext(this.ctx, width, height, metrics, meta, false);
    this.lastDrawAt = now;
  }

  getLayout(width, height) {
    const format = this.state.get("viewportFormat");
    const ratio = width / Math.max(1, height);
    const portrait = format === "portrait" || ratio < 0.75;
    const square = format === "square" || (!portrait && ratio >= 0.75 && ratio <= 1.25);
    const preset = square
      ? { graphWidth: 14, graphHeight: 4.5, metadataX: 2.5, metadataY: 2.5, textSize: 1.25 }
      : portrait
        ? { graphWidth: 22, graphHeight: 4.5, metadataX: 2.75, metadataY: 1.5, textSize: 1.5 }
        : { graphWidth: 10, graphHeight: 4.5, metadataX: 1.5, metadataY: 2.5, textSize: 0.75 };
    const fontSize = Math.max(6, width * (preset.textSize / 100));
    const lineStep = Math.max(fontSize + 2, fontSize * 1.34);
    const pad = Math.max(10, Math.min(width, height) * 0.018);
    const graphWidth = width * (preset.graphWidth / 100);
    const graphHeight = height * (preset.graphHeight / 100);
    const labelGap = Math.max(4, fontSize * 0.55);
    const graphRect = (placement) => {
      const isRight = placement.endsWith("right");
      const isTop = placement.startsWith("top");
      return {
        x: isRight ? width - pad - graphWidth - 8 : pad + 9,
        y: isTop ? pad + fontSize + labelGap + 8 : height - pad - graphHeight - 9,
        width: graphWidth,
        height: graphHeight,
        isRight,
      };
    };
    return {
      fontSize,
      lineStep,
      metadataX: width * (preset.metadataX / 100),
      metadataY: height * (preset.metadataY / 100),
      pad,
      labelGap,
      frequency: graphRect("top-right"),
      waveform: graphRect("bottom-left"),
      levels: graphRect("bottom-right"),
      square,
    };
  }

  drawToContext(ctx, width, height, metrics, meta, clear = false) {
    if (clear) ctx.clearRect(0, 0, width, height);
    const layout = this.getLayout(width, height);
    const line = "rgba(255,255,255,.90)";
    const faint = "rgba(255,255,255,.18)";
    const veryFaint = "rgba(255,255,255,.08)";
    const baseLineWidth = Math.max(0.6, width / 1920);

    ctx.save();
    ctx.lineWidth = baseLineWidth;
    ctx.strokeStyle = line;
    ctx.fillStyle = line;
    ctx.font = `${layout.fontSize}px ${HUD_FONT}`;
    ctx.textBaseline = "top";

    ctx.strokeRect(layout.pad, layout.pad, width - layout.pad * 2, height - layout.pad * 2);

    for (let index = 0; index <= 10; index += 1) {
      const x = layout.pad + ((width - layout.pad * 2) * index) / 10;
      const y = layout.pad + ((height - layout.pad * 2) * index) / 10;
      const tickSize = index % 5 === 0 ? 7 : 4;
      ctx.beginPath();
      ctx.moveTo(x, layout.pad);
      ctx.lineTo(x, layout.pad + tickSize);
      ctx.moveTo(x, height - layout.pad);
      ctx.lineTo(x, height - layout.pad - tickSize);
      ctx.moveTo(layout.pad, y);
      ctx.lineTo(layout.pad + tickSize, y);
      ctx.moveTo(width - layout.pad, y);
      ctx.lineTo(width - layout.pad - tickSize, y);
      ctx.stroke();
    }

    const settings = this.state.settings;
    const viewportName = settings.viewportFormat === "landscape" ? "16:9 LANDSCAPE"
      : settings.viewportFormat === "portrait" ? "9:16 PORTRAIT"
        : settings.viewportFormat === "square" ? "1:1 SQUARE" : "RESPONSIVE";
    const maximumFileLength = layout.square ? 30 : 38;
    const lines = [
      [0, "SYS/FIBONACCI AUDIO FIELD"],
      [1, truncateFileName(meta.fileName, maximumFileLength)],
      [2, `MODE:${meta.mode}`],
      [3, `VIEW:${viewportName} / ORTHOGRAPHIC 2D`],
      [4, `FIELD:${formatSettingName(settings.shape)} / ${formatSettingName(settings.palette)}`],
      [5, `POINTS:${meta.points.toLocaleString()} / BASE:${Number(settings.pointCount).toLocaleString()}`],
      [6, `ANGLE:${Number(settings.goldenAngle).toFixed(2)} DEG / SPACING:${Number(settings.spacing).toFixed(2)}`],
      [7, `WARP:${Number(settings.warp).toFixed(2)} / SIZE:${Number(settings.pointSize).toFixed(1)} / FFT:${meta.fftSize}`],
      [8, `FPS:${Math.round(meta.fps || 0)} / RMS:${Number(metrics.rms || 0).toFixed(3)}`],
    ];
    for (const [lineIndex, text] of lines) {
      ctx.fillText(text, layout.metadataX, layout.metadataY + lineIndex * layout.lineStep);
    }

    const rectangles = [layout.frequency, layout.waveform, layout.levels];
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,.92)";
    for (const rectangle of rectangles) ctx.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    ctx.restore();

    const drawGraphLabel = (text, rectangle) => {
      ctx.save();
      ctx.font = `${layout.fontSize}px ${HUD_FONT}`;
      ctx.fillStyle = line;
      ctx.textBaseline = "top";
      ctx.textAlign = rectangle.isRight ? "right" : "left";
      ctx.fillText(text, rectangle.isRight ? rectangle.x + rectangle.width : rectangle.x, rectangle.y - layout.fontSize - layout.labelGap);
      ctx.restore();
    };
    drawGraphLabel("FR MAGNITUDE dB V/V", layout.frequency);
    drawGraphLabel("WAVEFORM", layout.waveform);
    drawGraphLabel("LEVELS dBFS", layout.levels);

    ctx.strokeStyle = line;
    for (const rectangle of rectangles) ctx.strokeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);

    const frequencyToX = (frequencyHz) => {
      const normalized = Math.log10(frequencyHz / 20) / Math.log10(20000 / 20);
      return layout.frequency.x + normalized * layout.frequency.width;
    };
    ctx.save();
    ctx.lineWidth = Math.max(0.35, baseLineWidth * 0.5);
    for (let decade = 10; decade <= 10000; decade *= 10) {
      for (let multiple = 2; multiple <= 9; multiple += 1) {
        const frequencyHz = decade * multiple;
        if (frequencyHz <= 20 || frequencyHz >= 20000) continue;
        const x = frequencyToX(frequencyHz);
        ctx.strokeStyle = veryFaint;
        ctx.beginPath();
        ctx.moveTo(x, layout.frequency.y);
        ctx.lineTo(x, layout.frequency.y + layout.frequency.height);
        ctx.stroke();
      }
    }
    for (const frequencyHz of [100, 1000, 10000]) {
      const x = frequencyToX(frequencyHz);
      ctx.strokeStyle = faint;
      ctx.beginPath();
      ctx.moveTo(x, layout.frequency.y);
      ctx.lineTo(x, layout.frequency.y + layout.frequency.height);
      ctx.stroke();
    }
    ctx.strokeStyle = faint;
    for (let index = 1; index < 5; index += 1) {
      const y = layout.frequency.y + layout.frequency.height * (index / 5);
      ctx.beginPath();
      ctx.moveTo(layout.frequency.x, y);
      ctx.lineTo(layout.frequency.x + layout.frequency.width, y);
      ctx.stroke();
    }
    for (let index = 1; index < 4; index += 1) {
      const waveformX = layout.waveform.x + (layout.waveform.width * index) / 4;
      ctx.beginPath();
      ctx.moveTo(waveformX, layout.waveform.y + 3);
      ctx.lineTo(waveformX, layout.waveform.y + layout.waveform.height - 3);
      ctx.stroke();
      const levelX = layout.levels.x + (layout.levels.width * index) / 4;
      ctx.beginPath();
      ctx.moveTo(levelX, layout.levels.y + 3);
      ctx.lineTo(levelX, layout.levels.y + layout.levels.height - 3);
      ctx.stroke();
    }
    ctx.restore();

    const frequencyData = metrics.frequencyData || [];
    if (frequencyData.length) {
      const points = Math.min(128, frequencyData.length);
      ctx.save();
      ctx.beginPath();
      ctx.rect(layout.frequency.x, layout.frequency.y, layout.frequency.width, layout.frequency.height);
      ctx.clip();
      ctx.beginPath();
      ctx.moveTo(layout.frequency.x, layout.frequency.y + layout.frequency.height);
      for (let index = 0; index < points; index += 1) {
        const sourceIndex = Math.floor((index / Math.max(1, points - 1)) * (frequencyData.length - 1));
        const value = clamp((frequencyData[sourceIndex] || 0) / 255, 0, 1);
        const x = layout.frequency.x + (index / Math.max(1, points - 1)) * layout.frequency.width;
        const y = layout.frequency.y + layout.frequency.height - value * layout.frequency.height;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(layout.frequency.x + layout.frequency.width, layout.frequency.y + layout.frequency.height);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,255,255,.19)";
      ctx.fill();
      ctx.strokeStyle = line;
      ctx.lineWidth = baseLineWidth;
      ctx.stroke();
      ctx.restore();
    }

    const waveform = metrics.waveformData || [];
    if (waveform.length) {
      const points = Math.min(128, waveform.length);
      const waveformY = layout.waveform.y + 3;
      const waveformHeight = layout.waveform.height - 6;
      const middleY = waveformY + waveformHeight * 0.5;
      ctx.beginPath();
      for (let index = 0; index < points; index += 1) {
        const sourceIndex = Math.floor((index / Math.max(1, points - 1)) * (waveform.length - 1));
        const sample = ((waveform[sourceIndex] || 128) - 128) / 128;
        const x = layout.waveform.x + (index / Math.max(1, points - 1)) * layout.waveform.width;
        const y = middleY - sample * waveformHeight * 0.44;
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = line;
      ctx.lineWidth = baseLineWidth;
      ctx.stroke();
    }

    this.drawLevels(ctx, layout.levels, layout.fontSize, line, metrics);
    ctx.restore();
  }

  drawLevels(ctx, rectangle, graphFontSize, line, metrics) {
    const innerPad = Math.max(2, rectangle.height * 0.16);
    const top = rectangle.y + innerPad;
    const usableHeight = rectangle.height - innerPad * 2;
    const rowGap = Math.max(2, usableHeight * 0.16);
    const rowHeight = (usableHeight - rowGap) / 2;
    const meterFont = Math.max(5, graphFontSize * 0.82);
    const leftPad = Math.max(3, rectangle.width * 0.02);
    const labelWidth = Math.max(14, meterFont * 2.6);
    const labelX = rectangle.x + leftPad;
    const meterX = labelX + labelWidth;
    const meterWidth = rectangle.x + rectangle.width - meterX - leftPad;
    const peak = clamp(metrics.peak || 0, 0, 1);
    const rms = clamp(metrics.rms || 0, 0, 1);

    ctx.save();
    ctx.font = `${meterFont}px ${HUD_FONT}`;
    ctx.textBaseline = "middle";
    const drawRow = (rowIndex, label, value, hold) => {
      const rowY = top + rowIndex * (rowHeight + rowGap);
      const middleY = rowY + rowHeight * 0.5;
      ctx.textAlign = "left";
      ctx.fillStyle = line;
      ctx.fillText(label, labelX, middleY);
      ctx.fillStyle = "rgba(255,255,255,.82)";
      ctx.fillRect(meterX, rowY, value * meterWidth, rowHeight);
      if (hold != null) {
        const holdX = meterX + clamp(hold, 0, 1) * meterWidth;
        ctx.fillStyle = line;
        ctx.fillRect(clamp(holdX - 0.75, meterX, meterX + meterWidth - 1.5), rowY, 1.5, rowHeight);
      }
    };
    drawRow(0, "PK", peak, peak);
    drawRow(1, "RMS", rms, null);
    ctx.restore();
  }
}
