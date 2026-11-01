/* ============================================================
   export-tiles.js —— 超大 PNG 导出：整幅能装下就直接画，装不下就分条

   浏览器单张画布的像素面积/边长有限（Chrome 约 2.68 亿像素，Firefox
   单边约 32767px，内存不足时还会静默返回空白画布）。做法：
     · 先尝试申请整幅画布，能画就直接画完编码（最快）；
     · 装不下就横向切条：每条约 h 行，画到条带画布上（整幅图按
       -y 平移，画布边界自然只保留这条的范围），再逐行交给编码器。
   编码交给 png-encode.js（浏览器原生 CompressionStream），不用自研
   deflate，稳定且快。
   ============================================================ */

(function (global) {
  'use strict';

  const MAX_DIM = 65535;
  const MIN_STRIP = 64;
  /** 整幅画布直接绘制的像素上限：再大就分条，避免一次性占用数 GB 内存 */
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
    if (W < 1 || H < 1 || W > MAX_DIM || H > MAX_DIM) return null;
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
    if (W > MAX_DIM || H > MAX_DIM) throw new Error('单边不能超过 65535 像素');

    const bg = plot.getExportBackground();
    report({ phase: 'render', done: 0, total: 1 });
    await tick();
    if (signal && signal.aborted) throw abortError();

    // 1) 整幅画布直接画（超大图直接分条，避免一次占满内存）
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

    // 2) 分条：逐步减半找一个本机能分配的条带高度（64 的倍数）
    let stripH = Math.min(H, 4096);
    stripH = Math.max(MIN_STRIP, Math.floor(stripH / MIN_STRIP) * MIN_STRIP);
    let strip = null;
    while (stripH >= MIN_STRIP) {
      strip = alloc(W, stripH);
      if (strip) break;
      if (stripH === MIN_STRIP) break;
      stripH = Math.max(MIN_STRIP, Math.floor(stripH / 2 / MIN_STRIP) * MIN_STRIP);
    }
    if (!strip) throw new Error('浏览器画布太小，无法分块绘制（请降低宽高）');

    const ctx = ctx2d(strip);
    let drawnY = -1;
    let drawnH = 0;

    const ensureStrip = (y, n) => {
      // 必须保证 [y, y+n) 整段都落在已绘制的条带内，否则 getImageData 会读到条带外
      const need = Math.min(n, H - y);
      if (y >= drawnY && y + need <= drawnY + drawnH) return;
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
          ensureStrip(y, n);
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

  global.ExportTiles = { render, canvasUsable };
})(window);
