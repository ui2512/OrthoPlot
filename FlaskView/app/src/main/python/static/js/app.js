/* ============================================================
   app.js —— 界面逻辑：函数管理、与 Python 后端通信、交互控制
   ============================================================ */

(function () {
  'use strict';

  const COLORS = [
    '#3f66f0', '#e0483f', '#12a150', '#f59f0b',
    '#8b5cf6', '#0891b2', '#db2777', '#65a30d',
    '#d946ef', '#0ea5e9',
  ];

  const $ = (sel) => document.querySelector(sel);

  const state = {
    functions: [],
    colorIndex: 0,
    fetchRange: null,
    pendingPlot: null,
    plotTimer: null,
    plotSeq: 0,
    lastPlotAt: 0,
    analysisTimers: new Map(),
    showIntersections: false,
    tableOpen: false,
    seq: 0,
  };

  const el = {
    input: $('#expr-input'),
    hint: $('#input-hint'),
    list: $('#fn-list'),
    empty: $('#fn-empty'),
    count: $('#fn-count'),
    presets: $('#preset-groups'),
    readout: $('#readout'),
    badge: $('#status-badge'),
    tablePanel: $('#table-panel'),
    tableScroll: $('#table-scroll'),
    help: $('#help-modal'),
    export: $('#export-modal'),
    updateBanner: $('#update-banner'),
    updateVersion: $('#update-version'),
    updateNotes: $('#update-notes'),
    updateLink: $('#update-link'),
    updateDismiss: $('#update-dismiss'),
    checkUpdate: $('#btn-check-update'),
  };

  const plot = new Plotter($('#plot'));

  // 画布点选工具：'tangent' 点击求切线；'integral' 两次点击算定积分
  const tool = { mode: null, curveId: null, a: null };

  /* ============================================================
     工具函数
     ============================================================ */

  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function fmtNum(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    if (Math.abs(v) < 1e-9) return '0';
    if (Math.abs(v - Math.round(v)) < 1e-9 && Math.abs(v) < 1e12) return String(Math.round(v));
    let s = Number(v.toPrecision(digits || 6));
    if (Math.abs(s) >= 1e6 || Math.abs(s) < 1e-4) return s.toExponential(2);
    return String(s);
  }

  function niceStep(raw) {
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    let m = 10;
    if (n <= 1) m = 1; else if (n <= 2) m = 2; else if (n <= 5) m = 5;
    return m * mag;
  }

  function nextColor() {
    const c = COLORS[state.colorIndex % COLORS.length];
    state.colorIndex += 1;
    return c;
  }

  function toast(text, duration) {
    el.badge.textContent = text;
    el.badge.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.badge.classList.remove('show'), duration || 1800);
  }

  function setHint(text, type) {
    el.hint.textContent = text || '';
    el.hint.className = 'hint' + (type ? ' ' + type : '');
  }

  /* ============================================================
     自动更新检测
     ============================================================ */

  const UPDATE_DISMISS_KEY = 'orthoplot.update.dismissed';
  const UPDATE_LAST_KEY = 'orthoplot.update.last-check';
  const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;

  function updateStorageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function updateStorageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* 隐私模式写入失败时忽略 */ }
  }

  function showUpdateBanner(data) {
    const latest = String(data.latest || '').trim();
    if (!latest) return;
    el.updateVersion.textContent = 'v' + latest;
    el.updateNotes.textContent = String(data.notes || '').trim();
    const downloads = (data.downloads && typeof data.downloads === 'object') ? data.downloads : {};
    // 按系统选择安装包：Android → APK 分支；Windows / Linux → 对应桌面包；其余 → Web 仓库
    const ua = navigator.userAgent || '';
    let url = '';
    if (/Android/i.test(ua)) url = downloads.android || '';
    else if (/Windows/i.test(ua)) url = downloads.windows || '';
    else if (/Linux/i.test(ua)) url = downloads.linux || '';
    url = url || downloads.web || data.url || '';
    if (url) {
      el.updateLink.href = url;
      el.updateLink.hidden = false;
    } else {
      el.updateLink.hidden = true;
    }
    el.updateBanner.hidden = false;
  }

  async function checkForUpdates(manual) {
    const now = Date.now();
    const last = Number(updateStorageGet(UPDATE_LAST_KEY) || 0);
    if (!manual && now - last < UPDATE_INTERVAL) return;
    let data = null;
    try {
      const res = await fetch('/api/update-check' + (manual ? '?force=1' : ''), {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (res.ok) data = await res.json();
    } catch (e) {
      // 离线 / 后端未启动：自动检查静默，手动检查给出提示
    }
    if (!data || !data.ok) {
      if (manual) toast('检查更新失败，请检查网络');
      return;
    }
    updateStorageSet(UPDATE_LAST_KEY, String(now));
    if (!data.has_update) {
      if (manual) toast('已是最新版本 v' + data.current);
      return;
    }
    if (!manual && updateStorageGet(UPDATE_DISMISS_KEY) === String(data.latest)) return;
    showUpdateBanner(data);
  }

  /* ============================================================
     函数管理
     ============================================================ */

  function addFunction(expr, params) {
    const text = String(expr || '').trim();
    if (!text) return null;
    if (state.functions.some((f) => f.expr === text)) {
      setHint('这个函数已经在列表里了', 'ok');
      return null;
    }
    if (state.functions.length >= 12) {
      setHint('最多同时绘制 12 个函数，先删掉几个吧', 'error');
      return null;
    }

    const item = {
      id: 'fn' + (++state.seq),
      expr: text,
      color: nextColor(),
      visible: true,
      params: Object.assign({}, params || {}),
      paramList: [],
      analysis: null,
      segments: [],
      error: '',
      // 首个函数默认展开性质分析，其余保持紧凑，避免侧栏被撑得过长
      expanded: state.functions.length === 0,
      _fresh: true,
    };
    state.functions.push(item);
    renderList();
    syncVolume();
    refreshAnalysis(item);
    requestPlot(true);
    return item;
  }

  function removeFunction(id) {
    state.functions = state.functions.filter((f) => f.id !== id);
    renderList();
    syncVolume();
    requestPlot(true);
    renderOverlays();
    if (state.showIntersections) refreshIntersections();
  }

  function toggleVisible(id) {
    const item = state.functions.find((f) => f.id === id);
    if (!item) return;
    item.visible = !item.visible;
    renderList();
    requestPlot(true);
    renderOverlays();
    if (state.showIntersections) refreshIntersections();
  }

  function cycleColor(id) {
    const item = state.functions.find((f) => f.id === id);
    if (!item) return;
    const idx = COLORS.indexOf(item.color);
    item.color = COLORS[(idx + 1) % COLORS.length];
    renderList();
    drawCurves();
  }

  /* ============================================================
     与后端通信
     ============================================================ */

  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return res.json();
  }

  async function refreshAnalysis(item) {
    clearTimeout(state.analysisTimers.get(item.id));
    const timer = setTimeout(async () => {
      try {
        const data = await api('/api/analyze', {
          expr: item.expr,
          params: item.params,
          xmin: plot.getRange().xMin,
          xmax: plot.getRange().xMax,
        });
        if (!data.ok) {
          item.error = data.error || '表达式无法解析';
          item.analysis = null;
          item.color = item.color;
          if (item._fresh) setHint('⚠ ' + item.error, 'error');
        } else {
          item.error = '';
          item.analysis = data;
          mergeParams(item, data.params);
        }
      } catch (err) {
        item.error = '无法连接后端服务，请确认 app.py 正在运行';
      }
      renderList();
      renderOverlays();
      item._fresh = false;
    }, 160);
    state.analysisTimers.set(item.id, timer);
  }

  function mergeParams(item, params) {
    if (!params) return;
    item.paramList = params.map((p) => {
      if (item.params[p.name] === undefined) item.params[p.name] = p.value;
      return p.name;
    });
    // 清除已不存在的参数
    Object.keys(item.params).forEach((k) => {
      if (item.paramList.indexOf(k) === -1) delete item.params[k];
    });
  }

  function visibleFunctions() {
    return state.functions.filter((f) => f.visible && !f.error);
  }

  function tableXs() {
    if (!state.tableOpen) return [];
    const r = plot.getRange();
    const span = r.xMax - r.xMin;
    let step = niceStep(span / 16);
    if (step < 1) step = 1;
    if (step % 1 !== 0) step = Math.max(1, Math.round(step));
    const xs = [];
    const start = Math.ceil(r.xMin / step) * step;
    for (let x = start, n = 0; x <= r.xMax && n < 24; x += step, n++) {
      xs.push(Number(x.toPrecision(12)));
    }
    return xs;
  }

  async function requestPlot(immediate) {
    clearTimeout(state.plotTimer);
    const delay = immediate ? 0 : 110;
    state.plotTimer = setTimeout(doPlot, delay);
  }

  async function doPlot() {
    const seq = ++state.plotSeq;
    state.lastPlotAt = Date.now();
    const list = visibleFunctions();
    const range = plot.getRange();
    const span = range.xMax - range.xMin;
    const margin = span * 0.4;

    if (!list.length) {
      state.fetchRange = null;
      plot.setCurves([]);
      renderTable();
      return;
    }

    const body = {
      functions: list.map((f) => ({
        id: f.id,
        expr: f.expr,
        params: f.params,
        derivative: !!f.showDerivative,
      })),
      xmin: range.xMin - margin,
      xmax: range.xMax + margin,
      table_xs: tableXs(),
      quality: 'normal',
      // 采样密度与画布宽度挂钩:后端按"铺满画布"计算均匀点数,
      // 深度放大时折线间距才不会超过 1~2px(否则曲线呈明显棱角)
      px_width: Math.max(0, Math.round(plot.width || 0)),
    };

    try {
      const data = await api('/api/plot', body);
      // 节流期间可能已有更新的请求发出,过期响应直接丢弃,防止旧范围回写
      if (seq !== state.plotSeq) return;
      state.fetchRange = { xmin: body.xmin, xmax: body.xmax };
      (data.curves || []).forEach((c) => {
        const item = state.functions.find((f) => f.id === c.id);
        if (!item) return;
        if (c.ok === false) {
          item.error = c.error || '无法绘制';
          item.segments = [];
          item.dsegments = [];
        } else {
          item.segments = c.segments || [];
          item.dsegments = c.dsegments || [];
          item.table = c.table || null;
          if (!item.error) item.error = '';
        }
      });
      drawCurves();
      renderTable();
      renderListErrors();
    } catch (err) {
      toast('后端未响应，请检查 python3 app.py 是否在运行');
    }
  }

  const SUPERSCRIPT = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻' };
  const SUPERSCRIPT_LETTER = { x: 'ˣ', X: 'ˣ', n: 'ⁿ', N: 'ⁿ' };

  function toSuperscript(text) {
    return String(text).split('').map((ch) => SUPERSCRIPT[ch] || SUPERSCRIPT_LETTER[ch] || ch).join('');
  }

  // 把 x^2、x^(1/3)、pi 之类的写法转成画布上更易读的符号；
  // 与函数卡片上的 LaTeX 排版保持同一套记号。
  function prettyExpr(text) {
    let out = String(text);

    // 简单底数的分数指数写成根式：x^(1/3) -> ³√x、x^(1/2) -> √x
    out = out.replace(/([A-Za-z]|\d+(?:\.\d+)?)\^\(\s*1\s*\/\s*(\d+)\s*\)/g, (m, base, n) =>
      (n === '2' ? '√' : toSuperscript(n) + '√') + base);

    // 带括号的整数指数：x^(-2)、x^(3)
    out = out.replace(/\^\((-?\d+)\)/g, (m, digits) => toSuperscript(digits));

    // 不带括号的整数指数：x^2、x^-2；分数指数留到上面处理，避免只匹配到分子
    out = out.replace(/\^(-?\d+)(?![\d/.])/g, (m, digits) => toSuperscript(digits));

    // 单字母指数：2^x -> 2ˣ、x^n -> xⁿ
    out = out.replace(/\^([xXnN])(?![A-Za-z0-9])/g, (m, ch) => SUPERSCRIPT_LETTER[ch]);

    // 根号：简单内容去掉括号（sqrt(x) -> √x），复杂内容保留
    out = out.replace(/sqrt\(([^()]*)\)/g, (m, inner) =>
      (/^[A-Za-z]$|^\d+(?:\.\d+)?$/.test(inner) ? '√' + inner : '√(' + inner + ')'));

    out = out
      .replace(/\blog2\(/gi, 'log₂(')
      .replace(/\blog10\(/gi, 'lg(')
      .replace(/\bpi\b/gi, 'π')
      .replace(/\*/g, '·');
    return out.length > 22 ? out.slice(0, 22) + '…' : out;
  }

  function drawCurves() {
    const curves = [];
    state.functions
      .filter((f) => f.visible && !f.error)
      .forEach((f) => {
        curves.push({
          id: f.id,
          color: f.color,
          segments: f.segments,
          label: 'y = ' + prettyExpr(f.expr),
          visible: f.visible,
        });
        // 导数曲线：虚线、同色，hover 取值同样可用
        if (f.showDerivative && f.dsegments && f.dsegments.length) {
          curves.push({
            id: f.id + "'d",
            color: f.color,
            segments: f.dsegments,
            label: "y′ = " + prettyExpr(f.expr),
            visible: true,
            dashed: true,
            width: 1.6,
            isDerivative: true,
          });
        }
      });
    plot.setCurves(curves);
  }

  /* ============================================================
     浮层：渐近线 / 关键点 / 交点
     ============================================================ */

  function renderOverlays() {
    const asymptotes = [];
    const points = [];
    state.functions.forEach((f) => {
      if (!f.visible || !f.analysis) return;
      // 渐近线属于曲线本身的性质，所有可见函数都画；
      // 关键点只在展开分析的那个函数上标注，避免标注堆叠。
      (f.analysis.asymptotes.vertical || []).forEach((v) => {
        const m = /x\s*=\s*(-?[\d.eE+-]+)/.exec(v);
        if (m) asymptotes.push({ x: parseFloat(m[1]), label: v });
      });
      if (!f.expanded) return;
      (f.analysis.points || []).forEach((p) => {
        points.push({ x: p.x, y: p.y, label: p.label, color: f.color, hollow: p.hollow });
      });
    });
    plot.setOverlays({
      asymptotes,
      points,
      intersections: plot.overlays.intersections,
    });
  }

  async function refreshIntersections() {
    const list = visibleFunctions().slice(0, 5);
    if (list.length < 2) {
      plot.setOverlays({ intersections: [] });
      return;
    }
    const r = plot.getRange();
    const jobs = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        jobs.push({
          a: { expr: list[i].expr, params: list[i].params },
          b: { expr: list[j].expr, params: list[j].params },
          xmin: r.xMin, xmax: r.xMax,
        });
      }
    }
    try {
      const results = await Promise.all(jobs.map((j) => api('/api/intersections', j)));
      const pts = [];
      results.forEach((res) => {
        (res.points || []).forEach((p) => pts.push(p));
      });
      plot.setOverlays(Object.assign({}, plot.overlays, { intersections: pts }));
      if (pts.length) {
        const texts = pts.slice(0, 6).map((p) => `(${fmtNum(p.x, 4)}, ${fmtNum(p.y, 4)})`);
        el.readout.innerHTML = '<div class="row"><b>交点：</b>' + escapeHtml(texts.join('  ')) + '</div>';
        el.readout.classList.add('show');
        clearTimeout(refreshIntersections._t);
        refreshIntersections._t = setTimeout(() => el.readout.classList.remove('show'), 4000);
      } else {
        toast('当前范围内没有找到交点');
      }
    } catch (err) {
      toast('求交点失败');
    }
  }

  /* ============================================================
     画布点选工具：切线 / 定积分
     ============================================================ */

  /** 在 x 处挑选"离点击位置最近"的可见基础曲线（导数曲线不参与拾取） */
  function nearestCurve(xMath, yMath) {
    const vals = (plot.valuesAt(xMath) || []).filter((v) => !v.isDerivative);
    if (!vals.length) return null;
    if (!isFinite(yMath)) return vals[0];
    let best = vals[0];
    let bd = Infinity;
    for (const v of vals) {
      const d = Math.abs(v.y - yMath);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  async function handleTangentPick(p) {
    const v = nearestCurve(p.x, p.y);
    if (!v) { toast('该位置附近没有曲线'); return; }
    const item = state.functions.find((f) => f.id === v.id);
    if (!item) return;
    try {
      const res = await api('/api/tangent', { expr: item.expr, params: item.params, x0: p.x });
      if (!res.ok) { toast(res.error || '求切线失败'); return; }
      // 只保留最新一条切线，避免多条相互遮挡
      plot.setOverlays(Object.assign({}, plot.overlays, {
        tangents: [{
          x0: res.x, y0: res.y, slope: res.slope, color: v.color,
          label: 'k = ' + fmtNum(res.slope, 4),
        }],
      }));
      el.readout.innerHTML =
        '<div class="row"><b>切线</b>　y = ' + escapeHtml(item.expr) + '</div>' +
        '<div class="row">切点 x = ' + fmtNum(res.x, 5) + '，y = ' + fmtNum(res.y, 5) +
        '　斜率 k = ' + fmtNum(res.slope, 5) + '</div>';
      el.readout.classList.add('show');
      clearTimeout(handleTangentPick._t);
      handleTangentPick._t = setTimeout(() => el.readout.classList.remove('show'), 4000);
    } catch (err) {
      toast('后端未响应，请检查服务是否在运行');
    }
  }

  async function handleIntegralPick(p) {
    const v = nearestCurve(p.x, p.y);
    if (!v) { toast('该位置附近没有曲线'); return; }
    const item = state.functions.find((f) => f.id === v.id);
    if (!item) return;
    // 第一次点击记起点，第二次点击取终点并计算（换曲线则重新记起点）
    if (tool.curveId !== v.id || tool.a === null) {
      tool.curveId = v.id;
      tool.a = p.x;
      plot.setOverlays(Object.assign({}, plot.overlays, { areas: [] }));
      toast('起点 x = ' + fmtNum(p.x, 5) + '，再点击终点', 2400);
      return;
    }
    const a = tool.a;
    const b = p.x;
    tool.a = null;
    try {
      const res = await api('/api/integral', { expr: item.expr, params: item.params, a, b });
      if (!res.ok) { toast(res.error || '积分失败'); return; }
      plot.setOverlays(Object.assign({}, plot.overlays, {
        areas: [{
          x0: a, x1: b, segments: item.segments, color: v.color,
          label: '∫ = ' + fmtNum(res.value, 5),
        }],
      }));
      el.readout.innerHTML =
        '<div class="row"><b>定积分</b>　∫[' + fmtNum(Math.min(a, b), 4) + ', ' +
        fmtNum(Math.max(a, b), 4) + '] ' + escapeHtml(item.expr) + ' dx = ' +
        fmtNum(res.value, 6) + '</div>';
      el.readout.classList.add('show');
      clearTimeout(handleIntegralPick._t);
      handleIntegralPick._t = setTimeout(() => el.readout.classList.remove('show'), 5000);
    } catch (err) {
      toast('后端未响应，请检查服务是否在运行');
    }
  }

  /* ============================================================
     状态持久化与分享（localStorage 自动保存 + URL hash 还原）
     ============================================================ */

  function serializeState() {
    return {
      v: 1,
      fns: state.functions.map((f) => ({
        e: f.expr,
        p: f.params,
        c: f.color,
        v: f.visible ? 1 : 0,
        d: f.showDerivative ? 1 : 0,
      })),
      view: { cx: plot.view.cx, cy: plot.view.cy, s: plot.view.scale },
      theme: document.documentElement.getAttribute('data-theme'),
    };
  }

  function applyState(s) {
    if (!s || !Array.isArray(s.fns)) return false;
    const fns = [];
    s.fns.slice(0, 12).forEach((sf) => {
      if (!sf || typeof sf.e !== 'string' || !sf.e.trim()) return;
      fns.push({
        id: 'fn' + (++state.seq),
        expr: sf.e.trim().slice(0, 120),
        color: COLORS.indexOf(sf.c) > -1 ? sf.c : COLORS[fns.length % COLORS.length],
        visible: sf.v !== 0,
        params: (sf.p && typeof sf.p === 'object') ? Object.assign({}, sf.p) : {},
        paramList: [],
        analysis: null,
        segments: [],
        dsegments: [],
        error: '',
        expanded: false,
        showDerivative: !!sf.d,
        _fresh: false,
      });
    });
    if (!fns.length) return false;
    state.functions = fns;
    if (s.view && isFinite(s.view.cx) && isFinite(s.view.s) && s.view.s > 0) {
      plot.setView(Number(s.view.cx), Number(s.view.cy) || 0, Number(s.view.s));
    }
    if (s.theme === 'dark' || s.theme === 'light') {
      document.documentElement.setAttribute('data-theme', s.theme);
      const btn = $('#btn-theme');
      if (btn) btn.innerHTML = s.theme === 'dark' ? '☀️ <span class="tlabel">白天</span>' : '🌙 <span class="tlabel">夜间</span>';
      plot.setOptions({ theme: s.theme });
    }
    return true;
  }

  function restoreFromHash() {
    try {
      if (location.hash.indexOf('#s=') !== 0) return false;
      return applyState(JSON.parse(decodeURIComponent(location.hash.slice(3))));
    } catch (e) {
      return false;
    }
  }

  function restoreFromStorage() {
    try {
      const raw = localStorage.getItem('fn-plot-state');
      if (!raw) return false;
      return applyState(JSON.parse(raw));
    } catch (e) {
      return false;
    }
  }

  function scheduleSave() {
    clearTimeout(scheduleSave._t);
    scheduleSave._t = setTimeout(() => {
      try { localStorage.setItem('fn-plot-state', JSON.stringify(serializeState())); } catch (e) { /* 忽略 */ }
    }, 400);
  }

  /* ============================================================
     渲染：函数列表
     ============================================================ */

  function renderList() {
    const items = state.functions;
    el.count.textContent = String(items.length);
    el.empty.style.display = items.length ? 'none' : 'block';
    el.list.innerHTML = '';

    items.forEach((f) => {
      const li = document.createElement('li');
      li.className = 'fn-item' + (f.visible ? '' : ' hidden-fn') + (f.error ? ' error' : '');
      li.dataset.id = f.id;

      const head = document.createElement('div');
      head.className = 'fn-head';

      const dot = document.createElement('span');
      dot.className = 'color-dot';
      dot.style.background = f.color;
      dot.title = '点击更换颜色';
      dot.addEventListener('click', () => cycleColor(f.id));
      head.appendChild(dot);

      const expr = document.createElement('div');
      expr.className = 'fn-expr';
      if (f.analysis && f.analysis.latex) {
        expr.innerHTML = 'y = ' + MathRender.render(f.analysis.latex);
      } else {
        expr.innerHTML = escapeHtml('y = ' + f.expr);
      }
      head.appendChild(expr);

      const tools = document.createElement('div');
      tools.className = 'fn-tools';

      const btnEye = document.createElement('button');
      btnEye.innerHTML = f.visible ? '👁' : '🚫';
      btnEye.title = f.visible ? '隐藏' : '显示';
      btnEye.className = f.visible ? 'on' : '';
      btnEye.addEventListener('click', () => toggleVisible(f.id));
      tools.appendChild(btnEye);

      const btnInfo = document.createElement('button');
      btnInfo.innerHTML = 'ⓘ';
      btnInfo.title = '性质分析';
      btnInfo.className = f.expanded ? 'on' : '';
      btnInfo.addEventListener('click', () => {
        const next = !f.expanded;
        // 手风琴式：同时只展开一个函数，画布上的关键点标注才不会互相遮挡
        state.functions.forEach((item) => { item.expanded = false; });
        f.expanded = next;
        renderList();
        renderOverlays();
      });
      tools.appendChild(btnInfo);

      const btnDeriv = document.createElement('button');
      btnDeriv.innerHTML = "f′";
      btnDeriv.title = '叠加导数曲线 y′ = f′(x)';
      btnDeriv.className = f.showDerivative ? 'on' : '';
      btnDeriv.addEventListener('click', () => {
        f.showDerivative = !f.showDerivative;
        renderList();
        requestPlot(true);
        scheduleSave();
      });
      tools.appendChild(btnDeriv);

      const btnDel = document.createElement('button');
      btnDel.innerHTML = '✕';
      btnDel.className = 'del';
      btnDel.title = '删除';
      btnDel.addEventListener('click', () => removeFunction(f.id));
      tools.appendChild(btnDel);

      head.appendChild(tools);
      li.appendChild(head);

      // 类型徽章与提示
      const meta = document.createElement('div');
      meta.className = 'fn-meta';
      if (f.error) {
        meta.innerHTML = '<span style="color:var(--danger)">⚠ ' + escapeHtml(f.error) + '</span>';
      } else if (f.analysis) {
        const kind = f.analysis.kind ? '<span class="badge">' + escapeHtml(f.analysis.kind) + '</span>' : '';
        const pts = (f.analysis.zeros || []).length;
        const extra = [];
        if (pts) extra.push('零点 ' + pts + ' 个');
        const asy = (f.analysis.asymptotes.vertical || []).length +
                    (f.analysis.asymptotes.horizontal || []).length +
                    (f.analysis.asymptotes.oblique || []).length;
        if (asy) extra.push('渐近线 ' + asy + ' 条');
        meta.innerHTML = kind + (extra.length ? '<span>' + extra.join(' · ') + '</span>' : '');
      }
      li.appendChild(meta);

      // 参数滑块
      if (!f.error && f.paramList && f.paramList.length) {
        const box = document.createElement('div');
        box.className = 'params';
        f.paramList.forEach((name) => {
          const value = f.params[name] !== undefined ? f.params[name] : 1;
          const row = document.createElement('div');
          row.className = 'param-row';
          row.innerHTML =
            '<span class="param-name">' + escapeHtml(name) + '</span>' +
            '<input type="range" min="-10" max="10" step="0.1" value="' + value + '">' +
            '<span class="param-value">' + fmtNum(value, 4) + '</span>';
          const slider = row.querySelector('input');
          const label = row.querySelector('.param-value');
          slider.addEventListener('input', () => {
            const v = parseFloat(slider.value);
            f.params[name] = v;
            label.textContent = fmtNum(v, 4);
            requestPlot(true);
            scheduleAnalysisRefresh(f);
            scheduleSave();
          });
          box.appendChild(row);
        });
        li.appendChild(box);
      }

      // 性质分析
      if (!f.error && f.expanded && f.analysis) {
        li.appendChild(buildAnalysis(f));
      }

      el.list.appendChild(li);
    });

    scheduleSave();
  }

  function scheduleAnalysisRefresh(f) {
    clearTimeout(f._paramTimer);
    f._paramTimer = setTimeout(() => refreshAnalysis(f), 260);
  }

  function renderListErrors() {
    // 采样阶段的错误（例如定义域为空）只更新错误提示，避免整表重绘打断滑块拖动
    state.functions.forEach((f) => {
      const node = el.list.querySelector('.fn-item[data-id="' + f.id + '"]');
      if (!node) return;
      node.classList.toggle('error', !!f.error);
    });
  }

  function buildAnalysis(f) {
    const a = f.analysis;
    const box = document.createElement('div');
    box.className = 'analysis';
    let html = '';

    if (a.formula || a.kind) {
      html += '<div class="sect"><div class="sect-title">函数类型</div><div>' +
        escapeHtml(a.kind || '') + (a.formula ? '　' + escapeHtml(a.formula) : '') + '</div></div>';
    }

    if (a.properties && a.properties.length) {
      html += '<div class="sect"><div class="sect-title">基本性质</div><div class="prop-grid">';
      a.properties.forEach((p) => {
        html += '<div class="prop-row"><span class="k">' + escapeHtml(p.label) +
                '</span><span class="v">' + escapeHtml(p.value) + '</span></div>';
      });
      html += '</div></div>';
    }

    const extra = [];
    if (a.parity) extra.push('奇偶性：' + a.parity);
    if (a.domain_notes && a.domain_notes.length) extra.push('定义域：' + a.domain_notes.join('；'));
    if (a.y_intercept !== null && a.y_intercept !== undefined &&
        !(a.properties || []).some((p) => p.label.indexOf('y 轴') > -1)) {
      extra.push('与 y 轴交点：(0, ' + fmtNum(a.y_intercept) + ')');
    }
    if (extra.length) {
      html += '<div class="sect"><div class="sect-title">定义域与奇偶性</div><ul>';
      extra.forEach((t) => { html += '<li>' + escapeHtml(t) + '</li>'; });
      html += '</ul></div>';
    }

    if (a.zeros && a.zeros.length) {
      html += '<div class="sect"><div class="sect-title">零点（与 x 轴交点）</div><ul>';
      a.zeros.slice(0, 8).forEach((z) => {
        html += '<li>x = ' + fmtNum(z.x) + '</li>';
      });
      if (a.zeros.length > 8) html += '<li>…共 ' + a.zeros.length + ' 个</li>';
      html += '</ul></div>';
    }

    const asy = a.asymptotes || {};
    const asyText = []
      .concat((asy.vertical || []).map((v) => '垂直 ' + v))
      .concat((asy.horizontal || []).map((v) => '水平 ' + v))
      .concat((asy.oblique || []).map((v) => '斜 ' + v));
    if (asyText.length) {
      html += '<div class="sect"><div class="sect-title">渐近线</div><ul>';
      asyText.forEach((t) => { html += '<li>' + escapeHtml(t) + '</li>'; });
      html += '</ul></div>';
    }

    if (a.monotonic && a.monotonic.length) {
      html += '<div class="sect"><div class="sect-title">单调性</div><ul>';
      a.monotonic.slice(0, 8).forEach((m) => {
        html += '<li>在 ' + escapeHtml(m.interval) + ' 上 ' + escapeHtml(m.behavior) + '</li>';
      });
      if (a.monotonic.length > 8) html += '<li>…</li>';
      html += '</ul></div>';
    }

    if (a.extrema && a.extrema.length) {
      html += '<div class="sect"><div class="sect-title">极值点</div><ul>';
      a.extrema.forEach((m) => {
        html += '<li>' + escapeHtml(m.kind) + '：x = ' + fmtNum(m.x) + '，y = ' + fmtNum(m.y) + '</li>';
      });
      html += '</ul></div>';
    }

    if (a.inflections && a.inflections.length) {
      html += '<div class="sect"><div class="sect-title">拐点</div><ul>';
      a.inflections.forEach((m) => {
        html += '<li>(' + fmtNum(m.x) + ', ' + fmtNum(m.y) + ')</li>';
      });
      html += '</ul></div>';
    }

    if (a.derivative_latex) {
      html += '<div class="sect"><div class="sect-title">导数</div><div>y′ = ' +
              MathRender.render(a.derivative_latex) + '</div></div>';
    }

    box.innerHTML = html;
    return box;
  }

  /* ============================================================
     渲染：数据表
     ============================================================ */

  function renderTable() {
    if (!state.tableOpen) return;
    const list = visibleFunctions();
    const xs = tableXs();
    if (!list.length || !xs.length) {
      el.tableScroll.innerHTML = '<div class="empty">没有可显示的数据</div>';
      return;
    }
    let html = '<table class="data-table"><thead><tr><th>x</th>';
    list.forEach((f) => {
      html += '<th style="color:' + f.color + '">y = ' + escapeHtml(f.expr) + '</th>';
    });
    html += '</tr></thead><tbody>';
    xs.forEach((x, idx) => {
      html += '<tr><td>' + fmtNum(x) + '</td>';
      list.forEach((f) => {
        let y = null;
        if (f.table) {
          const hit = f.table.find((t) => Math.abs(t.x - x) < 1e-9);
          if (hit) y = hit.y;
        }
        html += '<td>' + (y === null || y === undefined ? '—' : fmtNum(y, 6)) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    el.tableScroll.innerHTML = html;
  }

  /* ============================================================
     预设库
     ============================================================ */

  async function loadPresets() {
    try {
      const res = await fetch('/api/presets');
      const data = await res.json();
      const groups = data.groups || [];
      el.presets.innerHTML = '';
      groups.forEach((g, idx) => {
        const div = document.createElement('div');
        div.className = 'preset-group' + (idx < 3 ? ' open' : '');
        const title = document.createElement('div');
        title.className = 'preset-title';
        title.textContent = g.group;
        title.addEventListener('click', () => div.classList.toggle('open'));
        div.appendChild(title);

        const items = document.createElement('div');
        items.className = 'preset-items';
        (g.items || []).forEach((it) => {
          const chip = document.createElement('button');
          chip.className = 'preset-chip';
          chip.innerHTML = escapeHtml(it.name) +
            (it.note ? '<small>' + escapeHtml(it.note) + '</small>' : '');
          chip.title = it.note || '';
          chip.addEventListener('click', () => {
            const added = addFunction(it.expr, it.params);
            if (added) setHint('已添加：' + it.name, 'ok');
          });
          items.appendChild(chip);
        });
        div.appendChild(items);
        el.presets.appendChild(div);
      });
    } catch (err) {
      el.presets.innerHTML = '<div class="empty">预设库加载失败，请确认后端已启动</div>';
    }
  }

  /* ============================================================
     交互绑定
     ============================================================ */

  function syncVolume() {
    const has = state.functions.length > 0;
    $('#btn-clear').disabled = !has;
  }

  function bindUI() {
    $('#btn-add').addEventListener('click', () => {
      const text = el.input.value.trim();
      if (!text) { setHint('请先输入函数表达式', 'error'); el.input.focus(); return; }
      const item = addFunction(text);
      if (item) {
        el.input.value = '';
        setHint('已添加 y = ' + text + '，可在下方拖动参数滑块', 'ok');
      }
    });

    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('#btn-add').click(); }
      else setHint('');
    });

    $('#quick-tags').addEventListener('click', (e) => {
      const tag = e.target.closest('.tag');
      if (!tag) return;
      const text = tag.dataset.insert;
      const start = el.input.selectionStart || 0;
      const end = el.input.selectionEnd || 0;
      const value = el.input.value;
      el.input.value = value.slice(0, start) + text + value.slice(end);
      const caret = start + text.length;
      el.input.focus();
      el.input.setSelectionRange(caret, caret);
    });

    $('#btn-clear').addEventListener('click', () => {
      state.functions = [];
      state.colorIndex = 0;
      plot.setOverlays({ intersections: [], points: [], asymptotes: [] });
      renderList();
      syncVolume();
      requestPlot(true);
    });

    const demo = [
      ['x^2-3x+2', {}],
      ['2x+1', {}],
      ['1/x', {}],
    ];
    $('#btn-demo').addEventListener('click', () => {
      state.functions = [];
      renderList();
      plot.reset(true);
      demo.forEach(([expr, params]) => addFunction(expr, params));
      toast('已加载示例组合');
    });

    // 画布工具
    $('#btn-zoom-in').addEventListener('click', () => plot.zoomCenter(1.3));
    $('#btn-zoom-out').addEventListener('click', () => plot.zoomCenter(1 / 1.3));
    $('#btn-reset').addEventListener('click', () => plot.reset(true));

    $('#btn-grid').addEventListener('click', (e) => {
      const on = !e.currentTarget.classList.contains('active');
      e.currentTarget.classList.toggle('active', on);
      plot.setOptions({ grid: on });
    });

    $('#btn-asym').addEventListener('click', (e) => {
      const on = !e.currentTarget.classList.contains('active');
      e.currentTarget.classList.toggle('active', on);
      plot.setOptions({ asymptotes: on });
    });

    $('#btn-cross').addEventListener('click', (e) => {
      state.showIntersections = !state.showIntersections;
      e.currentTarget.classList.toggle('active', state.showIntersections);
      if (state.showIntersections) refreshIntersections();
      else plot.setOverlays(Object.assign({}, plot.overlays, { intersections: [] }));
    });

    // ---- 点选工具：切线 / 定积分 ----
    function setTool(mode) {
      tool.mode = mode;
      tool.curveId = null;
      tool.a = null;
      $('#btn-tangent').classList.toggle('active', mode === 'tangent');
      $('#btn-integral').classList.toggle('active', mode === 'integral');
      plot.setOverlays(Object.assign({}, plot.overlays, {
        tangents: mode === 'tangent' ? plot.overlays.tangents : [],
        areas: mode === 'integral' ? plot.overlays.areas : [],
      }));
      if (mode === 'tangent') toast('切线工具：点击曲线上任意一点', 2400);
      else if (mode === 'integral') toast('积分工具：先点起点，再点终点', 2400);
      else toast('已退出点选工具', 1600);
    }
    $('#btn-tangent').addEventListener('click', () => setTool(tool.mode === 'tangent' ? null : 'tangent'));
    $('#btn-integral').addEventListener('click', () => setTool(tool.mode === 'integral' ? null : 'integral'));

    plot.on('pick', (p) => {
      if (!p || !tool.mode) return;
      if (tool.mode === 'tangent') handleTangentPick(p);
      else if (tool.mode === 'integral') handleIntegralPick(p);
    });

    // ---- 光标模式：触屏设备自动开启，点按画布即可读取数值 ----
    const isTouch = (window.matchMedia && matchMedia('(pointer: coarse)').matches) ||
                    matchMedia('(hover: none)').matches;
    plot.setOptions({ tapCursor: isTouch });
    $('#btn-cursor').classList.toggle('active', isTouch);
    if (isTouch) toast('光标模式：十字准线会显示在手指上方，不会被遮挡', 3000);
    $('#btn-cursor').addEventListener('click', () => {
      const on = !plot.options.tapCursor;
      plot.setOptions({ tapCursor: on });
      $('#btn-cursor').classList.toggle('active', on);
      if (on) toast('光标模式：点按画布任意位置读取数值', 2400);
      else { plot.clearHover(); toast('已关闭光标', 1600); }
    });

    // ---- 保存为文件 / 从文件打开 ----
    $('#btn-save').addEventListener('click', () => {
      try {
        const blob = new Blob([JSON.stringify(serializeState())], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const t = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        a.href = url;
        a.download = 'OrthoPlot-' + t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate()) +
          '-' + pad(t.getHours()) + pad(t.getMinutes()) + pad(t.getSeconds()) + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast('已保存到下载目录（.json）', 2400);
      } catch (e) {
        toast('保存失败：' + (e.message || e));
      }
    });

    $('#btn-open').addEventListener('click', () => $('#file-open').click());
    $('#file-open').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';  // 允许下次重复选择同一文件
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const s = JSON.parse(String(reader.result));
          if (!s || !Array.isArray(s.fns) || !s.fns.length) throw new Error('bad file');
          // 清空当前工作区（含点选工具的浮层）后应用导入状态
          state.functions = [];
          state.colorIndex = 0;
          tool.mode = null;
          tool.a = null;
          tool.curveId = null;
          $('#btn-tangent').classList.remove('active');
          $('#btn-integral').classList.remove('active');
          plot.setOverlays({ intersections: [], points: [], asymptotes: [], tangents: [], areas: [] });
          if (!applyState(s)) { toast('文件里没有可用的函数'); return; }
          renderList();
          syncVolume();
          state.functions.forEach((f) => refreshAnalysis(f));
          requestPlot(true);
          scheduleSave();
          toast('已打开：' + s.fns.length + ' 个函数', 2400);
        } catch (err) {
          toast('无法识别的文件，请选择本站保存的 .json');
        }
      };
      reader.onerror = () => toast('读取文件失败');
      reader.readAsText(file);
    });

    $('#btn-table').addEventListener('click', (e) => {
      state.tableOpen = !state.tableOpen;
      e.currentTarget.classList.toggle('active', state.tableOpen);
      el.tablePanel.classList.toggle('open', state.tableOpen);
      if (state.tableOpen) requestPlot(true);
      renderTable();
    });

    $('#btn-table-close').addEventListener('click', () => {
      state.tableOpen = false;
      $('#btn-table').classList.remove('active');
      el.tablePanel.classList.remove('open');
    });

    /* ---------------- 导出 PNG（自定义分辨率） ---------------- */
    const exportW = $('#export-width');
    const exportH = $('#export-height');

    const exportNative = () => [
      Math.max(100, Math.round(plot.width * plot.dpr)),
      Math.max(100, Math.round(plot.height * plot.dpr)),
    ];

    const openExport = () => {
      const [w, h] = exportNative();
      exportW.value = w;
      exportH.value = h;
      el.export.classList.add('open');
      exportW.focus();
      exportW.select();
    };

    const closeExport = () => el.export.classList.remove('open');

    const applyExportPreset = (name) => {
      const [nw, nh] = exportNative();
      const presets = {
        current: [nw, nh],
        '2x': [nw * 2, nh * 2],
        '1080p': [1920, 1080],
        '1440p': [2560, 1440],
        '4k': [3840, 2160],
        '5k': [5120, 2880],
        '8k': [7680, 4320],
        '100mp': [10000, 10000],
      };
      const p = presets[name];
      if (p) {
        exportW.value = p[0];
        exportH.value = p[1];
      }
    };

    const doExport = async () => {
      const confirmBtn = $('#btn-export-confirm');
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = '' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
        '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
      confirmBtn.disabled = true;
      confirmBtn.textContent = '导出中…';
      try {
        const res = await plot.exportPNG('OrthoPlot-' + stamp + '.png', {
          width: Math.round(Number(exportW.value)),
          height: Math.round(Number(exportH.value)),
        });
        if (!res.ok) {
          toast(res.error || '导出失败', 3000);
          return;
        }
        closeExport();
        toast('已导出 PNG（' + res.width + '×' + res.height + '）', 3000);
      } catch (err) {
        toast('导出失败：' + (err && err.message ? err.message : err), 3000);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = '导出';
      }
    };

    $('#btn-export').addEventListener('click', openExport);
    $('#btn-export-close').addEventListener('click', closeExport);
    $('#btn-export-cancel').addEventListener('click', closeExport);
    $('#btn-export-confirm').addEventListener('click', doExport);
    el.export.addEventListener('click', (e) => {
      if (e.target === el.export) closeExport();
    });
    document.querySelectorAll('[data-export-preset]').forEach((btn) => {
      btn.addEventListener('click', () => applyExportPreset(btn.dataset.exportPreset));
    });
    [exportW, exportH].forEach((inp) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          doExport();
        }
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeExport();
    });

    $('#btn-full').addEventListener('click', () => {
      const wrap = document.querySelector('.canvas-wrap');
      if (!document.fullscreenElement) {
        (wrap.requestFullscreen ? wrap.requestFullscreen() : Promise.reject()).catch(() => {});
      } else {
        document.exitFullscreen();
      }
      setTimeout(() => plot.resize(), 350);
    });

    document.addEventListener('fullscreenchange', () => setTimeout(() => plot.resize(), 120));

    // 主题
    const btnTheme = $('#btn-theme');
    const applyTheme = (theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      btnTheme.innerHTML = theme === 'dark' ? '☀️ <span class="tlabel">白天</span>' : '🌙 <span class="tlabel">夜间</span>';
      localStorage.setItem('fn-plot-theme', theme);
      plot.setOptions({ theme });
      plot.requestDraw();
      renderTable();
      scheduleSave();
    };
    const saved = localStorage.getItem('fn-plot-theme');
    if (saved === 'dark') applyTheme('dark');
    btnTheme.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });

    // 帮助
    $('#btn-help').addEventListener('click', () => el.help.classList.add('open'));
    $('#btn-help-close').addEventListener('click', () => el.help.classList.remove('open'));
    el.help.addEventListener('click', (e) => {
      if (e.target === el.help) el.help.classList.remove('open');
    });

    // 更新提示：关闭本次提示只记住当前版本，后续版本仍会再次提醒
    if (el.updateDismiss) {
      el.updateDismiss.addEventListener('click', () => {
        const latest = (el.updateVersion.textContent || '').replace(/^v/, '');
        if (latest) updateStorageSet(UPDATE_DISMISS_KEY, latest);
        el.updateBanner.hidden = true;
      });
    }
    if (el.checkUpdate) {
      el.checkUpdate.addEventListener('click', () => {
        el.help.classList.remove('open');
        checkForUpdates(true);
      });
    }

    // 画布事件
    plot.on('hover', (h) => {
      if (!h || !h.values || !h.values.length) {
        el.readout.classList.remove('show');
        return;
      }
      let html = '<div class="row"><b>x = ' + fmtNum(h.x, 5) + '</b></div>';
      h.values.slice(0, 5).forEach((v) => {
        html += '<div class="row"><i style="background:' + v.color + '"></i>' +
                escapeHtml(v.label || '') + ' ： y = ' + fmtNum(v.y, 6) + '</div>';
      });
      el.readout.innerHTML = html;
      el.readout.classList.add('show');
    });

    // 视图变化 → 需要时重新采样
    let viewTimer = null;
    plot.on('viewchange', () => {
      scheduleSave();
      const r = plot.getRange();
      const f = state.fetchRange;
      // 两种情况需要重新采样：
      //   1. 视野超出已取数据范围（缩小 / 平移出界）；
      //   2. 深度放大：视野比取数时缩小到 1/3 以下，旧数据的采样间距
      //      在当前视野里已经稀疏到无法还原曲线（表现为直线段 / 乱线），
      //      必须按新范围重新请求。
      // 连续缩放期间，单纯的 110ms 防抖会被不断重置、重采样一直推迟，
      // 旧折线相对新视野越来越稀疏（曲线呈棱角）。因此用"节流 + 尾随"：
      // 距上次请求超过 220ms 就立即采样一轮，否则走尾随防抖兜底。
      const needFetch = !f ||
        r.xMin < f.xmin + (f.xmax - f.xmin) * 0.02 ||
        r.xMax > f.xmax - (f.xmax - f.xmin) * 0.02 ||
        (r.xMax - r.xMin) < (f.xmax - f.xmin) / 3;
      if (needFetch) {
        if (Date.now() - state.lastPlotAt > 220) requestPlot(true);
        else requestPlot(false);
      }
      if (state.tableOpen) {
        clearTimeout(viewTimer);
        viewTimer = setTimeout(() => requestPlot(true), 260);
      }
      if (state.showIntersections) {
        clearTimeout(viewTimer);
        viewTimer = setTimeout(() => refreshIntersections(), 420);
      }
    });
  }

  /* ============================================================
     启动
     ============================================================ */

  function boot() {
    bindUI();
    loadPresets();
    syncVolume();
    // 优先从分享链接还原，其次本地自动保存；都没有才加载默认示例
    const restored = restoreFromHash() || restoreFromStorage();
    if (restored && state.functions.length) {
      renderList();
      syncVolume();
      state.functions.forEach((f) => refreshAnalysis(f));
      requestPlot(true);
    } else {
      addFunction('x^2-3x+2');
      addFunction('2x+1');
      setTimeout(() => {
        plot.reset(false);
        requestPlot(true);
      }, 60);
    }
    window.addEventListener('resize', () => setTimeout(() => plot.resize(), 60));
    // 延迟检查，避免和首屏绘图 / 引擎预热抢资源；失败静默
    setTimeout(() => checkForUpdates(false), 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
