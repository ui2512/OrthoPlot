package com.example.flaskview

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import androidx.core.content.ContextCompat

/**
 * 主界面：本地服务器控制页。
 *
 * 职责只有三个：
 *   1. 自动申请保活相关权限：通知权限（Android 13+ 运行时弹窗）与电池优化
 *      白名单（弹一次系统对话框）；两者都是“应用自动弹出、用户点一次允许”，
 *      系统不允许静默授予；
 *   2. 启动前台服务 ServerService，并由 ServerController 确保网站运行——
 *      服务随进程常驻，退到后台 / 划掉屏幕后继续运行，通知栏可查看状态、
 *      重启或关闭；进程被系统杀死后 START_STICKY 会自动拉起重启；
 *   3. 展示服务状态，提供“在浏览器中打开”入口（访问交给用户自己的浏览器）。
 *
 * 局域网访问：默认绑定 127.0.0.1（仅本机）；开关打开后改绑 0.0.0.0 并列出本机
 * 局域网 IP，同一 Wi-Fi 下的设备即可用浏览器访问。切换由 ServerController
 * 热切换完成（werkzeug make_server 的优雅停机），无需杀进程。
 *
 * 界面控件用 findViewById 而非 ViewBinding：仅 6 个控件， findViewById 不依赖
 * 生成代码，在受限环境（如 Termux 端构建）下更稳。
 *
 * 首次启动需解压 Python 运行时并导入依赖（sympy 较大），慢设备上约十几秒；
 * 之后启动只有依赖导入的开销，明显更快。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var tvStatus: TextView
    private lateinit var btnOpen: Button
    private lateinit var swLan: SwitchCompat
    private lateinit var tvLan: TextView

    private val mainHandler = Handler(Looper.getMainLooper())
    private val prefs: SharedPreferences by lazy {
        getSharedPreferences(ServerController.PREFS_NAME, MODE_PRIVATE)
    }

    private val stateListener: (ServerController.Snapshot) -> Unit = { snapshot ->
        mainHandler.post { render(snapshot) }
    }

    /** 通知权限申请结果：无论授予与否，都继续引导电池优化白名单 */
    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            Log.i(TAG, "通知权限申请结果: granted=$granted")
            requestBatteryWhitelistIfNeeded()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvStatus = findViewById(R.id.tv_status)
        btnOpen = findViewById(R.id.btn_open)
        swLan = findViewById(R.id.sw_lan)
        tvLan = findViewById(R.id.tv_lan)

        ServerController.attach(applicationContext)
        ServerController.addListener(stateListener)

        btnOpen.setOnClickListener { openBrowser() }

        // 先设初值再挂监听，避免触发一次无谓的回调
        swLan.isChecked = prefs.getBoolean(ServerController.KEY_LAN, false)
        swLan.setOnCheckedChangeListener { _, checked ->
            prefs.edit().putBoolean(ServerController.KEY_LAN, checked).apply()
            updateLanInfo()
            ServerController.ensureStarted(ServerController.hostFor(checked))
        }
        updateLanInfo()

        requestNeededPermissions()
        startServerFlow()
    }

    override fun onResume() {
        super.onResume()
        // IP 可能随网络切换变化，回到前台时刷新展示
        updateLanInfo()
        // 覆盖“进程被杀后重新打开 / 用户在通知栏关闭后又打开应用”的场景
        startServerFlow()
    }

    override fun onDestroy() {
        ServerController.removeListener(stateListener)
        mainHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    // ------------------------------------------------------------------
    // 权限：通知（Android 13+）+ 电池优化白名单（降低后台被杀概率）
    // ------------------------------------------------------------------

    private fun requestNeededPermissions() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            requestBatteryWhitelistIfNeeded()
        }
    }

    /** 引导加入电池优化白名单（Doze 豁免）；仅自动弹一次，之后可在系统设置里手动改 */
    @SuppressLint("BatteryLife")
    private fun requestBatteryWhitelistIfNeeded() {
        if (prefs.getBoolean(KEY_BATTERY_ASKED, false)) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        prefs.edit().putBoolean(KEY_BATTERY_ASKED, true).apply()
        try {
            startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName")
                )
            )
        } catch (e: Exception) {
            // 个别 ROM 没有该对话框，退回电池优化列表页
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: Exception) {
                Log.w(TAG, "无法打开电池优化设置", e)
            }
        }
    }

    // ------------------------------------------------------------------
    // 服务启动
    // ------------------------------------------------------------------

    /** 前台服务保活 + 确保网站以当前设置运行 */
    private fun startServerFlow() {
        ContextCompat.startForegroundService(this, Intent(this, ServerService::class.java))
        ServerController.ensureStarted(
            ServerController.hostFor(prefs.getBoolean(ServerController.KEY_LAN, false))
        )
    }

    private fun openBrowser() {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ServerController.SERVER_URL)))
        } catch (e: Exception) {
            Toast.makeText(this, "未找到可用的浏览器，请手动访问 ${ServerController.SERVER_URL}", Toast.LENGTH_LONG).show()
        }
    }

    // ------------------------------------------------------------------
    // 局域网访问
    // ------------------------------------------------------------------

    private fun updateLanInfo() {
        val lan = prefs.getBoolean(ServerController.KEY_LAN, false)
        if (!lan) {
            tvLan.text = getString(R.string.lan_off)
            return
        }
        val ips = ServerController.lanIps()
        tvLan.text = if (ips.isEmpty()) {
            getString(R.string.lan_no_ip)
        } else {
            ips.joinToString("\n") { "其他设备访问：http://$it:${ServerController.SERVER_PORT}" }
        }
    }

    // ------------------------------------------------------------------
    // 状态展示
    // ------------------------------------------------------------------

    private fun render(snapshot: ServerController.Snapshot) {
        when (snapshot.state) {
            ServerController.State.READY -> {
                tvStatus.text = getString(R.string.status_ready)
                btnOpen.isEnabled = true
            }
            ServerController.State.FAILED -> {
                tvStatus.text = getString(R.string.status_failed, snapshot.detail.orEmpty())
                btnOpen.isEnabled = false
            }
            ServerController.State.STOPPED -> {
                tvStatus.text = getString(R.string.status_stopped)
                btnOpen.isEnabled = false
            }
            ServerController.State.STARTING, ServerController.State.IDLE -> {
                tvStatus.text = getString(R.string.status_starting)
                btnOpen.isEnabled = false
            }
        }
    }

    companion object {
        private const val TAG = "FlaskView"

        /** 电池白名单只自动引导一次的标记（存偏好） */
        private const val KEY_BATTERY_ASKED = "battery_asked"
    }
}
