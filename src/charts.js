/**
 * High-DPI Interactive Telemetry Charts Engine
 * Supports smooth curves, gradient fills, touch/pointer scrubbing,
 * crosshair indicators, and multi-node dual comparison.
 */

export class TelemetryChart {
  constructor(canvasId, tooltipId, options = {}) {
    this.canvas = document.getElementById(canvasId);
    this.tooltip = document.getElementById(tooltipId);
    if (!this.canvas) return;

    this.ctx = this.canvas.getContext('2d');
    this.metricKey = options.metricKey || 'vbat';
    this.unit = options.unit || 'V';
    this.colorNode1 = options.colorNode1 || '#22D3EE';
    this.colorNode2 = options.colorNode2 || '#A78BFA';
    this.gradientFill = options.gradientFill !== false;
    this.formatDecimals = options.decimals ?? 2;
    this.timeRange = options.timeRange || '15m';

    this.dataNode1 = [];
    this.dataNode2 = [];
    this.scrubbingIndex = null;
    this.scrubbingX = null;

    this.initCanvasSize();
    this.bindEvents();

    window.addEventListener('resize', () => {
      this.initCanvasSize();
      this.render();
    });
  }

  initCanvasSize() {
    if (!this.canvas) return;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;

    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.resetTransform?.();
    this.ctx.scale(dpr, dpr);
  }

  bindEvents() {
    if (!this.canvas) return;

    const handlePointer = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const x = clientX - rect.left;
      this.scrubbingX = Math.max(0, Math.min(this.width, x));
      this.render();
      this.updateTooltip(this.scrubbingX);
    };

    const handlePointerEnd = () => {
      this.scrubbingX = null;
      if (this.tooltip) {
        this.tooltip.style.display = 'none';
      }
      this.render();
    };

    this.canvas.addEventListener('mousemove', handlePointer);
    this.canvas.addEventListener('mouseleave', handlePointerEnd);
    this.canvas.addEventListener('touchstart', handlePointer, { passive: true });
    this.canvas.addEventListener('touchmove', handlePointer, { passive: true });
    this.canvas.addEventListener('touchend', handlePointerEnd);
    this.canvas.addEventListener('touchcancel', handlePointerEnd);
  }

  setTimeRange(range) {
    this.timeRange = range;
    this.render();
  }

  setData(node1Series, node2Series) {
    this.dataNode1 = node1Series || [];
    this.dataNode2 = node2Series || [];
    this.render();
  }

  getWindowMs() {
    if (this.timeRange === '1h') return 60 * 60 * 1000;
    if (this.timeRange === '24h') return 24 * 60 * 60 * 1000;
    return 15 * 60 * 1000;
  }

  filterByRange(series) {
    if (!series || !series.length) return [];
    const now = Date.now();
    const windowMs = this.getWindowMs();
    const cutoff = now - windowMs;

    // Find first index >= cutoff
    let firstIdx = series.findIndex(pt => pt.t >= cutoff);
    if (firstIdx === -1) {
      return [];
    }

    const filtered = series.slice(firstIdx);

    // If there is a point immediately preceding the cutoff, interpolate/anchor at cutoff
    // so the line starts cleanly at the left edge when prior history exists
    if (firstIdx > 0) {
      const prev = series[firstIdx - 1];
      const curr = series[firstIdx];
      const dt = curr.t - prev.t;
      const ratio = dt > 0 ? (cutoff - prev.t) / dt : 0;
      const interpVal = prev.val + (curr.val - prev.val) * Math.max(0, Math.min(1, ratio));
      filtered.unshift({ t: cutoff, val: interpVal });
    }

    return filtered;
  }

  render() {
    if (!this.ctx || !this.width || !this.height) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';

    ctx.clearRect(0, 0, w, h);

    const s1 = this.filterByRange(this.dataNode1);
    const s2 = this.filterByRange(this.dataNode2);

    if (s1.length === 0 && s2.length === 0) {
      this.renderEmptyState(ctx, w, h, isLight);
      return;
    }

    const padding = { top: 16, right: 16, bottom: 42, left: 38 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    // Calculate Y range
    const allVals = [
      ...s1.map(d => d.val),
      ...s2.map(d => d.val)
    ].filter(v => v !== null && !isNaN(v));

    if (allVals.length === 0) {
      this.renderEmptyState(ctx, w, h, isLight);
      return;
    }

    let minVal = Math.min(...allVals);
    let maxVal = Math.max(...allVals);

    // Give some breathing room
    if (minVal === maxVal) {
      minVal -= 1;
      maxVal += 1;
    } else {
      const margin = (maxVal - minVal) * 0.12;
      minVal -= margin;
      maxVal += margin;
    }

    // Gridlines and Y axis labels
    const gridLines = 4;
    ctx.font = '10px Inter, monospace';
    ctx.fillStyle = isLight ? '#475569' : '#64748B';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let i = 0; i <= gridLines; i++) {
      const yNorm = i / gridLines;
      const y = padding.top + chartH * (1 - yNorm);
      const val = minVal + (maxVal - minVal) * yNorm;

      ctx.beginPath();
      ctx.strokeStyle = isLight ? '#E2E8F0' : '#1E2733';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();

      ctx.fillText(`${val.toFixed(this.formatDecimals)}`, padding.left - 6, y);
    }

    // X Time axis reference: always span the full selected window (15m, 1h, or 24h) ending at now
    const maxTime = Math.max(
      Date.now(),
      s1.length ? s1[s1.length - 1].t : -Infinity,
      s2.length ? s2[s2.length - 1].t : -Infinity
    );
    const timeSpan = this.getWindowMs();
    const minTime = maxTime - timeSpan;

    // Format X labels
    ctx.font = '10px Inter, monospace';
    ctx.fillStyle = isLight ? '#475569' : '#64748B';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xLabels = 4;
    for (let i = 0; i <= xLabels; i++) {
      const norm = i / xLabels;
      const x = padding.left + chartW * norm;
      const t = minTime + timeSpan * norm;
      const date = new Date(t);
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      ctx.fillText(timeStr, x, h - padding.bottom + 8);
    }

    // Centered X-axis "Time" label below timestamp tick labels
    ctx.save();
    ctx.font = '600 11px Inter, sans-serif';
    ctx.fillStyle = isLight ? '#334155' : '#94A3B8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Time', padding.left + chartW / 2, h - 10);
    ctx.restore();

    const getX = (t) => padding.left + ((t - minTime) / timeSpan) * chartW;
    const getY = (val) => padding.top + chartH * (1 - (val - minVal) / (maxVal - minVal));

    // Render Node 1 (Solid line + soft gradient fill)
    if (s1.length > 1) {
      const pts1 = s1.map(d => ({ x: getX(d.t), y: getY(d.val), raw: d }));

      // Gradient Fill under Node 1
      if (this.gradientFill) {
        ctx.save();
        ctx.beginPath();
        this.buildSmoothPath(ctx, pts1);
        ctx.lineTo(pts1[pts1.length - 1].x, padding.top + chartH);
        ctx.lineTo(pts1[0].x, padding.top + chartH);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
        grad.addColorStop(0, 'rgba(34, 211, 238, 0.22)');
        grad.addColorStop(1, 'rgba(34, 211, 238, 0.00)');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();
      }

      // Stroke Node 1 line
      ctx.save();
      ctx.beginPath();
      this.buildSmoothPath(ctx, pts1);
      ctx.strokeStyle = this.colorNode1;
      ctx.lineWidth = 2.2;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.restore();
    }

    // Render Node 2 (Dashed line)
    if (s2.length > 1) {
      const pts2 = s2.map(d => ({ x: getX(d.t), y: getY(d.val), raw: d }));
      ctx.save();
      ctx.beginPath();
      this.buildSmoothPath(ctx, pts2);
      ctx.strokeStyle = this.colorNode2;
      ctx.lineWidth = 2.0;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.restore();
    }

    // Interactive Crosshair if scrubbing
    if (this.scrubbingX !== null && this.scrubbingX >= padding.left && this.scrubbingX <= w - padding.right) {
      const x = this.scrubbingX;

      // Draw vertical crosshair line
      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = isLight ? 'rgba(15, 23, 42, 0.3)' : 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, padding.top + chartH);
      ctx.stroke();

      // Find closest point in s1 and s2
      const targetTime = minTime + ((x - padding.left) / chartW) * timeSpan;
      const closest1 = this.findClosest(s1, targetTime);
      const closest2 = this.findClosest(s2, targetTime);

      if (closest1) {
        const ptX = getX(closest1.t);
        const ptY = getY(closest1.val);
        ctx.beginPath();
        ctx.fillStyle = this.colorNode1;
        ctx.arc(ptX, ptY, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#FFFFFF';
        ctx.stroke();
      }

      if (closest2) {
        const ptX = getX(closest2.t);
        const ptY = getY(closest2.val);
        ctx.beginPath();
        ctx.fillStyle = this.colorNode2;
        ctx.arc(ptX, ptY, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#FFFFFF';
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  findClosest(series, targetTime) {
    if (!series || !series.length) return null;
    let closest = series[0];
    let minDiff = Math.abs(closest.t - targetTime);
    for (let i = 1; i < series.length; i++) {
      const diff = Math.abs(series[i].t - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closest = series[i];
      }
    }
    return closest;
  }

  buildSmoothPath(ctx, pts) {
    if (pts.length < 2) return;
    ctx.moveTo(pts[0].x, pts[0].y);

    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i === 0 ? 0 : i - 1];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];

      // Catmull-Rom to Monotone-X Cubic Bezier conversion (prevents time-axis loopback)
      const cp1x = Math.min(p2.x, Math.max(p1.x, p1.x + (p2.x - p0.x) / 6));
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = Math.max(p1.x, Math.min(p2.x, p2.x - (p3.x - p1.x) / 6));
      const cp2y = p2.y - (p3.y - p1.y) / 6;

      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
  }

  updateTooltip(x) {
    if (!this.tooltip || !this.canvas) return;

    const padding = { top: 16, right: 16, bottom: 42, left: 38 };
    const chartW = this.width - padding.left - padding.right;
    if (chartW <= 0) return;

    const s1 = this.filterByRange(this.dataNode1);
    const s2 = this.filterByRange(this.dataNode2);

    const maxTime = Math.max(
      Date.now(),
      s1.length ? s1[s1.length - 1].t : -Infinity,
      s2.length ? s2[s2.length - 1].t : -Infinity
    );
    const timeSpan = this.getWindowMs();
    const minTime = maxTime - timeSpan;

    const targetTime = minTime + ((x - padding.left) / chartW) * timeSpan;
    const c1 = this.findClosest(s1, targetTime);
    const c2 = this.findClosest(s2, targetTime);

    const displayTime = new Date(targetTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const n1Text = c1 ? `${c1.val.toFixed(this.formatDecimals)} ${this.unit}` : '--';
    const n2Text = c2 ? `${c2.val.toFixed(this.formatDecimals)} ${this.unit}` : '--';

    this.tooltip.innerHTML = `
      <div style="font-weight: 600; color: #94A3B8; margin-bottom: 4px; font-size: 0.68rem;">${displayTime}</div>
      <div style="display: flex; gap: 12px; align-items: center; font-variant-numeric: tabular-nums;">
        <span style="color: ${this.colorNode1};"><strong>N1:</strong> ${n1Text}</span>
        <span style="color: ${this.colorNode2};"><strong>N2:</strong> ${n2Text}</span>
      </div>
    `;

    // Tooltip position
    const clampedX = Math.max(padding.left + 30, Math.min(this.width - padding.right - 30, x));
    this.tooltip.style.left = `${clampedX}px`;
    this.tooltip.style.top = `${padding.top + 20}px`;
    this.tooltip.style.display = 'block';
  }

  renderEmptyState(ctx, w, h, isLight = false) {
    ctx.font = '12px Inter, sans-serif';
    ctx.fillStyle = isLight ? '#475569' : '#64748B';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Waiting for telemetry stream...', w / 2, h / 2);
  }

  /**
   * Export high-resolution PNG with header metadata and legend
   */
  downloadPng(filename = 'chart.png', titleText = '') {
    if (!this.canvas) return;

    // Temporarily clear scrubbing crosshair to ensure a clean chart export
    const prevScrub = this.scrubbingX;
    if (prevScrub !== null) {
      this.scrubbingX = null;
      this.render();
    }

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const dpr = window.devicePixelRatio || 1;
    const headerH = 44;
    const totalW = this.width;
    const totalH = this.height + headerH;

    const offscreen = document.createElement('canvas');
    offscreen.width = Math.round(totalW * dpr);
    offscreen.height = Math.round(totalH * dpr);

    const octx = offscreen.getContext('2d');
    if (!octx) return;

    octx.scale(dpr, dpr);

    // 1. Solid background so exported PNG is never transparent (#FFFFFF in light, #090C10 in dark)
    octx.fillStyle = isLight ? '#FFFFFF' : '#090C10';
    octx.fillRect(0, 0, totalW, totalH);

    // 2. Draw Header Area (44px tall)
    // 2a. Title Text on top-left
    if (titleText) {
      octx.save();
      octx.font = '600 13px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      octx.fillStyle = isLight ? '#0F172A' : '#F8FAFC';
      octx.textAlign = 'left';
      octx.textBaseline = 'middle';
      octx.fillText(titleText, 16, headerH / 2);
      octx.restore();
    }

    // 2b. Compact Legend & Range on top-right
    octx.save();
    octx.font = '500 11px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    octx.textBaseline = 'middle';

    const rangeStr = `Range: ${this.timeRange}`;
    const n2Str = 'Node 2 (Dashed)';
    const n1Str = 'Node 1 (Solid)';

    const rangeWidth = octx.measureText(rangeStr).width;
    const n2Width = octx.measureText(n2Str).width;
    const n1Width = octx.measureText(n1Str).width;

    const swatchLen = 14;
    const gap = 6;
    const itemGap = 16;

    let curX = totalW - 16;

    // Draw Range info
    octx.textAlign = 'right';
    octx.fillStyle = isLight ? '#64748B' : '#94A3B8';
    octx.fillText(rangeStr, curX, headerH / 2);
    curX -= (rangeWidth + itemGap);

    // Draw Node 2 (Dashed)
    octx.textAlign = 'right';
    octx.fillStyle = this.colorNode2;
    octx.fillText(n2Str, curX, headerH / 2);
    curX -= (n2Width + gap);

    octx.strokeStyle = this.colorNode2;
    octx.lineWidth = 2;
    octx.setLineDash([4, 3]);
    octx.beginPath();
    octx.moveTo(curX - swatchLen, headerH / 2);
    octx.lineTo(curX, headerH / 2);
    octx.stroke();
    curX -= (swatchLen + itemGap);

    // Draw Node 1 (Solid)
    octx.textAlign = 'right';
    octx.fillStyle = this.colorNode1;
    octx.fillText(n1Str, curX, headerH / 2);
    curX -= (n1Width + gap);

    octx.strokeStyle = this.colorNode1;
    octx.lineWidth = 2;
    octx.setLineDash([]);
    octx.beginPath();
    octx.moveTo(curX - swatchLen, headerH / 2);
    octx.lineTo(curX, headerH / 2);
    octx.stroke();

    // Subtle divider line under header
    octx.strokeStyle = isLight ? '#E2E8F0' : '#1E2733';
    octx.lineWidth = 1;
    octx.setLineDash([]);
    octx.beginPath();
    octx.moveTo(0, headerH);
    octx.lineTo(totalW, headerH);
    octx.stroke();

    octx.restore();

    // 3. Draw chart canvas below header
    octx.drawImage(this.canvas, 0, headerH, totalW, this.height);

    // 4. Trigger automatic browser download
    try {
      const dataUrl = offscreen.toDataURL('image/png');
      const downloadLink = document.createElement('a');
      downloadLink.download = filename || 'chart.png';
      downloadLink.href = dataUrl;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
    } catch (err) {
      console.error('Failed to export chart PNG:', err);
    }

    // Restore scrubbing state if it was active
    if (prevScrub !== null) {
      this.scrubbingX = prevScrub;
      this.render();
    }
  }
}

/**
 * Utility to render a clean SVG sparkline
 */
export function renderSvgSparkline(svgElement, values, strokeColor = '#22D3EE') {
  if (!svgElement) return;
  if (!values || values.length < 2) {
    svgElement.innerHTML = '';
    return;
  }

  const w = 200;
  const h = 40;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max === min ? 1 : max - min;

  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const pathD = `M ${pts.join(' L ')}`;
  const fillD = `${pathD} L ${w},${h} L 0,${h} Z`;

  const gradId = `sparkGrad_${Math.random().toString(36).substring(2, 8)}`;

  svgElement.innerHTML = `
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${strokeColor}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${strokeColor}" stop-opacity="0.0"/>
      </linearGradient>
    </defs>
    <path d="${fillD}" fill="url(#${gradId})" />
    <path d="${pathD}" fill="none" stroke="${strokeColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
  `;
}
