import { clamp } from "./utils.js";

const HUD_FONT = '"Rajdhani", sans-serif';
const HUD_MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Consolas, monospace';
const COLORS = Object.freeze({
  accent: "#60a5fa",
  accentStrong: "#3b82f6",
  accentSoft: "rgba(96,165,250,.28)",
  text: "#ffffff",
  muted: "#ffffff",
  subtle: "#ffffff",
  border: "rgba(255,255,255,.12)",
  borderSoft: "rgba(255,255,255,.07)",
  grid: "rgba(255,255,255,.075)",
  panel: "rgba(0,0,0,.66)",
  panelDeep: "rgba(3,7,18,.76)",
});

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

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width * 0.5, height * 0.5));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawPanel(ctx, rectangle, radius, fill = COLORS.panel, stroke = COLORS.border) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.42)";
  ctx.shadowBlur = Math.max(6, radius * 1.65);
  ctx.shadowOffsetY = Math.max(2, radius * 0.35);
  roundedRectPath(ctx, rectangle.x, rectangle.y, rectangle.width, rectangle.height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(0.7, rectangle.width / 900);
  ctx.stroke();
  ctx.restore();
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
    this.logoImage = new Image();
    this.logoReady = false;
    this.logoImage.addEventListener("load", () => { this.logoReady = true; });
    this.logoImage.src = "./AIGOX.svg";
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
      ? { graphWidth: 14, graphHeight: 4.5, metadataWidth: 55, metadataX: 2.5, metadataY: 2.5, textSize: 1.18 }
      : portrait
        ? { graphWidth: 22, graphHeight: 4.5, metadataWidth: 66, metadataX: 2.75, metadataY: 1.5, textSize: 1.38 }
        : { graphWidth: 10, graphHeight: 4.5, metadataWidth: 33, metadataX: 1.5, metadataY: 2.5, textSize: 0.70 };
    const fontSize = Math.max(7, width * (preset.textSize / 100));
    const lineStep = Math.max(fontSize + 2, fontSize * 1.34);
    const pad = Math.max(10, Math.min(width, height) * 0.018);
    const cardPad = Math.max(8, fontSize * 0.85);
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
    const metadataX = width * (preset.metadataX / 100);
    const metadataY = height * (preset.metadataY / 100);
    return {
      fontSize,
      lineStep,
      metadataX,
      metadataY,
      metadata: {
        x: metadataX - cardPad,
        y: metadataY - cardPad,
        width: Math.min(width * (preset.metadataWidth / 100), width - metadataX - pad),
        height: lineStep * 9 + cardPad * 2,
      },
      cardPad,
      pad,
      labelGap,
      frequency: graphRect("top-right"),
      waveform: graphRect("bottom-left"),
      levels: graphRect("bottom-right"),
      square,
      portrait,
    };
  }

  drawToContext(ctx, width, height, metrics, meta, clear = false) {
    if (clear) ctx.clearRect(0, 0, width, height);
    const layout = this.getLayout(width, height);
    const baseLineWidth = Math.max(0.7, width / 1920);
    const radius = Math.max(6, Math.min(width, height) * 0.008);

    ctx.save();
    ctx.textBaseline = "top";

    const outer = {
      x: layout.pad,
      y: layout.pad,
      width: width - layout.pad * 2,
      height: height - layout.pad * 2,
    };
    roundedRectPath(ctx, outer.x, outer.y, outer.width, outer.height, radius * 1.15);
    ctx.strokeStyle = "rgba(96,165,250,.26)";
    ctx.lineWidth = baseLineWidth;
    ctx.stroke();

    const settings = this.state.settings;
    const viewportName = settings.viewportFormat === "landscape" ? "16:9 LANDSCAPE"
      : settings.viewportFormat === "portrait" ? "9:16 PORTRAIT"
        : settings.viewportFormat === "square" ? "1:1 SQUARE" : "RESPONSIVE";
    const maximumFileLength = layout.square ? 30 : 38;
    const lines = [
      "FIBONACCI AUDIO FIELD",
      truncateFileName(meta.fileName, maximumFileLength),
      `MODE  ${meta.mode} / REACT ${formatSettingName(settings.reactionMode)}`,
      `VIEW  ${viewportName} / ORTHOGRAPHIC 2D`,
      `FIELD ${formatSettingName(settings.shape)} / ${formatSettingName(settings.palette)}`,
      `POINTS ${meta.points.toLocaleString()} / BASE ${Number(settings.pointCount).toLocaleString()}`,
      `ANGLE ${Number(settings.goldenAngle).toFixed(2)}° / SPACING ${Number(settings.spacing).toFixed(2)}`,
      `WARP ${Number(settings.warp).toFixed(2)} / SIZE ${Number(settings.pointSize).toFixed(1)} / FFT ${meta.fftSize}`,
      `FPS ${Math.round(meta.fps || 0)} / RMS ${Number(metrics.rms || 0).toFixed(3)}`,
    ];

    for (let index = 0; index < lines.length; index += 1) {
      ctx.font = index === 0
        ? `700 ${layout.fontSize * 1.18}px ${HUD_FONT}`
        : index === 1
          ? `600 ${layout.fontSize * 0.92}px ${HUD_FONT}`
          : `500 ${layout.fontSize * 0.82}px ${HUD_FONT}`;
      ctx.fillStyle = COLORS.text;
      ctx.fillText(lines[index], layout.metadataX, layout.metadataY + index * layout.lineStep);
    }

    this.drawGraphCard(ctx, layout.frequency, "FREQUENCY RESPONSE", radius, baseLineWidth);
    this.drawGraphCard(ctx, layout.waveform, "WAVEFORM", radius, baseLineWidth);
    this.drawGraphCard(ctx, layout.levels, "OUTPUT LEVELS", radius, baseLineWidth);

    this.drawFrequency(ctx, layout.frequency, metrics, baseLineWidth);
    this.drawWaveform(ctx, layout.waveform, metrics, baseLineWidth);
    this.drawLevels(ctx, layout.levels, layout.fontSize, metrics);
    this.drawLogo(ctx, width, height, layout);
    ctx.restore();
  }

  drawGraphCard(ctx, rectangle, label, radius, baseLineWidth) {
    drawPanel(ctx, rectangle, radius * 0.72, COLORS.panelDeep, COLORS.border);
    ctx.save();
    ctx.font = `600 ${Math.max(7, rectangle.height * 0.17)}px ${HUD_FONT}`;
    ctx.fillStyle = COLORS.muted;
    ctx.textBaseline = "bottom";
    ctx.textAlign = rectangle.isRight ? "right" : "left";
    ctx.fillText(label, rectangle.isRight ? rectangle.x + rectangle.width : rectangle.x, rectangle.y - Math.max(5, rectangle.height * 0.10));
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = Math.max(0.35, baseLineWidth * 0.55);
    for (let index = 1; index < 4; index += 1) {
      const x = rectangle.x + (rectangle.width * index) / 4;
      ctx.beginPath();
      ctx.moveTo(x, rectangle.y + 3);
      ctx.lineTo(x, rectangle.y + rectangle.height - 3);
      ctx.stroke();
    }
    for (let index = 1; index < 3; index += 1) {
      const y = rectangle.y + (rectangle.height * index) / 3;
      ctx.beginPath();
      ctx.moveTo(rectangle.x + 3, y);
      ctx.lineTo(rectangle.x + rectangle.width - 3, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawFrequency(ctx, rectangle, metrics, baseLineWidth) {
    const frequencyData = metrics.frequencyData || [];
    if (!frequencyData.length) return;
    const points = Math.min(128, frequencyData.length);
    const inner = 3;
    const drawX = rectangle.x + inner;
    const drawY = rectangle.y + inner;
    const drawWidth = rectangle.width - inner * 2;
    const drawHeight = rectangle.height - inner * 2;
    const fillGradient = ctx.createLinearGradient(0, drawY, 0, drawY + drawHeight);
    fillGradient.addColorStop(0, "rgba(96,165,250,.36)");
    fillGradient.addColorStop(1, "rgba(37,99,235,.035)");
    const strokeGradient = ctx.createLinearGradient(drawX, 0, drawX + drawWidth, 0);
    strokeGradient.addColorStop(0, "#93c5fd");
    strokeGradient.addColorStop(1, "#3b82f6");

    ctx.save();
    roundedRectPath(ctx, rectangle.x, rectangle.y, rectangle.width, rectangle.height, Math.max(4, rectangle.height * 0.12));
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(drawX, drawY + drawHeight);
    for (let index = 0; index < points; index += 1) {
      const sourceIndex = Math.floor((index / Math.max(1, points - 1)) * (frequencyData.length - 1));
      const value = clamp((frequencyData[sourceIndex] || 0) / 255, 0, 1);
      const x = drawX + (index / Math.max(1, points - 1)) * drawWidth;
      const y = drawY + drawHeight - value * drawHeight;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(drawX + drawWidth, drawY + drawHeight);
    ctx.closePath();
    ctx.fillStyle = fillGradient;
    ctx.fill();
    ctx.strokeStyle = strokeGradient;
    ctx.lineWidth = Math.max(1, baseLineWidth * 1.35);
    ctx.stroke();
    ctx.restore();
  }

  drawWaveform(ctx, rectangle, metrics, baseLineWidth) {
    const waveform = metrics.waveformData || [];
    if (!waveform.length) return;
    const points = Math.min(128, waveform.length);
    const inner = 3;
    const waveformY = rectangle.y + inner;
    const waveformHeight = rectangle.height - inner * 2;
    const middleY = waveformY + waveformHeight * 0.5;
    const drawWidth = rectangle.width - inner * 2;

    ctx.save();
    roundedRectPath(ctx, rectangle.x, rectangle.y, rectangle.width, rectangle.height, Math.max(4, rectangle.height * 0.12));
    ctx.clip();
    ctx.beginPath();
    for (let index = 0; index < points; index += 1) {
      const sourceIndex = Math.floor((index / Math.max(1, points - 1)) * (waveform.length - 1));
      const sample = ((waveform[sourceIndex] || 128) - 128) / 128;
      const x = rectangle.x + inner + (index / Math.max(1, points - 1)) * drawWidth;
      const y = middleY - sample * waveformHeight * 0.43;
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#93c5fd";
    ctx.lineWidth = Math.max(1, baseLineWidth * 1.25);
    ctx.shadowColor = "rgba(59,130,246,.46)";
    ctx.shadowBlur = Math.max(3, rectangle.height * 0.10);
    ctx.stroke();
    ctx.restore();
  }

  drawLogo(ctx, width, height, layout) {
    if (!this.logoReady || !this.logoImage.naturalWidth || !this.logoImage.naturalHeight) return;
    const ratio = width / Math.max(1, height);
    const portrait = this.state.get("viewportFormat") === "portrait" || ratio < 0.75;
    const square = this.state.get("viewportFormat") === "square" || (!portrait && ratio >= 0.75 && ratio <= 1.25);
    const sizePercent = portrait ? 14 : square ? 10 : 5.5;
    const yPercent = portrait ? 3.5 : 5;
    const drawWidth = width * (sizePercent / 100);
    const drawHeight = drawWidth * (this.logoImage.naturalHeight / this.logoImage.naturalWidth);
    const centerX = width * 0.5;
    const centerY = height * (yPercent / 100);
    ctx.save();
    ctx.globalAlpha = 0.86;
    ctx.shadowColor = "rgba(59,130,246,.22)";
    ctx.shadowBlur = Math.max(5, drawWidth * 0.08);
    ctx.drawImage(this.logoImage, centerX - drawWidth / 2, centerY - drawHeight / 2, drawWidth, drawHeight);
    ctx.restore();
  }

  drawLevels(ctx, rectangle, graphFontSize, metrics) {
    const innerPad = Math.max(3, rectangle.height * 0.16);
    const top = rectangle.y + innerPad;
    const usableHeight = rectangle.height - innerPad * 2;
    const rowGap = Math.max(2, usableHeight * 0.15);
    const rowHeight = (usableHeight - rowGap) / 2;
    const meterFont = Math.max(6, graphFontSize * 0.72);
    const leftPad = Math.max(4, rectangle.width * 0.025);
    const labelWidth = Math.max(16, meterFont * 2.75);
    const labelX = rectangle.x + leftPad;
    const meterX = labelX + labelWidth;
    const meterWidth = rectangle.x + rectangle.width - meterX - leftPad;
    const peak = clamp(metrics.peak || 0, 0, 1);
    const rms = clamp(metrics.rms || 0, 0, 1);
    const meterGradient = ctx.createLinearGradient(meterX, 0, meterX + meterWidth, 0);
    meterGradient.addColorStop(0, "#2563eb");
    meterGradient.addColorStop(1, "#93c5fd");

    ctx.save();
    ctx.font = `600 ${meterFont}px ${HUD_FONT}`;
    ctx.textBaseline = "middle";
    const drawRow = (rowIndex, label, value, hold) => {
      const rowY = top + rowIndex * (rowHeight + rowGap);
      const middleY = rowY + rowHeight * 0.5;
      ctx.textAlign = "left";
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(label, labelX, middleY);
      roundedRectPath(ctx, meterX, rowY, meterWidth, rowHeight, Math.max(2, rowHeight * 0.5));
      ctx.fillStyle = "rgba(255,255,255,.08)";
      ctx.fill();
      if (value > 0) {
        roundedRectPath(ctx, meterX, rowY, Math.max(1, value * meterWidth), rowHeight, Math.max(2, rowHeight * 0.5));
        ctx.fillStyle = meterGradient;
        ctx.fill();
      }
      if (hold != null) {
        const holdX = meterX + clamp(hold, 0, 1) * meterWidth;
        ctx.fillStyle = "rgba(255,255,255,.92)";
        ctx.fillRect(clamp(holdX - 0.75, meterX, meterX + meterWidth - 1.5), rowY, 1.5, rowHeight);
      }
    };
    drawRow(0, "PK", peak, peak);
    drawRow(1, "RMS", rms, null);
    ctx.restore();
  }
}
