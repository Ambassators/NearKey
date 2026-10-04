package dev.nearkey.passive

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.ViewModelProvider
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    private val handler = Handler(Looper.getMainLooper())
    private val enrollmentApi by lazy { PhoneApi(this) }
    private val key = SigningKey()
    private val prefs by lazy { getSharedPreferences("phone", MODE_PRIVATE) }
    private val store by lazy { WebsiteStore(prefs) }
    private val draft by lazy { ViewModelProvider(this)[EnrollmentDraft::class.java] }
    private lateinit var ui: NearKeyUi
    private var websites = emptyList<ConnectedWebsite>()
    private val runtime by lazy { (application as NearKeyApplication).authenticator }
    private val connections get() = runtime.connections
    private val runtimeChanged: () -> Unit = {
        if (foreground) {
            ui.updateConnections(connectionStates())
            ui.updateLogin(loginDescription())
            if (runtime.status.isNotBlank()) setStatus(runtime.status)
            completeSetupIfReady()
        }
    }
    private var storageError = false
    private var foreground = false
    private var generation = 0
    private var enrolling = false
    private var wizardStep = 1 // 0 is the connected websites list.
    private var manualExpanded = false
    private var setupLoaded = false
    private var manualOrigin = ""
    private var manualCode = ""
    private var setupOrigin: String?
        get() = runtime.setupOrigin
        set(value) { runtime.setupOrigin = value }
    private val bluetoothReadyOrigin get() = runtime.bluetoothReadyOrigin
    private var status = ""
    private var permissionAction: (() -> Unit)? = null
    private var permissionRequested = false
    private var demoResetVisible = false
    private val shakeDetector = ShakeDetector()
    private val sensors by lazy { getSystemService(SENSOR_SERVICE) as SensorManager }
    private val shakeListener = object : SensorEventListener {
        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
        override fun onSensorChanged(event: SensorEvent) {
            if (!foreground || demoResetVisible) return
            if (shakeDetector.sample(event.values[0], event.values[1], event.values[2], event.timestamp / 1_000_000)) {
                demoResetVisible = true
                ui.showDemoReset(true, !enrolling, ::confirmDemoReset)
                ui.root.announceForAccessibility("reset demo button available")
            }
        }
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
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private fun ensureBackgroundService() {
        if (!foreground || storageError || websites.isEmpty() || !hasPermissions()) return
        try {
            prefs.edit().putBoolean("backgroundEnabled", true).apply()
            AuthenticatorService.start(this)
            if (Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean("notificationAsked", false)) {
                prefs.edit().putBoolean("notificationAsked", true).apply()
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        } catch (_: Exception) {
            setStatus("Background verification could not start. Check Bluetooth access and reopen NearKey.")
        }
    }

    private fun offerBackgroundSettings(always: Boolean = false) {
        if (!foreground) return
        val power = getSystemService(PowerManager::class.java)
        val allowed = power.isIgnoringBatteryOptimizations(packageName)
        if (!always && (allowed || prefs.getBoolean("batterySettingsOffered", false))) return
        prefs.edit().putBoolean("batterySettingsOffered", true).apply()
        AlertDialog.Builder(this).setTitle("Verify with the screen off")
            .setMessage(if (allowed)
                "Background verification is enabled. Keep Bluetooth and your network connected. The running notification lets you pause verification; reopen NearKey to resume. A powered-off phone or a force-stopped app cannot verify logins."
            else "Allow NearKey to run without battery optimization so website connections can receive login requests while the phone is idle. In battery settings, find NearKey and choose Don’t optimize or Unrestricted. Background Bluetooth verification uses extra battery. Keep Bluetooth and your network connected.")
            .setNegativeButton(if (allowed) "Done" else "Later", null)
            .apply {
                if (!allowed) setPositiveButton("Open battery settings") { _, _ ->
                    try {
                        startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                    } catch (_: Exception) {
                        setStatus("Open phone settings → Apps → NearKey → Battery and allow unrestricted background use.")
                    }
                }
            }.show()
    }

    private val ticker = object : Runnable {
        override fun run() {
            if (!foreground) return
            ui.updateLogin(loginDescription())
            handler.postDelayed(this, 250)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        demoResetVisible = savedInstanceState?.getBoolean("demoResetVisible") ?: false
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
        runtime.updateWebsites(websites)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (enrolling) return
                when {
                    wizardStep == 2 -> backFromWebsite()
                    wizardStep > 0 && websites.isNotEmpty() -> closeWizard()
                    else -> { isEnabled = false; onBackPressedDispatcher.onBackPressed(); isEnabled = true }
                }
            }
        })
        render()
        consumeEnrollmentIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt("wizardStep", wizardStep)
        outState.putBoolean("demoResetVisible", demoResetVisible)
        super.onSaveInstanceState(outState)
    }

    private fun render() {
        if (wizardStep == 0) {
            ui.websites(websites, connectionStates(), loginDescription(), status, ::beginSetup, ::websiteDetails)
        } else {
            ui.wizard(wizardStep, manualOrigin, manualCode, manualExpanded, setupLoaded, enrolling,
                foreground && !storageError, status, websites.isNotEmpty(),
                start = { wizardStep = 2; render() }, importKeys = ::showKeyImport, scan = ::scan,
                toggleManual = { manualExpanded = !manualExpanded; render() }, enroll = ::enroll,
                bluetooth = ::setupBluetooth,
                back = ::backFromWebsite,
                retry = { setupOrigin?.let { connections[it]?.retry() } },
                edit = { origin, code ->
                    manualOrigin = origin; manualCode = code
                    if (setupLoaded) { setupLoaded = false; draft.clear() }
                })
        }
        ui.showDemoReset(demoResetVisible, foreground && !enrolling, ::confirmDemoReset)
    }

    private fun confirmDemoReset() {
        if (!foreground || enrolling) return
        AlertDialog.Builder(this).setTitle("Reset demo?")
            .setMessage("Clear all website registrations and the key saved on this phone, then return to the first setup screen. Server pairing stays in place and requires an offline reset before pairing again.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Reset demo") { _, _ -> resetDemo() }.show()
    }

    private fun resetDemo() {
        if (!foreground || enrolling) return
        try {
            store.save(emptyList())
            generation++
            enrollmentApi.cancelRequests()
            setupOrigin = null; websites = emptyList()
            runtime.updateWebsites(emptyList())
            stopService(Intent(this, AuthenticatorService::class.java))
            draft.clear(); manualOrigin = ""; manualCode = ""
            setupLoaded = false; manualExpanded = false; storageError = false
            wizardStep = 1; demoResetVisible = false
            status = "Phone demo reset. Reset server pairing offline before pairing again."
            try { key.delete() } catch (_: Exception) { status += " The phone key could not be erased." }
            render()
        } catch (e: Exception) { setStatus(e.message ?: "Could not reset the demo") }
    }

    private fun showKeyImport() {
        AlertDialog.Builder(this)
            .setTitle("Import keys")
            .setMessage("Key import is not available yet.")
            .setPositiveButton("OK", null)
            .show()
    }

    private fun setStatus(message: String) { status = message; ui.updateStatus(message) }
    private fun connectionStates() = runtime.connectionStates()
    private fun loginDescription() = runtime.loginDescription()

    private fun beginSetup() {
        if (websites.size >= 30) { setStatus("You can connect up to 30 websites."); return }
        if (enrolling || storageError) return
        setupOrigin = null
        manualOrigin = ""; manualCode = ""; setupLoaded = false; manualExpanded = false; draft.clear()
        status = ""; wizardStep = 2; render()
    }

    private fun closeWizard() {
        if (enrolling || websites.isEmpty()) return
        draft.clear(); manualCode = ""; setupLoaded = false; manualExpanded = false
        wizardStep = 0; render()
    }

    private fun backFromWebsite() {
        if (enrolling) return
        if (setupLoaded || manualExpanded) {
            draft.clear()
            manualOrigin = ""; manualCode = ""; setupLoaded = false; manualExpanded = false
            status = ""; wizardStep = 2; render()
        } else if (websites.isEmpty()) {
            wizardStep = 1; render()
        } else {
            closeWizard()
        }
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
        runtime.observe(runtimeChanged)
        runtime.lifetime.attachUi()
        ensureBackgroundService()
        render()
        completeSetupIfReady()
    }

    override fun onResume() {
        super.onResume()
        if (runtime.lifetime.serviceRunning) runtime.setupBluetooth()
        shakeDetector.reset()
        sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let {
            sensors.registerListener(shakeListener, it, SensorManager.SENSOR_DELAY_GAME)
        }
    }

    override fun onPause() {
        sensors.unregisterListener(shakeListener)
        shakeDetector.reset()
        super.onPause()
    }

    override fun onStop() {
        foreground = false; generation++; permissionAction = null
        handler.removeCallbacks(ticker)
        runtime.removeObserver(runtimeChanged)
        runtime.lifetime.detachUi()
        enrollmentApi.cancelRequests()
        if (enrolling) status = "Setup interrupted. If the browser shows enrollment, perform an offline server reset before retrying."
        enrolling = false; render()
        super.onStop()
    }

    override fun onDestroy() {
        foreground = false; generation++; handler.removeCallbacks(ticker)
        enrollmentApi.close()
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
                if (result == null) {
                    status = error ?: "Enrollment failed"
                    render()
                    return@post
                }
                try {
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
                    runtime.updateWebsites(websites)
                    ensureBackgroundService()
                } catch (e: Exception) {
                    status = "${e.message ?: "Enrollment failed"}. If your browser already shows enrollment, perform an offline server reset before retrying."
                }
                render()
            } }
        } catch (e: Exception) {
            enrolling = false
            status = e.message ?: "Enrollment failed"
            render()
        }
    }

    private fun setupBluetooth() {
        if (!foreground || setupOrigin == null) return
        val site = connections[setupOrigin] ?: return
        if (!site.online) {
            setStatus("Connecting to your website. Bluetooth setup will wait for the authenticated connection.")
            site.retry()
        }
        withPermissions {
            ensureBackgroundService()
            runtime.setupBluetooth()
        }
    }

    private fun completeSetupIfReady() {
        val origin = setupOrigin ?: return
        if (wizardStep != 3 || bluetoothReadyOrigin != origin || connections[origin]?.online != true) return
        try {
            val next = websites.map { if (it.origin == origin) it.copy(setupComplete = true) else it }
            store.save(next); websites = next
            setupOrigin = null; wizardStep = 0
            runtime.updateWebsites(websites)
            status = "Website connected. Continue in your browser to finish signing in."
            render()
            offerBackgroundSettings()
        } catch (e: Exception) { setStatus(e.message ?: "Cannot save setup completion. Retry Bluetooth setup.") }
    }

    private fun hasPermissions() = runtime.hasPermissions()

    private fun withPermissions(action: () -> Unit) {
        if (!foreground) return
        if (hasPermissions()) action()
        else {
            val epoch = generation; val setup = setupOrigin
            permissionAction = { if (foreground && generation == epoch && setupOrigin == setup) action() }
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
            .setItems(arrayOf("Retry website connection", "Bluetooth setup", "Connection details", "Background settings", "Forget website")) { _, which ->
                when (which) {
                    0 -> connection?.retry()
                    1 -> { setupOrigin = site.origin; wizardStep = 3; status = ""; render() }
                    2 -> AlertDialog.Builder(this).setTitle("Connection details")
                        .setMessage("${site.origin}\n\n${connection?.status ?: "Offline"}\nBluetooth: ${runtime.bluetoothStatus}\n\n${key.backing()}\n\nVerification continues in the background and with the screen off.")
                        .setPositiveButton("Done", null).show()
                    3 -> offerBackgroundSettings(always = true)
                    4 -> AlertDialog.Builder(this).setTitle("Forget ${site.address}?")
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
            runtime.updateWebsites(websites)
            if (setupOrigin == site.origin) setupOrigin = null
            if (next.isEmpty()) {
                stopService(Intent(this, AuthenticatorService::class.java))
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
