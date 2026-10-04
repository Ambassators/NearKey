package dev.nearkey.passive

import android.app.Application

class NearKeyApplication : Application() {
    // Never retain an Activity: the service and replacement screens share one authenticator.
    val authenticator by lazy { AuthenticatorRuntime(this) }
}
