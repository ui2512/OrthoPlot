package com.example.flaskview

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * 自动更新检查：从 GitHub / GitCode 的 main 分支读取 version.json。
 *
 * 打开应用时最多每 6 小时检查一次；离线、超时或清单格式错误都静默失败。
 * 不发送设备信息，使用系统 HTTPS，不需要额外权限（清单已声明 INTERNET）。
 */
object UpdateChecker {

    private const val TAG = "OrthoPlotUpdate"
    private const val PREFS = "orthoplot_update"
    private const val KEY_LAST_CHECK = "last_check"
    private const val KEY_IGNORED = "ignored_version"
    private const val CHECK_INTERVAL_MS = 6L * 60 * 60 * 1000
    private const val MAX_BYTES = 64 * 1024
    private const val GITHUB_REPO = "https://github.com/ui2512/OrthoPlot"

    private val MANIFEST_URLS = listOf(
        "https://raw.githubusercontent.com/ui2512/OrthoPlot/main/version.json",
        "https://gitcode.com/api/v5/repos/ui2512/OrthoPlot/contents/version.json?ref=main",
        "https://raw.gitcode.com/ui2512/OrthoPlot/raw/main/version.txt",
    )
    private val VERSION_RE = Regex("^\\d+(\\.\\d+){0,3}$")

    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "orthoplot-update").apply { isDaemon = true }
    }
    private val mainHandler = Handler(Looper.getMainLooper())

    data class UpdateInfo(
        val version: String,
        val notes: String,
        val downloadUrl: String,
    )

    sealed class Result {
        data class Available(val info: UpdateInfo) : Result()
        object UpToDate : Result()
        object Failed : Result()
    }

    fun checkAsync(context: Context, manual: Boolean, callback: (Result) -> Unit) {
        val app = context.applicationContext
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (!manual && now - prefs.getLong(KEY_LAST_CHECK, 0L) < CHECK_INTERVAL_MS) {
            callback(Result.UpToDate)
            return
        }
        val current = currentVersion(app)
        executor.execute {
            val fetched = MANIFEST_URLS.asSequence()
                .mapNotNull { fetch(it, current) }
                .firstOrNull()
            prefs.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply()
            if (fetched == null) {
                mainHandler.post { callback(Result.Failed) }
                return@execute
            }
            val ignored = prefs.getString(KEY_IGNORED, "") == fetched.version
            val result = when {
                compareVersions(fetched.version, current) <= 0 -> Result.UpToDate
                ignored && !manual -> Result.UpToDate
                else -> Result.Available(fetched)
            }
            mainHandler.post { callback(result) }
        }
    }

    fun ignore(context: Context, version: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_IGNORED, version)
            .apply()
    }

    private fun currentVersion(context: Context): String = try {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0.0.0"
    } catch (_: Exception) {
        "0.0.0"
    }

    private fun fetch(url: String, currentVersion: String): UpdateInfo? {
        var conn: HttpURLConnection? = null
        return try {
            val connection = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 5000
                readTimeout = 5000
                requestMethod = "GET"
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "OrthoPlot/$currentVersion")
                setRequestProperty("Accept", "application/json")
            }
            conn = connection
            if (connection.responseCode != HttpURLConnection.HTTP_OK) return null

            val output = ByteArrayOutputStream()
            val buffer = ByteArray(4096)
            connection.inputStream.use { input ->
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    output.write(buffer, 0, read)
                    if (output.size() > MAX_BYTES) return null
                }
            }
            val text = output.toString("UTF-8")
            if (text.isBlank()) return null

            val obj = manifestObject(text)
            val version = obj.optString("version").trim()
            if (!VERSION_RE.matches(version)) return null

            val downloads = obj.optJSONObject("downloads")
            val androidUrl = downloads?.optString("android")?.trim().orEmpty()
            val repoUrl = obj.optString("url").trim()
            UpdateInfo(
                version = version,
                notes = obj.optString("notes").trim(),
                downloadUrl = androidUrl.takeIf { it.startsWith("https://") }
                    ?: repoUrl.takeIf { it.startsWith("https://") }
                    ?: "$GITHUB_REPO/tree/android",
            )
        } catch (e: Exception) {
            Log.i(TAG, "更新检查失败（$url）：${e.message}")
            null
        } finally {
            conn?.disconnect()
        }
    }

    /** GitCode contents API 会把文件包成 {"encoding":"base64","content":"..."}，这里剥掉包装。 */
    private fun manifestObject(text: String): JSONObject {
        val outer = JSONObject(text)
        val content = outer.optString("content").trim()
        if (outer.optString("encoding") == "base64" && content.isNotEmpty()) {
            val decoded = Base64.decode(content, Base64.DEFAULT)
            return JSONObject(String(decoded, Charsets.UTF_8))
        }
        return outer
    }

    private fun compareVersions(a: String, b: String): Int {
        val left = a.split(".").map { it.toIntOrNull() ?: 0 }
        val right = b.split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(left.size, right.size)) {
            val x = left.getOrElse(i) { 0 }
            val y = right.getOrElse(i) { 0 }
            if (x != y) return x.compareTo(y)
        }
        return 0
    }
}
