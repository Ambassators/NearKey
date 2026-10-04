package dev.nearkey.passive

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private val api = PhoneApi()
    private val key = SigningKey()
    private val prefs by lazy { getSharedPreferences("phone", MODE_PRIVATE) }
    private lateinit var urlInput: EditText
    private lateinit var codeInput: EditText
    private lateinit var enrollButton: Button
    private lateinit var setupButton: Button
    private lateinit var onlineText: TextView
    private lateinit var bleText: TextView
    private lateinit var challengeText: TextView
    private lateinit var statusText: TextView
    private var foreground = false
    private var generation = 0
    private var enrolling = false
    private var socket: WebSocket? = null
    private var online = false
    private var reconnectDelay = 1000L
    private var pending: Challenge? = null
    private var pendingEnd = 0L
    private var ble: BlePeripheral? = null
    private var permissionAction: (() -> Unit)? = null
    private var readyInFlight: String? = null
    private val reconnect = Runnable { connect() }
    private val ticker = object : Runnable {
        override fun run() {
            if (!foreground) return
            pending?.let {
                if (System.currentTimeMillis() >= it.expiresAt || SystemClock.elapsedRealtime() >= pendingEnd) {
                    clearChallenge("Challenge expired")
                }
            }
            displayChallenge()
            handler.postDelayed(this, 250)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 40, 32, 32)
        }
        fun text(value: String): TextView = TextView(this).apply {
            text = value; textSize = 17f; setPadding(0, 12, 0, 12); layout.addView(this)
        }
        text("NearKey · fictional transfer demo").textSize = 23f
        text("Keep this app in the foreground. No phone confirmation or biometrics. Bluetooth must already be enabled.")
        urlInput = EditText(this).apply {
            hint = "Server URL (https://…)"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true); setText(prefs.getString("origin", "")); layout.addView(this)
        }
        codeInput = EditText(this).apply {
            hint = "Paste pairing code from browser"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setSingleLine(true); isSaveEnabled = false; layout.addView(this)
        }
        enrollButton = Button(this).apply {
            text = "Enroll phone"
            setOnClickListener { enroll() }; layout.addView(this)
        }
        setupButton = Button(this).apply {
            text = "Advertise setup for 60 seconds"
            setOnClickListener { withPermissions { startBluetooth(pending) } }; layout.addView(this)
        }
        Button(this).apply {
            text = "Retry online connection"
            setOnClickListener {
                disconnect("Reconnecting")
                handler.removeCallbacks(reconnect)
                reconnectDelay = 1000
                connect()
            }
            layout.addView(this)
        }
        onlineText = text("Phone channel: offline")
        bleText = text("Bluetooth: stopped")
        challengeText = text("No pending server challenge")
        statusText = text(if (enrolled())
            "Locally enrolled · ${key.backing()}. Keep the app open for the authenticated phone channel."
            else "Enroll once using the browser's code and reachable server URL.")
        Button(this).apply {
            text = "Forget local enrollment"
            setOnClickListener {
                AlertDialog.Builder(this@MainActivity).setTitle("Erase this phone's local key and token?")
                    .setMessage("This does NOT remove the enrolled phone on the server. Re-enrollment requires an explicit offline server reset; password login cannot replace a phone.")
                    .setNegativeButton("Keep enrollment", null)
                    .setPositiveButton("Forget locally") { _, _ -> reset() }.show()
            }
            layout.addView(this)
        }
        setContentView(ScrollView(this).apply { addView(layout) })
        updateControls()
    }

    override fun onStart() {
        super.onStart()
        foreground = true
        generation++
        handler.post(ticker)
        updateControls()
        connect()
    }

    override fun onStop() {
        foreground = false
        generation++
        permissionAction = null
        handler.removeCallbacks(ticker)
        handler.removeCallbacks(reconnect)
        disconnect("App left foreground; Bluetooth and phone channel stopped")
        api.cancelRequests()
        if (enrolling) statusText.text = "Enrollment interrupted. If the browser shows enrollment, perform an offline server reset before retrying."
        enrolling = false
        updateControls()
        super.onStop()
    }

    override fun onDestroy() { api.close(); super.onDestroy() }

    private fun enrolled() = prefs.getString("token", null) != null

    private fun updateControls() {
        urlInput.isEnabled = !enrolled() && !enrolling
        codeInput.isEnabled = !enrolled() && !enrolling
        enrollButton.isEnabled = foreground && !enrolled() && !enrolling
        setupButton.isEnabled = foreground && enrolled() && !enrolling
        setupButton.text = if (pending == null) "Advertise setup for 60 seconds" else "Retry pending challenge advertising"
    }

    private fun enroll() {
        if (!foreground || enrolling || enrolled()) return
        try {
            val origin = api.origin(urlInput.text.toString())
            val code = codeInput.text.toString().trim()
            require(code.isNotEmpty() && code.length <= 512 && !code.contains('\n') && !code.contains('\r')) { "Paste a valid pairing code" }
            key.ensure()
            val publicKey = key.publicKey()
            val request = JSONObject().put("pairingCode", code).put("publicKey", publicKey)
                .put("label", "Android phone").put("signature", key.sign(Protocol.enrollmentText(code, publicKey)))
            enrolling = true
            updateControls()
            statusText.text = "Enrolling…"
            val epoch = generation
            api.post(origin, "/api/phones/enroll", request) { result, error -> handler.post {
                if (!foreground || generation != epoch) return@post
                enrolling = false
                try {
                    check(result != null) { error ?: "Enrollment failed" }
                    // Reject malformed responses without formatting credential-bearing JSON into an error.
                    val phoneId = requireNotNull(result.opt("phoneId") as? String) { "Invalid enrollment response" }
                    val token = requireNotNull(result.opt("deviceToken") as? String) { "Invalid enrollment response" }
                    require(phoneId.isNotBlank() && phoneId.length <= 128 && token.isNotEmpty() &&
                        token.length <= 1024 && token.all { it.code in 33..126 }) {
                        "Invalid enrollment response"
                    }
                    check(prefs.edit().putString("origin", origin.toString()).putString("phoneId", phoneId)
                        .putString("token", token).commit()) { "Cannot save phone credentials" }
                    urlInput.setText(origin.toString())
                    codeInput.text.clear()
                    statusText.text = "Enrolled · ${key.backing()}. Use setup advertising for the first browser chooser."
                    connect()
                } catch (e: Exception) {
                    statusText.text = "${e.message ?: "Enrollment failed"}. If the server enrolled this phone but credentials were not saved, an offline server reset is required."
                }
                updateControls()
            } }
        } catch (e: Exception) { statusText.text = e.message ?: "Enrollment failed" }
    }

    private fun connect() {
        if (!foreground || !enrolled() || socket != null) return
        try {
            // Never generate a replacement key for an already-enrolled credential.
            key.publicKey()
            val origin = api.origin(prefs.getString("origin", "")!!)
            val token = prefs.getString("token", null)!!
            onlineText.text = "Phone channel: connecting…"
            socket = api.channel(origin, token, object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) { handler.post {
                    if (!foreground || socket !== webSocket) return@post
                    try {
                        require(text.length <= 8192) { "Phone message too large" }
                        val json = JSONObject(text)
                        when (json.getString("type")) {
                            "ready" -> {
                                require(json.getString("phoneId") == prefs.getString("phoneId", null)) { "Phone identity mismatch" }
                                online = true
                                reconnectDelay = 1000
                                onlineText.text = "Phone channel: online (authenticated)"
                            }
                            "challenge" -> {
                                require(online) { "Challenge received before authenticated ready" }
                                val challenge = Protocol.challenge(json.getJSONObject("challenge"),
                                    prefs.getString("phoneId", null)!!, System.currentTimeMillis())
                                if (pending?.id == challenge.id) {
                                    require(pending == challenge) { "Server changed an immutable challenge" }
                                    return@post
                                }
                                clearChallenge("Previous Bluetooth window closed")
                                pending = challenge
                                pendingEnd = SystemClock.elapsedRealtime() + challenge.expiresAt - System.currentTimeMillis()
                                displayChallenge()
                                updateControls()
                                if (hasPermissions()) startBluetooth(challenge)
                                else bleText.text = "Bluetooth permission missing. Tap retry advertising to grant access."
                            }
                            "cancel" -> {
                                if (pending?.id == json.getString("challengeId")) clearChallenge("Server cancelled/completed the challenge")
                            }
                            else -> error("Unsupported phone message")
                        }
                    } catch (e: Exception) {
                        connectionLost(webSocket, e.message ?: "Invalid phone message")
                    }
                } }
                override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) {
                    handler.post { connectionLost(webSocket, "Rejected binary phone message") }
                }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, null)
                    handler.post { connectionLost(webSocket, "Phone channel closed") }
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    handler.post { connectionLost(webSocket, "Phone channel closed") }
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    val message = if (response?.code == 401 || response?.code == 403)
                        "Phone credential rejected; re-enrollment requires offline server reset" else "Phone channel disconnected; reconnecting while foreground"
                    handler.post { connectionLost(webSocket, message, response?.code != 401 && response?.code != 403) }
                }
            })
        } catch (e: Exception) {
            onlineText.text = "Phone channel: offline"
            statusText.text = e.message ?: "Cannot connect phone channel"
        }
    }

    private fun connectionLost(ws: WebSocket, message: String, retry: Boolean = true) {
        if (socket !== ws) return
        disconnect(message)
        statusText.text = message
        if (foreground && enrolled() && retry) {
            handler.removeCallbacks(reconnect)
            handler.postDelayed(reconnect, reconnectDelay)
            reconnectDelay = (reconnectDelay * 2).coerceAtMost(15_000)
        }
    }

    private fun disconnect(message: String) {
        val old = socket
        socket = null
        online = false
        old?.cancel()
        clearChallenge(message)
        onlineText.text = "Phone channel: offline"
    }

    private fun clearChallenge(message: String) {
        pending = null
        pendingEnd = 0
        readyInFlight = null
        ble?.close(); ble = null
        bleText.text = "Bluetooth: stopped · $message"
        displayChallenge()
        updateControls()
    }

    private fun displayChallenge() {
        val c = pending
        challengeText.text = if (c == null) "No pending server challenge" else {
            val remaining = minOf(c.expiresAt - System.currentTimeMillis(), pendingEnd - SystemClock.elapsedRealtime()).coerceAtLeast(0)
            "Pending server challenge ${c.id}\nTo: ${c.recipientName} (${c.recipientId})\nAmount: ${c.amountCents} cents\nNote: ${c.note}\nRemaining: ${(remaining + 999) / 1000} seconds"
        }
    }

    private fun startBluetooth(challenge: Challenge?) {
        if (!foreground || !enrolled()) return
        if (challenge != null && (pending !== challenge || !online || SystemClock.elapsedRealtime() >= pendingEnd)) {
            clearChallenge("No live online challenge")
            return
        }
        ble?.close()
        lateinit var peripheral: BlePeripheral
        peripheral = BlePeripheral(this, handler, challenge, key::sign,
            onReady = { if (ble === peripheral && pending === challenge && challenge != null) acknowledgeReady(challenge) },
            onStatus = { if (ble === peripheral) bleText.text = "Bluetooth: $it" },
            onError = { if (ble === peripheral) { ble = null; bleText.text = "Bluetooth: $it" } })
        ble = peripheral
        peripheral.start()
    }

    private fun acknowledgeReady(challenge: Challenge) {
        if (!foreground || !online || pending !== challenge || readyInFlight == challenge.id) return
        val epoch = generation
        val channel = socket
        readyInFlight = challenge.id
        try {
            val origin = api.origin(prefs.getString("origin", "")!!)
            api.post(origin, "/api/phone/challenges/${challenge.id}/ready", JSONObject(), prefs.getString("token", null)) { result, error -> handler.post {
                if (!foreground || generation != epoch || socket !== channel || pending !== challenge) return@post
                readyInFlight = null
                if (result?.optBoolean("ok") != true) {
                    // Never leave an unacknowledged challenge signing after an API error.
                    clearChallenge(error ?: "Server did not acknowledge advertising readiness")
                    statusText.text = "Readiness failed. Cancel/retry in the browser or reconnect the phone channel."
                } else statusText.text = "Server acknowledged advertising. Waiting for browser GATT handshake."
            } }
        } catch (e: Exception) { clearChallenge(e.message ?: "Readiness failed") }
    }

    private fun hasPermissions(): Boolean = Build.VERSION.SDK_INT < 31 ||
        listOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE)
            .all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    private fun withPermissions(action: () -> Unit) {
        if (!foreground) return
        if (hasPermissions()) action()
        else {
            permissionAction = action
            requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE), 1)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val action = permissionAction
        permissionAction = null
        if (requestCode == 1 && foreground) {
            if (hasPermissions()) action?.invoke()
            else bleText.text = "Bluetooth access denied. Allow Nearby devices in app settings and retry."
        }
    }

    private fun reset() {
        generation++
        permissionAction = null
        handler.removeCallbacks(reconnect)
        disconnect("Local enrollment forgotten")
        api.cancelRequests()
        enrolling = false
        // Attempt both erasures even if one fails; never reconnect during a partial reset.
        val credentialsErased = try { prefs.edit().clear().commit() } catch (_: Exception) { false }
        val keyErased = try { key.delete(); true } catch (_: Exception) { false }
        urlInput.text.clear(); codeInput.text.clear()
        val failedParts = listOfNotNull(
            if (credentialsErased) null else "credential storage",
            if (keyErased) null else "Keystore"
        ).joinToString(" and ")
        statusText.text = if (failedParts.isEmpty())
            "Local token/key erased. Server phone enrollment is unchanged; offline reset required before enrolling again."
        else "Local reset incomplete ($failedParts). Retry Forget locally. Server enrollment is unchanged; offline reset is still required."
        updateControls()
    }
}
