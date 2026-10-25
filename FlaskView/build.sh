#!/usr/bin/env bash
# =============================================================
#  FlaskView APK 一键构建脚本（自举式：自动下载全部构建工具）
#
#  支持平台：Linux x86_64 (amd64)、macOS x86_64 / arm64
#  注意：Android 构建工具 aapt2 只发布 x86_64 Linux 二进制，
#        因此 aarch64 Linux 主机无法原生构建（脚本会明确拒绝）。
#
#  用法：
#    ./build.sh            # 构建 Debug APK（默认）
#    ./build.sh release    # 构建签名 Release APK（无 keystore 时自动生成）
#    ./build.sh clean      # 清理构建产物（保留工具链缓存）
#
#  说明：
#    * 首次构建需联网，自动下载约 600MB（JDK17 + Android SDK + Gradle），
#      缓存于本目录 .buildtools/，之后离线可重复构建；
#    * 工具链完全安装在本项目内，不污染系统环境，无需 root。
# =============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

TOOLS_DIR="$ROOT_DIR/.buildtools"
SDK_DIR="$TOOLS_DIR/android-sdk"
JDK_DIR="$TOOLS_DIR/jdk"
GRADLE_ROOT="$TOOLS_DIR/gradle"

JAVA_VERSION=17
CMDLINE_TOOLS_VERSION=11076708
PLATFORM="platforms;android-34"
BUILD_TOOLS="build-tools;34.0.0"
GRADLE_VERSION=8.7

log()  { printf '\033[1;32m[build]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn ]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 0. 参数与基本检查 ----------
MODE="${1:-debug}"
case "$MODE" in
  debug|release|clean) ;;
  *) die "未知参数: $MODE（支持: debug / release / clean）" ;;
esac

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 \
  || die "缺少 curl 或 wget，请先安装"
command -v unzip >/dev/null 2>&1 || die "缺少 unzip，请先安装（apt install unzip / brew install unzip）"
command -v tar   >/dev/null 2>&1 || die "缺少 tar"

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS:$ARCH" in
  Linux:x86_64)  HOST=linux; JDK_ARCH=x64 ;;
  Darwin:x86_64) HOST=mac;   JDK_ARCH=x64 ;;
  Darwin:arm64)  HOST=mac;   JDK_ARCH=aarch64 ;;
  *)
    die "本脚本仅支持 Linux x86_64(amd64) 与 macOS。当前系统: $OS/$ARCH。
说明：Google 的 aapt2 只提供 x86_64 Linux 二进制。aarch64 Linux 主机请改用
x86_64 机器/虚拟机，或使用 Docker: docker run --platform linux/amd64 -v \$PWD:/w -w /w eclipse-temurin:17 ./build.sh"
    ;;
esac
log "系统: $OS/$ARCH，构建模式: $MODE"

if [ "$MODE" = "clean" ]; then
  rm -rf "$ROOT_DIR/.gradle" "$ROOT_DIR/app/build" "$ROOT_DIR/app/.gradle" "$ROOT_DIR/build"
  log "已清理构建产物（工具链缓存保留于 $TOOLS_DIR）"
  exit 0
fi

# 预检：关键文件是否齐全
for f in settings.gradle.kts build.gradle.kts gradle.properties \
         app/build.gradle.kts \
         app/src/main/AndroidManifest.xml \
         app/src/main/java/com/example/flaskview/MainActivity.kt \
         app/src/main/java/com/example/flaskview/ServerController.kt \
         app/src/main/java/com/example/flaskview/ServerService.kt \
         app/src/main/res/layout/activity_main.xml; do
  [ -f "$ROOT_DIR/$f" ] || die "缺少关键文件: $f"
done

# XML 合法性预检（有 python3 时执行，避免低级错误浪费一次完整构建）
if command -v python3 >/dev/null 2>&1; then
  log "校验 XML 资源文件..."
  python3 - <<'PYEOF' || die "存在非法 XML，请修复后重试"
import glob, sys, xml.etree.ElementTree as ET
bad = []
for p in glob.glob('app/src/main/**/*.xml', recursive=True):
    try:
        ET.parse(p)
    except Exception as e:
        bad.append(f'{p}: {e}')
if bad:
    print('\n'.join(bad))
sys.exit(1 if bad else 0)
PYEOF
fi

mkdir -p "$TOOLS_DIR"

fetch() { # fetch <url> <输出文件>
  local url="$1" out="$2"
  if [ -s "$out" ]; then log "已存在 $(basename "$out")，跳过下载"; return 0; fi
  log "下载 $url"
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --retry 3 --retry-delay 2 -o "$out.part" "$url"
  else
    wget -q --tries=3 -O "$out.part" "$url"
  fi
  mv "$out.part" "$out"
}

# ---------- 1. JDK 17（系统已有则直接用） ----------
java_major() {
  command -v java >/dev/null 2>&1 || { echo 0; return; }
  local v
  v="$(java -version 2>&1 | head -n1 | sed -E 's/.*version "?([0-9]+).*/\1/')"
  [ -n "$v" ] || v=0
  echo "$v"
}

JAVA_HOME_DIR=""
sys_major="$(java_major)"
if command -v javac >/dev/null 2>&1 && [ "$sys_major" -ge "$JAVA_VERSION" ]; then
  log "使用系统 JDK $sys_major"
else
  log "未找到 JDK ${JAVA_VERSION}+，安装 Temurin JDK $JAVA_VERSION（$HOST/$JDK_ARCH）..."
  JDK_VENDOR_OS=linux; [ "$HOST" = "mac" ] && JDK_VENDOR_OS=macos
  JDK_URL="https://api.adoptium.net/v3/binary/latest/$JAVA_VERSION/ga/$JDK_VENDOR_OS/$JDK_ARCH/jdk/hotspot/normal/eclipse?project=jdk"
  fetch "$JDK_URL" "$TOOLS_DIR/jdk.tar.gz"
  rm -rf "$JDK_DIR"; mkdir -p "$JDK_DIR"
  tar -xzf "$TOOLS_DIR/jdk.tar.gz" -C "$JDK_DIR" --strip-components=1
  JAVA_HOME_DIR="$JDK_DIR"
  export JAVA_HOME="$JAVA_HOME_DIR"
  export PATH="$JAVA_HOME/bin:$PATH"
  log "JDK 就绪: $JAVA_HOME_DIR"
fi

if [ -n "$JAVA_HOME_DIR" ]; then
  KEYTOOL_BIN="$JAVA_HOME_DIR/bin/keytool"
else
  KEYTOOL_BIN="keytool"
fi

# ---------- 2. Android cmdline-tools ----------
if [ "$HOST" = "mac" ]; then
  CMDTOOLS_ZIP="commandlinetools-mac-${CMDLINE_TOOLS_VERSION}_latest.zip"
else
  CMDTOOLS_ZIP="commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip"
fi
fetch "https://dl.google.com/android/repository/$CMDTOOLS_ZIP" "$TOOLS_DIR/$CMDTOOLS_ZIP"

if [ ! -x "$SDK_DIR/cmdline-tools/latest/bin/sdkmanager" ]; then
  log "安装 Android cmdline-tools..."
  rm -rf "$SDK_DIR/cmdline-tools"
  mkdir -p "$SDK_DIR/cmdline-tools"
  TMPD="$TOOLS_DIR/cmdtools-extract.$$"
  mkdir -p "$TMPD"
  unzip -q -o "$TOOLS_DIR/$CMDTOOLS_ZIP" -d "$TMPD"
  mv "$TMPD/cmdline-tools" "$SDK_DIR/cmdline-tools/latest"
  rm -rf "$TMPD"
fi
SDKMANAGER="$SDK_DIR/cmdline-tools/latest/bin/sdkmanager"
chmod +x "$SDKMANAGER" 2>/dev/null || true
run_sdk() { "$SDKMANAGER" --sdk_root="$SDK_DIR" "$@"; }

# ---------- 3. 接受许可 + 安装平台与构建工具 ----------
log "接受 Android SDK 许可..."
printf 'y\n%.0s' $(seq 1 100) | run_sdk --licenses >/dev/null 2>&1 || true
[ -d "$SDK_DIR/licenses" ] || die "SDK 许可证接受失败，请手动执行: $SDKMANAGER --sdk_root=$SDK_DIR --licenses"

if [ ! -d "$SDK_DIR/platforms/android-34" ] || [ ! -d "$SDK_DIR/build-tools/34.0.0" ]; then
  log "安装 $PLATFORM / $BUILD_TOOLS / platform-tools（首次约 200MB+，请耐心等待）..."
  run_sdk --yes "$PLATFORM" "$BUILD_TOOLS" "platform-tools" >/dev/null
fi

# ---------- 4. Gradle ----------
GRADLE_ZIP="gradle-$GRADLE_VERSION-bin.zip"
fetch "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip" "$TOOLS_DIR/$GRADLE_ZIP"
GRADLE_BIN="$GRADLE_ROOT/gradle-$GRADLE_VERSION/bin/gradle"
if [ ! -x "$GRADLE_BIN" ]; then
  log "解压 Gradle $GRADLE_VERSION..."
  rm -rf "$GRADLE_ROOT/gradle-$GRADLE_VERSION"
  unzip -q -o "$TOOLS_DIR/$GRADLE_ZIP" -d "$GRADLE_ROOT"
fi

# ---------- 5. local.properties ----------
log "sdk.dir=$SDK_DIR" > "$ROOT_DIR/local.properties"

# ---------- 6. 构建 ----------
GRADLE_ARGS=(--no-daemon -p "$ROOT_DIR")

if [ "$MODE" = "release" ]; then
  KS_DIR="$ROOT_DIR/keystore"
  KS="$KS_DIR/flaskview.keystore"
  mkdir -p "$KS_DIR"
  if [ ! -f "$KS" ]; then
    log "未找到 keystore，自动生成（正式发布请替换为自己的）..."
    "$KEYTOOL_BIN" -genkeypair -v \
      -keystore "$KS" -alias flaskview -keyalg RSA -keysize 2048 -validity 10950 \
      -storepass flaskview123 -keypass flaskview123 \
      -dname "CN=FlaskView, OU=Dev, O=Dev, L=Beijing, ST=Beijing, C=CN" >/dev/null
    warn "已生成临时 keystore（store/key 密码均为 flaskview123），仅用于测试分发！"
  fi
  log "构建 Release APK..."
  "$GRADLE_BIN" "${GRADLE_ARGS[@]}" \
    -PRELEASE_STORE_FILE="$KS" \
    -PRELEASE_STORE_PASSWORD=flaskview123 \
    -PRELEASE_KEY_ALIAS=flaskview \
    -PRELEASE_KEY_PASSWORD=flaskview123 \
    assembleRelease
  OUT_APK="$ROOT_DIR/app/build/outputs/apk/release/app-release.apk"
else
  log "构建 Debug APK..."
  "$GRADLE_BIN" "${GRADLE_ARGS[@]}" assembleDebug
  OUT_APK="$ROOT_DIR/app/build/outputs/apk/debug/app-debug.apk"
fi

[ -f "$OUT_APK" ] || die "构建流程结束但未找到 APK: $OUT_APK"

log "=================================================="
log "构建成功: $OUT_APK ($(du -h "$OUT_APK" | cut -f1))"
log "=================================================="

# 生成 Gradle Wrapper，便于 Android Studio 直接打开工程（失败不影响结果）
"$GRADLE_BIN" "${GRADLE_ARGS[@]}" wrapper --gradle-version "$GRADLE_VERSION" >/dev/null 2>&1 \
  && log "已生成 Gradle Wrapper（gradlew），可用 Android Studio 直接打开工程" \
  || warn "Gradle Wrapper 生成失败（可忽略，不影响 APK）"

log "安装到手机: adb install -r $OUT_APK"
