package com.example.flaskview

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * 前台服务：本地网站服务的“保活壳 + 通知栏遥控器”。
 *
 *   - 保活：以 specialUse 前台服务运行，进程退到后台 / 从最近任务划掉屏幕后
 *     系统不会轻易回收；再配合 START_STICKY，进程被杀后系统还会拉起服务、
 *     重新初始化 Python 并启动网站；
 *   - 通知：常驻展示服务状态（启动中 / 运行中 + 访问地址 / 失败原因），
 *     点击正文回到本应用，并提供“重启服务 / 关闭服务”两个按钮。
 *
 * 服务自身不直接操作 Python，一律经由 ServerController；Activity 与本服务
 * 通过控制器共享状态，谁先启动都能把网站拉起来。
 */
class ServerService : Service() {

    private val mainHandler = Handler(Looper.getMainLooper())

    private val stateListener: (ServerController.Snapshot) -> Unit = { snapshot ->
        mainHandler.post { render(snapshot) }
    }

    override fun onCreate() {
        super.onCreate()
        ServerController.attach(applicationContext)
        createChannel()
        startInForeground()
        ServerController.addListener(stateListener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_RESTART -> ServerController.restart()
            ACTION_STOP -> {
                ServerController.stop()
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            else -> ensureServer() // ACTION_START 或进程被杀后的粘性重启（intent == null）
        }
        return START_STICKY
    }

    override fun onDestroy() {
        ServerController.removeListener(stateListener)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** 以持久化的局域网开关状态确保服务运行（粘性重启时 intent 为空，同样走这里） */
    private fun ensureServer() {
        val lan = getSharedPreferences(ServerController.PREFS_NAME, MODE_PRIVATE)
            .getBoolean(ServerController.KEY_LAN, false)
        ServerController.ensureStarted(ServerController.hostFor(lan))
    }

    // ------------------------------------------------------------------
    // 通知
    // ------------------------------------------------------------------

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notif_channel_name),
            NotificationManager.IMPORTANCE_LOW // 常驻状态条目，不打扰（无声音、无横幅）
        ).apply {
            description = getString(R.string.notif_channel_desc)
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun startInForeground() {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            0 // Android 14 以下无类型校验，用 Manifest 声明即可
        }
        ServiceCompat.startForeground(this, NOTIF_ID, buildNotification(ServerController.snapshot()), type)
    }

    private fun render(snapshot: ServerController.Snapshot) {
        // STOPPED 时前台服务已在自行停止（stopForeground 会移除通知），无需再发
        if (snapshot.state == ServerController.State.STOPPED) return
        getSystemService(NotificationManager::class.java)
            .notify(NOTIF_ID, buildNotification(snapshot))
    }

    private fun buildNotification(snapshot: ServerController.Snapshot): Notification {
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(getString(R.string.notif_title))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openAppIntent())
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, getString(R.string.notif_action_restart), serviceIntent(ACTION_RESTART, REQUEST_RESTART))
            .addAction(0, getString(R.string.notif_action_stop), serviceIntent(ACTION_STOP, REQUEST_STOP))

        when (snapshot.state) {
            ServerController.State.READY -> {
                val lan = getSharedPreferences(ServerController.PREFS_NAME, MODE_PRIVATE)
                    .getBoolean(ServerController.KEY_LAN, false)
                val ips = if (lan) ServerController.lanIps() else emptyList()
                if (ips.isEmpty()) {
                    builder.setContentText(getString(R.string.notif_ready_local, ServerController.SERVER_URL))
                } else {
                    builder.setContentText(getString(R.string.notif_ready_lan))
                        .setStyle(
                            NotificationCompat.BigTextStyle().bigText(
                                ips.joinToString("\n") { "http://$it:${ServerController.SERVER_PORT}" }
                            )
                        )
                }
            }
            ServerController.State.FAILED -> {
                val text = getString(R.string.notif_failed, snapshot.detail.orEmpty())
                builder.setContentText(text)
                    .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            }
            else -> builder.setContentText(getString(R.string.notif_starting))
        }
        return builder.build()
    }

    /** 点击通知正文：回到应用控制页 */
    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this, 0,
        Intent(this, MainActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    /** 通知按钮：发给本服务的动作指令（服务本身在前台运行，无后台启动限制） */
    private fun serviceIntent(action: String, requestCode: Int): PendingIntent =
        PendingIntent.getService(
            this, requestCode,
            Intent(this, ServerService::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    companion object {
        private const val CHANNEL_ID = "server_status"
        private const val NOTIF_ID = 1

        const val ACTION_START = "com.example.flaskview.action.START"
        const val ACTION_RESTART = "com.example.flaskview.action.RESTART"
        const val ACTION_STOP = "com.example.flaskview.action.STOP"

        private const val REQUEST_RESTART = 1
        private const val REQUEST_STOP = 2
    }
}
