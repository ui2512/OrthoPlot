#!/usr/bin/env bash
# =============================================================
#  FlaskView APK arm64 一键构建脚本（自动处理所有依赖）
#
#  自动识别三种 arm64 环境：
#   [A] Termux（Android 手机原生 arm64）—— 推荐，原生速度
#       自动处理：pkg 安装 openjdk-17 / unzip / xz-utils / aapt2；
#       下载 Gradle + Android SDK；aapt2 使用 Termux 官方源版本
#       （社区预编译版会被 AGP 拒绝），通过 android.aapt2FromMavenOverride
#       供 AGP 使用；依赖走阿里云镜像加速；限制 JVM 内存防 OOM。
#   [B] aarch64 Linux（glibc，兼容 proot 容器、arm 服务器）——
#       qemu-user 透明运行 amd64 工具链（JDK/aapt2 均 amd64）。
#       自动处理：qemu-user(-static) + amd64 glibc 运行库
#       （优先 apt-get download 免 root 解包，失败再提示手动安装）。
#       速度慢 5~20 倍，属兜底方案。
#   [C] macOS arm64（Apple Silicon）/ x86_64 主机 —— 委托 ./build.sh 原生构建。
#
#  用法：
#    ./build-arm64.sh            # Debug APK
#    ./build-arm64.sh release    # 签名 Release APK（无 keystore 时自动生成）
#    ./build-arm64.sh clean      # 清理构建产物
# =============================================================
set -euo pipefail

# JVM 的进程参数/文件名编码跟随 locale：环境完全未提供时回退 C.UTF-8，
# 避免非 ASCII 路径（如中文目录）在 daemon→worker 进程参数传递中被替换成 '?'
if [ -z "${LANG:-}" ] && [ -z "${LC_ALL:-}" ]; then
  export LANG=C.UTF-8
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

TOOLS_DIR="$ROOT_DIR/.buildtools"
SDK_DIR="$TOOLS_DIR/android-sdk"
JDK_DIR="$TOOLS_DIR/jdk"
GRADLE_ROOT="$TOOLS_DIR/gradle"
GRADLE_USER_HOME_DIR="$TOOLS_DIR/gradle-home"
BUILD_LOG="$ROOT_DIR/build.log"

JAVA_VERSION=17
GRADLE_VERSION=8.7
CMDLINE_TOOLS_VERSION=11076708
PLATFORM_PKG="platforms;android-34"
BUILD_TOOLS_VER="34.0.0"
BUILD_TOOLS_PKG="build-tools;${BUILD_TOOLS_VER}"
AGP_VERSION=8.2.2
AAPT2_BUILD=10154469

log()  { printf '\033[1;32m[build]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn ]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

MODE="${1:-debug}"
case "$MODE" in
  debug|release|clean) ;;
  *) die "未知参数: $MODE（支持: debug / release / clean）" ;;
esac

if [ "$MODE" = "clean" ]; then
  rm -rf "$ROOT_DIR/.gradle" "$ROOT_DIR/app/build" "$ROOT_DIR/app/.gradle" "$ROOT_DIR/build"
  rm -f "$BUILD_LOG"
  log "已清理构建产物（工具链缓存保留于 $TOOLS_DIR）"
  exit 0
fi

fetch() { # fetch <url> <输出文件>
  local url="$1" out="$2"
  if [ -s "$out" ]; then log "已存在 $(basename "$out")，跳过下载"; return 0; fi
  log "下载 $url"
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --retry 3 --retry-delay 2 -o "$out.part" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 -O "$out.part" "$url"
  else
    die "需要 curl 或 wget"
  fi
  mv "$out.part" "$out"
}

# ---------- 安装 Gradle / cmdline-tools / SDK（两种模式共用） ----------
install_gradle() {
  fetch "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip" "$TOOLS_DIR/gradle-bin.zip"
  GRADLE_BIN="$GRADLE_ROOT/gradle-$GRADLE_VERSION/bin/gradle"
  if [ ! -x "$GRADLE_BIN" ]; then
    log "解压 Gradle $GRADLE_VERSION..."
    rm -rf "$GRADLE_ROOT/gradle-$GRADLE_VERSION"
    unzip -q -o "$TOOLS_DIR/gradle-bin.zip" -d "$GRADLE_ROOT"
  fi
  # 重跑防护：gradle 启动脚本有时会被上次异常中断清成 0 字节
  # （文件存在、可执行，但为空 → gradle 秒退、无输出、退出码 0），定向重新提取
  if [ ! -s "$GRADLE_BIN" ]; then
    warn "gradle 启动脚本为 0 字节，从 gradle-bin.zip 重新提取..."
    unzip -o "$TOOLS_DIR/gradle-bin.zip" "gradle-$GRADLE_VERSION/bin/gradle" -d "$GRADLE_ROOT"
  fi
  [ -x "$GRADLE_BIN" ] && [ -s "$GRADLE_BIN" ] || die "Gradle 启动脚本异常: $GRADLE_BIN"
  chmod +x "$GRADLE_BIN" 2>/dev/null || true
}

install_cmdline_tools() { # $1 = linux|mac
  local z="commandlinetools-$1-${CMDLINE_TOOLS_VERSION}_latest.zip"
  fetch "https://dl.google.com/android/repository/$z" "$TOOLS_DIR/$z"
  if [ ! -x "$SDK_DIR/cmdline-tools/latest/bin/sdkmanager" ]; then
    log "安装 Android cmdline-tools..."
    rm -rf "$SDK_DIR/cmdline-tools"
    mkdir -p "$SDK_DIR/cmdline-tools"
    local tmp="$TOOLS_DIR/cmdtools-extract.$$"
    mkdir -p "$tmp"
    unzip -q -o "$TOOLS_DIR/$z" -d "$tmp"
    mv "$tmp/cmdline-tools" "$SDK_DIR/cmdline-tools/latest"
    rm -rf "$tmp"
  fi
  chmod +x "$SDK_DIR/cmdline-tools/latest/bin/sdkmanager" 2>/dev/null || true
}

install_sdk_packages() {
  local sdkman="$SDK_DIR/cmdline-tools/latest/bin/sdkmanager"
  log "接受 Android SDK 许可..."
  printf 'y\n%.0s' $(seq 1 100) | "$sdkman" --sdk_root="$SDK_DIR" --licenses >/dev/null 2>&1 || true
  [ -d "$SDK_DIR/licenses" ] || die "SDK 许可证接受失败"
  if [ ! -d "$SDK_DIR/platforms/android-34" ] || [ ! -d "$SDK_DIR/build-tools/$BUILD_TOOLS_VER" ]; then
    log "安装 $PLATFORM_PKG / $BUILD_TOOLS_PKG（首次较慢，请耐心等待）..."
    # 新版 commandlinetools(11076708) 已移除 --yes 参数，改为喂入 y 应对可能的许可确认
    if ! printf 'y\n%.0s' $(seq 1 100) | "$sdkman" --sdk_root="$SDK_DIR" \
        "$PLATFORM_PKG" "$BUILD_TOOLS_PKG" "platform-tools" > "$TOOLS_DIR/sdkmanager.log" 2>&1; then
      warn "sdkmanager 安装失败，日志尾部："
      tail -n 20 "$TOOLS_DIR/sdkmanager.log" 2>/dev/null || true
      die "SDK 包安装失败（完整日志: $TOOLS_DIR/sdkmanager.log）"
    fi
  fi
}

write_local_properties() {
  # 注意：必须用 echo 而非 log() —— log 会加 [build] 前缀，Gradle 将读不到 sdk.dir
  echo "sdk.dir=$SDK_DIR" > "$ROOT_DIR/local.properties"
  log "已写入 local.properties: sdk.dir=$SDK_DIR"
}

write_init_gradle() { # 依赖镜像加速：beforeSettings 在 settings.gradle.kts 之前注入，镜像优先、官方源兜底
  mkdir -p "$GRADLE_USER_HOME_DIR"
  cat > "$GRADLE_USER_HOME_DIR/init.gradle" <<'INIT_EOF'
// 由 build-arm64.sh 自动生成：阿里云镜像加速，缓解依赖下载慢
beforeSettings { settings ->
    settings.pluginManagement {
        repositories {
            maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }
            maven { url 'https://maven.aliyun.com/repository/public' }
            maven { url 'https://maven.aliyun.com/repository/google' }
            google()
            mavenCentral()
            gradlePluginPortal()
        }
    }
    settings.dependencyResolutionManagement {
        repositories {
            maven { url 'https://maven.aliyun.com/repository/public' }
            maven { url 'https://maven.aliyun.com/repository/google' }
            google()
            mavenCentral()
        }
    }
}
INIT_EOF
  log "已写入 init.gradle（阿里云镜像加速）"
}

write_gradle_user_home() { # $1 = aapt2 覆盖路径（或空）
  local aapt2_override="$1"
  mkdir -p "$GRADLE_USER_HOME_DIR"
  # gradle.properties 按 Java Properties 规范以 ISO-8859-1 解码：若路径含非 ASCII
  # 字符（如中文目录名），AGP 会把它读成乱码，报 "Specified AAPT2 executable
  # does not exist"。统一经 $HOME 下的 ASCII 符号链接绕开（$HOME 本身总是 ASCII）。
  if [ -n "$aapt2_override" ]; then
    case "$aapt2_override" in
      *[!\ -~]*)
        local ascii_link="$HOME/.cache/flaskview-build/aapt2"
        mkdir -p "$(dirname "$ascii_link")"
        ln -sfn "$aapt2_override" "$ascii_link"
        warn "aapt2 路径含非 ASCII 字符，改用符号链接供 AGP 使用: $ascii_link"
        aapt2_override="$ascii_link"
        ;;
    esac
  fi
  {
    echo "# 由 build-arm64.sh 自动生成：手机内存有限，小堆 + 关闭 daemon 防 OOM"
    echo "org.gradle.jvmargs=-Xmx1024m -XX:MaxMetaspaceSize=384m -Dfile.encoding=UTF-8"
    echo "org.gradle.daemon=false"
    echo "org.gradle.workers.max=2"
    echo "kotlin.compiler.execution.strategy=in-process"
    if [ -n "$aapt2_override" ]; then
      echo "android.aapt2FromMavenOverride=$aapt2_override"
    fi
  } > "$GRADLE_USER_HOME_DIR/gradle.properties"
  log "已写入 gradle.properties（-Xmx1024m, daemon 关闭, workers=2）"
}

finish_build() { # $1 = gradle 可执行文件；其余为附加参数（如 release 签名 -P 属性）
  local gradle_bin="$1"; shift
  local task="assembleDebug"
  if [ "$MODE" = "release" ]; then
    local ks_dir="$ROOT_DIR/keystore" ks="$ROOT_DIR/keystore/flaskview.keystore"
    mkdir -p "$ks_dir"
    if [ ! -f "$ks" ]; then
      log "未找到 keystore，自动生成（正式发布请替换为自己的）..."
      keytool -genkeypair -v \
        -keystore "$ks" -alias flaskview -keyalg RSA -keysize 2048 -validity 10950 \
        -storepass flaskview123 -keypass flaskview123 \
        -dname "CN=FlaskView, OU=Dev, O=Dev, L=Beijing, ST=Beijing, C=CN" >/dev/null
      warn "已生成临时 keystore（store/key 密码均为 flaskview123），仅用于测试分发！"
    fi
    task="assembleRelease"
    set -- -PRELEASE_STORE_FILE="$ks" -PRELEASE_STORE_PASSWORD=flaskview123 \
      -PRELEASE_KEY_ALIAS=flaskview -PRELEASE_KEY_PASSWORD=flaskview123 "$@"
  fi
  # 输出全程记录到 build.log；失败或未产出 APK 时打印日志尾部辅助定位。
  # jvmargs 用 -D 再强制一遍：项目根 gradle.properties 优先级高于 GRADLE_USER_HOME，
  # 实测其 -Xmx2048m 会覆盖 user-home 中的内存限制，命令行 -D 优先级最高可确保生效
  log "构建 $task（日志: $BUILD_LOG）..."
  if ! "$gradle_bin" --no-daemon -p "$ROOT_DIR" \
      "-Dorg.gradle.jvmargs=-Xmx1024m -XX:MaxMetaspaceSize=384m -Dfile.encoding=UTF-8" \
      --init-script "$GRADLE_USER_HOME_DIR/init.gradle" "$@" "$task" 2>&1 | tee "$BUILD_LOG"; then
    warn "Gradle 构建失败，日志尾部："
    tail -n 40 "$BUILD_LOG" 2>/dev/null || true
    die "$task 构建失败（完整日志: $BUILD_LOG）"
  fi
  if [ "$MODE" = "release" ]; then
    OUT_APK="$ROOT_DIR/app/build/outputs/apk/release/app-release.apk"
  else
    OUT_APK="$ROOT_DIR/app/build/outputs/apk/debug/app-debug.apk"
  fi
  if [ ! -f "$OUT_APK" ]; then
    warn "构建流程结束但未找到 APK，日志尾部："
    tail -n 40 "$BUILD_LOG" 2>/dev/null || true
    die "未生成 APK: $OUT_APK（完整日志: $BUILD_LOG）"
  fi
  log "=================================================="
  log "构建成功: $OUT_APK ($(du -h "$OUT_APK" | cut -f1))"
  log "=================================================="
}

# =============================================================
# 环境识别
# =============================================================
OS="$(uname -s)"; ARCH="$(uname -m)"

if [ "$ARCH" = "x86_64" ] || { [ "$OS" = "Darwin" ]; }; then
  log "检测到 $OS/$ARCH：由 build.sh 原生支持，转调..."
  exec bash "$ROOT_DIR/build.sh" "$MODE"
fi
[ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ] || die "本脚本面向 arm64/aarch64，当前: $OS/$ARCH"

if [ -n "${PREFIX:-}" ] && [ -x "$PREFIX/bin/pkg" ] && [ -d "/data/data/com.termux" ]; then
  ENV_MODE="termux"
elif [ "$OS" = "Linux" ]; then
  ENV_MODE="linux"
else
  die "无法识别的环境: $OS/$ARCH"
fi

mkdir -p "$TOOLS_DIR"

# =============================================================
# [A] Termux 原生构建（推荐）
# =============================================================
if [ "$ENV_MODE" = "termux" ]; then
  log "环境: Termux（Android 原生 arm64）"
  command -v pkg >/dev/null 2>&1 || die "未找到 pkg 命令"

  log "安装依赖包（openjdk-17 / unzip / xz-utils）..."
  pkg install -y unzip xz-utils openjdk-17

  JAVA_HOME="$PREFIX/lib/jvm/openjdk-17"
  # 兼容不同版本的 Termux openjdk-17 包:实际安装目录可能是 java-17-openjdk
  [ -x "$JAVA_HOME/bin/java" ] || JAVA_HOME="$PREFIX/lib/jvm/java-17-openjdk"
  [ -x "$JAVA_HOME/bin/java" ] || die "未找到 Termux JDK: $JAVA_HOME"
  export JAVA_HOME
  export PATH="$JAVA_HOME/bin:$PATH"
  log "JDK: $(java -version 2>&1 | head -n1)"

  # aapt2 必须用 Termux 官方源版本：社区预编译版（版本号 2.19）会被 AGP 拒绝，
  # 报 "Custom AAPT2 location does not point to an AAPT2 executable"
  AAPT2="/data/data/com.termux/files/usr/bin/aapt2"
  if [ ! -x "$AAPT2" ]; then
    log "未找到 Termux 官方 aapt2，执行 pkg install..."
    pkg install -y aapt2
  fi
  [ -x "$AAPT2" ] || die "aapt2 未能安装: $AAPT2（请检查 Termux 源后重试）"
  log "aapt2: $($AAPT2 version 2>&1 | head -n1)"

  install_gradle
  install_cmdline_tools linux
  install_sdk_packages
  write_local_properties
  write_init_gradle
  # 手机内存有限：小堆、关闭守护进程、Kotlin 编译进程内执行（防 OOM）
  write_gradle_user_home "$AAPT2"
  export GRADLE_USER_HOME="$GRADLE_USER_HOME_DIR"

  finish_build "$GRADLE_BIN"
  log "提示：APK 已生成，用文件管理器或 adb 安装即可。"
  exit 0
fi

# =============================================================
# [B] aarch64 Linux（qemu 运行 amd64 工具链）
# =============================================================
log "环境: aarch64 Linux（将用 qemu-user 透明运行 amd64 构建工具链，速度较慢属正常）"

command -v unzip >/dev/null 2>&1 || die "缺少 unzip"
command -v dpkg-deb >/dev/null 2>&1 || true

# ---- 1. 获取 qemu-x86_64 ----
QEMU=""
for c in qemu-x86_64-static qemu-x86_64; do
  p="$(command -v "$c" 2>/dev/null || true)"
  if [ -n "$p" ]; then
    rp="$(readlink -f "$p" 2>/dev/null || echo "$p")"
    if [ -x "$rp" ]; then QEMU="$rp"; break; fi
  fi
done
if [ -z "$QEMU" ]; then
  log "下载 qemu-user（apt-get download 免 root 解包）..."
  command -v apt-get >/dev/null 2>&1 || die "无 apt-get。请手动安装 qemu-user-static 后重试"
  QEMU_DEBS="$TOOLS_DIR/qemu-debs"
  mkdir -p "$QEMU_DEBS" "$TOOLS_DIR/qemu-root"
  ( cd "$QEMU_DEBS"
    apt-get download qemu-user qemu-user-static 2>/dev/null || \
      apt-get download qemu-user-static 2>/dev/null || \
      apt-get download qemu-user || die "qemu 下载失败，请手动安装: sudo apt install qemu-user-static"
    for d in ./*.deb; do dpkg-deb -x "$d" "$TOOLS_DIR/qemu-root"; done
  )
  for c in qemu-root/usr/bin/qemu-x86_64-static qemu-root/usr/bin/qemu-x86_64; do
    if [ -x "$TOOLS_DIR/$c" ] && [ ! -L "$TOOLS_DIR/$c" ]; then QEMU="$TOOLS_DIR/$c"; break; fi
  done
  [ -n "$QEMU" ] || { QEMU="$(readlink -f "$TOOLS_DIR/qemu-root/usr/bin/qemu-x86_64-static" 2>/dev/null || true)"; }
  [ -n "$QEMU" ] && [ -x "$QEMU" ] || die "未能获取可用的 qemu-x86_64，请手动安装: sudo apt install qemu-user-static"
fi
log "qemu: $QEMU"

# ---- 2. amd64 glibc 运行库（sysroot） ----
SYS=""
if [ -f "/usr/x86_64-linux-gnu/lib64/ld-linux-x86-64.so.2" ] || [ -f "/usr/x86_64-linux-gnu/lib/ld-linux-x86-64.so.2" ]; then
  SYS="/usr/x86_64-linux-gnu"
else
  log "下载 amd64 运行库（libc6-amd64-cross / libgcc / libstdc++）..."
  command -v apt-get >/dev/null 2>&1 || die "无 apt-get。请手动安装 libc6-amd64-cross"
  QEMU_DEBS="$TOOLS_DIR/qemu-debs"
  mkdir -p "$QEMU_DEBS" "$TOOLS_DIR/qemu-root"
  ( cd "$QEMU_DEBS"
    apt-get download libc6-amd64-cross libgcc-s1-amd64-cross libstdc++6-amd64-cross \
      || die "amd64 运行库下载失败，请手动安装: sudo apt install libc6-amd64-cross"
    for d in libc6-amd64-cross_*.deb libgcc-s1-amd64-cross_*.deb libstdc++6-amd64-cross_*.deb; do
      if [ -f "$d" ]; then dpkg-deb -x "$d" "$TOOLS_DIR/qemu-root"; fi
    done
  )
  SYS="$TOOLS_DIR/qemu-root/usr/x86_64-linux-gnu"
fi
{ [ -f "$SYS/lib64/ld-linux-x86-64.so.2" ] || [ -f "$SYS/lib/ld-linux-x86-64.so.2" ]; } \
  || die "sysroot 中未找到 amd64 动态加载器: $SYS"
export QEMU_LD_PREFIX="$SYS"
log "sysroot: $SYS"

# ---- 3. amd64 JDK ----
sys_major="$(java -version 2>&1 | head -n1 | sed -E 's/.*version "?([0-9]+).*/\1/' 2>/dev/null || echo 0)"
if [ -x "$JDK_DIR/bin/java" ]; then
  log "使用缓存的 amd64 JDK"
elif command -v javac >/dev/null 2>&1 && [ "${sys_major:-0}" -ge "$JAVA_VERSION" ]; then
  log "使用系统 JDK（原生 arm64，无需 qemu 运行 JVM，更快）"
  JDK_DIR="$(cd "$(dirname "$(readlink -f "$(command -v javac)")")/.." && pwd)"
else
  log "下载 Temurin JDK $JAVA_VERSION（amd64，经 qemu 运行）..."
  fetch "https://api.adoptium.net/v3/binary/latest/$JAVA_VERSION/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk" \
    "$TOOLS_DIR/jdk.tar.gz"
  rm -rf "$JDK_DIR"; mkdir -p "$JDK_DIR"
  tar -xzf "$TOOLS_DIR/jdk.tar.gz" -C "$JDK_DIR" --strip-components=1
fi
export JAVA_HOME="$JDK_DIR"
export PATH="$JAVA_HOME/bin:$PATH"

# 若 JVM 本身是 amd64（经 qemu 运行），把 JDK 关键工具包一层 qemu；
# 若系统 JDK 是原生 arm64 则跳过（qemu 只用于 aapt2）。
if file "$JAVA_HOME/bin/java" 2>/dev/null | grep -q "x86-64"; then
  log "为 JDK 工具添加 qemu 包装（java/javac/jar/keytool/jarsigner）..."
  for t in java javac jar keytool jarsigner; do
    [ -x "$JAVA_HOME/bin/$t" ] || continue
    [ -e "$JAVA_HOME/bin/$t.real" ] || mv "$JAVA_HOME/bin/$t" "$JAVA_HOME/bin/$t.real"
    cat > "$JAVA_HOME/bin/$t" <<WEOF
#!/bin/sh
exec "$QEMU" -L "$SYS" "$JAVA_HOME/bin/$t.real" "\$@"
WEOF
    chmod +x "$JAVA_HOME/bin/$t"
  done
fi
log "JDK: $(java -version 2>&1 | head -n1)"

# ---- 4. amd64 aapt2（来自 Google Maven，与 AGP 版本精确匹配）+ qemu 包装 ----
AAPT2_REAL="$TOOLS_DIR/aapt2-amd64"
AAPT2_WRAPPER="$TOOLS_DIR/aapt2"
if [ ! -x "$AAPT2_REAL" ]; then
  fetch "https://dl.google.com/android/maven2/com/android/tools/build/aapt2/$AGP_VERSION-$AAPT2_BUILD/aapt2-$AGP_VERSION-$AAPT2_BUILD-linux.jar" \
    "$TOOLS_DIR/aapt2-linux.jar"
  unzip -o -q "$TOOLS_DIR/aapt2-linux.jar" aapt2 -d "$TOOLS_DIR/aapt2-extract"
  mv "$TOOLS_DIR/aapt2-extract/aapt2" "$AAPT2_REAL"
  rm -rf "$TOOLS_DIR/aapt2-extract"
  chmod +x "$AAPT2_REAL"
fi
cat > "$AAPT2_WRAPPER" <<WEOF
#!/bin/sh
exec "$QEMU" -L "$SYS" "$AAPT2_REAL" "\$@"
WEOF
chmod +x "$AAPT2_WRAPPER"
log "aapt2（经 qemu）: $("$AAPT2_WRAPPER" version 2>&1 | head -n1)"

# ---- 5. SDK / Gradle / 构建 ----
install_gradle
install_cmdline_tools linux
install_sdk_packages
write_local_properties
write_init_gradle
write_gradle_user_home "$AAPT2_WRAPPER"
export GRADLE_USER_HOME="$GRADLE_USER_HOME_DIR"

finish_build "$GRADLE_BIN"
log "提示：qemu 模式构建较慢属正常现象；手机上更推荐在 Termux 内直接运行本脚本（原生模式）。"
