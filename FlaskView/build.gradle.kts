// 根工程：统一声明插件版本（app 模块中不再重复指定版本）
plugins {
    id("com.android.application") version "8.2.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.22" apply false
    // 内置 Python 运行时（支持 AGP 7.3~9.2，插件本体与 pip 产物均在 Maven Central）
    id("com.chaquo.python") version "17.0.0" apply false
}
