import { clamp, formatTime } from "./utils.js";

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
    const ctx = this.ctx;
    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.clearRect(0, 0, width, height);
    if (!this.state.get("showHud")) return;
    this.drawToContext(ctx, width, height, metrics, meta, true);
    this.lastDrawAt = now;
  }

  drawToContext(ctx, width, height, metrics, meta, clear = false) {
    if (clear) ctx.clearRect(0, 0, width, height);
    const scale = Math.max(0.75, width / 1920);
    const margin = 28 * scale;
    const accent = "rgba(255,255,255,.88)";
    const dim = "rgba(255,255,255,.42)";
    const faint = "rgba(255,255,255,.13)";
    ctx.save();
    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeStyle = faint;
    ctx.strokeRect(margin, margin, width - margin * 2, height - margin * 2);
    const corner = 28 * scale;
    ctx.strokeStyle = accent;
    for (const [x, y, sx, sy] of [[margin,margin,1,1],[width-margin,margin,-1,1],[margin,height-margin,1,-1],[width-margin,height-margin,-1,-1]]) {
      ctx.beginPath(); ctx.moveTo(x, y + sy * corner); ctx.lineTo(x, y); ctx.lineTo(x + sx * corner, y); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,.08)";
    ctx.beginPath(); ctx.moveTo(width / 2 - 9 * scale, height / 2); ctx.lineTo(width / 2 + 9 * scale, height / 2); ctx.moveTo(width / 2, height / 2 - 9 * scale); ctx.lineTo(width / 2, height / 2 + 9 * scale); ctx.stroke();

    const font = `${Math.max(10, 12 * scale)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
    const smallFont = `${Math.max(8, 10 * scale)}px ui-monospace, SFMono-Regular, Consolas, monospace`;
    ctx.font = font;
    ctx.fillStyle = accent;
    ctx.textBaseline = "top";
    ctx.fillText(`FIBONACCI FIELD // ${meta.mode}`, margin + 12 * scale, margin + 12 * scale);
    ctx.font = smallFont;
    ctx.fillStyle = dim;
    ctx.fillText(`${Math.round(meta.fps)} FPS  |  ${meta.points.toLocaleString()} POINTS  |  ${meta.drawCalls} DRAW CALL`, margin + 12 * scale, margin + 32 * scale);

    const rightText = `${formatTime(meta.currentTime)} / ${formatTime(meta.duration)}`;
    ctx.textAlign = "right";
    ctx.fillText(rightText, width - margin - 12 * scale, margin + 13 * scale);
    ctx.textAlign = "left";

    const graphWidth = Math.min(width * 0.36, 520 * scale);
    const graphHeight = 82 * scale;
    const graphX = margin + 12 * scale;
    const graphY = height - margin - graphHeight - 18 * scale;
    ctx.fillStyle = "rgba(0,0,0,.32)";
    ctx.fillRect(graphX, graphY, graphWidth, graphHeight);
    ctx.strokeStyle = "rgba(255,255,255,.12)";
    ctx.strokeRect(graphX, graphY, graphWidth, graphHeight);

    const frequencyData = metrics.frequencyData || [];
    if (frequencyData.length) {
      const bars = Math.min(96, frequencyData.length);
      const barWidth = graphWidth / bars;
      for (let index = 0; index < bars; index += 1) {
        const sourceIndex = Math.floor(index / bars * frequencyData.length);
        const value = frequencyData[sourceIndex] / 255;
        const barHeight = value * (graphHeight - 8 * scale);
        ctx.fillStyle = `rgba(255,255,255,${0.18 + value * 0.72})`;
        ctx.fillRect(graphX + index * barWidth, graphY + graphHeight - barHeight, Math.max(1, barWidth - 1), barHeight);
      }
    }

    const meterX = width - margin - 250 * scale;
    const meterY = height - margin - 104 * scale;
    const meters = [["BASS", metrics.bass], ["MID", metrics.mid], ["TREBLE", metrics.treble], ["ENERGY", metrics.energy]];
    ctx.font = smallFont;
    for (let index = 0; index < meters.length; index += 1) {
      const y = meterY + index * 24 * scale;
      ctx.fillStyle = dim;
      ctx.fillText(meters[index][0], meterX, y);
      ctx.fillStyle = "rgba(255,255,255,.12)";
      ctx.fillRect(meterX + 64 * scale, y + 1 * scale, 178 * scale, 8 * scale);
      ctx.fillStyle = accent;
      ctx.fillRect(meterX + 64 * scale, y + 1 * scale, 178 * scale * clamp(meters[index][1], 0, 1), 8 * scale);
    }
    ctx.restore();
  }
}
