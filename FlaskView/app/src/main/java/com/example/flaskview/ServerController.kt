package com.example.flaskview

import android.content.Context
import android.util.Log
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * 服务控制器：进程级单例，持有 Flask 服务线程与生命周期状态，
 * 供 MainActivity（界面）与 ServerService（前台服务 / 通知栏）共同读写。
 *
 * 状态机：IDLE → STARTING → READY / FAILED；用户主动关闭为 STOPPED。
 * FAILED（含启动超时）后再次 ensureStarted 会自动重试，无需杀进程。
 *
 * 线程模型：
 *   - 所有启停操作经 ops 单线程执行器串行化（“停旧 → 等退出 → 起新”顺序不乱）；
 *   - 状态字段 @Volatile；就绪监视线程与异常回调凭 token 判断自己是否已被
 *     新一轮启停取代（tokenLock 保护判定 + 写状态），避免旧线程误报状态；
 *   - 状态变化通过 listeners 广播，监听方自行切到主线程刷新 UI。
 */
object ServerController {

    enum class State { IDLE, STARTING, READY, FAILED, STOPPED }

    data class Snapshot(val state: State, val detail: String?)

    @Volatile
    var state = State.IDLE
        private set

    /** FAILED 时的失败详情（超时文案 / Python 异常消息） */
    @Volatile
    var failureDetail: String? = null
        private set

    /** 当前（或最近一次请求的）监听地址 */
    @Volatile
    var host: String? = null
        private set

    @Volatile
    private var contextRef: Context? = null

    private var serverThread: Thread? = null
    private val ops = Executors.newSingleThreadExecutor()
    private val listeners = CopyOnWriteArrayList<(Snapshot) -> Unit>()
    private val tokenLock = Any()

    @Volatile
    private var watchToken = 0

    @Volatile
    private var lastHost: String? = null

    /** 进程内初始化一次即可（Activity / Service 的 onCreate 里调用） */
    fun attach(context: Context) {
        if (contextRef == null) contextRef = context.applicationContext
    }

    // ------------------------------------------------------------------
    // 对外操作（任意线程可调）
    // ------------------------------------------------------------------

    /** 确保服务以指定 host 运行；地址变化时热切换（停旧起新）。未运行 / 失败 / 已关闭则（重）启动 */
    fun ensureStarted(host: String) {
        lastHost = host
        ops.execute {
            when (state) {
                State.STARTING, State.READY ->
                    if (this.host != host) restartInPlace(host)
                else -> startInternal(host)
            }
        }
    }

    /** 以最近一次请求的地址重启（通知栏“重启服务”按钮） */
    fun restart() {
        ops.execute { restartInPlace(lastHost ?: host ?: HOST_LOCAL) }
    }

    /** 停止服务（通知栏“关闭服务”按钮） */
    fun stop() {
        ops.execute {
            synchronized(tokenLock) {
                watchToken++
                state = State.STOPPED
            }
            stopPythonAndJoin()
            publish()
        }
    }

    fun snapshot(): Snapshot = Snapshot(state, failureDetail)

    /** 注册状态监听；立即回调一次当前状态，方便界面初始化 */
    fun addListener(listener: (Snapshot) -> Unit) {
        listeners.add(listener)
        listener(snapshot())
    }

    fun removeListener(listener: (Snapshot) -> Unit) {
        listeners.remove(listener)
    }

    // ------------------------------------------------------------------
    // 内部实现（除注明外均在 ops 线程执行）
    // ------------------------------------------------------------------

    private fun restartInPlace(newHost: String) {
        stopInternal()
        startInternal(newHost)
    }

    private fun stopInternal() {
        synchronized(tokenLock) {
            watchToken++
            state = State.IDLE
        }
        stopPythonAndJoin()
    }

    /** 优雅停止 Python 端服务并等待服务线程退出（werkzeug shutdown，见 server.py） */
    private fun stopPythonAndJoin() {
        try {
            if (Python.isStarted()) {
                Python.getInstance().getModule("server").callAttr("stop")
            }
        } catch (e: Throwable) {
            Log.w(TAG, "停止服务失败（可能尚未完成初始化）", e)
        }
        // join 可能赶上线程还在初始化 Python（此时 stop 是空操作、服务尚未绑定），
        // 线程稍后完成绑定的话需要再补一刀 stop；serverThread 不在这里清空，
        // 而是由新服务线程作为 previous 等其完全退出（见 runServer）
        val thread = serverThread ?: return
        repeat(2) {
            try {
                thread.join(JOIN_TIMEOUT_MS)
            } catch (_: InterruptedException) {
            }
            if (thread.isAlive) {
                try {
                    if (Python.isStarted()) {
                        Python.getInstance().getModule("server").callAttr("stop")
                    }
                } catch (_: Throwable) {
                }
            }
        }
    }

    private fun startInternal(newHost: String) {
        // 上次异常退出时 server.py 的 _server 可能未清空，防御性清理
        if (state == State.FAILED && Python.isStarted()) {
            try {
                Python.getInstance().getModule("server").callAttr("stop")
            } catch (_: Throwable) {
            }
        }
        state = State.STARTING
        failureDetail = null
        host = newHost
        val token = ++watchToken
        val previous = serverThread
        publish()

        val thread = Thread { runServer(newHost, token, previous) }
        serverThread = thread
        thread.start()
        Thread { watchReadiness(token) }.start()
    }

    /** 服务线程：等旧线程退出 → 初始化 Python（Chaquopy，进程内）→ 阻塞式运行 Flask */
    private fun runServer(host: String, token: Int, previous: Thread?) {
        try {
            // 等上一轮线程完全退出（可能仍在初始化 Python），避免并发 Python.start
            previous?.let { prev ->
                if (prev !== Thread.currentThread()) {
                    try {
                        prev.join()
                    } catch (_: InterruptedException) {
                        return
                    }
                }
            }
            // 启动请求可能已被取消（如初始化期间用户点了“关闭”），此时不再绑定端口
            synchronized(tokenLock) {
                if (token != watchToken || state == State.IDLE || state == State.STOPPED) return
            }
            if (!Python.isStarted()) {
                Python.start(AndroidPlatform(appContext()))
            }
            Python.getInstance().getModule("server").callAttr("start", host, SERVER_PORT)
            // start() 正常返回 = 服务被 stop()；若非本轮启停操作所致，按意外退出处理
            synchronized(tokenLock) {
                if (token == watchToken && (state == State.STARTING || state == State.READY)) {
                    state = State.FAILED
                    failureDetail = "服务意外退出"
                    publish()
                }
            }
        } catch (e: Throwable) {
            Log.e(TAG, "本地服务启动失败", e)
            synchronized(tokenLock) {
                if (token == watchToken) {
                    state = State.FAILED
                    failureDetail = e.message ?: e.javaClass.simpleName
                    publish()
                }
            }
        }
    }

    /** 就绪监视线程：轮询端口，成功 → READY；超时 → FAILED（带重试提示） */
    private fun watchReadiness(token: Int) {
        var attempt = 0
        while (attempt < MAX_POLL_ATTEMPTS) {
            if (isStale(token)) return
            if (probePort()) {
                synchronized(tokenLock) {
                    if (token == watchToken && state == State.STARTING) {
                        state = State.READY
                        publish()
                    }
                }
                return
            }
            attempt++
            try {
                val interval =
                    if (attempt <= FAST_POLL_ATTEMPTS) FAST_POLL_INTERVAL_MS else POLL_INTERVAL_MS
                Thread.sleep(interval)
            } catch (_: InterruptedException) {
                return
            }
        }
        synchronized(tokenLock) {
            if (token == watchToken && state == State.STARTING) {
                state = State.FAILED
                failureDetail = "启动超时（60 秒）。慢设备首次启动可能更久，" +
                        "可从通知栏“重启服务”或重开应用重试。"
                publish()
            }
        }
    }

    private fun isStale(token: Int): Boolean = synchronized(tokenLock) {
        token != watchToken || state == State.IDLE || state == State.STOPPED
    }

    private fun appContext(): Context =
        requireNotNull(contextRef) { "ServerController.attach() 未被调用" }

    private fun publish() {
        val snapshot = snapshot()
        listeners.forEach { it(snapshot) }
    }

    // ------------------------------------------------------------------
    // 工具
    // ------------------------------------------------------------------

    /** 尝试连接本地端口，500ms 内连不上视为未就绪（本机回环通常立即返回） */
    fun probePort(): Boolean = try {
        Socket().use { socket ->
            socket.connect(InetSocketAddress("127.0.0.1", SERVER_PORT), 500)
        }
        true
    } catch (_: Exception) {
        false
    }

    /** 枚举本机非回环 IPv4 地址（Wi-Fi / 有线），供其他设备访问 */
    fun lanIps(): List<String> {
        val out = mutableListOf<String>()
        try {
            val enis = NetworkInterface.getNetworkInterfaces() ?: return out
            while (enis.hasMoreElements()) {
                val ni = enis.nextElement()
                if (!ni.isUp || ni.isLoopback) continue
                for (ia in ni.inetAddresses) {
                    if (ia is Inet4Address && !ia.isLoopbackAddress && !ia.isLinkLocalAddress) {
                        ia.hostAddress?.let { out.add(it) }
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "枚举局域网地址失败", e)
        }
        return out.distinct()
    }

    fun hostFor(lan: Boolean): String = if (lan) HOST_LAN else HOST_LOCAL

    private const val TAG = "FlaskView"

    /** 本地服务地址（本机入口；改端口时同步修改 strings.xml 的 server_url） */
    const val SERVER_URL = "http://127.0.0.1:5000"
    const val SERVER_PORT = 5000
    const val HOST_LOCAL = "127.0.0.1"
    const val HOST_LAN = "0.0.0.0"

    const val PREFS_NAME = "flaskview"
    const val KEY_LAN = "lan_mode"

    /** 就绪轮询：前 10 秒每 250ms 一次（界面更快进入“已启动”），随后每 1 秒一次，共 60 秒 */
    private const val FAST_POLL_INTERVAL_MS = 250L
    private const val FAST_POLL_ATTEMPTS = 40
    private const val POLL_INTERVAL_MS = 1000L
    private const val MAX_POLL_ATTEMPTS = 90

    /** 停止服务时等待旧线程退出的上限 */
    private const val JOIN_TIMEOUT_MS = 4000L
}
