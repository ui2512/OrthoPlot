plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}

android {
    namespace = "com.example.flaskview"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.example.flaskview"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        // 只打 arm64-v8a：真机基本都是 arm64；Python 3.12+ 本身也仅支持 64 位。
        // 需要在 x86_64 模拟器上跑时，改为 abiFilters += listOf("arm64-v8a", "x86_64")
        // （APK 体积会明显增大，Python 运行时与 pip 依赖按 ABI 各存一份）。
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    // Release 签名：./build.sh release 会通过 -P 传入以下属性并自动生成 keystore；
    // 未提供时回退为 debug 签名，保证 assembleRelease 直接产出可安装的 APK。
    val releaseStoreFile = providers.gradleProperty("RELEASE_STORE_FILE").orNull
    if (releaseStoreFile != null) {
        signingConfigs {
            create("release") {
                storeFile = rootProject.file(releaseStoreFile)
                storePassword = providers.gradleProperty("RELEASE_STORE_PASSWORD").get()
                keyAlias = providers.gradleProperty("RELEASE_KEY_ALIAS").get()
                keyPassword = providers.gradleProperty("RELEASE_KEY_PASSWORD").get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = if (releaseStoreFile != null) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        // 演示工程：避免 lint 阻断 release 构建
        checkReleaseBuilds = false
        abortOnError = false
    }
}

// 内置 Python 环境（Chaquopy）
//  * version 必须与构建机上的 buildPython 大版本一致（如 Termux 构建机为
//    python3.14）；运行时与 pip 依赖在首次启动时解压到应用私有目录，之后离线可用。
//  * 网站源码在 app/src/main/python/（默认 Python 源码目录）。
chaquopy {
    defaultConfig {
        version = "3.14"
        pip {
            install("flask")   // 连带 werkzeug / jinja2 / markupsafe 等（markupsafe 走 Chaquopy 预编译包）
            install("sympy")   // 连带 mpmath（纯 Python）
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
}
