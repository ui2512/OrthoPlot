# OrthoPlot · 正绘

输入 `y = f(x)` 实时绘制函数图像，并做符号分析：定义域、零点、单调区间、极值、拐点、渐近线、导数。支持参数滑块、切线、定积分、交点、数据表、PNG 导出，全程本地运行。

![界面截图](https://raw.githubusercontent.com/ui2512/OrthoPlot/screenshot/screenshot.png)

## 分支说明

| 分支 | 内容 |
| --- | --- |
| `main` | Web 版源码（`5/`：Flask + SymPy + 原生 Canvas） |
| [`android`](https://github.com/ui2512/OrthoPlot/tree/android) | Android 工程（Chaquopy 内置 Python）与预编译 APK |
| [`screenshot`](https://github.com/ui2512/OrthoPlot/tree/screenshot) | 界面截图 |

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
