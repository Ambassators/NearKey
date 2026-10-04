package dev.nearkey.passive

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.ViewModelProvider
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    private val handler = Handler(Looper.getMainLooper())
    private val enrollmentApi = PhoneApi()
    private val key = SigningKey()
    private val prefs by lazy { getSharedPreferences("phone", MODE_PRIVATE) }
    private val store by lazy { WebsiteStore(prefs) }
    private val draft by lazy { ViewModelProvider(this)[EnrollmentDraft::class.java] }
    private lateinit var ui: NearKeyUi
    private var websites = emptyList<ConnectedWebsite>()
    private val connections = linkedMapOf<String, WebsiteConnection>()
    private var storageError = false
    private var foreground = false
    private var generation = 0
    private var enrolling = false
    private var wizardStep = 1 // 0 is the connected websites list.
    private var manualExpanded = false
    private var setupLoaded = false
    private var manualOrigin = ""
    private var manualCode = ""
    private var setupOrigin: String? = null
    private var bluetoothReadyOrigin: String? = null
    private var status = ""
    private var bluetoothStatus = "Bluetooth is ready when a login needs it."
    private var ble: BlePeripheral? = null
    private var permissionAction: (() -> Unit)? = null
    private var permissionRequested = false
    private var readyInFlight: PendingLogin? = null
    private val waiting = linkedMapOf<String, PendingLogin>()
    private var activeLogin: PendingLogin? = null

    private data class PendingLogin(val owner: WebsiteConnection, val challenge: Challenge, val end: Long) {
        fun remaining() = minOf(challenge.expiresAt - System.currentTimeMillis(), end - SystemClock.elapsedRealtime())
    }

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        if (result.contents == null) setStatus("Scan cancelled. Scan again or enter your details manually.")
        else populateEnrollment(result.contents)
    }
    private val bluetoothPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        permissionRequested = false
        val action = permissionAction; permissionAction = null
        if (foreground) {
            if (hasPermissions()) action?.invoke()
            else setStatus("Bluetooth access denied. Allow Nearby devices in app settings, then retry.")
        }
    }
    private val ticker = object : Runnable {
        override fun run() {
            if (!foreground) return
            waiting.values.toList().filter { it.remaining() <= 0 }.forEach {
                clearLogin(it.owner, "Login request expired. Try again in your browser.")
            }
            ui.updateLogin(loginDescription())
            handler.postDelayed(this, 250)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        ui = NearKeyUi(this)
        setContentView(ui.root)
        try { websites = store.load() } catch (_: Exception) {
            storageError = true
            status = "Saved registrations could not be read. Clear local app storage before setting up again; server enrollments are unchanged."
        }
        setupOrigin = websites.firstOrNull { !it.setupComplete }?.origin
        wizardStep = if (setupOrigin != null) 3 else if (websites.isEmpty()) 1 else 0
        if (savedInstanceState != null && setupOrigin == null && !storageError) {
            val restored = savedInstanceState.getInt("wizardStep", wizardStep)
            if (restored in 0..2 && (restored != 0 || websites.isNotEmpty())) wizardStep = restored
        }
        draft.setup?.let { if (wizardStep != 3) applyEnrollment(it) }
        websites.forEach(::addConnection)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (enrolling) return
                when {
                    wizardStep > 0 && websites.isNotEmpty() -> closeWizard()
                    wizardStep == 2 -> { wizardStep = 1; render() }
                    else -> { isEnabled = false; onBackPressedDispatcher.onBackPressed(); isEnabled = true }
                }
            }
        })
        render()
        consumeEnrollmentIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt("wizardStep", wizardStep)
        super.onSaveInstanceState(outState)
    }

    private fun render() {
        if (wizardStep == 0) {
            ui.websites(websites, connectionStates(), loginDescription(), status, ::beginSetup, ::websiteDetails)
        } else {
            ui.wizard(wizardStep, manualOrigin, manualCode, manualExpanded, setupLoaded, enrolling,
                foreground && !storageError, status, websites.isNotEmpty(),
                start = { wizardStep = 2; render() }, scan = ::scan,
                toggleManual = { manualExpanded = !manualExpanded; render() }, enroll = ::enroll,
                bluetooth = ::setupBluetooth, close = ::closeWizard,
                back = { if (websites.isEmpty()) { wizardStep = 1; render() } else closeWizard() },
                retry = { setupOrigin?.let { connections[it]?.retry() } },
                edit = { origin, code ->
                    manualOrigin = origin; manualCode = code
                    if (setupLoaded) { setupLoaded = false; draft.clear() }
                })
        }
    }

    private fun setStatus(message: String) { status = message; ui.updateStatus(message) }
    private fun connectionStates() = connections.mapValues { (_, connection) -> connection.online to connection.status }
    private fun loginDescription(): String {
        val login = activeLogin ?: return if (connections.values.any { it.online })
            "✓  Ready when you sign in" else "Waiting for website connection"
        return "Verifying ${login.owner.website.address}\n${login.challenge.username} · ${(login.remaining().coerceAtLeast(0) + 999) / 1000}s remaining"
    }

    private fun beginSetup() {
        if (websites.size >= 30) { setStatus("You can connect up to 30 websites."); return }
        if (enrolling || storageError) return
        setupOrigin = null; bluetoothReadyOrigin = null
        manualOrigin = ""; manualCode = ""; setupLoaded = false; manualExpanded = false; draft.clear()
        status = ""; wizardStep = 2; render()
    }

    private fun closeWizard() {
        if (enrolling || websites.isEmpty()) return
        draft.clear(); manualCode = ""; setupLoaded = false; manualExpanded = false
        wizardStep = 0; render()
    }

    private fun scan() {
        if (!foreground || enrolling || storageError || wizardStep != 2) return
        scanner.launch(ScanOptions().apply {
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt("Scan the setup QR code in your computer’s browser")
            setBeepEnabled(false); setOrientationLocked(false)
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent); consumeEnrollmentIntent(intent)
    }

    private fun consumeEnrollmentIntent(intent: Intent) {
        val hasExtra = intent.hasExtra("enrollment_uri")
        val hasLink = intent.action == Intent.ACTION_VIEW && intent.data != null
        if (!hasExtra && !hasLink) return
        val value = try { if (hasExtra) intent.getStringExtra("enrollment_uri") else intent.dataString }
            catch (_: Exception) { null }
        intent.removeExtra("enrollment_uri"); if (hasLink) intent.data = null
        if (value == null) setStatus("Invalid setup QR code") else populateEnrollment(value)
    }

    private fun populateEnrollment(value: String) {
        if (enrolling || storageError) return
        try {
            val setup = EnrollmentQr.parse(value)
            require(websites.none { it.origin == setup.origin.toString() }) {
                "This website is already connected. Open its connection details to retry Bluetooth."
            }
            draft.load(value)
            applyEnrollment(setup)
        } catch (e: Exception) { setStatus(e.message ?: "Invalid setup QR code") }
    }

    private fun applyEnrollment(setup: EnrollmentSetup) {
        manualOrigin = setup.origin.toString(); manualCode = setup.pairingCode
        setupOrigin = null; setupLoaded = true; manualExpanded = false; wizardStep = 2
        status = "QR scanned. Review the website address before connecting."
        render()
    }

    override fun onStart() {
        super.onStart(); foreground = true; generation++
        handler.removeCallbacks(ticker); handler.post(ticker)
        render(); connections.values.forEach { it.start() }
    }

    override fun onStop() {
        foreground = false; generation++; permissionAction = null
        handler.removeCallbacks(ticker)
        stopBluetooth("App paused. Keep NearKey open to verify logins.")
        waiting.clear(); activeLogin = null
        connections.values.forEach { it.stop() }; enrollmentApi.cancelRequests()
        if (enrolling) status = "Setup interrupted. If the browser shows enrollment, perform an offline server reset before retrying."
        enrolling = false; render()
        super.onStop()
    }

    override fun onDestroy() {
        foreground = false; generation++; handler.removeCallbacks(ticker)
        stopBluetooth("App closed"); connections.values.forEach { it.close() }; enrollmentApi.close()
        super.onDestroy()
    }

    private fun enroll() {
        if (!foreground || enrolling || storageError || wizardStep != 2) return
        try {
            val origin = enrollmentApi.origin(manualOrigin)
            require(websites.size < 30) { "You can connect up to 30 websites" }
            require(websites.none { it.origin == origin.toString() }) { "This website is already connected" }
            val code = manualCode.trim()
            require(code.isNotEmpty() && code.length <= 512 && !code.contains('\n') && !code.contains('\r')) { "Paste a valid pairing code" }
            // Existing registrations share this non-exportable phone key; never silently replace it.
            if (websites.isEmpty()) key.ensure() else key.publicKey()
            val publicKey = key.publicKey()
            val request = JSONObject().put("pairingCode", code).put("publicKey", publicKey)
                .put("label", "Android phone").put("signature", key.sign(Protocol.enrollmentText(code, publicKey)))
            enrolling = true; status = "Securely connecting your phone…"; render()
            val epoch = generation
            enrollmentApi.post(origin, "/api/phones/enroll", request) { result, error -> handler.post {
                if (!foreground || generation != epoch) return@post
                enrolling = false
                try {
                    check(result != null) { error ?: "Enrollment failed" }
                    val phoneId = requireNotNull(result.opt("phoneId") as? String) { "Invalid enrollment response" }
                    val token = requireNotNull(result.opt("deviceToken") as? String) { "Invalid enrollment response" }
                    require(phoneId.isNotBlank() && phoneId.length <= 128 && token.isNotEmpty() &&
                        token.length <= 1024 && token.all { it.code in 33..126 }) { "Invalid enrollment response" }
                    val site = ConnectedWebsite(origin.toString(), phoneId, token)
                    val next = websites + site
                    store.save(next); websites = next
                    manualCode = ""; draft.clear(); setupLoaded = false
                    setupOrigin = site.origin; wizardStep = 3
                    status = "Website paired. Tap below to connect Bluetooth."
                    addConnection(site).start()
                } catch (e: Exception) {
                    status = "${e.message ?: "Enrollment failed"}. If your browser already shows enrollment, perform an offline server reset before retrying."
                }
                render()
            } }
        } catch (e: Exception) { setStatus(e.message ?: "Enrollment failed") }
    }

    private fun addConnection(site: ConnectedWebsite): WebsiteConnection {
        val connection = WebsiteConnection(site, handler, key,
            changed = {
                ui.updateConnections(connectionStates())
                ui.updateLogin(loginDescription())
                completeSetupIfReady()
            }, challengeReceived = ::receiveChallenge,
            challengeCancelled = { owner, id ->
                if (waiting[owner.website.origin]?.challenge?.id == id) {
                    clearLogin(owner, "Login request finished. Ready for the next sign-in.")
                }
            }, lost = { owner ->
                if (setupOrigin == owner.website.origin) {
                    bluetoothReadyOrigin = null
                    if (wizardStep == 3) setStatus(owner.status)
                }
                clearLogin(owner, "Website connection closed. Reconnect to verify logins.")
            })
        connections[site.origin] = connection
        return connection
    }

    private fun receiveChallenge(owner: WebsiteConnection, challenge: Challenge) {
        val previous = waiting[owner.website.origin]
        if (previous?.challenge?.id == challenge.id) {
            require(previous.challenge == challenge) { "Server changed an immutable challenge" }
            return
        }
        if (previous != null) clearLogin(owner, "Previous login request closed")
        waiting[owner.website.origin] = PendingLogin(owner, challenge,
            SystemClock.elapsedRealtime() + challenge.expiresAt - System.currentTimeMillis())
        activateNextLogin()
    }

    private fun activateNextLogin() {
        if (!foreground || activeLogin != null) return
        val next = waiting.values.firstOrNull { it.owner.online && it.remaining() > 0 } ?: return
        activeLogin = next
        ui.updateLogin(loginDescription())
        withPermissions { startBluetooth(next) }
    }

    private fun clearLogin(owner: WebsiteConnection, message: String) {
        val removed = waiting.remove(owner.website.origin)
        if (removed != null && activeLogin === removed) {
            activeLogin = null; stopBluetooth(message)
            ui.updateLogin(loginDescription()); activateNextLogin()
        }
    }

    private fun stopBluetooth(message: String) {
        val peripheral = ble; ble = null; peripheral?.close()
        readyInFlight = null; permissionAction = null; bluetoothReadyOrigin = null
        bluetoothStatus = message
    }

    private fun setupBluetooth() {
        if (!foreground || setupOrigin == null) return
        val site = connections[setupOrigin] ?: return
        if (activeLogin != null && activeLogin?.owner !== site) {
            setStatus("Another website is verifying a login. Finish that sign-in, then retry Bluetooth setup.")
            return
        }
        if (!site.online) {
            setStatus("Connecting to your website. Bluetooth setup will wait for the authenticated connection.")
            site.retry()
        }
        withPermissions { startBluetooth(activeLogin) }
    }

    private fun startBluetooth(login: PendingLogin?) {
        if (!foreground || activeLogin !== login || (login == null && setupOrigin == null)) return
        if (login != null && (!login.owner.online || login.remaining() <= 0)) {
            clearLogin(login.owner, "Login request expired"); return
        }
        if (!hasPermissions()) { withPermissions { startBluetooth(login) }; return }
        stopBluetooth("Starting Bluetooth…")
        val setup = setupOrigin
        lateinit var peripheral: BlePeripheral
        peripheral = BlePeripheral(this, handler, login?.challenge, key::sign,
            onReady = {
                if (foreground && ble === peripheral && activeLogin === login) {
                    if (login != null) acknowledgeReady(login)
                    if (setup != null && (login == null || login.owner.website.origin == setup)) {
                        bluetoothReadyOrigin = setup
                        completeSetupIfReady()
                    }
                }
            },
            onStatus = {
                if (foreground && ble === peripheral) {
                    bluetoothStatus = it
                    if (wizardStep == 3) setStatus(it)
                }
            },
            onError = {
                if (foreground && ble === peripheral) {
                    ble = null; readyInFlight = null; bluetoothReadyOrigin = null
                    bluetoothStatus = it; setStatus(it)
                }
            })
        ble = peripheral; peripheral.start()
    }

    private fun completeSetupIfReady() {
        val origin = setupOrigin ?: return
        if (wizardStep != 3 || bluetoothReadyOrigin != origin || connections[origin]?.online != true) return
        try {
            val next = websites.map { if (it.origin == origin) it.copy(setupComplete = true) else it }
            store.save(next); websites = next
            setupOrigin = null; wizardStep = 0
            status = "Website connected. Continue in your browser to finish signing in."
            render()
        } catch (e: Exception) { setStatus(e.message ?: "Cannot save setup completion. Retry Bluetooth setup.") }
    }

    private fun acknowledgeReady(login: PendingLogin) {
        val owner = login.owner
        if (!foreground || !owner.online || activeLogin !== login || readyInFlight === login) return
        if (login.remaining() <= 0) { clearLogin(owner, "Login request expired"); return }
        val peripheral = ble ?: return
        val epoch = generation; val channel = owner.socket ?: return
        readyInFlight = login
        try {
            owner.api.post(owner.api.origin(owner.website.origin), "/api/phone/challenges/${login.challenge.id}/ready",
                JSONObject(), owner.website.token) { result, error -> handler.post {
                if (!foreground || generation != epoch || owner.socket !== channel || activeLogin !== login || ble !== peripheral) return@post
                readyInFlight = null
                if (login.remaining() <= 0) { clearLogin(owner, "Login request expired"); return@post }
                if (result?.optBoolean("ok") != true) {
                    clearLogin(owner, error ?: "Readiness failed")
                    setStatus("Bluetooth could not be confirmed. Cancel and retry in your browser.")
                } else setStatus("Bluetooth is ready. Waiting for your browser to verify the login.")
            } }
        } catch (e: Exception) { clearLogin(owner, e.message ?: "Readiness failed") }
    }

    private fun hasPermissions(): Boolean = Build.VERSION.SDK_INT < 31 ||
        listOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE)
            .all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    private fun withPermissions(action: () -> Unit) {
        if (!foreground) return
        if (hasPermissions()) action()
        else {
            val epoch = generation; val login = activeLogin; val setup = setupOrigin
            permissionAction = { if (foreground && generation == epoch && activeLogin === login && setupOrigin == setup) action() }
            setStatus("Allow Nearby devices so NearKey can use Bluetooth.")
            if (!permissionRequested) {
                permissionRequested = true
                bluetoothPermissions.launch(arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE))
            }
        }
    }

    private fun websiteDetails(site: ConnectedWebsite) {
        val connection = connections[site.origin]
        AlertDialog.Builder(this).setTitle(site.address)
            .setItems(arrayOf("Retry website connection", "Bluetooth setup", "Connection details", "Forget website")) { _, which ->
                when (which) {
                    0 -> connection?.retry()
                    1 -> { setupOrigin = site.origin; wizardStep = 3; status = ""; render() }
                    2 -> AlertDialog.Builder(this).setTitle("Connection details")
                        .setMessage("${site.origin}\n\n${connection?.status ?: "Offline"}\nBluetooth: $bluetoothStatus\n\n${key.backing()}\n\nKeep this app open for automatic verification.")
                        .setPositiveButton("Done", null).show()
                    3 -> AlertDialog.Builder(this).setTitle("Forget ${site.address}?")
                        .setMessage("Removes this website’s local phone credential. Its server enrollment stays in place and needs an offline server reset before you can pair again.")
                        .setNegativeButton("Keep website", null)
                        .setPositiveButton("Forget locally") { _, _ -> forget(site) }.show()
                }
            }.show()
    }

    private fun forget(site: ConnectedWebsite) {
        try {
            val next = websites.filter { it.origin != site.origin }
            store.save(next); websites = next
            connections.remove(site.origin)?.close()
            if (setupOrigin == site.origin) setupOrigin = null
            if (next.isEmpty()) {
                stopBluetooth("Website forgotten")
                wizardStep = 1; draft.clear(); manualOrigin = ""; manualCode = ""
                setupLoaded = false; manualExpanded = false
            }
            status = "Local website registration removed. Its server enrollment is unchanged."
            if (next.isEmpty()) {
                try { key.delete() } catch (_: Exception) { status += " The phone key could not be erased." }
            }
            render()
        } catch (e: Exception) { setStatus(e.message ?: "Could not forget this website") }
    }
}
