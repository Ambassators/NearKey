package dev.nearkey.passive

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONObject

/** The service owns networking and GATT; screens only observe and configure them. */
class AuthenticatorRuntime(private val context: Context) {
    private val handler = Handler(Looper.getMainLooper())
    private val key = SigningKey()
    private var generation = 0
    private var websites = emptyList<ConnectedWebsite>()
    val connections = linkedMapOf<String, WebsiteConnection>()
    private val listeners = linkedSetOf<() -> Unit>()
    val lifetime = AuthenticatorLifetime(::start, ::stop)
    var setupOrigin: String? = null
    var bluetoothReadyOrigin: String? = null
        private set
    var status = ""
        private set
    var bluetoothStatus = "Bluetooth is ready when a login needs it."
        private set
    private var ble: BlePeripheral? = null
    private var readyInFlight: PendingLogin? = null
    private val waiting = linkedMapOf<String, PendingLogin>()
    private var activeLogin: PendingLogin? = null

    private data class PendingLogin(val owner: WebsiteConnection, val challenge: Challenge, val end: Long) {
        fun remaining() = minOf(challenge.expiresAt - System.currentTimeMillis(), end - SystemClock.elapsedRealtime())
    }

    fun observe(listener: () -> Unit) { listeners.add(listener) }
    fun removeObserver(listener: () -> Unit) { listeners.remove(listener) }
    private fun changed() { listeners.toList().forEach { it() } }
    private fun setStatus(message: String) { status = message; changed() }
    fun connectionStates() = connections.mapValues { (_, connection) -> connection.online to connection.status }
    fun loginDescription(): String {
        val login = activeLogin ?: return if (connections.values.any { it.online })
            "✓  Ready when you sign in" else "Waiting for website connection"
        return "Verifying ${login.owner.website.address}\n${login.challenge.username} · ${(login.remaining().coerceAtLeast(0) + 999) / 1000}s remaining"
    }

    fun updateWebsites(next: List<ConnectedWebsite>) {
        websites = next
        connections.values.toList().filter { old ->
            next.none { it.origin == old.website.origin && it.phoneId == old.website.phoneId && it.token == old.website.token }
        }.forEach { old -> connections.remove(old.website.origin); old.close() }
        next.filter { it.origin !in connections }.forEach { site ->
            val connection = addConnection(site)
            if (lifetime.running) connection.start()
        }
        if (next.isEmpty()) {
            setupOrigin = null
            waiting.clear(); activeLogin = null
            handler.removeCallbacks(expire)
            stopBluetooth("No websites connected")
        }
        changed()
    }

    private fun start() {
        generation++
        connections.values.toList().forEach { it.start() }
    }

    private fun stop() {
        generation++
        waiting.clear(); activeLogin = null
        handler.removeCallbacks(expire)
        stopBluetooth("Verification stopped")
        connections.values.toList().forEach { it.stop() }
        changed()
    }

    // Schedule only while a challenge is pending; no polling while idle or screen off.
    private val expire = Runnable {
        waiting.values.toList().filter { it.remaining() <= 0 }.forEach {
            clearLogin(it.owner, "Login request expired. Try again in your browser.")
        }
        scheduleExpiry()
    }
    private fun scheduleExpiry() {
        handler.removeCallbacks(expire)
        waiting.values.minOfOrNull { it.remaining().coerceAtLeast(1) }?.let { handler.postDelayed(expire, it) }
    }

    private fun addConnection(site: ConnectedWebsite): WebsiteConnection {
        val connection = WebsiteConnection(context, site, handler, key,
            changed = {
                if (lifetime.running && ble == null && hasPermissions() &&
                    websites.any { it.setupComplete && connections[it.origin]?.online == true }) {
                    startBluetooth(activeLogin)
                }
                changed()
            }, challengeReceived = ::receiveChallenge,
            challengeCancelled = { owner, id ->
                if (waiting[owner.website.origin]?.challenge?.id == id) {
                    clearLogin(owner, "Login request finished. Ready for the next sign-in.")
                }
            }, lost = { owner ->
                if (setupOrigin == owner.website.origin) bluetoothReadyOrigin = null
                clearLogin(owner, "Website connection closed. Reconnect to verify logins.")
                if (connections.values.none { it.online }) stopBluetooth("Waiting for website connection")
            })
        connections[site.origin] = connection
        return connection
    }

    fun reportError(message: String) { setStatus(message) }
    fun setupBluetooth() {
        val current = activeLogin
        if (current != null && setupOrigin != null && current.owner.website.origin != setupOrigin) {
            setStatus("Another website is verifying a login. Finish that sign-in, then retry Bluetooth setup.")
            return
        }
        startBluetooth(current)
    }
    fun hasPermissions(): Boolean = Build.VERSION.SDK_INT < 31 ||
        listOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE)
            .all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
    private fun receiveChallenge(owner: WebsiteConnection, challenge: Challenge) {
        val previous = waiting[owner.website.origin]
        if (previous?.challenge?.id == challenge.id) {
            require(previous.challenge == challenge) { "Server changed an immutable challenge" }
            return
        }
        if (previous != null) clearLogin(owner, "Previous login request closed")
        waiting[owner.website.origin] = PendingLogin(owner, challenge,
            SystemClock.elapsedRealtime() + challenge.expiresAt - System.currentTimeMillis())
        scheduleExpiry()
        activateNextLogin()
    }

    private fun activateNextLogin() {
        if (!lifetime.running || activeLogin != null) return
        val next = waiting.values.firstOrNull { it.owner.online && it.remaining() > 0 } ?: return
        activeLogin = next
        changed()
        startBluetooth(next)
    }

    private fun clearLogin(owner: WebsiteConnection, message: String) {
        val removed = waiting.remove(owner.website.origin)
        scheduleExpiry()
        if (removed != null && activeLogin === removed) {
            activeLogin = null; readyInFlight = null
            ble?.setChallenge(null)
            bluetoothStatus = message
            changed(); activateNextLogin()
        }
    }

    fun stopBluetooth(message: String) {
        val peripheral = ble; ble = null; peripheral?.close()
        readyInFlight = null; bluetoothReadyOrigin = null
        bluetoothStatus = message
    }

    private fun startBluetooth(login: PendingLogin?) {
        if (!lifetime.running || activeLogin !== login || (login == null && setupOrigin == null &&
            websites.none { it.setupComplete && connections[it.origin]?.online == true })) return
        if (login != null && (!login.owner.online || login.remaining() <= 0)) {
            clearLogin(login.owner, "Login request expired"); return
        }
        if (!hasPermissions()) { setStatus("Allow Nearby devices in NearKey to verify logins."); return }
        ble?.let { it.setChallenge(login?.challenge); return }
        bluetoothStatus = "Starting Bluetooth…"
        lateinit var peripheral: BlePeripheral
        peripheral = BlePeripheral(context, handler, login?.challenge, key::sign,
            onReady = {
                if (lifetime.running && ble === peripheral) {
                    val current = activeLogin
                    val setup = setupOrigin
                    if (current != null) acknowledgeReady(current)
                    if (setup != null && (current == null || current.owner.website.origin == setup)) {
                        bluetoothReadyOrigin = setup
                        changed()
                    }
                }
            },
            onStatus = {
                if (lifetime.running && ble === peripheral) {
                    bluetoothStatus = it
                    changed()
                }
            },
            onError = {
                if (lifetime.running && ble === peripheral) {
                    ble = null; readyInFlight = null; bluetoothReadyOrigin = null
                    bluetoothStatus = it; setStatus(it)
                }
            })
        ble = peripheral; peripheral.start()
    }

    private fun acknowledgeReady(login: PendingLogin) {
        val owner = login.owner
        if (!lifetime.running || !owner.online || activeLogin !== login || readyInFlight === login) return
        if (login.remaining() <= 0) { clearLogin(owner, "Login request expired"); return }
        val peripheral = ble ?: return
        val epoch = generation; val channel = owner.socket ?: return
        readyInFlight = login
        try {
            owner.api.post(owner.api.origin(owner.website.origin), "/api/phone/challenges/${login.challenge.id}/ready",
                JSONObject(), owner.website.token) { result, error -> handler.post {
                if (!lifetime.running || generation != epoch || owner.socket !== channel || activeLogin !== login || ble !== peripheral) return@post
                readyInFlight = null
                if (login.remaining() <= 0) { clearLogin(owner, "Login request expired"); return@post }
                if (result?.optBoolean("ok") != true) {
                    clearLogin(owner, error ?: "Readiness failed")
                    setStatus("Bluetooth could not be confirmed. Cancel and retry in your browser.")
                } else setStatus("Bluetooth is ready. Waiting for your browser to verify the login.")
            } }
        } catch (e: Exception) { clearLogin(owner, e.message ?: "Readiness failed") }
    }

}
