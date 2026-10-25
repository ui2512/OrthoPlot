# 第三方组件与许可证

OrthoPlot 正绘 本身以 **GPL-3.0** 发布。以下为运行、构建或安装包中使用的主要第三方组件，
它们分别遵循各自的许可证。Linux / Windows 安装包内还附有完整的许可证文本（`licenses/` 目录）。

| 组件 | 版本 | 许可证 | 上游 / 说明 |
| --- | --- | --- | --- |
| Python | 3.14（Windows 内置） | PSF-2.0 | <https://www.python.org/psf/license/> |
| OpenSSL | 3.x（Windows 内置） | Apache-2.0 | 见 Python 运行时自带的 `runtime/LICENSE.txt` |
| Flask | 3.1.3 | BSD-3-Clause | <https://flask.palletsprojects.com/> |
| Werkzeug | 3.1.9 | BSD-3-Clause | <https://werkzeug.palletsprojects.com/> |
| Jinja2 | 3.1.6 | BSD-3-Clause | <https://jinja.palletsprojects.com/> |
| MarkupSafe | 3.0.4 | BSD-3-Clause | <https://markupsafe.palletsprojects.com/> |
| ItsDangerous | 2.2.0 | BSD-3-Clause | <https://itsdangerous.palletsprojects.com/> |
| Click | 8.5.0 | BSD-3-Clause | <https://click.palletsprojects.com/> |
| Blinker | 1.9.0 | MIT | <https://blinker.readthedocs.io/> |
| SymPy | 1.14.0 | BSD-3-Clause | <https://www.sympy.org/> |
| mpmath | 1.3.0 | BSD-3-Clause | <https://mpmath.org/> |
| Chaquopy（仅 Android 构建） | 17.0.0 | 见官方许可 | <https://chaquo.com/chaquopy/license/> |

安装包内的 `licenses/` 目录保存了上述组件对应的许可证原文；`runtime/LICENSE.txt`
（Windows 包）为 Python 官方分发包附带的完整许可证与第三方声明。

本项目自身使用 GPL-3.0，详见 [LICENSE](LICENSE)；AI 生成声明见
[AI_GENERATED.md](AI_GENERATED.md)。
