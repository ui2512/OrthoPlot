/* ============================================================
   export-tiles.js —— 超大 PNG 导出：整幅能装下就直接画，装不下就分块

   浏览器单张画布的像素面积/边长有限（各浏览器不同，内存不足时还会静默
   返回空白画布）。导出按图幅自动选路：
     · 整幅画布装得下：直接画完编码（最快）；
     · 高度超出：横向切条，每条画 4096 行；
     · 宽度超出本机画布上限：再按列切块，逐块画出后拼成整行交给编码器。
   编码交给 png-encode.js（浏览器原生 CompressionStream），不限制单边
   长度，只受总像素上限约束。
   ============================================================ */

(function (global) {
  'use strict';

  const MIN_STRIP = 64;
  const TILE_WIDTH = 8192;          // 分列时单块最大宽度
  const RGBA_BUDGET = 64 * 1024 * 1024;   // 分列时整行像素缓冲的预算
  const FILTER_BUDGET = 32 * 1024 * 1024; // 编码器每块过滤数据的预算

  /** 整幅画布直接绘制的像素上限：再大就分块，避免一次性占用数 GB 内存 */
  const DIRECT_LIMIT = 128 * 1000 * 1000;

  function makeCanvas(W, H) {
    if (typeof OffscreenCanvas === 'function') {
      try {
        const c = new OffscreenCanvas(W, H);
        if (c.width === W && c.height === H) return c;
      } catch (err) { /* 回退普通 canvas */ }
    }
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return c;
  }

  function ctx2d(canvas) {
    try {
      return canvas.getContext('2d') || null;
    } catch (err) {
      return null;
    }
  }

  /** 画布真的可用：尺寸没被裁掉，读回得到刚画的像素 */
  function canvasUsable(canvas) {
    const ctx = ctx2d(canvas);
    if (!ctx) return false;
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // 用不透明色：Firefox 的画布是预乘 alpha 的，半透明颜色读回会取整偏差
      ctx.fillStyle = '#010203';
      ctx.fillRect(0, 0, 2, 2);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return d[0] === 1 && d[1] === 2 && d[2] === 3 && d[3] === 255;
    } catch (err) {
      return false;
    }
  }

  function alloc(W, H) {
    if (W < 1 || H < 1) return null;
    const c = makeCanvas(W, H);
    if (!canvasUsable(c)) {
      try { c.width = 0; c.height = 0; } catch (err) { /* 已失效 */ }
      return null;
    }
    return c;
  }

  function abortError() {
    const err = new Error('已取消');
    err.cancelled = true;
    return err;
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * 导出 PNG。
   *  plot：Plotter 实例（drawExportDirect / drawExportArea / getExportBackground）
   *  view：{ dpr, width, height }，width/height 是 CSS 逻辑尺寸
   *  W/H：最终像素尺寸
   *  返回 Promise<Blob>
   */
  async function render(plot, view, W, H, onProgress, signal) {
    const report = (p) => {
      if (typeof onProgress !== 'function') return;
      try { onProgress(p); } catch (err) { /* 进度回调出错不影响导出 */ }
    };
    if (!global.PngEncode || typeof global.PngEncode.encode !== 'function') {
      throw new Error('PNG 编码器未加载');
    }

    const bg = plot.getExportBackground();
    report({ phase: 'render', done: 0, total: 1 });
    await tick();
    if (signal && signal.aborted) throw abortError();

    // 1) 整幅画布直接画（超大图直接分块，避免一次占满内存）
    const full = W * H <= DIRECT_LIMIT ? alloc(W, H) : null;
    if (full) {
      try {
        const ctx = ctx2d(full);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);
        plot.drawExportDirect(ctx, view.dpr, view.width, view.height);
        report({ phase: 'render', done: 1, total: 1 });
        await tick();
        return await global.PngEncode.encode({
          width: W,
          height: H,
          readBlock: (y, n) => ctx.getImageData(0, y, W, n).data,
          onProgress: (done, total) => {
            report({ phase: 'encode', done, total });
            if (signal && signal.aborted) throw abortError();
          },
          signal,
        });
      } finally {
        full.width = 0;
        full.height = 0;
      }
    }

    // 2) 先看整幅宽度能否放进一张画布：能就按条渲染（一次画很宽，效率最高）
    const widthProbe = alloc(W, 1); // 只用 1 行探测宽度上限，避免大画布占用内存
    let stripWidthOk = !!widthProbe;
    if (widthProbe) { widthProbe.width = 0; widthProbe.height = 0; }

    if (stripWidthOk) {
      return await renderStrips(plot, view, W, H, bg, report, signal);
    }
    // 3) 宽度超过本机画布上限：分列 + 分条
    return await renderColumns(plot, view, W, H, bg, report, signal);
  }

  /** 按条渲染：条带宽度 = 整幅宽度，每个条带 4096 行 */
  async function renderStrips(plot, view, W, H, bg, report, signal) {
    let stripH = Math.min(H, 4096);
    stripH = Math.max(MIN_STRIP, Math.floor(stripH / MIN_STRIP) * MIN_STRIP);
    let strip = null;
    while (stripH >= MIN_STRIP) {
      strip = alloc(W, stripH);
      if (strip) break;
      if (stripH === MIN_STRIP) break;
      stripH = Math.max(MIN_STRIP, Math.floor(stripH / 2 / MIN_STRIP) * MIN_STRIP);
    }
    if (!strip) throw new Error('浏览器画布太小，无法分条绘制');

    const ctx = ctx2d(strip);
    let drawnY = -1;
    let drawnH = 0;

    const ensureStrip = (y) => {
      if (y >= drawnY && y < drawnY + drawnH) return;
      const rh = Math.min(stripH, H - y);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, rh);
      // 整幅画面按 -y 平移后画进条带；画布边界自然裁掉其余部分
      plot.drawExportArea(ctx, 0, W, y, y + rh, view.dpr, view.width, view.height, true);
      drawnY = y;
      drawnH = rh;
      report({ phase: 'render', done: Math.min(y + rh, H), total: H });
    };

    try {
      return await global.PngEncode.encode({
        width: W,
        height: H,
        readBlock: (y, n) => {
          if (signal && signal.aborted) throw abortError();
          ensureStrip(y);
          return ctx.getImageData(0, y - drawnY, W, n).data;
        },
        onProgress: (done, total) => {
          report({ phase: 'encode', done, total });
          if (signal && signal.aborted) throw abortError();
        },
        signal,
      });
    } finally {
      strip.width = 0;
      strip.height = 0;
    }
  }

  /**
   * 按列 + 按条渲染：整幅宽度超过画布上限时使用。
   * 每个块画成 cw × bandRows 的小画布，逐列拼成完整的一整行再交给编码器。
   */
  async function renderColumns(plot, view, W, H, bg, report, signal) {
    // 找一个本机能用的列宽（从 8192 开始，失败就减半）
    let cw = Math.min(W, TILE_WIDTH);
    let probe = null;
    while (cw >= MIN_STRIP) {
      probe = alloc(cw, 1);
      if (probe) break;
      cw = Math.max(MIN_STRIP, Math.floor(cw / 2));
    }
    if (!probe) throw new Error('浏览器画布太小，无法分列绘制');
    probe.width = 0;
    probe.height = 0;

    // 块高：保证一整行 RGBA 与编码器的过滤块都放得进内存
    const rowBytes = W * 3;
    let bandRows = Math.min(
      256,
      Math.max(1, Math.floor(RGBA_BUDGET / (W * 4))),
      Math.max(1, Math.floor(FILTER_BUDGET / rowBytes)),
      H,
    );
    bandRows = Math.max(1, bandRows);

    let tile = alloc(cw, bandRows);
    while (!tile && bandRows > 1) {
      bandRows = Math.max(1, Math.floor(bandRows / 2));
      tile = alloc(cw, bandRows);
    }
    if (!tile) throw new Error('浏览器画布太小，无法分块绘制');

    const tctx = ctx2d(tile);
    const out = new Uint8ClampedArray(W * bandRows * 4);

    const drawBand = (y, n) => {
      for (let x = 0; x < W; x += cw) {
        if (signal && signal.aborted) throw abortError();
        const cwAct = Math.min(cw, W - x);
        tctx.setTransform(1, 0, 0, 1, 0, 0);
        // noClear=false：每次绘制都会填好这块画布的底色
        plot.drawExportArea(tctx, x, x + cwAct, y, y + n, view.dpr, view.width, view.height, false);
        const src = tctx.getImageData(0, 0, cwAct, n).data;
        for (let r = 0; r < n; r++) {
          const so = r * cwAct * 4;
          out.set(src.subarray(so, so + cwAct * 4), (r * W + x) * 4);
        }
      }
      report({ phase: 'render', done: Math.min(y + n, H), total: H });
    };

    try {
      return await global.PngEncode.encode({
        width: W,
        height: H,
        blockRows: bandRows,
        readBlock: (y, n) => {
          if (signal && signal.aborted) throw abortError();
          const rows = Math.min(n, bandRows);
          drawBand(y, rows);
          return out.subarray(0, W * rows * 4);
        },
        onProgress: (done, total) => {
          report({ phase: 'encode', done, total });
          if (signal && signal.aborted) throw abortError();
        },
        signal,
      });
    } finally {
      tile.width = 0;
      tile.height = 0;
    }
  }

  global.ExportTiles = { render, canvasUsable };
})(window);
