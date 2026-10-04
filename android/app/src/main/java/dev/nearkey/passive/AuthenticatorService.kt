package dev.nearkey.passive

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/** A visible, user-stoppable connected-device service owns screen-off verification. */
class AuthenticatorService : Service() {
    private val runtime get() = (application as NearKeyApplication).authenticator
    private var wakeLock: PowerManager.WakeLock? = null
    private var lastNotificationText: String? = null
    private val changed: () -> Unit = { updateNotification() }

    override fun onBind(intent: Intent?): IBinder? = null

    @SuppressLint("WakelockTimeout") // Continuous Bluetooth callback handling; released with service ownership.
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_PAUSE) {
            getSharedPreferences("phone", MODE_PRIVATE).edit().putBoolean("backgroundEnabled", false).apply()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            val sites = WebsiteStore(getSharedPreferences("phone", MODE_PRIVATE)).load()
            if (sites.isEmpty() || !runtime.hasPermissions() ||
                !getSharedPreferences("phone", MODE_PRIVATE).getBoolean("backgroundEnabled", true)) {
                stopSelf()
                return START_NOT_STICKY
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Background login verification", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shows when NearKey is available over Bluetooth with the screen off."
                    setShowBadge(false)
                })
            val notification = notification("Connecting to your websites")
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
            } else startForeground(NOTIFICATION_ID, notification)
            if (wakeLock == null) {
                wakeLock = getSystemService(PowerManager::class.java)
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NearKey:BluetoothVerification").apply {
                        setReferenceCounted(false)
                        acquire()
                    }
            }
            runtime.updateWebsites(sites)
            runtime.observe(changed)
            runtime.lifetime.serviceStarted()
            updateNotification()
            return START_STICKY
        } catch (_: Exception) {
            runtime.reportError("Background verification could not start. Open NearKey and check Bluetooth access.")
            stopSelf()
            return START_NOT_STICKY
        }
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val pause = PendingIntent.getService(this, 1, Intent(this, AuthenticatorService::class.java).setAction(ACTION_PAUSE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_key)
            .setContentTitle("NearKey is running").setContentText(text)
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .addAction(Notification.Action.Builder(null, "Pause", pause).build()).build()
    }

    private fun updateNotification() {
        if (!runtime.lifetime.serviceRunning) return
        val online = runtime.connections.values.count { it.online }
        val text = if (online > 0) "Ready over Bluetooth · screen can stay off" else "Waiting for website connection"
        if (lastNotificationText == text) return
        lastNotificationText = text
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    override fun onDestroy() {
        runtime.removeObserver(changed)
        runtime.lifetime.serviceStopped()
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "nearkey_verification"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_PAUSE = "dev.nearkey.passive.PAUSE_VERIFICATION"

        fun start(context: Context) {
            context.startForegroundService(Intent(context, AuthenticatorService::class.java))
        }
    }
}
