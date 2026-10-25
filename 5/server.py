# -*- coding: utf-8 -*-
"""
server.py —— 进程内启动入口（Chaquopy）
========================================

由 MainActivity 在后台线程调用：

    Python.getInstance().getModule("server").callAttr("start", host, port)

支持运行中切换监听地址（如 127.0.0.1 ↔ 0.0.0.0）：

    Python.getInstance().getModule("server").callAttr("stop")   # 停止当前服务
    然后再次 callAttr("start", new_host, port)                    # 以新地址重启

实现上用 werkzeug 的 make_server 代替 app.run：后者拿不到服务器对象、
无法优雅停止；make_server 返回的实例自带 shutdown()（线程安全，可在
其他线程调用），因此切换局域网模式时无需杀进程。
"""

import threading

from werkzeug.serving import make_server

from app import app

_server = None
_lock = threading.Lock()


def _warm_engine() -> None:
    """后台预热函数引擎（sympy 导入较慢）。

    端口绑定成功后立即在守护线程里导入 sympy 并编译示例函数：
    服务能先就绪（界面秒开），首个绘图 / 分析请求也不必再等冷导入。
    """
    try:
        from app import warm_engine

        warm_engine()
    except Exception:  # noqa: BLE001 —— 预热失败不影响正常请求
        pass


def start(host: str, port: int) -> None:
    """在调用线程里阻塞式启动 Flask（调用线程即服务线程，随进程常驻）。

    必须关闭 debug：调试模式的自动重载依赖 fork 子进程，Android 上不可用。
    stdout/stderr 由 Chaquopy 重定向到 Logcat（tag: python.stdout / python.stderr），
    排查问题时用 ``adb logcat -s python.stdout python.stderr`` 查看。
    """
    global _server
    with _lock:
        if _server is not None:
            return  # 已有实例在运行（正常流程中不会发生，防御性保护）
        srv = make_server(host, port, app, threaded=True)
        _server = srv
    # 端口已就绪：立刻在后台预热 sympy，不阻塞 serve_forever
    threading.Thread(target=_warm_engine, daemon=True, name="engine-warmup").start()
    srv.serve_forever()


def stop() -> None:
    """优雅停止当前服务（供切换监听地址 / 回收端口时调用）。

    shutdown() 只是置位标志，serve_forever 会在下一个轮询周期返回，
    因此本函数立即返回、端口随后释放；调用方稍后即可用新地址重新 start。
    """
    global _server
    with _lock:
        srv, _server = _server, None
    if srv is not None:
        srv.shutdown()
