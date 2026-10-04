package dev.nearkey.passive

import android.os.Handler
import android.content.Context
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

/** One authenticated channel per enrolled origin, with independent reconnect state. */
class WebsiteConnection(
    context: Context,
    val website: ConnectedWebsite,
    private val handler: Handler,
    private val key: SigningKey,
    private val changed: () -> Unit,
    private val challengeReceived: (WebsiteConnection, Challenge) -> Unit,
    private val challengeCancelled: (WebsiteConnection, String) -> Unit,
    private val lost: (WebsiteConnection) -> Unit
) {
    val api = PhoneApi(context)
    var online = false
        private set
    var status = "Connecting…"
        private set
    var socket: WebSocket? = null
        private set
    private var running = false
    private var delay = 1000L
    private val reconnect = Runnable { connect() }

    fun start() { running = true; connect() }

    fun stop() {
        running = false
        disconnect("Verification stopped")
        api.cancelRequests()
    }

    fun close() { stop(); api.close() }

    fun retry() {
        disconnect("Connecting…")
        delay = 1000
        connect()
    }

    private fun connect() {
        if (!running || socket != null) return
        handler.removeCallbacks(reconnect)
        try {
            key.publicKey() // An enrolled registration must never create a replacement key.
            status = "Connecting…"
            changed()
            socket = api.channel(api.origin(website.origin), website.token, object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) { handler.post {
                    if (!running || socket !== webSocket) return@post
                    try {
                        require(text.length <= 8192) { "Phone message too large" }
                        val json = JSONObject(text)
                        when (json.getString("type")) {
                            "ready" -> {
                                require(json.getString("phoneId") == website.phoneId) { "Phone identity mismatch" }
                                online = true
                                delay = 1000
                                status = "Ready for a login"
                                changed()
                            }
                            "challenge" -> {
                                require(online) { "Challenge received before authenticated ready" }
                                challengeReceived(this@WebsiteConnection,
                                    Protocol.challenge(json.getJSONObject("challenge"), website.phoneId, System.currentTimeMillis()))
                            }
                            "cancel" -> challengeCancelled(this@WebsiteConnection, json.getString("challengeId"))
                            else -> error("Unsupported phone message")
                        }
                    } catch (e: Exception) { connectionLost(webSocket, e.message ?: "Invalid phone message") }
                } }
                override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) {
                    handler.post { connectionLost(webSocket, "Rejected binary phone message") }
                }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, null)
                    handler.post { connectionLost(webSocket, "Connection closed") }
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    handler.post { connectionLost(webSocket, "Connection closed") }
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    val rejected = response?.code == 401 || response?.code == 403
                    handler.post { connectionLost(webSocket,
                        if (rejected) "Enrollment rejected. An offline server reset is required."
                        else "Offline · reconnecting…", !rejected) }
                }
            })
        } catch (e: Exception) {
            status = e.message ?: "Cannot connect"
            changed()
            if (running && e.message == LocalNetwork.WIFI_REQUIRED) {
                handler.postDelayed(reconnect, delay)
                delay = (delay * 2).coerceAtMost(15_000)
            }
        }
    }

    private fun connectionLost(ws: WebSocket, message: String, retry: Boolean = true) {
        if (socket !== ws) return
        disconnect(message)
        if (running && retry) {
            handler.postDelayed(reconnect, delay)
            delay = (delay * 2).coerceAtMost(15_000)
        }
    }

    private fun disconnect(message: String) {
        handler.removeCallbacks(reconnect)
        val old = socket
        socket = null
        online = false
        old?.cancel()
        status = message
        lost(this)
        changed()
    }
}
