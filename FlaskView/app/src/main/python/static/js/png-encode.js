/* ============================================================
   png-encode.js —— 用浏览器原生 CompressionStream 编码 PNG

   只做三件事：逐行过滤（Up）、交给原生 zlib 压缩、拼 PNG 容器。
   浏览器自带的 deflate 比手写编码器快且不会出错；CompressionStream
   在 Chrome 80+ / Firefox 113+ / Safari 16.4+ 均可用。
   ============================================================ */

(function (global) {
  'use strict';

  const SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  let crcTable = null;
  function crc32(buf) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function u32(v) {
    return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
  }

  function chunk(type, data) {
    const body = new Uint8Array(4 + data.length);
    body[0] = type.charCodeAt(0);
    body[1] = type.charCodeAt(1);
    body[2] = type.charCodeAt(2);
    body[3] = type.charCodeAt(3);
    body.set(data, 4);
    const out = new Uint8Array(12 + data.length);
    out.set(u32(data.length), 0);
    out.set(body, 4);
    out.set(u32(crc32(body)), 8 + data.length);
    return out;
  }

  function ihdr(width, height) {
    const d = new Uint8Array(13);
    d.set(u32(width), 0);
    d.set(u32(height), 4);
    d[8] = 8;  // bit depth
    d[9] = 2;  // color type: truecolor RGB
    return chunk('IHDR', d);
  }

  function abortError() {
    const err = new Error('已取消');
    err.cancelled = true;
    return err;
  }

  /**
   * 编码一张 PNG。
   *  opts.width / opts.height：像素尺寸
   *  opts.readBlock(y, rows)：返回从第 y 行起 rows 行的 RGBA 像素（Uint8ClampedArray）
   *  opts.onProgress(done, total)：可选
   *  opts.signal：可选 AbortSignal
   * 返回 Promise<Blob>
   */
  async function encode(opts) {
    const W = opts.width;
    const H = opts.height;
    const signal = opts.signal;
    const readBlock = opts.readBlock;
    const rowBytes = W * 3;
    const autoRows = Math.max(1, Math.min(64, Math.floor((4 * 1024 * 1024) / (rowBytes + 1))));
    // 分列渲染时由调用方指定块高，保证读回的一整行能放进内存
    const blockRows = Math.max(1, Math.min(opts.blockRows || autoRows, 512));

    if (typeof CompressionStream !== 'function') {
      throw new Error('当前浏览器不支持 CompressionStream，无法导出超大图片');
    }

    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    const idatParts = [];
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) idatParts.push(value);
      }
    })();

    const prev = new Uint8Array(rowBytes);
    let y = 0;
    try {
      while (y < H) {
        if (signal && signal.aborted) throw abortError();
        const n = Math.min(blockRows, H - y);
        const rgba = readBlock(y, n);            // n * W * 4
        const out = new Uint8Array((rowBytes + 1) * n);
        let o = 0;
        for (let r = 0; r < n; r++) {
          out[o++] = 2;                           // 过滤方式：Up
          let i = r * W * 4;
          let k = 0;
          for (let x = 0; x < W; x++) {
            // Up 过滤：当前像素减上一行同一列（模 256），同时把当前行存为下一行的 prev
            out[o] = rgba[i] - prev[k];
            out[o + 1] = rgba[i + 1] - prev[k + 1];
            out[o + 2] = rgba[i + 2] - prev[k + 2];
            prev[k] = rgba[i];
            prev[k + 1] = rgba[i + 1];
            prev[k + 2] = rgba[i + 2];
            o += 3;
            i += 4;
            k += 3;
          }
        }
        await writer.write(out);
        y += n;
        if (typeof opts.onProgress === 'function') {
          try { opts.onProgress(y, H); } catch (err) { /* 进度回调出错不影响导出 */ }
        }
        // 让出主线程，保持进度条与取消按钮可响应
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await writer.close();
      await pump;
    } catch (err) {
      try { await writer.abort(); } catch (e2) { /* 已经关闭 */ }
      try { cs.writable.abort(); } catch (e3) { /* 已经中止 */ }
      throw err;
    }

    const parts = [SIG, ihdr(W, H)];
    for (const part of idatParts) parts.push(chunk('IDAT', part));
    parts.push(chunk('IEND', new Uint8Array(0)));
    return new Blob(parts, { type: 'image/png' });
  }

  global.PngEncode = { encode, crc32 };
})(window);
