package dev.nearkey.passive

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Resume after unlock following reboot or an app upgrade; never bypass force-stop. */
class AuthenticatorBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)) return
        try {
            val prefs = context.getSharedPreferences("phone", Context.MODE_PRIVATE)
            val runtime = (context.applicationContext as NearKeyApplication).authenticator
            if (prefs.getBoolean("backgroundEnabled", true) && runtime.hasPermissions() &&
                WebsiteStore(prefs).load().any { it.setupComplete }) AuthenticatorService.start(context)
        } catch (_: Exception) {
            // OS restrictions or inaccessible credentials require opening the app again.
        }
    }
}
