package dev.nearkey.passive

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Shared origin policy for manual setup, QR setup, and every authenticated request. */
object PhoneOrigin {
    fun parse(value: String, allowHttp: Boolean = BuildConfig.DEBUG): HttpUrl {
        val url = try { value.trim().toHttpUrl() } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("Enter a valid HTTPS server origin; HTTP is supported only in debug builds")
        }
        require(url.isHttps || (allowHttp && url.scheme == "http")) {
            "HTTPS is required; cleartext HTTP is supported only in debug builds"
        }
        require(url.username.isEmpty() && url.password.isEmpty() && url.query == null &&
            url.fragment == null && url.encodedPath == "/") { "Enter a server origin only, without path or credentials" }
        return url
    }
}
