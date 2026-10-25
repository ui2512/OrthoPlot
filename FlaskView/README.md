# OrthoPlot 正绘（FlaskView）—— 内置 Python（Chaquopy）本地网站服务器

Android 应用：APK 内置 Python 3.14 运行时（[Chaquopy](https://chaquo.com/chaquopy)），
打开应用即在**本机进程内**启动 Flask 网站（函数图像绘制），然后用任意浏览器访问
`http://127.0.0.1:5000`。
**单 APK、装上即用、全程离线，无需安装 Termux。**
网站运行在**前台服务**中常驻保活：首次打开会自动弹出通知权限（Android 13+）与
电池优化白名单的系统授权框（各点一次“允许”即可，系统不允许静默授予），
之后通知栏可随时查看服务状态、一键重启或关闭。
应用本身不带 WebView，页面浏览完全交给用户自己的浏览器。
网站界面适配竖屏 / 横屏 / 折叠屏（展开、外屏、分屏悬停窗口）。

## 项目结构

```
FlaskView/
├── build.sh                  # 一键构建脚本（Linux amd64 / macOS，自举 JDK+SDK+Gradle）
├── build-arm64.sh            # arm64 环境一键构建（自动处理所有依赖，见下）
├── settings.gradle.kts
├── build.gradle.kts          # 根工程：插件版本（含 com.chaquo.python 17.0.0）
├── gradle.properties
├── app/                      # Android 工程（Kotlin + ViewBinding）
│   ├── build.gradle.kts      # Chaquopy 配置：Python 版本 + pip 依赖（flask / sympy）
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/example/flaskview/
│       │   ├── MainActivity.kt     # 服务控制页：权限申请、启动前台服务、状态展示、跳转浏览器
│       │   ├── ServerController.kt # 进程级服务状态机：启停 / 热切换 / 重启、状态广播
│       │   └── ServerService.kt    # 前台服务：保活 + 常驻通知（状态查看 / 重启 / 关闭）
│       ├── python/               # 网站源码（Chaquopy 默认 Python 源码目录）
│       │   ├── app.py            # Flask 后端
│       │   ├── function_engine.py# sympy 函数分析引擎
│       │   ├── server.py         # 进程内启动入口（app.run 包装，供 Kotlin 调用）
│       │   ├── templates/  static/
│       └── res/                  # 布局 / 主题 / 图标 / 文案
```

## 快速开始

### 1）构建 APK

```bash
./build.sh             # x86_64 Linux / macOS：Debug APK
./build.sh release     # 签名 Release APK（自动生成临时 keystore）
./build-arm64.sh       # arm64 环境一键构建（自动处理所有依赖）：
                       #   * Termux 手机原生 arm64 —— 原生速度（自动装 openjdk-17 /
                       #     aapt2 与 python，下载 arm64 aapt2 并经
                       #     android.aapt2FromMavenOverride 接入 AGP；Chaquopy 的
                       #     buildPython 版本需与 Termux python 一致，脚本副本需
                       #     与 app/build.gradle.kts 的 version 同步调整）
                       #   * aarch64 Linux（含 proot）—— qemu-user 透明运行 amd64 工具链
                       #   * macOS arm64 / x86_64 —— 自动转调 build.sh
```

首次运行自动下载 JDK17 / Android SDK / Gradle 到 `.buildtools/`（约 600MB，需联网），
之后可离线重复构建。产物在 `app/build/outputs/apk/` 下。

**构建机要求**：除脚本自举的 JDK/SDK 外，还需本机装有 **python3.14**（含 pip）——
Chaquopy 在构建期用它做 pip 依赖解析与字节码预编译，且版本必须与 app 内 Python 一致
（`app/build.gradle.kts` 中 `chaquopy.defaultConfig.version`）。改动 Python 版本时两处同步。

### 2）安装使用

1. 安装 APK，打开应用；
2. 等待界面显示 **“服务已启动 ✓”**（首次启动需解压 Python 运行时，约十几秒）；
3. 点 **“在浏览器中打开”**（或手动在浏览器输入 `http://127.0.0.1:5000`）。

服务运行规则：

- 默认绑定 `127.0.0.1:5000`，**仅本机可访问**，不对外网开放；
- **局域网访问**：打开应用内的"允许局域网访问"开关后，服务改绑 `0.0.0.0` 并自动列出
  本机局域网地址（如 `http://192.168.x.x:5000`），同一 Wi-Fi 下的设备用浏览器即可访问；
  开关状态会记住，切换时服务热重启（无需杀应用）。**请在可信网络下使用**——
  局域网模式对同一网络内的所有设备开放，网站本身没有鉴权；
- **前台服务保活**：网站运行在前台服务中，退到后台（比如去用浏览器）、
  从最近任务划掉屏幕后服务都继续运行；常驻通知显示实时状态，并提供
  **“重启服务 / 关闭服务”** 按钮；
- **自动拉起**：进程即使被系统杀死，`START_STICKY` 也会让系统重新拉起服务、
  重启网站；重新打开应用同样会自动恢复；
- **权限**：应用启动时自动弹出通知权限（Android 13+）与电池优化白名单的系统
  授权框，各点一次“允许”；通知权限被拒时服务照常运行，但看不到常驻通知
  （也就用不了重启 / 关闭按钮）。个别国产 ROM（小米 / 华为等）若仍杀后台，
  需在其系统设置中手动允许本应用“自启动”与“后台运行”——这是厂商私有
  白名单，系统不提供标准申请接口。

### 功能一览

- 任意 `y = f(x)` 绘制（隐式乘法、`lg/ln/log` 教材记号、全角符号直接输入），最多 12 条曲线，参数滑块；
- 性质分析：函数类型、零点、单调区间、渐近线、**极值点、拐点**、导数（公式排版渲染）；
- **导数曲线**（f′ 一键虚线叠加）、**切线工具**（点击曲线画切线显示斜率）、
  **定积分**（两次点击着色区域并计算数值）；
- 两两交点、数据表、预设库、夜间模式、PNG 导出、全屏；
- **光标模式**：触屏设备自动开启，点按画布任意位置读取各曲线在该点的数值，工具栏可随时开关
  （桌面默认关闭，移动鼠标即可读数）；
- 界面适配竖屏 / 横屏 / 折叠屏（见下）；函数与视野自动保存在本机，顶栏"💾保存 / 📂打开"可把
  工作区存成 `.json` 文件或从文件恢复（可跨设备）。

### 多形态适配（竖屏 / 横屏 / 折叠屏）

- **竖屏手机、折叠屏外屏**：单栏布局，画布占首屏约 60%，控制面板在下方，整页滚动；
- **手机横屏 / 外屏横持**：恢复左右双栏，画布吃满剩余高度，顶栏自动压缩；
- **折叠屏展开**：中等宽度自动切双栏；浏览器支持视口分段时（新内核 Chrome/Edge），
  按真实铰链位置分栏——书式展开"面板左 / 画布右"，台面式展开"面板上 / 画布下"，
  内容不跨铰链（渐进增强，不支持的浏览器自动回退上面的通用布局）；
- **画布重绘**：尺寸变化由 `ResizeObserver` 跟随并同步重绘，转屏 / 分屏 / 键盘弹出 /
  窗口任意拖拽实时适配；页面短暂进入后台时也有 rAF 兜底，不会出现"白板画布"；
- 刘海 / 挖孔屏安全区、地址栏收展的动态视口（dvh）均已处理；
- 断点：≤600px 单栏、≤380px 极窄收紧、横屏矮窗（高度 ≤520px）压缩顶栏。

## 换成你自己的版本

- **网站源码**就在 `app/src/main/python/`，改完重新构建即可；
- **Python 依赖**在 `app/build.gradle.kts` 的 `chaquopy { defaultConfig { pip { ... } } }` 中声明，
  构建时联网拉取并打包进 APK（纯 Python 包直接来自 PyPI，含 C 扩展的常用包
  用 Chaquopy 官方预编译的 Android wheel）；运行时完全离线；
- **改端口**：`ServerController.kt` 的 `SERVER_PORT / SERVER_URL`，
  以及 `strings.xml` 的 `server_url`（界面展示）；`app.py` 的 `main()` 默认值
  仅影响命令行直接运行（`python app.py`）场景；
- **允许局域网访问**（如电脑浏览器访问手机）：直接打开应用内的
  "允许局域网访问"开关（绑定地址由 `ServerController.hostFor()` 决定），
  手机与电脑需在同一局域网；
- 在 x86_64 模拟器上调试：把 `app/build.gradle.kts` 中
  `abiFilters += "arm64-v8a"` 改为 `abiFilters += listOf("arm64-v8a", "x86_64")`（APK 变大）。

### 从旧版（Termux / WebView 方案）迁移

应用经历两版演进：初版经外部 Termux 的 `RUN_COMMAND` 启动 Flask（WebView 壳），
二版改为内置 Python（Chaquopy）+ WebView，当前版进一步去掉 WebView、
由用户浏览器直接访问。`TermuxLauncher.kt` 与 `termux/` 部署层均已移除。

## 常见问题速查

| 现象 | 处理 |
| --- | --- |
| 页面打不开 | 回到本应用看状态：显示“服务已启动”再刷新浏览器；或直接点通知栏“重启服务” |
| 通知栏看不到常驻通知 | Android 13+ 需允许通知权限（系统设置 → 应用 → 正绘 → 通知）；服务本身仍在运行 |
| 其他设备打不开 | 确认已打开"允许局域网访问"且两台设备在同一 Wi-Fi；地址用应用里列出的局域网 IP；路由器开了"AP 隔离"时无法互访 |
| 缩放时曲线短暂呈棱角 | 连续缩放中每 ~220ms 自动重采样一轮，松手后立即恢复平滑；若持续出现请反馈 |
| 启动超时 | 慢设备首次启动更久；可从通知栏“重启服务”或重开应用重试；多次失败可用 `adb logcat -s python.stderr python.stdout` 排查 |
| 仍被系统杀后台 | 确认已允许电池优化白名单；个别国产 ROM（小米 / 华为等）还需在其系统设置中允许“自启动”与“后台运行”；被杀后 START_STICKY 会自动拉起，重新打开应用也会自动恢复 |
| pip 依赖安装失败 | 构建机 python3.14 版本不匹配，或包无 Android 可用 wheel（见 Chaquopy FAQ） |
