# -*- coding: utf-8 -*-
"""
function_engine.py —— 函数图像引擎（后端核心）
================================================

职责：
    1. 表达式清洗：兼容中文全角符号、上标 ``²``、``y=`` 前缀、隐式乘法
       (``2x`` / ``x(x+1)``)、``|x|`` 绝对值写法、``ln/lg/tg`` 等教材记号。
    2. 安全解析：基于 sympy.parse_expr + 受限命名空间，杜绝表达式注入。
    3. 性质分析：识别函数类型，给出顶点、零点、渐近线、单调区间、奇偶性等。
    4. 数值采样：先在符号层面定位不连续点，再分区间自适应细分，
       保证曲线平滑且渐近线处正确断开。

对外主要接口：
    parse_function(text)                -> 解析结果（表达式、参数、LaTeX）
    analyze(text, param_values)         -> 完整性质分析（字典，可直接转 JSON）
    sample_functions(items, x0, x1, ..) -> 批量采样，返回可绘制的折线段
    PRESETS                             -> 预设函数库
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass, field
from functools import cached_property, lru_cache
from typing import Any, Callable

import sympy as sp
from sympy.parsing.sympy_parser import (
    convert_xor,
    implicit_multiplication_application,
    parse_expr,
    standard_transformations,
)
from sympy.printing.latex import LatexPrinter

X = sp.Symbol("x", real=True)
NAN = float("nan")
INF = float("inf")

# Y 值上限：超过则视为“超出绘图范围”，仅用于避免无穷大破坏 JSON
Y_CAP = 1.0e6


class _NotationLatexPrinter(LatexPrinter):
    """按国内教材习惯输出 LaTeX：ln 为自然对数、lg 为常用对数、其它底数写 log_b。

    SymPy 会把 log(x, 10) 自动展开成 log(x)/log(10)，默认 latex 输出为分式；
    这里在该分式上还原成 lg(x) / log_b(x)，并让其余对数统一显示为 ln。
    """

    def _print_Mul(self, expr):
        num, den = expr.as_numer_denom()
        if isinstance(num, sp.log) and isinstance(den, sp.log):
            base = den.args[0]
            inner = num.args[0]
            if base.is_number and base.is_positive and base != 1 and base is not sp.E:
                if base == 10:
                    return r"\lg{\left(%s \right)}" % self._print(inner)
                return r"\log_{%s}{\left(%s \right)}" % (self._print(base), self._print(inner))
        return super()._print_Mul(expr)


def _latex(expr: sp.Expr) -> str:
    """公式排版统一入口，保证前端看到的对数记号与教材一致。"""
    try:
        return _NotationLatexPrinter({"ln_notation": True}).doprint(expr)
    except Exception:  # noqa: BLE001 —— 排版失败时退回默认输出，不影响分析
        return sp.latex(expr, ln_notation=True)


# --------------------------------------------------------------------------
# 一、表达式清洗与解析
# --------------------------------------------------------------------------

_SUPERSCRIPT = {
    "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
    "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
    "⁻": "-",
}

_CHAR_REPLACE = {
    "×": "*", "·": "*", "∙": "*", "⋅": "*", "＊": "*",
    "÷": "/", "／": "/",
    "−": "-", "–": "-", "—": "-", "－": "-",
    "＋": "+", "＝": "=", "，": ",", "。": ".", "；": ";", "：": ":",
    "（": "(", "）": ")", "【": "[", "】": "]", "｛": "{", "｝": "}",
    "｜": "|", "“": '"', "”": '"', "‘": "'", "’": "'",
}


def _add_log_helpers() -> dict[str, Callable]:
    """国内教材记号：lg 为常用对数，ln 为自然对数，log 默认以 10 为底。"""

    def lg(v):
        return sp.log(v, 10)

    def log(*args):
        if len(args) == 1:
            return sp.log(args[0], 10)
        if len(args) == 2:
            return sp.log(args[0], args[1])
        raise ValueError("log 的参数个数应为 1 或 2，例如 log(x) 或 log(x, 2)")

    def log10(v):
        return sp.log(v, 10)

    def log2(v):
        return sp.log(v, 2)

    def root(n, v):
        return sp.real_root(v, n)

    return {"lg": lg, "log": log, "ln": sp.log, "log10": log10, "log2": log2,
            "root": root, "cbrt": sp.cbrt, "mod": sp.Mod}


#: 允许出现在表达式中的函数名（同时用于阻止 split_symbols 把名字拆散）
ALLOWED_FUNCS: dict[str, Any] = {
    "sin": sp.sin, "cos": sp.cos, "tan": sp.tan, "cot": sp.cot,
    "sec": sp.sec, "csc": sp.csc,
    "asin": sp.asin, "acos": sp.acos, "atan": sp.atan, "acot": sp.acot,
    "sinh": sp.sinh, "cosh": sp.cosh, "tanh": sp.tanh,
    "exp": sp.exp, "sqrt": sp.sqrt, "abs": sp.Abs, "sign": sp.sign,
    "floor": sp.floor, "ceil": sp.ceiling, "min": sp.Min, "max": sp.Max,
    "factorial": sp.factorial, "gamma": sp.gamma,
}
ALLOWED_FUNCS.update(_add_log_helpers())

ALLOWED_CONSTS: dict[str, Any] = {
    "pi": sp.pi, "PI": sp.pi, "π": sp.pi,
    "e": sp.E, "E": sp.E,
    "oo": sp.oo, "inf": sp.oo,
}

# 解析用受限全局命名空间：只暴露构造表达式所需的最小集合
_SAFE_GLOBALS: dict[str, Any] = {
    "Symbol": sp.Symbol, "Integer": sp.Integer, "Float": sp.Float,
    "Rational": sp.Rational, "Function": sp.Function, "Abs": sp.Abs,
    "pi": sp.pi, "E": sp.E, "I": sp.I, "oo": sp.oo, "nan": sp.nan,
    "__builtins__": {},
}

_TRANSFORMATIONS = standard_transformations + (
    implicit_multiplication_application,
    convert_xor,
)

# sinx -> sin(x)、2sinx -> 2sin(x)、lnx -> ln(x) 之类的紧凑写法
# 用「非字母」而不是 \b：2sinx 里 sin 前面是数字，\b 匹配不到
_COMPACT_FUNC_RE = re.compile(
    r"(?<![A-Za-z])(sin|cos|tan|cot|ln|lg|log|abs|exp|sqrt)\s*x(?![A-Za-z0-9_(])",
    re.IGNORECASE,
)
# 顺带把 sin ( x ) 这类多余空格规整一下
_PADDED_FUNC_RE = re.compile(
    r"(?<![A-Za-z])(sin|cos|tan|cot|ln|lg|log|abs|exp|sqrt)\s*\(\s*x\s*\)",
    re.IGNORECASE,
)
# 未知的“函数写法”，例如 zzz(x)
_UNKNOWN_CALL_RE = re.compile(r"(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]*)\s*\(")
_PREFIX_RE = re.compile(
    r"^\s*(?:y|f\s*\(\s*x\s*\)|g\s*\(\s*x\s*\)|h\s*\(\s*x\s*\))\s*=\s*", re.IGNORECASE
)


class ExpressionError(ValueError):
    """用户输入无法解析时抛出。"""


def normalize_input(text: str) -> str:
    """把各种“人类写法”统一成 sympy 能读的 Python 表达式。"""
    if text is None:
        raise ExpressionError("表达式为空")
    s = str(text).strip()
    if not s:
        raise ExpressionError("表达式为空")

    # 去掉 y = / f(x) = 前缀
    s = _PREFIX_RE.sub("", s)

    # 上标数字转幂（必须在 NFKC 之前，否则 ² 会被拆成 2）
    s = re.sub(
        r"([⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+)",
        lambda m: "**" + "".join(_SUPERSCRIPT[c] for c in m.group(1)),
        s,
    )

    # 全角 → 半角
    s = unicodedata.normalize("NFKC", s)

    for a, b in _CHAR_REPLACE.items():
        s = s.replace(a, b)

    # 常用别名
    s = re.sub(r"\barc(sin|cos|tan|cot)\b", r"a\1", s)
    s = re.sub(r"\btg\b", "tan", s)
    s = re.sub(r"\bctg\b", "cot", s)
    s = s.replace("√", "sqrt")
    s = re.sub(r"\bln\s*\(", "ln(", s)

    # sinx / lnx → sin(x) / ln(x)，并去掉函数名与括号之间的空格
    s = _COMPACT_FUNC_RE.sub(r"\1(x)", s)
    s = _PADDED_FUNC_RE.sub(r"\1(x)", s)

    # |expr| → abs(expr)，由内向外逐层替换
    s = _convert_abs_bars(s)

    _reject_unknown_calls(s)
    return s.strip()


def _reject_unknown_calls(s: str) -> None:
    """拦下 zzz(x) 这类不认识的函数名，避免被当成 z*z*x 静默算错。"""
    common = "sin、cos、tan、ln、lg、log、sqrt、abs、exp"
    for m in _UNKNOWN_CALL_RE.finditer(s):
        name = m.group(1)
        if len(name) == 1 or name.lower() in ALLOWED_FUNCS:
            continue
        raise ExpressionError(f"不认识的函数名：{name}（常用函数有 {common} 等）")


def _convert_abs_bars(s: str) -> str:
    """把 |x-1| 形式的绝对值转成 abs(x-1)；从最内层开始替换。"""
    for _ in range(8):
        m = re.search(r"\|([^|]*)\|", s)
        if not m or not m.group(1).strip():
            break
        if "|" in m.group(1):
            break
        s = s[: m.start()] + "abs(" + m.group(1) + ")" + s[m.end():]
    return s


@dataclass
class ParsedFunction:
    """解析结果。

    latex / pretty 改为惰性计算并缓存：绘图路径只用 expr / params，
    而 sp.latex / sp.pretty 排版在 sympy 里并不便宜，按需计算可明显
    降低每次绘图请求的开销。

    实例由 parse_function 的缓存复用，请勿修改其字段。
    """

    raw: str
    normalized: str
    expr: sp.Expr
    params: list[sp.Symbol] = field(default_factory=list)

    @cached_property
    def latex(self) -> str:
        return _latex(self.expr)

    @cached_property
    def pretty(self) -> str:
        return sp.pretty(self.expr)

    @property
    def param_names(self) -> list[str]:
        return [str(p) for p in self.params]


@lru_cache(maxsize=256)
def parse_function(text: str) -> ParsedFunction:
    """解析用户输入的表达式，返回符号表达式与其中的参数字符。

    按输入文本缓存：同一表达式（拖动参数滑块 / 缩放平移 / 反复分析时）
    不必重复做 parse_expr（手机上单次可达数十到数百毫秒）。
    线程安全（lru_cache 内部加锁），结果只读复用。
    """
    normalized = normalize_input(text)

    local_dict: dict[str, Any] = {"x": X}
    local_dict.update(ALLOWED_FUNCS)
    local_dict.update(ALLOWED_CONSTS)

    try:
        expr = parse_expr(
            normalized,
            local_dict=local_dict,
            global_dict=_SAFE_GLOBALS,
            transformations=_TRANSFORMATIONS,
            evaluate=True,
        )
    except Exception as exc:  # noqa: BLE001 —— 统一转成友好报错
        raise ExpressionError(_friendly_parse_error(normalized, exc)) from exc

    if not isinstance(expr, sp.Expr):
        raise ExpressionError("无法理解该表达式")

    params = sorted(
        (s for s in expr.free_symbols if s is not X and s.is_real is not False),
        key=lambda s: str(s),
    )
    other = [s for s in expr.free_symbols if s is not X and s.is_real is False]
    if other:
        raise ExpressionError(
            "表达式中不能含有复数符号：%s" % ", ".join(str(s) for s in other)
        )

    return ParsedFunction(
        raw=text,
        normalized=normalized,
        expr=expr,
        params=params,
    )


def _friendly_parse_error(src: str, exc: Exception) -> str:
    msg = str(exc)
    if "SyntaxError" in type(exc).__name__ or "invalid syntax" in msg:
        return f"表达式语法有误：{src}（请检查括号与运算符是否配对）"
    if "unexpected" in msg.lower():
        return f"表达式无法识别：{src}"
    return f"表达式无法解析：{src}"


# --------------------------------------------------------------------------
# 二、数值求值器
# --------------------------------------------------------------------------


def _to_float(v: Any) -> float:
    """把 sympy/mpmath/复数结果统一成 float，非法值返回 nan。"""
    if v is None:
        return NAN
    if isinstance(v, complex):
        return float(v.real) if abs(v.imag) < 1e-12 else NAN
    if isinstance(v, bool):
        return float(v)
    try:
        if hasattr(v, "is_real") and not v.is_real:  # sympy 复数
            return NAN
        f = float(v)
    except (TypeError, ValueError, OverflowError):
        try:
            c = complex(v)
            return float(c.real) if abs(c.imag) < 1e-12 else NAN
        except Exception:  # noqa: BLE001
            return NAN
    return f if math.isfinite(f) else (NAN if math.isnan(f) else math.copysign(INF, f))


def _build_evaluator_uncached(
    expr: sp.Expr, params: tuple[sp.Symbol, ...]
) -> Callable[[float, list[float]], float]:
    """把符号表达式编译成快速的数值函数（未缓存实现）。

    依次尝试 math / mpmath / sympy 三种后端，保证各类函数都能求值。
    注意：探测点要避开 0、1 这类特殊值，否则 1/(x-1) 之类的表达式会在
    编译成功的情况下因除零被误判为“编译失败”，退化到极慢的符号求值。
    """
    args = (X, *params)
    n = len(params) + 1
    probe_points = [[0.37] * n, [2.31] * n, [1.13] * n]
    func: Callable | None = None

    for modules in (["math"], ["mpmath"], None):
        try:
            candidate = sp.lambdify(args, expr, modules=modules)
        except Exception:  # noqa: BLE001
            continue
        usable = False
        for probe in probe_points:
            try:
                value = candidate(*probe)
            except (ZeroDivisionError, ValueError, OverflowError):
                # 该点无定义，但说明编译成功，可以正常使用
                usable = True
                continue
            except Exception:  # noqa: BLE001
                break
            if not isinstance(value, sp.Basic):
                usable = True
                break
        if usable:
            func = candidate
            break

    if func is None:

        def func(*vals):  # type: ignore[misc]
            subs = dict(zip(args, [sp.Float(v) for v in vals]))
            return sp.N(expr.subs(subs), 15)

    def evaluate(xv: float, pvals: list[float] | None = None) -> float:
        pv = pvals if pvals is not None else [1.0] * len(params)
        try:
            return _to_float(func(xv, *pv))
        except Exception:  # noqa: BLE001
            return NAN

    return evaluate


@lru_cache(maxsize=512)
def _build_evaluator_cached(
    expr: sp.Expr, params: tuple[sp.Symbol, ...]
) -> Callable[[float, list[float]], float]:
    return _build_evaluator_uncached(expr, params)


def build_evaluator(
    expr: sp.Expr, params: list[sp.Symbol] | tuple[sp.Symbol, ...]
) -> Callable[[float, list[float]], float]:
    """把符号表达式编译成快速的数值函数（带缓存）。

    sp.lambdify 的单次编译在手机上可达几十到几百毫秒，是绘图 / 分析
    请求里最主要的重复开销；表达式与参数符号相同的请求（拖动滑块、
    缩放平移、分析后再绘图等）直接复用编译结果。
    """
    return _build_evaluator_cached(expr, tuple(params))


def make_eval(parsed: ParsedFunction, param_values: dict[str, float] | None) -> Callable[[float], float]:
    """给定参数取值，返回只接受 x 的一元数值函数。"""
    pvals = [float((param_values or {}).get(str(p), 1.0)) for p in parsed.params]
    f = build_evaluator(parsed.expr, parsed.params)
    return lambda xv: f(xv, pvals)


# --------------------------------------------------------------------------
# 三、不连续点定位
# --------------------------------------------------------------------------


def _numeric_roots(
    f: Callable[[float], float],
    x0: float,
    x1: float,
    n: int = 2400,
    verify_max: float | None = None,
) -> list[float]:
    """扫描符号变化 + 二分法求根（对超越方程同样有效）。

    verify_max 用于过滤“假根”：当函数在该点发散（极点）时 |f| 会远大于阈值，
    据此把极点与真正的零点区分开。
    """
    roots: list[float] = []
    prev_x = x0
    prev_y = f(x0)
    for i in range(1, n + 1):
        cur_x = x0 + (x1 - x0) * i / n
        cur_y = f(cur_x)
        if math.isfinite(prev_y) and math.isfinite(cur_y):
            if prev_y != 0.0 and cur_y == 0.0:
                # 记录零值区间的起点，避免 floor(x) 之类产生成片“零点”
                roots.append(cur_x)
            elif prev_y * cur_y < 0:
                a, b, fa = prev_x, cur_x, prev_y
                for _ in range(80):
                    m = (a + b) / 2
                    fm = f(m)
                    if not math.isfinite(fm):
                        break
                    if fa * fm <= 0:
                        b = m
                    else:
                        a, fa = m, fm
                    if b - a < 1e-12 * max(1.0, abs(a)):
                        break
                roots.append((a + b) / 2)
        prev_x, prev_y = cur_x, cur_y

    if verify_max is None:
        return roots
    kept = []
    for r in roots:
        vr = f(r)
        if math.isfinite(vr) and abs(vr) <= verify_max:
            kept.append(r)
    return kept


def _dedupe(points: list[float], tol: float) -> list[float]:
    out: list[float] = []
    for p in sorted(points):
        if not math.isfinite(p):
            continue
        if not out or abs(p - out[-1]) > tol:
            out.append(p)
    return out


def find_break_points(expr: sp.Expr, f: Callable[[float], float], x0: float, x1: float) -> list[float]:
    """找出绘图区间内的不连续点 / 渐近线位置。"""
    tol = max(1e-9, (x1 - x0) * 1e-7)
    found: list[float] = []

    # (1) 分母零点：1/x、1/(x-1)、tan 等
    den = sp.Integer(1)
    if _node_count(expr) <= 400:
        try:
            _num, den = sp.fraction(sp.together(expr))
        except Exception:  # noqa: BLE001
            den = sp.Integer(1)
    candidates: list[sp.Expr] = []
    if den != 1:
        candidates.append(den)
    for p in expr.atoms(sp.Pow):  # x^(-1)、x^(-1/2) 形式
        exponent = p.exp
        if exponent.is_number and exponent.is_negative:
            candidates.append(p.base)
    for candidate in candidates:
        try:
            g = sp.lambdify(X, candidate, modules=["math"])
            roots = _numeric_roots(lambda t: _to_float(_safe_call(g, t)), x0, x1, 1200, verify_max=1e3)
            found.extend(r for r in roots if x0 < r < x1)
        except Exception:  # noqa: BLE001
            continue

    # (2) 极点探测：1/f 的零点即 f 的极点（可捕获 tan x 这类周期奇点）
    if _may_have_poles(expr):
        def reciprocal(t: float) -> float:
            v = f(t)
            if not math.isfinite(v) or v == 0.0:
                return NAN
            return 1.0 / v

        found.extend(_numeric_roots(reciprocal, x0, x1, 2400, verify_max=1e-3))

    # (3) 阶梯函数（floor/ceil/sign）的跳跃位置
    step_atoms: list[sp.Expr] = []
    for atom_type in (sp.floor, sp.ceiling, sp.sign):
        for node in expr.atoms(atom_type):
            if node.args:
                step_atoms.append(node.args[0])
    for arg in step_atoms:
        try:
            g = sp.lambdify(X, arg, modules=["math"])
            gv = lambda t: _to_float(_safe_call(g, t))
        except Exception:  # noqa: BLE001
            continue
        prev_x, prev_v = x0, gv(x0)
        for i in range(1, 1601):
            cur_x = x0 + (x1 - x0) * i / 1600
            cur_v = gv(cur_x)
            if math.isfinite(prev_v) and math.isfinite(cur_v):
                if math.floor(prev_v) != math.floor(cur_v):
                    a, b = prev_x, cur_x
                    for _ in range(60):
                        m = (a + b) / 2
                        if math.floor(gv(m)) == math.floor(prev_v):
                            a = m
                        else:
                            b = m
                    found.append((a + b) / 2)
            prev_x, prev_v = cur_x, cur_v

    return _dedupe([p for p in found if x0 < p < x1], tol)


@lru_cache(maxsize=256)
def _break_points_cached(
    expr: sp.Expr,
    syms: tuple[sp.Symbol, ...],
    values: tuple[float, ...],
    x0: float,
    x1: float,
) -> tuple[float, ...]:
    evaluator = _build_evaluator_cached(expr, syms)
    return tuple(find_break_points(expr, lambda t: evaluator(t, list(values)), x0, x1))


def cached_break_points(
    expr: sp.Expr,
    param_symbols: list[sp.Symbol],
    param_values: dict[str, float] | None,
    x0: float,
    x1: float,
) -> list[float]:
    """find_break_points 的缓存版：同表达式 + 同参数取值 + 同视野直接复用。

    不连续点检测要做数千次数值扫描，还有 sp.together / sp.fraction 的
    符号整理，是每次绘图请求的固定开销；前端重复请求（尺寸变化、
    表格刷新、同视野重绘）时缓存命中可省掉这部分。
    """
    values = tuple(
        float((param_values or {}).get(str(p), 1.0)) for p in param_symbols
    )
    return list(_break_points_cached(expr, tuple(param_symbols), values, x0, x1))


def _safe_call(f: Callable, t: float) -> Any:
    try:
        return f(t)
    except Exception:  # noqa: BLE001
        return NAN


# --------------------------------------------------------------------------
# 四、自适应采样
# --------------------------------------------------------------------------


def _sample_interval(
    f: Callable[[float], float],
    a: float,
    b: float,
    base: int,
    tol: float,
    max_depth: int,
    max_points: int,
) -> list[list[float]]:
    """在 [a, b] 上先均匀取样，再按曲率自适应加密，返回 [[x, y], ...]。"""
    xs = [a + (b - a) * i / base for i in range(base + 1)]
    ys = [f(t) for t in xs]

    pts: list[tuple[float, float]] = list(zip(xs, ys))

    if max_depth > 0:
        stack = [(xs[i], ys[i], xs[i + 1], ys[i + 1], 0) for i in range(len(xs) - 1)]
        extra: list[tuple[float, float]] = []
        budget = max_points
        while stack and budget > 0:
            xa, ya, xb, yb, depth = stack.pop()
            if depth >= max_depth:
                continue
            xm = (xa + xb) / 2.0
            if xm <= xa or xm >= xb:
                continue
            ym = f(xm)
            if math.isfinite(ym) and math.isfinite(ya) and math.isfinite(yb):
                linear = (ya + yb) / 2.0
                if abs(ym - linear) > tol:
                    extra.append((xm, ym))
                    budget -= 1
                    stack.append((xa, ya, xm, ym, depth + 1))
                    stack.append((xm, ym, xb, yb, depth + 1))
        pts.extend(extra)
        pts.sort(key=lambda p: p[0])

    return [[p[0], p[1]] for p in pts]


def _split_segments(points: list[list[float]], spans: float) -> list[list[list[float]]]:
    """按 nan / 无穷 / 剧烈跳变把采样点切成多段。"""
    segments: list[list[list[float]]] = []
    cur: list[list[float]] = []

    for xv, yv in points:
        if not math.isfinite(yv):
            if cur:
                segments.append(cur)
                cur = []
            continue
        yv = max(-Y_CAP, min(Y_CAP, yv))
        if cur:
            px, py = cur[-1]
            if (abs(yv) >= Y_CAP * 0.5 and abs(py) >= Y_CAP * 0.5
                    and (yv > 0) != (py > 0)):
                # 跨越渐近线：断开
                segments.append(cur)
                cur = []
            elif spans > 0 and abs(yv - py) > 0.55 * spans and abs(yv - py) > 1e-9:
                segments.append(cur)
                cur = []
        cur.append([xv, yv])

    if cur:
        segments.append(cur)
    return [s for s in segments if len(s) >= 2]


def sample_curve(
    f: Callable[[float], float],
    x0: float,
    x1: float,
    breaks: list[float] | None = None,
    base: int = 700,
    max_depth: int = 5,
    max_points: int = 4200,
) -> list[list[list[float]]]:
    """采样一条曲线，返回按连续区间分段的折线数据。"""
    eps = max((x1 - x0) * 1e-9, 1e-12)
    cuts = [x0]
    for bp in breaks or []:
        if x0 < bp < x1:
            cuts.append(bp - eps)
            cuts.append(bp + eps)
    cuts.append(x1)
    cuts = _dedupe(cuts, (x1 - x0) * 1e-12)

    # 粗采样估计纵向跨度，用于确定自适应容差
    probe_n = 200
    probe = [f(x0 + (x1 - x0) * i / probe_n) for i in range(probe_n + 1)]
    finite = [v for v in probe if math.isfinite(v)]
    if finite:
        lo, hi = min(finite), max(finite)
        spans = hi - lo
        if not math.isfinite(spans) or spans <= 0:
            spans = max(1e-6, abs(hi))
    else:
        spans = 1.0

    tol = spans / 1400.0
    per_interval = max(120, base // max(1, len(cuts) - 1))

    points: list[list[float]] = []
    for i in range(len(cuts) - 1):
        a, b = cuts[i], cuts[i + 1]
        if b - a <= 0:
            continue
        points.extend(
            _sample_interval(f, a, b, per_interval, tol, max_depth, max(200, max_points // max(1, len(cuts) - 1)))
        )

    return _split_segments(points, spans)


# --------------------------------------------------------------------------
# 五、函数类型识别与性质分析
# --------------------------------------------------------------------------


def _fmt_num(v: float, nd: int = 4) -> str:
    """把数值格式化成适合展示的字符串。"""
    if v is None or not math.isfinite(v):
        return "无"
    if abs(v) < 1e-7:
        return "0"
    if abs(v - round(v)) < 1e-9 and abs(v) < 1e15:
        return str(int(round(v)))
    if abs(v) >= 1e5 or abs(v) < 1e-4:
        return f"{v:.3g}"
    text = f"{v:.{nd}f}".rstrip("0").rstrip(".")
    return text


def _fmt_linear(m: float, b: float) -> str:
    """把 y = mx + b 渲染成教材写法。"""
    if abs(m - 1) < 1e-12:
        head = "x"
    elif abs(m + 1) < 1e-12:
        head = "-x"
    else:
        head = f"{_fmt_num(m)}x"
    if abs(b) < 1e-12:
        return f"y = {head}"
    return f"y = {head} {'+' if b > 0 else '-'} {_fmt_num(abs(b))}"


def _fmt_point(xv: float, yv: float) -> str:
    return f"({_fmt_num(xv)}, {_fmt_num(yv)})"


def _poly_coeffs(expr: sp.Expr, degree: int) -> list[float] | None:
    try:
        poly = sp.Poly(expr, X)
    except Exception:  # noqa: BLE001
        return None
    if poly.degree() != degree:
        return None
    coeffs = [float(sp.N(c)) for c in poly.all_coeffs()]  # 降幂
    return coeffs


def _is_poly(expr: sp.Expr, degree: int | None = None) -> bool:
    try:
        if not expr.is_polynomial(X):
            return False
        poly = sp.Poly(expr, X)
        return degree is None or poly.degree() == degree
    except Exception:  # noqa: BLE001
        return False


def classify(expr: sp.Expr) -> dict[str, Any]:
    """识别函数类型，返回 {kind, formula, features}。"""
    kind = "一般函数"
    formula = ""

    if _is_poly(expr, 0):
        return {"kind": "常函数", "formula": "y = C", "features": []}
    if _is_poly(expr, 1):
        coeffs = _poly_coeffs(expr, 1)
        if coeffs:
            k, b = coeffs
            formula = f"y = {_fmt_num(k)}x" + (f" + {_fmt_num(b)}" if b >= 0 else f" - {_fmt_num(-b)}")
        return {"kind": "一次函数" if not _is_proportional(expr) else "正比例函数",
                "formula": formula, "features": []}
    if _is_poly(expr, 2):
        return {"kind": "二次函数", "formula": _quadratic_formula(expr), "features": []}
    if _is_poly(expr, 3):
        return {"kind": "三次函数", "formula": _poly_formula(expr, 3), "features": []}
    if _is_poly(expr):
        try:
            deg = sp.Poly(expr, X).degree()
        except Exception:  # noqa: BLE001
            deg = 0
        if not isinstance(deg, int) or deg < 0:
            # 零多项式（例如 k/x 中 k=0 化简后为 0）次数为 -∞，归入常函数
            return {"kind": "常函数", "formula": "y = 0", "features": []}
        return {"kind": f"{deg} 次多项式函数", "formula": _poly_formula(expr, deg), "features": []}

    # 分式（有理）函数
    try:
        num, den = sp.fraction(sp.together(expr))
        if den != 1 and num.is_polynomial(X) and den.is_polynomial(X):
            dn = sp.Poly(num, X).degree()
            dd = sp.Poly(den, X).degree()
            if dn == 0 and dd == 1:
                kind = "反比例型函数（双曲线）"
                k = float(sp.N(sp.Poly(num, X).all_coeffs()[0] / sp.Poly(den, X).all_coeffs()[0]))
                shift = float(sp.N(-sp.Poly(den, X).all_coeffs()[1] / sp.Poly(den, X).all_coeffs()[0]))
                formula = f"y = {_fmt_num(k)}/(x" + ("" if abs(shift) < 1e-12 else f" - {_fmt_num(shift)}") + ")"
                return {"kind": kind, "formula": formula,
                        "features": [f"比例系数 k = {_fmt_num(k)}"] +
                                    ([f"中心平移至 ({_fmt_num(shift)}, 0)"] if abs(shift) > 1e-12 else [])}
            return {"kind": "分式函数", "formula": "", "features": []}
    except Exception:  # noqa: BLE001
        pass

    has = lambda fn: expr.has(fn)  # noqa: E731
    if has(sp.Abs):
        return {"kind": "含绝对值的函数", "formula": "", "features": []}
    if has(sp.exp) or _has_exp_form(expr):
        return {"kind": "指数型函数", "formula": "", "features": []}
    if has(sp.log):
        return {"kind": "对数型函数", "formula": "", "features": []}
    if has(sp.tan) or has(sp.cot):
        return {"kind": "正切型函数", "formula": "", "features": []}
    if has(sp.sin) or has(sp.cos) or has(sp.sec) or has(sp.csc):
        return {"kind": "三角函数", "formula": "", "features": []}
    if has(sp.sinh) or has(sp.cosh) or has(sp.tanh):
        return {"kind": "双曲函数", "formula": "", "features": []}
    if has(sp.asin) or has(sp.acos) or has(sp.atan) or has(sp.acot):
        return {"kind": "反三角函数", "formula": "", "features": []}
    if _has_root(expr):
        return {"kind": "根式函数", "formula": "", "features": []}
    if has(sp.floor) or has(sp.ceiling):
        return {"kind": "取整型函数", "formula": "", "features": []}
    if has(sp.sign):
        return {"kind": "符号函数型", "formula": "", "features": []}

    return {"kind": kind, "formula": formula, "features": []}


def _has_root(expr: sp.Expr) -> bool:
    """是否含根式（sympy 会把 sqrt/cbrt 自动变成 Pow，需按指数判断）。"""
    for node in expr.atoms(sp.Pow):
        exponent = node.exp
        if exponent.is_Rational and not exponent.is_Integer and node.base.has(X):
            return True
    return False


def _is_proportional(expr: sp.Expr) -> bool:
    return _is_poly(expr, 1) and abs(float(sp.Poly(expr, X).all_coeffs()[1])) < 1e-12


def _poly_formula(expr: sp.Expr, degree: int) -> str:
    """把多项式渲染成教材式的降幂写法。"""
    try:
        coeffs = [float(sp.N(c)) for c in sp.Poly(expr, X).all_coeffs()]
    except Exception:  # noqa: BLE001
        return ""
    names = {0: "", 1: "x", 2: "x²", 3: "x³", 4: "x⁴", 5: "x⁵"}
    parts = []
    for idx, c in enumerate(coeffs):
        power = degree - idx
        if abs(c) < 1e-12:
            continue
        sign = "-" if c < 0 else "+"
        mag = abs(c)
        body = names.get(power, f"x^{power}")
        if power == 0:
            term = _fmt_num(mag)
        elif abs(mag - 1) < 1e-12:
            term = body
        else:
            term = f"{_fmt_num(mag)}{body}"
        parts.append((sign, term))
    if not parts:
        return "y = 0"
    first_sign, first_term = parts[0]
    text = ("-" if first_sign == "-" else "") + first_term
    for sign, term in parts[1:]:
        text += f" {sign} {term}"
    return "y = " + text


def _quadratic_formula(expr: sp.Expr) -> str:
    return _poly_formula(expr, 2)


def _fmt_set(node: Any) -> str:
    """把 sympy 的区间集合格式化成中文可读文本。"""
    try:
        if isinstance(node, sp.Interval):
            left = "[" if not node.left_open else "("
            right = "]" if not node.right_open else ")"
            lo = "-∞" if node.start is -sp.oo else _fmt_num(float(node.start))
            hi = "+∞" if node.end is sp.oo else _fmt_num(float(node.end))
            return f"{left}{lo}, {hi}{right}"
        if isinstance(node, sp.Union):
            return " ∪ ".join(_fmt_set(a) for a in node.args)
        if isinstance(node, sp.FiniteSet):
            return " 或 ".join(f"x = {_fmt_num(float(v))}" for v in node.args)
        if node is sp.S.Reals or node == sp.S.Reals:
            return "R"
        if node is sp.S.EmptySet:
            return "空集"
        return sp.sstr(node)
    except Exception:  # noqa: BLE001
        return sp.sstr(node)


def _domain_restrictions(expr: sp.Expr) -> list[str]:
    """收集定义域限制条件（文字描述）。"""
    notes: list[str] = []

    try:
        _num, den = sp.fraction(sp.together(expr))
    except Exception:  # noqa: BLE001
        den = sp.Integer(1)

    if den != 1:
        roots = _safe_solve(den)
        if roots:
            conds = " 且 ".join(f"x ≠ {_fmt_num(float(r))}" for r in roots if r.is_real)
            if conds:
                notes.append(f"分母不为零：{conds}")

    for log_node in expr.atoms(sp.log):
        arg = log_node.args[0]
        if not arg.has(X):
            # 常数对数（如 lg 展开式里的 log(10)）不构成 x 的定义域限制
            continue
        if _node_count(arg) <= 40 and arg.is_polynomial(X):
            try:
                sol = sp.solve_univariate_inequality(sp.Gt(arg, 0), X, relational=False)
                notes.append(f"对数真数大于零：{_fmt_set(sol)}")
                continue
            except Exception:  # noqa: BLE001
                pass
        notes.append(f"对数真数需大于零：{sp.sstr(arg)} > 0")

    for pow_node in expr.atoms(sp.Pow):
        base, exponent = pow_node.base, pow_node.exp
        if not base.has(X):
            continue
        try:
            exp_val = float(exponent) if exponent.is_number else None
        except Exception:  # noqa: BLE001
            exp_val = None
        if exp_val is None or abs(exp_val - 0.5) > 1e-9:
            continue
        if _node_count(base) <= 40 and base.is_polynomial(X):
            try:
                sol = sp.solve_univariate_inequality(sp.Ge(base, 0), X, relational=False)
                notes.append(f"偶次根号内非负：{_fmt_set(sol)}")
                continue
            except Exception:  # noqa: BLE001
                pass
        notes.append(f"偶次根号内需非负：{sp.sstr(base)} ≥ 0")

    if expr.has(sp.tan):
        notes.append("正切函数：x ≠ π/2 + kπ（k 为整数）")
    if expr.has(sp.cot):
        notes.append("余切函数：x ≠ kπ（k 为整数）")
    if expr.has(sp.asin) or expr.has(sp.acos):
        notes.append("反三角函数：自变量需满足 -1 ≤ t ≤ 1")

    return notes


_TRANSCENDENTAL = (
    sp.sin, sp.cos, sp.tan, sp.cot, sp.sec, sp.csc, sp.exp, sp.log,
    sp.sinh, sp.cosh, sp.tanh, sp.asin, sp.acos, sp.atan, sp.Abs,
    sp.floor, sp.ceiling, sp.sign, sp.sqrt,
)


def _node_count(expr: sp.Expr) -> int:
    try:
        return sum(1 for _ in sp.preorder_traversal(expr))
    except Exception:  # noqa: BLE001
        return 10 ** 9


def _symbolic_solve_ok(expr: sp.Expr) -> bool:
    """判断是否适合符号求解。

    只有多项式 / 有理式才走 sympy.solve；含三角函数、指数、取整等的表达式
    一律改用数值扫描，避免 solve 在超越方程上耗时数秒甚至卡死。
    """
    try:
        num, den = sp.fraction(sp.together(expr))
        if num.is_polynomial(X) and den.is_polynomial(X):
            return max(sp.Poly(num, X).degree(), sp.Poly(den, X).degree()) <= 8
    except Exception:  # noqa: BLE001
        return False
    return False


def _safe_solve(eq: sp.Expr) -> list[Any]:
    """求方程的实数解，优先符号求解，失败则退化为数值扫描。"""
    if not _symbolic_solve_ok(eq):
        return []
    try:
        sols = sp.solve(sp.Eq(eq, 0), X)
        real = [s for s in sols if getattr(s, "is_real", False)]
        if real:
            return real
    except Exception:  # noqa: BLE001
        pass
    return []


def _numeric_real_roots(
    f: Callable[[float], float],
    x0: float,
    x1: float,
    n: int = 3000,
    verify_max: float | None = None,
) -> list[float]:
    return _numeric_roots(f, x0, x1, n, verify_max=verify_max)


def analyze_function(
    text: str,
    param_values: dict[str, float] | None = None,
    view: tuple[float, float] = (-20.0, 20.0),
) -> dict[str, Any]:
    """对函数做完整分析，返回可直接序列化的字典。"""
    if isinstance(view, dict):  # 允许传入 {"x0":..,"x1":..} 形式的绘图区间
        view = (
            float(view.get("x0", view.get("xmin", -20.0))),
            float(view.get("x1", view.get("xmax", 20.0))),
        )
    parsed = parse_function(text)
    pvals = {str(p): float((param_values or {}).get(str(p), 1.0)) for p in parsed.params}
    expr_num = parsed.expr.subs({p: sp.Float(v) for p, v in zip(parsed.params, [pvals[str(p)] for p in parsed.params])}) \
        if parsed.params else parsed.expr
    f = build_evaluator(parsed.expr, parsed.params)
    fv = lambda t: f(t, [pvals[str(p)] for p in parsed.params])  # noqa: E731

    # 类型识别与定义域判断都要用「参数已代入」的表达式，
    # 否则 kx+b 这类含参函数会因为 k 无法转成浮点数而失败
    info = classify(expr_num)
    result: dict[str, Any] = {
        "ok": True,
        "input": text,
        "normalized": parsed.normalized,
        "latex": parsed.latex,
        "pretty": parsed.pretty,
        "params": [
            {"name": str(p), "value": pvals[str(p)]}
            for p in parsed.params
        ],
        "kind": info["kind"],
        "formula": info["formula"],
        "features": info["features"],
        "properties": [],
        "points": [],
        "asymptotes": {"vertical": [], "horizontal": [], "oblique": []},
        "domain_notes": _domain_restrictions(expr_num),
        "zeros": [],
        "y_intercept": None,
        "parity": "",
        "monotonic": [],
        "derivative_latex": "",
        "warnings": [],
    }

    # ---- 特殊类型：一次 / 二次 / 反比例 ----
    props: list[dict[str, str]] = []

    if _is_poly(expr_num, 1):
        coeffs = _poly_coeffs(expr_num, 1)
        if coeffs:
            k, b = coeffs
            props.append({"label": "斜率 k", "value": _fmt_num(k)})
            props.append({"label": "纵截距 b", "value": _fmt_num(b)})
            props.append({"label": "倾斜方向", "value": "上升（y 随 x 增大而增大）" if k > 0
                          else ("下降（y 随 x 增大而减小）" if k < 0 else "水平")})
            if abs(b) > 1e-12:
                props.append({"label": "与 x 轴交点", "value": _fmt_point(-b / k, 0)})
                result["points"].append({"label": "x 轴交点", "x": -b / k, "y": 0})
            result["points"].append({"label": "y 轴交点", "x": 0.0, "y": b})

    if _is_poly(expr_num, 2):
        a, b, c = _poly_coeffs(expr_num, 2) or (0, 0, 0)
        vx, vy = -b / (2 * a), c - b * b / (4 * a)
        delta = b * b - 4 * a * c
        props.append({"label": "二次项系数 a", "value": _fmt_num(a)})
        props.append({"label": "开口方向", "value": "向上（有最小值）" if a > 0 else "向下（有最大值）"})
        props.append({"label": "对称轴", "value": f"x = {_fmt_num(vx)}"})
        props.append({"label": "顶点", "value": _fmt_point(vx, vy)})
        props.append({"label": "最值", "value": ("最小值 " if a > 0 else "最大值 ") + _fmt_num(vy)})
        props.append({"label": "判别式 Δ = b²-4ac", "value": _fmt_num(delta)})
        if delta > 1e-12:
            props.append({"label": "与 x 轴交点", "value": "2 个"})
        elif abs(delta) <= 1e-12:
            props.append({"label": "与 x 轴交点", "value": "1 个（与 x 轴相切）"})
        else:
            props.append({"label": "与 x 轴交点", "value": "0 个"})
        result["points"].append({"label": "顶点", "x": vx, "y": vy})
        for r in _quadratic_roots(a, b, c):
            result["zeros"].append({"x": r, "y": 0.0})
            result["points"].append({"label": "零点", "x": r, "y": 0.0})
        result["points"].append({"label": "y 轴交点", "x": 0.0, "y": c})
        result["y_intercept"] = c

    # ---- 反比例型 ----
    try:
        num, den = sp.fraction(sp.together(expr_num))
        if den != 1 and num.is_polynomial(X) and den.is_polynomial(X) \
                and sp.Poly(num, X).degree() == 0 and sp.Poly(den, X).degree() == 1:
            dc = [float(sp.N(v)) for v in sp.Poly(den, X).all_coeffs()]
            k = float(sp.N(sp.Poly(num, X).all_coeffs()[0])) / dc[0]
            shift = -dc[1] / dc[0]
            props.append({"label": "比例系数 k", "value": _fmt_num(k)})
            props.append({"label": "所在象限", "value": "一、三象限（k > 0）" if k > 0 else "二、四象限（k < 0）"})
            props.append({"label": "对称中心", "value": _fmt_point(shift, 0)})
            props.append({"label": "渐近线", "value": f"x = {_fmt_num(shift)} 与 y = 0"})
            props.append({"label": "单调性", "value": "在每个象限内 " + ("y 随 x 增大而减小" if k > 0 else "y 随 x 增大而增大")})
            result["points"].append({"label": "对称中心", "x": shift, "y": 0.0, "hollow": True})
            result["points"].append({"label": "参考点", "x": shift + 1, "y": k})
            result["points"].append({"label": "参考点", "x": shift - 1, "y": -k})
    except Exception:  # noqa: BLE001
        pass

    # ---- 零点（通用）----
    if not result["zeros"]:
        zeros: list[float] = []
        for r in _safe_solve(expr_num):
            try:
                rv = float(sp.N(r))
            except Exception:  # noqa: BLE001
                continue
            if math.isfinite(rv):
                zeros.append(rv)
        if not zeros:
            zeros = _numeric_real_roots(fv, view[0], view[1], 3000, verify_max=1e3)
        zeros = _dedupe([z for z in zeros if math.isfinite(z)], 1e-7)
        result["zeros"] = [{"x": z, "y": 0.0} for z in zeros[:40]]
        for z in result["zeros"][:12]:
            result["points"].append({"label": "零点", "x": z["x"], "y": 0.0})

    # ---- y 截距 ----
    if result["y_intercept"] is None:
        y0 = fv(0.0)
        if math.isfinite(y0) and abs(y0) <= Y_CAP:
            result["y_intercept"] = y0
            if abs(y0) < 1e-12:
                result["points"].append({"label": "原点", "x": 0.0, "y": 0.0})

    # ---- 奇偶性 ----
    result["parity"] = _parity(expr_num)

    # ---- 单调区间 ----
    result["monotonic"] = _monotonic(expr_num, fv, view)

    # ---- 极值点与拐点（数值法，限定在可视范围内）----
    # f′ 的符号变化点 = 极值候选（用 f″ 符号分类）；f″ 的符号变化点 = 拐点候选。
    # f′ 在间断处也会出现"符号变化"，二分会收敛到间断点，此时 f″=0 会被跳过。
    extrema: list[dict[str, Any]] = []
    inflections: list[dict[str, Any]] = []
    try:
        d1_expr = expr_num.diff(X)
        d2_expr = d1_expr.diff(X)
        if _node_count(d1_expr) <= 4000 and _node_count(d2_expr) <= 4000:
            f1 = build_evaluator(d1_expr, [])
            f2 = build_evaluator(d2_expr, [])
            f1v = lambda t: f1(t, [])  # noqa: E731
            f2v = lambda t: f2(t, [])  # noqa: E731
            for r in _numeric_real_roots(f1v, view[0], view[1], 2000, verify_max=1e3):
                yv = fv(r)
                s2 = f2v(r)
                if not (math.isfinite(yv) and math.isfinite(s2)) or abs(yv) > Y_CAP:
                    continue
                kind = "极大值" if s2 < -1e-12 else ("极小值" if s2 > 1e-12 else None)
                if kind:
                    extrema.append({"x": r, "y": yv, "kind": kind})
            for r in _numeric_real_roots(f2v, view[0], view[1], 2000, verify_max=1e3):
                yv = fv(r)
                if math.isfinite(yv) and abs(yv) <= Y_CAP:
                    inflections.append({"x": r, "y": yv})
    except Exception:  # noqa: BLE001 —— 个别表达式不可导时静默跳过
        pass
    result["extrema"] = extrema[:12]
    result["inflections"] = inflections[:12]
    for e in extrema[:8]:
        result["points"].append({"label": e["kind"], "x": e["x"], "y": e["y"]})
    for p in inflections[:6]:
        result["points"].append({"label": "拐点", "x": p["x"], "y": p["y"]})

    # ---- 渐近线 ----
    result["asymptotes"] = _asymptotes(expr_num, fv, view)

    # ---- 导数 ----
    try:
        d = sp.diff(parsed.expr, X)
        if _node_count(d) < 200:
            d = sp.simplify(d)
        result["derivative_latex"] = _latex(d)
    except Exception:  # noqa: BLE001
        result["derivative_latex"] = ""

    result["properties"] = props
    return result


def _quadratic_roots(a: float, b: float, c: float) -> list[float]:
    delta = b * b - 4 * a * c
    if delta < -1e-12:
        return []
    if abs(delta) <= 1e-12:
        return [-b / (2 * a)]
    sq = math.sqrt(delta)
    return sorted([(-b - sq) / (2 * a), (-b + sq) / (2 * a)])


def _parity(expr: sp.Expr) -> str:
    """判断奇偶性。

    多项式用符号化简（精确且快）；其余表达式优先数值验证，
    避免 simplify 在复杂三角/复合式上耗时过久。
    """
    if _is_poly(expr):
        try:
            if sp.expand(expr.subs(X, -X) - expr) == 0:
                return "偶函数（图像关于 y 轴对称）"
            if sp.expand(expr.subs(X, -X) + expr) == 0:
                return "奇函数（图像关于原点对称）"
        except Exception:  # noqa: BLE001
            pass

    f = build_evaluator(expr, [])
    samples = [0.37, 1.13, 2.71, 4.05, 0.93, 3.31, 1.77, 0.61]
    even_ok = odd_ok = True
    checked = 0
    for s in samples:
        a, b = f(s, []), f(-s, [])
        a_ok, b_ok = math.isfinite(a), math.isfinite(b)
        if a_ok != b_ok:
            # 定义域不关于原点对称（如 ln x），必然非奇非偶
            return "非奇非偶函数（定义域不关于原点对称）"
        if not a_ok:
            continue
        checked += 1
        tol = 1e-6 * max(1.0, abs(a), abs(b))
        if abs(a - b) > tol:
            even_ok = False
        if abs(a + b) > tol:
            odd_ok = False
        if not even_ok and not odd_ok:
            return "非奇非偶函数"
    if checked == 0:
        return ""
    if even_ok and odd_ok:
        return "既奇又偶函数"
    if even_ok:
        return "偶函数（图像关于 y 轴对称）"
    if odd_ok:
        return "奇函数（图像关于原点对称）"
    return "非奇非偶函数"


def _monotonic(expr_num: sp.Expr, fv: Callable[[float], float], view: tuple[float, float]) -> list[dict[str, str]]:
    """给出单调区间（符号求解优先，数值兜底）。"""
    try:
        d = sp.diff(expr_num, X)
    except Exception:  # noqa: BLE001
        return []
    if d.has(sp.Derivative) or d.has(sp.DiracDelta):
        return []

    # 只解导数的分子：分母为零处是间断点而非驻点
    try:
        num_d, _den_d = sp.fraction(sp.together(d))
    except Exception:  # noqa: BLE001
        num_d = d

    crit: list[float] = []
    if _symbolic_solve_ok(num_d):
        try:
            for s in sp.solve(sp.Eq(num_d, 0), X):
                try:
                    sv = float(sp.N(s))
                except Exception:  # noqa: BLE001
                    continue
                if math.isfinite(sv):
                    crit.append(sv)
        except Exception:  # noqa: BLE001
            crit = []

    too_many = False
    df = build_evaluator(d, [])
    if not crit:
        crit = _numeric_real_roots(lambda t: df(t, []), view[0], view[1], 2000, verify_max=1e3)
        crit = [c for c in crit if math.isfinite(c)]

    crit = _dedupe(crit, 1e-6)
    if len(crit) > 24:
        too_many = True
        crit = []

    bounds = [-INF] + crit + [INF]
    out: list[dict[str, str]] = []
    for i in range(len(bounds) - 1):
        lo, hi = bounds[i], bounds[i + 1]
        if lo == -INF and hi == INF:
            probe = 0.0
        else:
            left = lo if math.isfinite(lo) else hi - 1.0
            right = hi if math.isfinite(hi) else lo + 1.0
            probe = (left + right) / 2.0
        slope = df(probe, [])
        if not math.isfinite(slope) or abs(slope) < 1e-12:
            continue
        lo_s = "-∞" if lo == -INF else _fmt_num(lo)
        hi_s = "+∞" if hi == INF else _fmt_num(hi)
        out.append({
            "interval": f"({lo_s}, {hi_s})",
            "behavior": "单调递增 ↗" if slope > 0 else "单调递减 ↘",
        })

    # 没有驻点时，直接在采样点上判断整体单调性（如 y = ln x）
    if not out and not too_many:
        probes = [view[0] + (view[1] - view[0]) * i / 24 for i in range(25)]
        slopes = []
        for p in probes:
            v = fv(p)
            if not math.isfinite(v) or abs(v) > Y_CAP:
                continue
            s = df(p, [])
            if math.isfinite(s) and abs(s) > 1e-12:
                slopes.append(s)
        if slopes and (all(s > 0 for s in slopes) or all(s < 0 for s in slopes)):
            has_vertical = any(
                (not math.isfinite(fv(p))) for p in probes if view[0] < p < view[1]
            )
            out.append({
                "interval": "各连续区间内" if has_vertical else "定义域内",
                "behavior": "单调递增 ↗" if slopes[0] > 0 else "单调递减 ↘",
            })
    return out


def _snap(v: float, tol: float = 1e-4) -> float:
    """把 -3.5e-07 之类的浮点噪声吸附到 0、整数等整洁数值。"""
    if not math.isfinite(v):
        return v
    r = round(v)
    if abs(v - r) < tol * max(1.0, abs(v)):
        return float(r)
    return round(v, 4)


def _divergence(fv: Callable[[float], float], t: float) -> float:
    """估计函数在 t 附近的发散程度，用于在簇中挑选真正的渐近线。"""
    worst = 0.0
    for delta in (1e-7, -1e-7):
        v = fv(t + delta)
        if not math.isfinite(v):
            return 1e12
        worst = max(worst, abs(v))
    return min(worst, 1e12)


def _merge_poles(cands: list[float], fv: Callable[[float], float], span: float) -> list[float]:
    """合并同一奇点附近检出的多个候选，保留发散最强者。"""
    if not cands:
        return []
    tol = max(1e-9, abs(span) * 1e-3)
    ordered = sorted(cands)
    groups: list[list[float]] = [[ordered[0]]]
    for c in ordered[1:]:
        if c - groups[-1][-1] <= tol:
            groups[-1].append(c)
        else:
            groups.append([c])
    return [max(g, key=lambda t: _divergence(fv, t)) for g in groups]


def _may_have_poles(expr: sp.Expr) -> bool:
    """判断表达式是否存在极点（决定是否需要做 1/f 扫描，节省时间）。"""
    try:
        _num, den = sp.fraction(sp.together(expr))
        if den != 1:
            return True
    except Exception:  # noqa: BLE001
        return True
    if expr.has(sp.tan) or expr.has(sp.cot) or expr.has(sp.sec) or expr.has(sp.csc):
        return True
    for node in expr.atoms(sp.Pow):
        if node.exp.is_number and node.exp.is_negative:
            return True
    return False


def _may_have_domain_edge(expr: sp.Expr) -> bool:
    """判断定义域是否可能不是全体实数（决定是否需要边界扫描）。"""
    if expr.has(sp.log) or expr.has(sp.tan) or expr.has(sp.cot) or expr.has(sp.sec) \
            or expr.has(sp.csc) or expr.has(sp.asin) or expr.has(sp.acos):
        return True
    if _has_root(expr):
        return True
    return _may_have_poles(expr)


def _has_exp_form(expr: sp.Expr) -> bool:
    """是否形如 a^g(x)（指数型函数）。"""
    for node in expr.atoms(sp.Pow):
        if node.exp.has(X) and not node.base.has(X):
            return True
    return False


def _bisect_boundary(fv: Callable[[float], float], nan_x: float, ok_x: float) -> float:
    """二分定位定义域边界（一侧有定义、一侧无定义的交界）。"""
    a, b = nan_x, ok_x
    for _ in range(60):
        m = (a + b) / 2
        if m == a or m == b:
            break
        if math.isfinite(fv(m)):
            b = m
        else:
            a = m
    return b


def _boundary_asymptotes(fv: Callable[[float], float], view: tuple[float, float]) -> list[float]:
    """检测定义域边界处是否发散（如 y = ln x 在 x = 0）。

    先二分定位边界，再从有定义的一侧逼近，观察 |y| 是否单调增大并发散。
    """
    found: list[float] = []
    n = 1200
    x0, x1 = view
    prev_x, prev_v = x0, fv(x0)

    def diverges(boundary: float, side: int) -> bool:
        mags = []
        for delta in (1e-3, 1e-6, 1e-9):
            v = fv(boundary + side * delta)
            if not math.isfinite(v) or abs(v) > Y_CAP:
                mags.append(INF)
            else:
                mags.append(abs(v))
        if not (mags[0] < mags[1] < mags[2]):
            return False
        return mags[2] > 10.0

    for i in range(1, n + 1):
        cur_x = x0 + (x1 - x0) * i / n
        cur_v = fv(cur_x)
        prev_ok, cur_ok = math.isfinite(prev_v), math.isfinite(cur_v)
        if prev_ok != cur_ok:
            ok_x = prev_x if prev_ok else cur_x
            nan_x = cur_x if prev_ok else prev_x
            boundary = _bisect_boundary(fv, nan_x, ok_x)
            side = -1 if prev_ok else 1
            if diverges(boundary, side):
                found.append(boundary)
        prev_x, prev_v = cur_x, cur_v

    return list(dict.fromkeys(found))[:4]


def _asymptotes(expr_num: sp.Expr, fv: Callable[[float], float], view: tuple[float, float]) -> dict[str, list[str]]:
    """求垂直 / 水平 / 斜渐近线。"""
    out: dict[str, list[str]] = {"vertical": [], "horizontal": [], "oblique": []}
    vertical_candidates: list[float] = []

    # 垂直渐近线一：分母零点（符号求解，数值精确）
    try:
        num, den = sp.fraction(sp.together(expr_num))
        if den != 1:
            for r in _safe_solve(den):
                try:
                    rv = float(sp.N(r))
                except Exception:  # noqa: BLE001
                    continue
                if math.isfinite(rv) and view[0] - 5 <= rv <= view[1] + 5:
                    left, right = fv(rv - 1e-6), fv(rv + 1e-6)
                    huge = (not math.isfinite(left)) or (not math.isfinite(right)) \
                        or abs(left) > 1e3 or abs(right) > 1e3
                    if huge and abs(left - right) > 1e3:
                        vertical_candidates.append(rv)
    except Exception:  # noqa: BLE001
        pass

    # 垂直渐近线二：数值扫描 1/f 的零点（内部极点，可捕获 tan x 这类周期奇点）
    def recip(t: float) -> float:
        v = fv(t)
        return NAN if (not math.isfinite(v) or v == 0) else 1.0 / v

    for r in _numeric_roots(recip, view[0], view[1], 1500, verify_max=1e-3):
        left, right = fv(r - 1e-5), fv(r + 1e-5)
        if (not math.isfinite(left) or not math.isfinite(right)
                or abs(left) > 1e4 or abs(right) > 1e4):
            if abs(left - right) > 1e3 or not math.isfinite(left + right):
                vertical_candidates.append(r)

    # 垂直渐近线三：定义域边界处发散（如 y = ln x 在 x = 0）
    if _may_have_domain_edge(expr_num):
        vertical_candidates.extend(_boundary_asymptotes(fv, view))

    merged = _merge_poles(vertical_candidates, fv, view[1] - view[0])
    out["vertical"] = [f"x = {_fmt_num(v)}" for v in merged][:6]

    # 水平 / 斜渐近线：有理函数用次数比较（精确），其余用数值试探
    try:
        num, den = sp.fraction(sp.together(expr_num))
        rational = den != 1 and num.is_polynomial(X) and den.is_polynomial(X)
    except Exception:  # noqa: BLE001
        rational = False

    if rational:
        dn = sp.Poly(num, X).degree()
        dd = sp.Poly(den, X).degree()
        if dn < dd:
            out["horizontal"] = ["y = 0"]
        elif dn == dd:
            ratio = float(sp.N(sp.Poly(num, X).all_coeffs()[0] / sp.Poly(den, X).all_coeffs()[0]))
            out["horizontal"] = [f"y = {_fmt_num(ratio)}"]
        elif dn == dd + 1:
            quo = sp.simplify(sp.div(num, den, X)[0])
            try:
                coeffs = [float(sp.N(c)) for c in sp.Poly(quo, X).all_coeffs()]
                m, b = coeffs[0], coeffs[1] if len(coeffs) > 1 else 0.0
                out["oblique"] = [_fmt_linear(m, b)]
            except Exception:  # noqa: BLE001
                out["oblique"] = [f"y = {sp.sstr(quo)}"]
    else:
        # 阶梯函数（sign/floor）与常函数不做水平渐近线判断，避免误报
        is_step = expr_num.has(sp.sign) or expr_num.has(sp.floor) or expr_num.has(sp.ceiling)
        try:
            is_const = sp.diff(expr_num, X) == 0
        except Exception:  # noqa: BLE001
            is_const = False
        for direction, tag in ((1.0, "x → +∞"), (-1.0, "x → -∞")) if not (is_step or is_const) else ():
            # 在四个跨度很大的点上取样：既能看出趋势，又能识破 x+sin(x) 这类
            # 「看着像直线、其实一直在摆动」的假渐近线
            xs = [direction * 1e3, direction * 1e4, direction * 1e5, direction * 1e6]
            vals = [fv(t) for t in xs]
            if not all(math.isfinite(v) for v in vals):
                continue
            if abs(vals[-1]) < 1e-6:
                vals[-1] = 0.0
            if max(vals) - min(vals) < 1e-3 * max(1.0, abs(vals[-1])):
                label = f"y = {_fmt_num(vals[-1])}"
                if label not in [h.split("（")[0] for h in out["horizontal"]]:
                    out["horizontal"].append(f"{label}（{tag}）")
                continue
            if abs(vals[-1]) <= 1e4:
                continue
            # 用最远两点定出候选直线，再要求其余各点到直线的偏差都很小
            m = (vals[-1] - vals[-2]) / (xs[-1] - xs[-2])
            if not math.isfinite(m) or abs(m) < 1e-6:
                continue
            b = vals[-1] - m * xs[-1]
            deviations = [abs(v - (m * t + b)) for v, t in zip(vals, xs)]
            if max(deviations) > 0.05:
                continue
            m_snap, b_snap = _snap(m), _snap(b)
            label = _fmt_linear(m_snap, b_snap) + f"（{tag}）"
            if not any(o.split("（")[0] == label.split("（")[0] for o in out["oblique"]):
                out["oblique"].append(label)
    return out


# --------------------------------------------------------------------------
# 六、批量采样与交点
# --------------------------------------------------------------------------


def integrate_numeric(
    f: Callable[[float], float],
    a: float,
    b: float,
    n: int = 2000,
) -> float:
    """复合辛普森法数值积分 ∫[a,b] f dx。

    区间内存在不可求值点（奇点 / 定义域外）时抛 ExpressionError，
    避免把发散积分当成一个有限值返回。
    """
    if b < a:
        a, b = b, a
    if n % 2:
        n += 1
    h = (b - a) / n
    ys: list[float] = []
    for i in range(n + 1):
        try:
            y = _to_float(f(a + i * h))
        except Exception:  # noqa: BLE001
            y = NAN
        if not math.isfinite(y):
            raise ExpressionError(f"积分区间内函数无定义（x ≈ {_fmt_num(a + i * h)} 附近可能存在奇点）")
        ys.append(y)

    total = ys[0] + ys[n]
    for i in range(1, n):
        total += (4.0 if i % 2 else 2.0) * ys[i]
    return total * h / 3.0


def sample_functions(
    items: list[dict[str, Any]],
    x0: float,
    x1: float,
    table_xs: list[float] | None = None,
    quality: str = "normal",
    px_width: float = 0,
) -> dict[str, Any]:
    """批量采样多个函数，返回绘图所需的分段折线。

    items: [{"id": "f1", "expr": "x^2", "params": {"a": 1}}, ...]
    px_width: 前端画布宽度（CSS 像素）。均匀采样密度与显示分辨率挂钩：
        点数按"铺满画布宽度（含 ±40% 取数边距）+ 约 20% 光顺余量"计算，
        单条上限 2600；函数较多时按总预算 18000 点摊薄，控制单次请求开销。
    """
    base_map = {"fast": 420, "normal": 760, "high": 1400}
    base = base_map.get(quality, 760)
    if px_width and px_width > 0:
        need = int(px_width * 2.2)
        base = max(base, max(700, min(need, 2600, 18000 // max(1, len(items)))))

    results: list[dict[str, Any]] = []
    for item in items:
        fid = str(item.get("id", ""))
        text = str(item.get("expr", "")).strip()
        if not text:
            continue
        try:
            parsed = parse_function(text)
            f = make_eval(parsed, item.get("params"))
            breaks = cached_break_points(parsed.expr, parsed.params, item.get("params"), x0, x1)
            segments = sample_curve(f, x0, x1, breaks, base=base)
            entry: dict[str, Any] = {
                "id": fid,
                "ok": True,
                "segments": segments,
                "breaks": [round(b, 12) for b in breaks],
                "param_names": parsed.param_names,
            }
            # 可选：同时采样导数曲线 y′ = f′(x)（虚线叠加用）
            if item.get("derivative"):
                try:
                    dexpr = parsed.expr.diff(X)
                    d_parsed = ParsedFunction(raw="", normalized="", expr=dexpr, params=parsed.params)
                    df = make_eval(d_parsed, item.get("params"))
                    dbreaks = cached_break_points(dexpr, parsed.params, item.get("params"), x0, x1)
                    entry["dsegments"] = sample_curve(df, x0, x1, dbreaks, base=max(420, base // 2))
                except Exception:  # noqa: BLE001 —— 不可导时前端就不画导数曲线
                    entry["dsegments"] = []
            if table_xs:
                entry["table"] = [
                    {"x": tx, "y": _clean(f(tx))} for tx in table_xs
                ]
            results.append(entry)
        except ExpressionError as exc:
            results.append({"id": fid, "ok": False, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            results.append({"id": fid, "ok": False, "error": f"无法绘制：{exc}"})

    return {"ok": True, "curves": results, "range": [x0, x1]}


def _clean(v: float) -> float | None:
    if v is None or not math.isfinite(v):
        return None
    if abs(v) > Y_CAP:
        return None
    return round(v, 6)


def find_intersections(
    expr_a: str,
    expr_b: str,
    params_a: dict[str, float] | None,
    params_b: dict[str, float] | None,
    x0: float,
    x1: float,
) -> dict[str, Any]:
    """求两条曲线的交点（数值扫描 + 二分细化）。"""
    try:
        fa = make_eval(parse_function(expr_a), params_a)
        fb = make_eval(parse_function(expr_b), params_b)
    except ExpressionError as exc:
        return {"ok": False, "error": str(exc)}

    diff = lambda t: (fa(t) - fb(t)) if (math.isfinite(fa(t)) and math.isfinite(fb(t))) else NAN  # noqa: E731
    roots = _numeric_real_roots(diff, x0, x1, 4000)
    points = []
    for r in _dedupe(roots, 1e-6)[:40]:
        yv = fa(r)
        if math.isfinite(yv) and abs(yv) <= Y_CAP:
            points.append({"x": round(r, 8), "y": round(yv, 8)})
    return {"ok": True, "points": points}


# --------------------------------------------------------------------------
# 七、预设函数库（由后端下发，前端直接渲染）
# --------------------------------------------------------------------------

# 预设函数库拆到纯数据模块：无需加载 sympy 即可提供 /api/presets
from presets_data import PRESETS  # noqa: F401 —— 兼容既有引用


def presets() -> list[dict[str, Any]]:
    return PRESETS


if __name__ == "__main__":  # 简单的自检
    for t in ["y=x^2-3x+2", "1/x", "2sin(2x+pi/3)", "|x-1|+2", "ln(x)", "2^x", "x^(-2)"]:
        p = parse_function(t)
        print(f"{t:20s} -> {p.expr!s:35s} params={p.param_names}")
    print(analyze_function("x^2-3x+2")["kind"], analyze_function("1/x")["kind"])
