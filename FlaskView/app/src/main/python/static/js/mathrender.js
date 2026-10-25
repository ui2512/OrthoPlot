/* ============================================================
   mathrender.js —— 极简 LaTeX 渲染器
   只覆盖 SymPy 的 latex() 输出所用到的语法子集，
   用纯 HTML + CSS 排版（分数、根号、上下标），无需任何外部库。
   ============================================================ */

(function (global) {
  'use strict';

  const GREEK = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
    tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  };

  const SYMBOLS = {
    cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓',
    le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
    approx: '≈', equiv: '≡', infty: '∞', partial: '∂', nabla: '∇',
    to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒',
    in: '∈', notin: '∉', subset: '⊂', cup: '∪', cap: '∩', emptyset: '∅',
    ldots: '…', cdots: '⋯', ' ': ' ', ',': '\u2009', ';': '\u2009', quad: '\u2003', qquad: '\u2003\u2003',
    '\\': '\n', left: '', right: '', displaystyle: '', limits: '',
  };

  const FUNCS = new Set([
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
    'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp', 'max', 'min',
    'abs', 'sign', 'sgn', 'gcd', 'lcm', 'mod', 'det',
  ]);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function parse(src) {
    let i = 0;

    function parseGroup(stopAtBrace) {
      let out = '';
      let spaceBefore = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '}') break;
        if (ch === '{') { i++; out += parseGroup(true); if (src[i] === '}') i++; spaceBefore = false; continue; }
        if (ch === '\\') { out += parseCommand(spaceBefore); spaceBefore = false; continue; }
        if (ch === '^') { i++; out += '<sup>' + parseAtom() + '</sup>'; spaceBefore = false; continue; }
        if (ch === '_') { i++; out += '<sub>' + parseAtom() + '</sub>'; spaceBefore = false; continue; }
        if (ch === '&') { i++; spaceBefore = false; continue; }
        if (ch === '~') { i++; out += '\u00a0'; spaceBefore = false; continue; }
        if (ch === ' ') { i++; spaceBefore = true; continue; }
        i++;
        out += renderChar(ch);
        spaceBefore = false;
      }
      return out;
    }

    function parseAtom() {
      while (src[i] === ' ') i++;
      if (src[i] === '{') {
        i++;
        const html = parseGroup(true);
        if (src[i] === '}') i++;
        return html;
      }
      if (src[i] === '\\') return parseCommand();
      const c = src[i] || '';
      i++;
      return renderChar(c);
    }

    function parseCommand(spaceBefore) {
      i++; // 跳过反斜杠
      let name = '';
      if (/[a-zA-Z]/.test(src[i] || '')) {
        while (/[a-zA-Z]/.test(src[i] || '')) { name += src[i]; i++; }
      } else {
        const c = src[i] || '';
        i++;
        return escapeHtml(c === '\\' ? ' ' : c);
      }

      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const num = parseAtom();
        const den = parseAtom();
        return '<span class="frac"><span>' + num + '</span><span>' + den + '</span></span>';
      }

      if (name === 'sqrt') {
        let index = '';
        if (src[i] === '[') {
          const end = src.indexOf(']', i);
          if (end > -1) { index = src.slice(i + 1, end); i = end + 1; }
        }
        const body = parseAtom();
        const idx = index ? '<sup style="font-size:.62em">' + escapeHtml(index) + '</sup>' : '';
        return '<span class="sqrt">' + idx + '√<span class="radic">' + body + '</span></span>';
      }

      if (name === 'operatorname' || name === 'mathrm' || name === 'text') {
        const body = parseAtom();
        const plain = body.replace(/<\/?i>/g, '');
        return '<span class="fn">' + plain + '</span>';
      }

      if (name === 'left' || name === 'right') {
        const delim = src[i] || '';
        i++;
        return renderDelim(delim);
      }

      if (FUNCS.has(name)) {
        const lead = spaceBefore ? '<span class="op">\u2009</span>' : '';
        return lead + '<span class="fn">' + name + '</span>';
      }

      if (Object.prototype.hasOwnProperty.call(GREEK, name)) {
        return '<i>' + GREEK[name] + '</i>';
      }
      if (Object.prototype.hasOwnProperty.call(SYMBOLS, name)) {
        const sym = SYMBOLS[name];
        return sym === '' ? '' : '<span class="op">' + escapeHtml(sym) + '</span>';
      }
      return '<span class="fn">' + escapeHtml(name) + '</span>';
    }

    function renderDelim(ch) {
      const table = { '.': '', '{': '{', '}': '}', '|': '|', '\\': '‖', '(': '(', ')': ')', '[': '[', ']': ']' };
      if (ch === '.') return '';
      if (ch === '|') return '<span style="padding:0 1px">|</span>';
      if (ch === '{') return '<span style="padding:0 1px">{</span>';
      if (ch === '}') return '<span style="padding:0 1px">}</span>';
      return escapeHtml(Object.prototype.hasOwnProperty.call(table, ch) ? table[ch] : ch);
    }

    function renderChar(ch) {
      if (/[a-zA-Z]/.test(ch)) return '<i>' + ch + '</i>';
      if (/[0-9.]/.test(ch)) return ch;
      if (ch === '*') return '<span class="op">·</span>';
      if (ch === '<') return '<span class="op">&lt;</span>';
      if (ch === '>') return '<span class="op">&gt;</span>';
      if ('+-=±∓'.indexOf(ch) > -1) return '<span class="op">' + escapeHtml(ch) + '</span>';
      if (ch === ',') return '<span class="op">,</span>';
      if (ch === ' ') return '';
      return escapeHtml(ch);
    }

    const html = parseGroup(false);
    return html;
  }

  const cache = new Map();

  function renderLatex(latex) {
    if (!latex) return '';
    if (cache.has(latex)) return cache.get(latex);
    let html;
    try {
      html = '<span class="math">' + parse(String(latex)) + '</span>';
    } catch (err) {
      html = '<span class="math">' + escapeHtml(latex) + '</span>';
    }
    if (cache.size > 800) cache.clear();
    cache.set(latex, html);
    return html;
  }

  global.MathRender = { render: renderLatex, escapeHtml };
})(window);
