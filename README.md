# OrthoPlot 正绘 · Android

> **AI 生成声明**：本分支的源码、文档与打包内容由 AI 辅助生成，可能存在错误；使用前请自行审查。详见 [AI_GENERATED.md](AI_GENERATED.md)。

本分支包含 Android 工程与预编译 APK。

- `FlaskView/` — 工程源码（1.1.0）与构建脚本，包含原生自动更新检测
- `OrthoPlot-1.0.0-release.apk` — arm64-v8a 预编译包（1.0.0）

SHA-256：`b8f5eb28cad6b7538ca41df036402fe5d71b11c0ec5a75157d17fe9506559342`

说明：该 APK 构建于项目定名和 1.1.0 源码之前，安装后应用内名称仍为「函数图像」，
且不含自动更新检测、AI 生成声明与第三方许可证文件。重新执行 `FlaskView/build.sh`
后会得到 1.1.0 APK（应用名「正绘」，启动时自动检查新版本，主界面带 AI / GPL 入口）。

安装后打开应用，等待「服务已启动 ✓」，点「在浏览器中打开」，或手动访问 <http://127.0.0.1:5000>。

## 自动更新

应用回到前台时读取 `main` 分支的 `version.json`（GitHub 优先、GitCode 兜底，6 小时内不重复），
发现更高版本时弹窗提示；主界面也提供“检查更新”入口。更新源：

- <https://github.com/ui2512/OrthoPlot>
- <https://gitcode.com/ui2512/OrthoPlot>

## 许可证

GNU General Public License v3.0（GPL-3.0），详见 [LICENSE](LICENSE)。

Copyright (C) 2026 ui2512

第三方组件（Chaquopy、Flask、SymPy、Python 等）的许可证与声明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
