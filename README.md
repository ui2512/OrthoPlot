# OrthoPlot · 正绘

输入 `y = f(x)` 实时绘制函数图像，并做符号分析：定义域、零点、单调区间、极值、拐点、渐近线、导数。支持参数滑块、切线、定积分、交点、数据表、PNG 导出，全程本地运行。

![界面截图](https://raw.githubusercontent.com/ui2512/OrthoPlot/screenshot/screenshot.png)

## 分支说明

| 分支 | 内容 |
| --- | --- |
| `main` | Web 版源码（`5/`：Flask + SymPy + 原生 Canvas） |
| [`android`](https://github.com/ui2512/OrthoPlot/tree/android) | Android 工程（Chaquopy 内置 Python）与预编译 APK |
| [`screenshot`](https://github.com/ui2512/OrthoPlot/tree/screenshot) | 界面截图 |

镜像：[GitCode](https://gitcode.com/ui2512/OrthoPlot)

## 更新检查

应用会自动读取仓库 `main` 分支的 [`version.json`](version.json)（GitHub / GitCode 双源，失败静默，6 小时内不重复请求）。发现更高版本时，Web 端显示更新横幅，Android 端弹窗提示；也可以在使用说明里手动检查。

发布新版本时同步修改三处：`5/app.py` 的 `APP_VERSION`、`FlaskView/app/build.gradle.kts` 的 `versionName`、根目录 `version.json` 的 `version` / `notes` / `downloads`。

## 快速开始（Web）

```bash
cd 5
python3 -m pip install -r requirements.txt
python3 app.py
```

浏览器打开 <http://127.0.0.1:5000>。

更多用法、接口与实现说明见 [`5/README.md`](5/README.md)。

## Android

代码、构建说明与 APK 都在 [`android` 分支](https://github.com/ui2512/OrthoPlot/tree/android)。构建机需要 JDK 17、Android SDK 与 python3.14（Chaquopy）。

## 许可证

本项目使用 GNU General Public License v3.0（GPL-3.0）发布，详见 [LICENSE](LICENSE)。

Copyright (C) 2026 ui2512
