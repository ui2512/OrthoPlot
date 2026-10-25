# -*- coding: utf-8 -*-
"""
app.py —— OrthoPlot（正绘）后端（Flask，函数图像绘制网站）
==========================================

启动：
    python3 app.py                # 默认 http://0.0.0.0:5000（App 内由 server.py 绑定 127.0.0.1，浏览器访问 http://127.0.0.1:5000）
    python3 app.py --port 9000    # 指定端口
    python3 app.py --host 0.0.0.0 # 供局域网访问

接口一览：
    GET  /                     页面
    GET  /api/presets          预设函数库
    POST /api/analyze          解析 + 性质分析（零点、顶点、极值、拐点、渐近线、单调性…）
    POST /api/plot             批量采样，返回可直接绘制的折线数据（可选导数曲线）
    POST /api/intersections    求两条曲线的交点
    POST /api/tangent          求过指定点的切线（切点 + 斜率）
    POST /api/integral         数值计算定积分（辛普森法）
    GET  /api/health           健康检查
    GET  /api/update-check     检查是否有新版本（GitHub / GitCode，失败静默）
"""

from __future__ import annotations

import argparse
import importlib
import json
import math
import os
import re
import threading
import time
import urllib.request

from flask import Flask, jsonify, render_template, request

import presets_data

# --------------------------------------------------------------------------
# 引擎惰性加载
# --------------------------------------------------------------------------
# function_engine 依赖 sympy，导入需要数秒（手机上更明显）。如果在这里直接
# import，Flask 会等 sympy 加载完才开始监听——「服务已启动」迟迟不出现。
# 改为惰性代理：服务先就绪，sympy 由 server.py 的后台线程预热（见 warm_engine），
# 启动速度显著提升；预热未完时首个请求会在导入锁上等待，结果正确、不会报错。

_engine_mod = None
_engine_lock = threading.Lock()


def _engine():
    global _engine_mod
    if _engine_mod is None:
        with _engine_lock:
            if _engine_mod is None:
                _engine_mod = importlib.import_module("function_engine")
    return _engine_mod


class _LazyEngine:
    """惰性代理：首次访问属性时才真正导入 function_engine。"""

    __slots__ = ()

    def __getattr__(self, name):
        return getattr(_engine(), name)


fe = _LazyEngine()


def warm_engine() -> None:
    """预热引擎：后台导入 sympy 并编译一个示例，摊平首次请求的冷启动开销。"""
    try:
        engine = _engine()
        parsed = engine.parse_function("x^2-4")
        engine.make_eval(parsed, None)
        _ = parsed.latex
    except Exception:  # noqa: BLE001 —— 预热失败不影响正常请求
        pass

# --------------------------------------------------------------------------
# 版本与自动更新
# --------------------------------------------------------------------------
# version.json 放在仓库 main 分支根目录，Web 端与 Android 端共用。
# 发布新版本时同步修改：本文件的 APP_VERSION、Android 的 versionName、
# 仓库根目录 version.json 的 version / notes / downloads。

APP_VERSION = "1.1.0"
PROJECT_URL = "https://github.com/ui2512/OrthoPlot"
MIRROR_URL = "https://gitcode.com/ui2512/OrthoPlot"

# GitHub 优先，GitCode 镜像兜底；可用环境变量覆盖（本地测试 / 自建镜像）。
UPDATE_MANIFEST_URLS = tuple(
    url.strip()
    for url in os.environ.get(
        "ORTHOPLOT_UPDATE_MANIFEST_URLS",
        "https://raw.githubusercontent.com/ui2512/OrthoPlot/main/version.json,"
        "https://raw.gitcode.com/ui2512/OrthoPlot/raw/main/version.json",
    ).split(",")
    if url.strip()
)
UPDATE_CHECK_TTL = 6 * 3600
UPDATE_CHECK_FAIL_TTL = 600
UPDATE_FETCH_TIMEOUT = 3.0
UPDATE_MAX_BYTES = 64 * 1024

_VERSION_RE = re.compile(r"^v?(\d+(?:\.\d+){0,3})$")
_update_lock = threading.Lock()
_update_cache: dict = {"at": 0.0, "ok": False, "data": None}


def _parse_version(value) -> tuple[int, ...] | None:
    """把 1.2.3 之类的版本号转成可比较的元组；非法版本返回 None。"""
    match = _VERSION_RE.match(str(value or "").strip())
    if not match:
        return None
    parts = [int(part) for part in match.group(1).split(".")]
    while len(parts) < 4:
        parts.append(0)
    return tuple(parts[:4])


def _valid_url(value) -> str:
    if not isinstance(value, str):
        return ""
    value = value.strip()
    return value if value.startswith(("https://", "http://")) else ""


def _fetch_update_manifest() -> dict | None:
    """按顺序拉取更新清单；全部失败返回 None（离线时静默）。"""
    for url in UPDATE_MANIFEST_URLS:
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": f"OrthoPlot/{APP_VERSION}",
                    "Accept": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=UPDATE_FETCH_TIMEOUT) as resp:
                raw = resp.read(UPDATE_MAX_BYTES + 1)
            if len(raw) > UPDATE_MAX_BYTES:
                continue
            data = json.loads(raw.decode("utf-8-sig"))
            if not isinstance(data, dict):
                continue
            latest = str(data.get("version") or "").strip()
            if _parse_version(latest) is None:
                continue
            downloads = data.get("downloads")
            downloads = downloads if isinstance(downloads, dict) else {}
            clean_downloads = {}
            for key in ("web", "android"):
                value = _valid_url(downloads.get(key))
                if value:
                    clean_downloads[key] = value
            return {
                "version": latest,
                "released": str(data.get("released") or "")[:32],
                "notes": str(data.get("notes") or "")[:600],
                "url": _valid_url(data.get("url")) or PROJECT_URL,
                "downloads": clean_downloads,
                "source": url,
            }
        except Exception:  # noqa: BLE001 —— 网络 / JSON / 证书问题都按检查失败处理
            continue
    return None


def _update_info(force: bool = False) -> dict | None:
    """带缓存的更新检查：成功缓存 6 小时，失败缓存 10 分钟。"""
    now = time.time()
    with _update_lock:
        age = now - _update_cache["at"]
        ttl = UPDATE_CHECK_TTL if _update_cache["ok"] else UPDATE_CHECK_FAIL_TTL
        if not force and _update_cache["at"] and age < ttl:
            return _update_cache["data"]
    data = _fetch_update_manifest()
    with _update_lock:
        _update_cache.update({"at": time.time(), "ok": data is not None, "data": data})
    return data


app = Flask(__name__)
app.json.ensure_ascii = False
app.config["JSON_SORT_KEYS"] = False
# 模板自动重载：非调试模式下 Jinja 会缓存已渲染模板，改 index.html 不重启服务不生效。
# 本工具以"改完刷新浏览器即可见"为目标，打开该开关（静态 js/css 本就不经 Jinja 缓存）。
app.config["TEMPLATES_AUTO_RELOAD"] = True


@app.after_request
def _no_cache_html(resp):
    """页面 HTML 禁止启发式缓存：手机浏览器缓存旧 HTML/旧静态引用是新功能不生效的常见原因。"""
    if resp.mimetype == "text/html":
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.context_processor
def _static_version():
    """静态资源版本号 = 各文件的最新修改时间，写入 URL 查询参数做缓存击穿。"""
    base = os.path.join(app.root_path, "static")
    latest = 0.0
    for root, _dirs, files in os.walk(base):
        for name in files:
            try:
                latest = max(latest, os.path.getmtime(os.path.join(root, name)))
            except OSError:
                pass
    return {"STATIC_V": str(int(latest))}

# --------------------------------------------------------------------------
# 轻量缓存：避免拖动参数滑块 / 缩放平移时重复做符号分析
# --------------------------------------------------------------------------

_CACHE_LOCK = threading.Lock()
_ANALYZE_CACHE: dict[tuple, tuple[float, dict]] = {}
_CACHE_TTL = 600.0
_CACHE_MAX = 256


def _cache_get(key: tuple):
    with _CACHE_LOCK:
        item = _ANALYZE_CACHE.get(key)
        if not item:
            return None
        ts, value = item
        if time.time() - ts > _CACHE_TTL:
            _ANALYZE_CACHE.pop(key, None)
            return None
        return value


def _cache_put(key: tuple, value: dict) -> None:
    with _CACHE_LOCK:
        if len(_ANALYZE_CACHE) > _CACHE_MAX:
            oldest = sorted(_ANALYZE_CACHE.items(), key=lambda kv: kv[1][0])
            for k, _ in oldest[: _CACHE_MAX // 2]:
                _ANALYZE_CACHE.pop(k, None)
        _ANALYZE_CACHE[key] = (time.time(), value)


# --------------------------------------------------------------------------
# 页面
# --------------------------------------------------------------------------


@app.get("/")
def index():
    return render_template("index.html", app_version=APP_VERSION)


@app.get("/api/presets")
def api_presets():
    # 纯数据直接取用，避免为静态列表触发 sympy 导入（手机上数秒）
    return jsonify({"ok": True, "groups": presets_data.PRESETS})


@app.get("/api/health")
def api_health():
    return jsonify({"ok": True, "engine": "sympy", "version": APP_VERSION})


@app.get("/api/update-check")
def api_update_check():
    """检查远端 version.json；离线或两个地址都失败时返回 ok=false，不报错。"""
    info = _update_info(force=request.args.get("force") == "1")
    current = _parse_version(APP_VERSION)
    if info is None:
        resp = jsonify({
            "ok": False,
            "current": APP_VERSION,
            "latest": None,
            "has_update": False,
            "notes": "",
            "url": PROJECT_URL,
            "downloads": {},
        })
        resp.headers["Cache-Control"] = "no-store"
        return resp

    latest = _parse_version(info["version"])
    resp = jsonify({
        "ok": True,
        "current": APP_VERSION,
        "latest": info["version"],
        "has_update": bool(current and latest and latest > current),
        "released": info.get("released", ""),
        "notes": info.get("notes", ""),
        "url": info.get("url", PROJECT_URL),
        "downloads": info.get("downloads", {}),
        "source": info.get("source", ""),
    })
    resp.headers["Cache-Control"] = "no-store"
    return resp


# --------------------------------------------------------------------------
# 工具
# --------------------------------------------------------------------------


def _payload() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _as_float(value, default: float) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(out):
        return default
    return out


def _parse_view(data: dict) -> tuple[float, float]:
    x0 = _as_float(data.get("xmin"), -10.0)
    x1 = _as_float(data.get("xmax"), 10.0)
    if not (x0 < x1):
        x0, x1 = -10.0, 10.0
    # 限制视野范围，防止浮点精度问题
    x0 = max(x0, -1e9)
    x1 = min(x1, 1e9)
    if x1 - x0 < 1e-9:
        x0, x1 = -10.0, 10.0
    return x0, x1


def _param_values(raw) -> dict[str, float]:
    out: dict[str, float] = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            try:
                fv = float(v)
            except (TypeError, ValueError):
                continue
            if math.isfinite(fv):
                out[str(k)] = fv
    return out


# --------------------------------------------------------------------------
# 分析
# --------------------------------------------------------------------------


@app.post("/api/analyze")
def api_analyze():
    data = _payload()
    expr_text = str(data.get("expr", "")).strip()
    if not expr_text:
        return jsonify({"ok": False, "error": "请输入函数表达式"}), 400

    view = _parse_view(data)
    params = _param_values(data.get("params"))
    key = ("analyze", expr_text, tuple(sorted(params.items())), round(view[0], 6), round(view[1], 6))

    cached = _cache_get(key)
    if cached is not None:
        return jsonify(cached)

    try:
        result = fe.analyze_function(expr_text, params, view)
    except fe.ExpressionError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 200
    except Exception as exc:  # noqa: BLE001
        app.logger.exception("analyze failed")
        return jsonify({"ok": False, "error": f"分析失败：{exc}"}), 200

    _cache_put(key, result)
    return jsonify(result)


# --------------------------------------------------------------------------
# 采样（绘图）
# --------------------------------------------------------------------------


@app.post("/api/plot")
def api_plot():
    data = _payload()
    raw_items = data.get("functions")
    if not isinstance(raw_items, list) or not raw_items:
        return jsonify({"ok": True, "curves": [], "range": _parse_view(data)})

    items = []
    for idx, item in enumerate(raw_items[:24]):  # 最多同时绘制 24 条
        if not isinstance(item, dict):
            continue
        expr_text = str(item.get("expr", "")).strip()
        if not expr_text:
            continue
        items.append({
            "id": str(item.get("id", f"f{idx}")),
            "expr": expr_text,
            "params": _param_values(item.get("params")),
            "derivative": bool(item.get("derivative")),
        })

    x0, x1 = _parse_view(data)
    quality = str(data.get("quality", "normal"))
    if quality not in ("fast", "normal", "high"):
        quality = "normal"

    table_xs: list[float] = []
    raw_table = data.get("table_xs")
    if isinstance(raw_table, list):
        for v in raw_table[:60]:
            fv = _as_float(v, float("nan"))
            if math.isfinite(fv):
                table_xs.append(fv)

    started = time.time()
    try:
        result = fe.sample_functions(items, x0, x1, table_xs, quality,
                                     px_width=_as_float(data.get("px_width"), 0.0))
    except Exception as exc:  # noqa: BLE001
        app.logger.exception("plot failed")
        return jsonify({"ok": False, "error": f"绘制失败：{exc}"}), 200

    result["elapsed_ms"] = round((time.time() - started) * 1000, 1)
    return jsonify(result)


# --------------------------------------------------------------------------
# 交点
# --------------------------------------------------------------------------


@app.post("/api/intersections")
def api_intersections():
    data = _payload()
    a = data.get("a") or {}
    b = data.get("b") or {}
    if not isinstance(a, dict) or not isinstance(b, dict):
        return jsonify({"ok": False, "error": "参数格式错误"}), 400
    ea, eb = str(a.get("expr", "")).strip(), str(b.get("expr", "")).strip()
    if not ea or not eb:
        return jsonify({"ok": False, "error": "请提供两条曲线"}), 400
    x0, x1 = _parse_view(data)
    result = fe.find_intersections(ea, eb, _param_values(a.get("params")),
                                   _param_values(b.get("params")), x0, x1)
    return jsonify(result)


# --------------------------------------------------------------------------
# 切线
# --------------------------------------------------------------------------


@app.post("/api/tangent")
def api_tangent():
    """求函数在 x0 处的切线：返回切点与斜率，连线由前端按当前视野绘制。"""
    data = _payload()
    expr_text = str(data.get("expr", "")).strip()
    if not expr_text:
        return jsonify({"ok": False, "error": "请提供函数表达式"}), 400
    x0 = _as_float(data.get("x0"), float("nan"))
    if not math.isfinite(x0):
        return jsonify({"ok": False, "error": "请提供切点横坐标 x0"}), 400
    try:
        parsed = fe.parse_function(expr_text)
        f = fe.make_eval(parsed, _param_values(data.get("params")))
        y0 = fe._to_float(f(x0))
        d_expr = parsed.expr.diff(fe.X)
        d_parsed = fe.ParsedFunction(raw="", normalized="", expr=d_expr, params=parsed.params)
        df = fe.make_eval(d_parsed, _param_values(data.get("params")))
        slope = fe._to_float(df(x0))
    except fe.ExpressionError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 200
    except Exception as exc:  # noqa: BLE001
        app.logger.exception("tangent failed")
        return jsonify({"ok": False, "error": f"求切线失败：{exc}"}), 200
    if not (math.isfinite(y0) and math.isfinite(slope)):
        return jsonify({"ok": False, "error": "该点处函数值或导数不存在"}), 200
    return jsonify({"ok": True, "x": x0, "y": y0, "slope": slope})


# --------------------------------------------------------------------------
# 定积分（数值）
# --------------------------------------------------------------------------


@app.post("/api/integral")
def api_integral():
    """数值计算 ∫[a,b] f(x) dx（复合辛普森法），面积着色由前端完成。"""
    data = _payload()
    expr_text = str(data.get("expr", "")).strip()
    if not expr_text:
        return jsonify({"ok": False, "error": "请提供函数表达式"}), 400
    a = _as_float(data.get("a"), float("nan"))
    b = _as_float(data.get("b"), float("nan"))
    if not (math.isfinite(a) and math.isfinite(b)):
        return jsonify({"ok": False, "error": "请提供两个积分端点"}), 400
    if abs(b - a) < 1e-15:
        return jsonify({"ok": False, "error": "两个端点不能重合"}), 400
    try:
        parsed = fe.parse_function(expr_text)
        f = fe.make_eval(parsed, _param_values(data.get("params")))
        value = fe.integrate_numeric(f, a, b)
    except fe.ExpressionError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 200
    except Exception as exc:  # noqa: BLE001
        app.logger.exception("integral failed")
        return jsonify({"ok": False, "error": f"积分失败：{exc}"}), 200
    if not math.isfinite(value):
        return jsonify({"ok": False, "error": "积分结果发散或无法计算"}), 200
    return jsonify({"ok": True, "a": a, "b": b, "value": value})


# --------------------------------------------------------------------------
# 启动
# --------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="OrthoPlot（正绘）函数图像绘制网站")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址，0.0.0.0 表示允许局域网访问")
    parser.add_argument("--port", type=int, default=5000, help="监听端口")
    parser.add_argument("--debug", action="store_true", help="开启调试模式")
    args = parser.parse_args()

    print("=" * 58)
    print("  OrthoPlot 正绘 已启动 —— 函数图像绘制网站")
    print(f"  请在浏览器打开： http://{args.host if args.host != '0.0.0.0' else '127.0.0.1'}:{args.port}")
    print("  按 Ctrl + C 停止服务")
    print("=" * 58)
    # 后台预热（sympy 导入较慢）：服务先就绪，浏览器打开页面时通常已预热完成
    threading.Thread(target=warm_engine, daemon=True, name="engine-warmup").start()
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
