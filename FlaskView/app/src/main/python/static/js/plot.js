/* ============================================================
   plot.js —— Canvas 函数图像绘制引擎
   坐标变换、自适应网格、曲线绘制、缩放 / 平移 / 悬停取值。
   ============================================================ */

(function (global) {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /** 触屏光标模式的竖向偏移:十字准线显示在手指上方这么多像素,避免被手指遮挡 */
  const TOUCH_HOVER_OFFSET = 64;

  class Plotter {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = Math.min(window.devicePixelRatio || 1, 3);

      /** 视图：cx / cy 为屏幕中心对应的数学坐标，scale 为“每单位多少像素” */
      this.view = { cx: 0, cy: 0, scale: 40 };
      this.defaultView = { cx: 0, cy: 0, scale: 40 };

      this.curves = [];
      this.overlays = { asymptotes: [], points: [], intersections: [], tangents: [], areas: [] };
      this.options = { grid: true, asymptotes: true, labels: true, crosshair: true, tapCursor: false, theme: 'light' };

      this.width = 0;
      this.height = 0;
      this.hover = null;
      this.pointers = new Map();
      this.pinch = null;
      this.listeners = new Map();
      this._frame = null;
      this._anim = null;

      this._bindEvents();
      this.resize();
    }

    /* ---------------- 事件系统 ---------------- */

    on(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(fn);
      return this;
    }

    emit(name, payload) {
      (this.listeners.get(name) || []).forEach((fn) => {
        try { fn(payload); } catch (e) { console.error(e); }
      });
    }

    /* ---------------- 坐标变换 ---------------- */

    xToPx(x) { return this.width / 2 + (x - this.view.cx) * this.view.scale; }
    yToPx(y) { return this.height / 2 - (y - this.view.cy) * this.view.scale; }
    pxToX(px) { return this.view.cx + (px - this.width / 2) / this.view.scale; }
    pxToY(py) { return this.view.cy - (py - this.height / 2) / this.view.scale; }

    getRange() {
      const halfW = this.width / 2 / this.view.scale;
      const halfH = this.height / 2 / this.view.scale;
      return {
        xMin: this.view.cx - halfW,
        xMax: this.view.cx + halfW,
        yMin: this.view.cy - halfH,
        yMax: this.view.cy + halfH,
      };
    }

    /* ---------------- 视图操作 ---------------- */

    setView(cx, cy, scale) {
      this.view.cx = cx;
      this.view.cy = cy;
      this.view.scale = clamp(scale, 1e-6, 1e8);
      this.requestDraw();
      this.emit('viewchange', this.getRange());
    }

    reset(animate) {
      const target = { ...this.defaultView };
      if (animate === false) {
        this.setView(target.cx, target.cy, target.scale);
        return;
      }
      this._animateTo(target);
    }

    _animateTo(target, duration = 260) {
      const from = { ...this.view };
      const start = performance.now();
      if (this._anim) cancelAnimationFrame(this._anim);
      const step = (now) => {
        const t = clamp((now - start) / duration, 0, 1);
        const e = 1 - Math.pow(1 - t, 3);
        this.view.cx = from.cx + (target.cx - from.cx) * e;
        this.view.cy = from.cy + (target.cy - from.cy) * e;
        this.view.scale = from.scale + (target.scale - from.scale) * e;
        this.requestDraw();
        if (t < 1) this._anim = requestAnimationFrame(step);
        else { this._anim = null; this.emit('viewchange', this.getRange()); }
      };
      this._anim = requestAnimationFrame(step);
      this.emit('viewchange', this.getRange());
    }

    zoomAt(px, py, factor) {
      const wx = this.pxToX(px);
      const wy = this.pxToY(py);
      const next = clamp(this.view.scale * factor, 1e-6, 1e8);
      if (next === this.view.scale) return;
      this.view.scale = next;
      this.view.cx += wx - this.pxToX(px);
      this.view.cy += wy - this.pxToY(py);
      this.requestDraw();
      this.emit('viewchange', this.getRange());
    }

    zoomCenter(factor) {
      this.zoomAt(this.width / 2, this.height / 2, factor);
    }

    panByPixels(dx, dy) {
      this.view.cx -= dx / this.view.scale;
      this.view.cy += dy / this.view.scale;
      this.requestDraw();
      this.emit('viewchange', this.getRange());
    }

    /* ---------------- 数据 ---------------- */

    setCurves(curves) {
      this.curves = curves || [];
      this.requestDraw();
    }

    setOverlays(overlays) {
      this.overlays = Object.assign(
        { asymptotes: [], points: [], intersections: [], tangents: [], areas: [] },
        overlays || {}
      );
      this.requestDraw();
    }

    setOptions(options) {
      Object.assign(this.options, options || {});
      this.requestDraw();
    }

    /* ---------------- 尺寸 ---------------- */

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      this.dpr = Math.min(window.devicePixelRatio || 1, 3);
      this.width = w;
      this.height = h;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      // 同步重绘：重建位图即清屏，若只依赖 rAF，页面恰在后台时回调会被丢弃，
      // 画布将停留在空白状态（转屏 / 折叠 / 分屏调整时可能出现），故这里直接绘制。
      // ResizeObserver 本身按帧合并回调，同步绘制的开销与 rAF 合并方案相当。
      this.draw();
    }

    /* ---------------- 绘制调度 ---------------- */

    requestDraw() {
      if (this._frame) return;
      this._frame = requestAnimationFrame(() => {
        this._frame = null;
        this.draw();
      });
      // 兜底：页面处于后台时 rAF 会被暂停（转屏 / 折叠 / 分屏瞬间可能发生），
      // 仅靠 rAF 重绘可能被永久丢弃，导致"位图已清空但迟迟不画"。
      // 可见状态下 rAF 先行执行，此定时器为空操作；后台状态下由它完成绘制。
      setTimeout(() => {
        if (this._frame) {
          cancelAnimationFrame(this._frame);
          this._frame = null;
          this.draw();
        }
      }, 120);
    }

    _colors() {
      const cs = getComputedStyle(document.documentElement);
      const get = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
      return {
        bg: get('--canvas-bg', '#fff'),
        minor: get('--grid-minor', '#eef2f8'),
        major: get('--grid-major', '#dee5f0'),
        axis: get('--axis', '#93a0b8'),
        label: get('--axis-label', '#64708c'),
        text: get('--text', '#16203a'),
      };
    }

    /* ---------------- 主绘制 ---------------- */

    draw() {
      const ctx = this.ctx;
      const W = this.width;
      const H = this.height;
      if (W <= 0 || H <= 0) return;
      const C = this._colors();

      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, W, H);

      const range = this.getRange();
      const ticks = this._computeTicks(range);

      if (this.options.grid) this._drawGrid(C, ticks, range);
      this._drawAxes(C, ticks, range);
      this._drawAreas(C, range);
      if (this.options.asymptotes) this._drawAsymptotes(C, range);
      this._drawCurves(C, range);
      this._drawTangents(C);
      this._drawPoints(C);
      this._drawCrosshair(C);

      ctx.restore();
    }

    _computeTicks(range) {
      const major = this._niceStep(96 / this.view.scale);
      const minorCandidates = [major / 5, major / 4, major / 2];
      let minor = null;
      for (const c of minorCandidates) {
        if (c * this.view.scale >= 13) { minor = c; break; }
      }
      return { major, minor };
    }

    _niceStep(rawStep) {
      if (!isFinite(rawStep) || rawStep <= 0) return 1;
      const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
      const norm = rawStep / mag;
      let mult = 10;
      if (norm <= 1.0000001) mult = 1;
      else if (norm <= 2.0000001) mult = 2;
      else if (norm <= 5.0000001) mult = 5;
      return mult * mag;
    }

    _drawGrid(C, ticks, range) {
      const ctx = this.ctx;
      const W = this.width;
      const H = this.height;

      if (ticks.minor) {
        ctx.strokeStyle = C.minor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const startX = Math.ceil(range.xMin / ticks.minor) * ticks.minor;
        for (let x = startX, n = 0; x <= range.xMax && n < 4000; x += ticks.minor, n++) {
          const px = Math.round(this.xToPx(x)) + 0.5;
          ctx.moveTo(px, 0);
          ctx.lineTo(px, H);
        }
        const startY = Math.ceil(range.yMin / ticks.minor) * ticks.minor;
        for (let y = startY, n = 0; y <= range.yMax && n < 4000; y += ticks.minor, n++) {
          const py = Math.round(this.yToPx(y)) + 0.5;
          ctx.moveTo(0, py);
          ctx.lineTo(W, py);
        }
        ctx.stroke();
      }

      ctx.strokeStyle = C.major;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const startX = Math.ceil(range.xMin / ticks.major) * ticks.major;
      for (let x = startX, n = 0; x <= range.xMax && n < 2000; x += ticks.major, n++) {
        const px = Math.round(this.xToPx(x)) + 0.5;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, H);
      }
      const startY = Math.ceil(range.yMin / ticks.major) * ticks.major;
      for (let y = startY, n = 0; y <= range.yMax && n < 2000; y += ticks.major, n++) {
        const py = Math.round(this.yToPx(y)) + 0.5;
        ctx.moveTo(0, py);
        ctx.lineTo(W, py);
      }
      ctx.stroke();
    }

    _fmtTick(v, step) {
      if (Math.abs(v) < step * 1e-6) return '0';
      const abs = Math.abs(v);
      if (abs >= 1e6 || abs < 1e-4) {
        return v.toExponential(1).replace('e+', 'e');
      }
      const decimals = clamp(Math.ceil(-Math.log10(step)) + 0.999999, 0, 8);
      let s = v.toFixed(decimals);
      if (s.indexOf('.') > -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
      return s;
    }

    _drawAxes(C, ticks, range) {
      const ctx = this.ctx;
      const W = this.width;
      const H = this.height;

      const axisY = clamp(this.yToPx(0), 0.5, H - 0.5);   // x 轴屏幕位置
      const axisX = clamp(this.xToPx(0), 0.5, W - 0.5);   // y 轴屏幕位置
      const xAxisVisible = this.yToPx(0) >= 0 && this.yToPx(0) <= H;
      const yAxisVisible = this.xToPx(0) >= 0 && this.xToPx(0) <= W;

      ctx.strokeStyle = C.axis;
      ctx.fillStyle = C.axis;
      ctx.lineWidth = 1.4;

      // x 轴
      ctx.beginPath();
      ctx.moveTo(0, axisY);
      ctx.lineTo(W, axisY);
      ctx.stroke();
      // y 轴
      ctx.beginPath();
      ctx.moveTo(axisX, 0);
      ctx.lineTo(axisX, H);
      ctx.stroke();

      // 箭头
      const arrow = 5;
      ctx.beginPath();
      ctx.moveTo(W - 1, axisY - arrow); ctx.lineTo(W - 1, axisY + arrow); ctx.lineTo(W - 8, axisY); ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(axisX - arrow, 1); ctx.lineTo(axisX + arrow, 1); ctx.lineTo(axisX, 8); ctx.closePath();
      ctx.fill();

      // 刻度与数字
      ctx.font = '11.5px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const startX = Math.ceil(range.xMin / ticks.major) * ticks.major;
      const labelY = clamp(axisY + 5, 4, H - 18);
      for (let x = startX, n = 0; x <= range.xMax && n < 2000; x += ticks.major, n++) {
        if (Math.abs(x) < ticks.major * 1e-6) continue;
        const px = this.xToPx(x);
        if (px < 14 || px > W - 14) continue;
        ctx.beginPath();
        ctx.moveTo(Math.round(px) + 0.5, axisY - 3.5);
        ctx.lineTo(Math.round(px) + 0.5, axisY + 3.5);
        ctx.stroke();
        ctx.fillStyle = C.label;
        ctx.fillText(this._fmtTick(x, ticks.major), px, labelY);
      }

      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const startY = Math.ceil(range.yMin / ticks.major) * ticks.major;
      const labelX = clamp(axisX - 6, 24, W - 4);
      for (let y = startY, n = 0; y <= range.yMax && n < 2000; y += ticks.major, n++) {
        if (Math.abs(y) < ticks.major * 1e-6) continue;
        const py = this.yToPx(y);
        if (py < 12 || py > H - 12) continue;
        ctx.beginPath();
        ctx.moveTo(axisX - 3.5, Math.round(py) + 0.5);
        ctx.lineTo(axisX + 3.5, Math.round(py) + 0.5);
        ctx.strokeStyle = C.axis;
        ctx.stroke();
        ctx.fillStyle = C.label;
        ctx.fillText(this._fmtTick(y, ticks.major), labelX, py);
      }

      // 原点与轴名
      ctx.fillStyle = C.label;
      ctx.font = 'italic 13px "Times New Roman", serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      if (xAxisVisible && yAxisVisible) {
        ctx.fillText('O', axisX - 5, axisY + 4);
      }
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText('x', W - 14, axisY - 8);
      ctx.textAlign = 'left';
      ctx.fillText('y', axisX + 9, 14);
    }

    _drawAsymptotes(C, range) {
      const ctx = this.ctx;
      const H = this.height;
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(224, 92, 92, .55)';
      for (const line of this.overlays.asymptotes) {
        const px = this.xToPx(line.x);
        if (px < -50 || px > this.width + 50) continue;
        ctx.beginPath();
        ctx.moveTo(Math.round(px) + 0.5, 0);
        ctx.lineTo(Math.round(px) + 0.5, H);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(224, 92, 92, .9)';
        ctx.font = '11px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(line.label || ('x = ' + this._fmtTick(line.x, 1e-6 * Math.abs(line.x) || 0.01)), px + 4, 6);
        ctx.setLineDash([5, 5]);
      }
      ctx.restore();
    }

    /**
     * 视口裁剪（Liang-Barsky）：线段与画布（含边距）不相交返回 null，
     * 相交返回裁剪后的端点。极端缩放时旧折线里远离视口的点不再被
     * 强行连成横跨全屏的错误直线。
     */
    _clipSegment(x1, y1, x2, y2) {
      const M = 50;
      const minX = -M, minY = -M, maxX = this.width + M, maxY = this.height + M;
      let t0 = 0, t1 = 1;
      const dx = x2 - x1, dy = y2 - y1;
      const p = [-dx, dx, -dy, dy];
      const q = [x1 - minX, maxX - x1, y1 - minY, maxY - y1];
      for (let i = 0; i < 4; i++) {
        if (p[i] === 0) {
          if (q[i] < 0) return null;
        } else {
          const r = q[i] / p[i];
          if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
          else          { if (r < t0) return null; if (r < t1) t1 = r; }
        }
      }
      return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
    }

    /** 切线：按当前视野动态连线（缩放平移后始终横贯视野），并标出切点与斜率 */
    _drawTangents(C) {
      const ctx = this.ctx;
      for (const t of this.overlays.tangents || []) {
        if (!isFinite(t.x0) || !isFinite(t.y0) || !isFinite(t.slope)) continue;
        const half = this.width / 2 / this.view.scale + 1;
        const x1 = this.view.cx - half;
        const x2 = this.view.cx + half;
        const yA = t.y0 + t.slope * (x1 - t.x0);
        const yB = t.y0 + t.slope * (x2 - t.x0);
        const color = t.color || '#f59f0b';

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([8, 5]);
        ctx.beginPath();
        ctx.moveTo(this.xToPx(x1), this.yToPx(yA));
        ctx.lineTo(this.xToPx(x2), this.yToPx(yB));
        ctx.stroke();
        ctx.setLineDash([]);

        const px = this.xToPx(t.x0);
        const py = this.yToPx(t.y0);
        if (px >= -20 && px <= this.width + 20 && py >= -20 && py <= this.height + 20) {
          ctx.beginPath();
          ctx.arc(px, py, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = C.bg;
          ctx.stroke();
          if (t.label) {
            ctx.font = '600 12px -apple-system, "PingFang SC", system-ui, sans-serif';
            ctx.textBaseline = 'middle';
            const tw = ctx.measureText(t.label).width;
            const lx = clamp(px + 10, 4, this.width - tw - 12);
            const ly = clamp(py - 16, 12, this.height - 12);
            ctx.globalAlpha = 0.85;
            ctx.fillStyle = C.bg;
            ctx.fillRect(lx - 4, ly - 9, tw + 8, 18);
            ctx.globalAlpha = 1;
            ctx.fillStyle = color;
            ctx.textAlign = 'left';
            ctx.fillText(t.label, lx, ly);
          }
        }
        ctx.restore();
      }
    }

    /** 取 [lo, hi] 内的折线点（端点处线性插值，分段不连续处断开） */
    _areaPoints(segments, lo, hi) {
      const out = [];
      for (const seg of segments) {
        const piece = [];
        let prev = null;
        let broken = false;
        for (const p of seg) {
          const x = p[0];
          const y = p[1];
          if (!isFinite(y)) {
            if (piece.length > 1) out.push(piece);
            piece.length = 0;
            prev = null;
            broken = true;
            continue;
          }
          if (x < lo) { prev = p; continue; }
          if (x > hi) {
            if (prev && prev[0] < hi) {
              const t = (hi - prev[0]) / (x - prev[0]);
              piece.push([hi, prev[1] + (y - prev[1]) * t]);
            }
            broken = true;
            break;
          }
          if (prev && prev[0] < lo) {
            const t = (lo - prev[0]) / (x - prev[0]);
            piece.push([lo, prev[1] + (y - prev[1]) * t]);
          }
          piece.push([x, y]);
          prev = p;
        }
        if (!broken && piece.length > 1) out.push(piece);
      }
      return out;
    }

    /** 定积分面积着色：曲线与 x 轴围成的区域 + 端点虚线 + 积分值标签 */
    _drawAreas(C, range) {
      const ctx = this.ctx;
      for (const a of this.overlays.areas || []) {
        if (!isFinite(a.x0) || !isFinite(a.x1)) continue;
        const lo = Math.min(a.x0, a.x1);
        const hi = Math.max(a.x0, a.x1);
        const pieces = this._areaPoints(a.segments || [], lo, hi);
        if (!pieces.length) continue;
        const color = a.color || '#3f66f0';

        ctx.save();
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = color;
        for (const piece of pieces) {
          ctx.beginPath();
          ctx.moveTo(this.xToPx(piece[0][0]), clamp(this.yToPx(0), -1e4, 1e4));
          for (const p of piece) {
            ctx.lineTo(this.xToPx(p[0]), clamp(this.yToPx(p[1]), -1e4, 1e4));
          }
          ctx.lineTo(this.xToPx(piece[piece.length - 1][0]), clamp(this.yToPx(0), -1e4, 1e4));
          ctx.closePath();
          ctx.fill();
        }
        ctx.globalAlpha = 1;

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 4]);
        for (const bx of [a.x0, a.x1]) {
          const px = this.xToPx(bx);
          if (px < 0 || px > this.width) continue;
          ctx.beginPath();
          ctx.moveTo(px, 0);
          ctx.lineTo(px, this.height);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        if (a.label) {
          const mx = (lo + hi) / 2;
          const px = this.xToPx(mx);
          if (px > 0 && px < this.width) {
            ctx.font = '600 12.5px -apple-system, "PingFang SC", system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const tw = ctx.measureText(a.label).width;
            const ly = 26;
            ctx.globalAlpha = 0.88;
            ctx.fillStyle = C.bg;
            ctx.fillRect(px - tw / 2 - 6, ly - 10, tw + 12, 20);
            ctx.globalAlpha = 1;
            ctx.fillStyle = color;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.strokeRect(px - tw / 2 - 6, ly - 10, tw + 12, 20);
            ctx.fillText(a.label, px, ly);
          }
        }
        ctx.restore();
      }
    }

    _drawCurves(C, range) {
      const ctx = this.ctx;
      const W = this.width;
      const H = this.height;
      const labels = [];

      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      for (const curve of this.curves) {
        if (curve.visible === false) continue;
        const segments = curve.segments || [];
        ctx.strokeStyle = curve.color;
        ctx.lineWidth = curve.width || 2.4;
        if (curve.dashed) ctx.setLineDash([7, 5]);
        else ctx.setLineDash([]);
        if (curve.opacity) ctx.globalAlpha = curve.opacity;

        for (const seg of segments) {
          if (!seg.length) continue;
          ctx.beginPath();
          let started = false;
          let prev = null;
          for (let i = 0; i < seg.length; i++) {
            const px = this.xToPx(seg[i][0]);
            const py = this.yToPx(seg[i][1]);
            if (!isFinite(px) || !isFinite(py)) { prev = null; started = false; continue; }
            // ±1e5 仅为数值兜底（防溢出），画与不画交给视口裁剪判断
            const cx = clamp(px, -1e5, 1e5);
            const cy = clamp(py, -1e5, 1e5);
            if (prev) {
              const c = this._clipSegment(prev[0], prev[1], cx, cy);
              if (c) {
                if (!started) { ctx.moveTo(c[0], c[1]); started = true; }
                else ctx.lineTo(c[0], c[1]);
                ctx.lineTo(c[2], c[3]);
              } else {
                // 整段都在视口外：断开路径，避免与下一段连出错误弦线
                started = false;
              }
            }
            prev = [cx, cy];
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);

        // 曲线标注：取右侧/左侧最靠边的可见点
        if (this.options.labels && curve.label && segments.length) {
          let best = null;
          for (const seg of segments) {
            for (let i = 0; i < seg.length; i += Math.max(1, Math.floor(seg.length / 24))) {
              const px = this.xToPx(seg[i][0]);
              const py = this.yToPx(seg[i][1]);
              if (px < 0 || px > W || py < 12 || py > H - 26) continue;
              const score = Math.min(px, W - px);
              if (!best || score < best.score) best = { px, py, score };
            }
          }
          if (best) labels.push({ x: best.px, y: best.py, text: curve.label, color: curve.color });
        }
      }

      // 绘制标注（错开避免重叠）
      ctx.font = '600 12px -apple-system, "PingFang SC", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      for (const lab of labels) {
        const wText = ctx.measureText(lab.text).width;
        let x = lab.x + 8;
        if (x + wText + 8 > W) x = lab.x - wText - 14;
        const y = clamp(lab.y, 12, H - 12);
        ctx.fillStyle = C.bg;
        ctx.globalAlpha = 0.82;
        ctx.beginPath();
        const r = 5;
        const bx = x - 4, by = y - 9, bw = wText + 8, bh = 18;
        ctx.moveTo(bx + r, by);
        ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
        ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
        ctx.arcTo(bx, by + bh, bx, by, r);
        ctx.arcTo(bx, by, bx + bw, by, r);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = lab.color;
        ctx.fillText(lab.text, x, y);
      }
    }

    _drawPoints(C) {
      const ctx = this.ctx;
      const placed = [];
      const hits = (r) => placed.some((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h);

      // 先把所有标记点登记为占位区域，随后标签就不会盖在相邻的点上
      for (const p of this.overlays.points) {
        const px = this.xToPx(p.x);
        const py = this.yToPx(p.y);
        if (px < -20 || px > this.width + 20 || py < -20 || py > this.height + 20) continue;
        placed.push({ x: px - 6, y: py - 6, w: 12, h: 12 });
      }

      ctx.font = '11.5px -apple-system, "PingFang SC", system-ui, sans-serif';
      for (const p of this.overlays.points) {
        const px = this.xToPx(p.x);
        const py = this.yToPx(p.y);
        if (px < -20 || px > this.width + 20 || py < -20 || py > this.height + 20) continue;
        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        if (p.hollow) {
          ctx.fillStyle = C.bg;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = p.color || C.axis;
          ctx.stroke();
        } else {
          ctx.fillStyle = p.color || '#e0483f';
          ctx.fill();
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = C.bg;
          ctx.stroke();
        }
        if (p.label) {
          const tw = ctx.measureText(p.label).width;
          // 依次尝试右侧、左侧、上方、下方，选第一个不与已画内容重叠的位置
          const candidates = [
            { x: px + 8, y: py - 5 },
            { x: px - tw - 8, y: py - 5 },
            { x: px - tw / 2, y: py - 11 },
            { x: px - tw / 2, y: py + 19 },
          ];
          let spot = null;
          for (const c of candidates) {
            const rect = { x: c.x - 3, y: c.y - 13, w: tw + 6, h: 15 };
            if (rect.x < 2 || rect.x + rect.w > this.width - 2) continue;
            if (rect.y < 2 || rect.y + rect.h > this.height - 2) continue;
            if (hits(rect)) continue;
            spot = { c, rect };
            break;
          }
          if (!spot) continue; // 实在放不下就只留标记点，不硬挤标签
          placed.push(spot.rect);
          ctx.fillStyle = C.bg;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(spot.rect.x, spot.rect.y, spot.rect.w, spot.rect.h);
          ctx.globalAlpha = 1;
          ctx.fillStyle = C.label;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(p.label, spot.c.x, spot.c.y);
        }
      }

      for (const p of this.overlays.intersections) {
        const px = this.xToPx(p.x);
        const py = this.yToPx(p.y);
        if (px < 0 || px > this.width || py < 0 || py > this.height) continue;
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#f59f0b';
        ctx.fill();
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = C.bg;
        ctx.stroke();
      }
    }

    _drawCrosshair(C) {
      if (!this.hover || !this.options.crosshair) return;
      const ctx = this.ctx;
      const { px, py } = this.hover;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = C.axis;
      ctx.beginPath();
      ctx.moveTo(Math.round(px) + 0.5, 0);
      ctx.lineTo(Math.round(px) + 0.5, this.height);
      ctx.moveTo(0, Math.round(py) + 0.5);
      ctx.lineTo(this.width, Math.round(py) + 0.5);
      ctx.stroke();
      ctx.restore();

      for (const v of this.hover.values || []) {
        const yy = this.yToPx(v.y);
        if (yy < -20 || yy > this.height + 20) continue;
        ctx.beginPath();
        ctx.arc(px, yy, 4, 0, Math.PI * 2);
        ctx.fillStyle = v.color;
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = C.bg;
        ctx.stroke();
      }
    }

    /* ---------------- 取值 ---------------- */

    /** 在给定 x 处对每条可见曲线线性插值求 y */
    valuesAt(xMath) {
      const out = [];
      for (const curve of this.curves) {
        if (curve.visible === false) continue;
        const segments = curve.segments || [];
        let found = null;
        for (const seg of segments) {
          if (!seg.length) continue;
          if (xMath < seg[0][0] || xMath > seg[seg.length - 1][0]) continue;
          let lo = 0;
          let hi = seg.length - 1;
          while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (seg[mid][0] <= xMath) lo = mid; else hi = mid;
          }
          const [x1, y1] = seg[lo];
          const [x2, y2] = seg[hi];
          const t = x2 === x1 ? 0 : (xMath - x1) / (x2 - x1);
          found = y1 + (y2 - y1) * t;
          break;
        }
        if (found !== null && isFinite(found)) {
          out.push({ id: curve.id, color: curve.color, label: curve.label, y: found, isDerivative: !!curve.isDerivative });
        }
      }
      return out;
    }

    /* ---------------- 交互 ---------------- */

    _localPoint(evt) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
    }

    _bindEvents() {
      const canvas = this.canvas;

      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const p = this._localPoint(e);
        const factor = Math.pow(1.0016, -e.deltaY * (e.deltaMode === 1 ? 18 : 1));
        this.zoomAt(p.x, p.y, factor);
      }, { passive: false });

      canvas.addEventListener('pointerdown', (e) => {
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch (err) { /* 合成事件等场景可能没有活动指针,忽略 */ }
        this._lastPointerType = e.pointerType || 'mouse';
        const p = this._localPoint(e);
        this.pointers.set(e.pointerId, p);
        if (this.pointers.size === 1) {
          this.dragging = { startX: p.x, startY: p.y, lastX: p.x, lastY: p.y, moved: false };
          canvas.classList.add('dragging');
          // 触屏光标模式:手指一按下去,准线就出现在手指上方,移动中实时跟随
          if (e.pointerType === 'touch' && this.options.tapCursor) this._touchHover(p);
        } else if (this.pointers.size === 2) {
          const pts = [...this.pointers.values()];
          this.pinch = {
            dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
            mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
          };
          this.dragging = null;
        }
      });

      canvas.addEventListener('pointermove', (e) => {
        const p = this._localPoint(e);
        if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);

        if (this.pointers.size === 2 && this.pinch) {
          const pts = [...this.pointers.values()];
          const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
          if (this.pinch.dist > 0) {
            this.zoomAt(mid.x, mid.y, dist / this.pinch.dist);
            this.panByPixels(mid.x - this.pinch.mid.x, mid.y - this.pinch.mid.y);
          }
          this.pinch = { dist, mid };
          return;
        }

        if (this.dragging) {
          const dx = p.x - this.dragging.lastX;
          const dy = p.y - this.dragging.lastY;
          if (Math.abs(p.x - this.dragging.startX) + Math.abs(p.y - this.dragging.startY) > 3) {
            this.dragging.moved = true;
          }
          this.dragging.lastX = p.x;
          this.dragging.lastY = p.y;
          if (this.dragging.moved) this.panByPixels(dx, dy);
          // 触屏光标模式:准线浮在手指上方实时跟随;鼠标保持精确悬停
          if (e.pointerType === 'touch' && this.options.tapCursor) this._touchHover(p);
          else this._updateHover(p);
          return;
        }

        this._updateHover(p);
      });

      const endPointer = (e) => {
        // 点击拾取（拖动不算）：供切线 / 积分等工具使用；
        // 光标模式下（触屏设备默认开启），点按同时把十字准线与取值定位到该点
        if (this.dragging && !this.dragging.moved && this.pointers.size === 1) {
          const px = this.dragging.lastX;
          const py = this.dragging.lastY;
          this.emit('pick', { px, py, x: this.pxToX(px), y: this.pxToY(py) });
          if (this.options.tapCursor) {
            if (e.pointerType === 'touch') this._touchHover({ x: px, y: py });
            else this._updateHover({ x: px, y: py });
          }
        }
        this.pointers.delete(e.pointerId);
        if (this.pointers.size < 2) this.pinch = null;
        if (this.pointers.size === 0) {
          this.dragging = null;
          canvas.classList.remove('dragging');
        }
      };
      canvas.addEventListener('pointerup', endPointer);
      canvas.addEventListener('pointercancel', endPointer);

      canvas.addEventListener('pointerleave', () => {
        if (this.dragging) return;
        // 触屏光标模式:手指抬起后 Chromium 会补发 pointerout/pointerleave 边界事件,
        // 此时若清空 hover,准线和读数会在抬手瞬间消失(功能等于没用)。
        // 因此触屏来源的 leave 直接忽略——准线保留,直到下一次点按或关闭光标。
        if (this.options.tapCursor && this._lastPointerType === 'touch') return;
        this.hover = null;
        this.requestDraw();
        this.emit('hover', null);
      });

      canvas.addEventListener('dblclick', () => this.reset(true));

      this._keyHandler = (e) => {
        if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
        const step = 40;
        switch (e.key) {
          case 'ArrowLeft': this.panByPixels(step, 0); break;
          case 'ArrowRight': this.panByPixels(-step, 0); break;
          case 'ArrowUp': this.panByPixels(0, step); break;
          case 'ArrowDown': this.panByPixels(0, -step); break;
          case '+': case '=': this.zoomCenter(1.25); break;
          case '-': case '_': this.zoomCenter(0.8); break;
          case 'r': case 'R': this.reset(true); break;
          default: return;
        }
        e.preventDefault();
      };
      window.addEventListener('keydown', this._keyHandler);

      if (window.ResizeObserver) {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(canvas.parentElement || canvas);
      } else {
        window.addEventListener('resize', () => this.resize());
      }
    }

    /** 触屏光标模式专用:十字准线定位到手指上方,避免遮挡 */
    _touchHover(p) {
      this._updateHover({ x: p.x, y: clamp(p.y - TOUCH_HOVER_OFFSET, 0, this.height - 1) });
    }

    _updateHover(p) {
      const xMath = this.pxToX(p.x);
      const yMath = this.pxToY(p.y);
      const values = this.valuesAt(xMath);
      this.hover = { px: p.x, py: p.y, x: xMath, y: yMath, values };
      this.requestDraw();
      this.emit('hover', this.hover);
    }

    /** 清除十字准线与取值（光标模式关闭时调用） */
    clearHover() {
      this.hover = null;
      this.requestDraw();
      this.emit('hover', null);
    }

    /** 导出 PNG
     *  opts.width / opts.height：目标像素尺寸（省略则用当前画布原生像素）。
     *  做法是在离屏画布上按目标分辨率重绘（不是放大截图）：文字、线宽随
     *  分辨率等比放大；长宽比与当前画布不同时，画面按目标比例拉伸（与
     *  调整窗口大小同理），保证完整视野。
     *  返回 Promise<{ ok:true, width, height } | { ok:false, error }>。
     *  1 亿像素级导出需要几百 MB 内存，手机端可能较慢，失败时会给出提示。
     */
    exportPNG(filename, opts) {
      return new Promise((resolve) => {
        opts = opts || {};
        // 手机与桌面统一支持 1 亿像素级导出；只限制总像素，单边大小交给
        // 浏览器画布上限决定（分配后校验实际尺寸），失败时返回明确错误。
        const MAX_PIXELS = 108 * 1000 * 1000; // 1.08 亿，覆盖 10000×10000 与 12000×9000
        const cssW = Math.max(1, this.width);
        const cssH = Math.max(1, this.height);

        let W = Math.round(Number(opts.width) || cssW * this.dpr);
        let H = Math.round(Number(opts.height) || cssH * this.dpr);
        if (!(W >= 100 && H >= 100)) return resolve({ ok: false, error: '分辨率太小（至少 100×100）' });
        if (W * H > MAX_PIXELS) {
          return resolve({ ok: false, error: '总像素过大（上限约 1.08 亿像素）' });
        }

        // 每 CSS 像素对应的导出像素数：横向比例与屏幕一致，文字/线宽等比放大
        const scale = Math.max(W / cssW, 0.05);
        const off = document.createElement('canvas');
        off.width = W;
        off.height = H;
        if (off.width !== W || off.height !== H) {
          off.width = 0;
          off.height = 0;
          return resolve({ ok: false, error: '当前浏览器不支持该画布尺寸（单边过大），请降低宽高' });
        }
        let octx;
        try {
          octx = off.getContext('2d');
        } catch (err) {
          octx = null;
        }
        if (!octx) {
          off.width = 0;
          off.height = 0;
          return resolve({ ok: false, error: '无法创建导出画布（分辨率可能过高）' });
        }

        // 临时把绘制目标切到离屏画布（draw() 全部依赖 this.* 状态）
        const bak = {
          canvas: this.canvas, ctx: this.ctx,
          width: this.width, height: this.height,
          dpr: this.dpr, hover: this.hover,
        };
        this.canvas = off;
        this.ctx = octx;
        this.dpr = scale;
        this.width = W / scale;
        this.height = H / scale;
        this.hover = null; // 导出图中不含光标十字线
        try {
          this.draw();
          octx.getImageData(0, 0, 1, 1); // 部分设备画布分配失败时不会抛错，用一次读回确认真实可用
        } catch (err) {
          off.width = 0;
          off.height = 0;
          return resolve({ ok: false, error: '导出绘制失败（可能是分辨率过高或内存不足）' });
        } finally {
          this.canvas = bak.canvas;
          this.ctx = bak.ctx;
          this.width = bak.width;
          this.height = bak.height;
          this.dpr = bak.dpr;
          this.hover = bak.hover;
        }

        const name = filename || 'OrthoPlot.png';
        const save = (href) => {
          const a = document.createElement('a');
          a.href = href;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        };
        const finish = () => {
          off.width = 0;
          off.height = 0;
        };
        if (off.toBlob) {
          // toBlob 比 toDataURL 省内存（高分辨率尤其明显）
          try {
            off.toBlob((blob) => {
              if (!blob) {
                finish();
                resolve({ ok: false, error: 'PNG 编码失败（图片过大或内存不足）' });
                return;
              }
              try {
                const url = URL.createObjectURL(blob);
                save(url);
                setTimeout(() => URL.revokeObjectURL(url), 4000);
                finish();
                resolve({ ok: true, width: W, height: H });
              } catch (err) {
                finish();
                resolve({ ok: false, error: '无法保存导出文件' });
              }
            }, 'image/png');
          } catch (err) {
            finish();
            resolve({ ok: false, error: 'PNG 编码失败（图片过大或内存不足）' });
          }
        } else {
          try {
            save(off.toDataURL('image/png'));
            finish();
            resolve({ ok: true, width: W, height: H });
          } catch (err) {
            finish();
            resolve({ ok: false, error: 'PNG 编码失败（图片过大或内存不足）' });
          }
        }
      });
    }

    destroy() {
      if (this._ro) this._ro.disconnect();
      window.removeEventListener('keydown', this._keyHandler);
    }
  }

  global.Plotter = Plotter;
})(window);
