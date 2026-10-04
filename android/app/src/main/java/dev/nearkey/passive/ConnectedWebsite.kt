package dev.nearkey.passive

import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/** Registrations are local to this phone. Pairing codes are never persisted. */
data class ConnectedWebsite(
    val origin: String,
    val phoneId: String,
    val token: String,
    val setupComplete: Boolean = false
) {
    val address: String get() = PhoneOrigin.parse(origin).let {
        it.host + if (it.port == (if (it.isHttps) 443 else 80)) "" else ":${it.port}"
    }
}

object WebsiteRecords {
    fun encode(websites: List<ConnectedWebsite>): String = JSONArray().apply {
        websites.forEach { site -> put(JSONObject().put("origin", site.origin)
            .put("phoneId", site.phoneId).put("token", site.token)
            .put("setupComplete", site.setupComplete)) }
    }.toString()

    fun decode(value: String): List<ConnectedWebsite> {
        val records = JSONArray(value)
        require(records.length() <= 30) { "Too many connected websites" }
        val origins = mutableSetOf<String>()
        return (0 until records.length()).map { index ->
            val record = records.getJSONObject(index)
            val origin = PhoneOrigin.parse(record.getString("origin")).toString()
            val id = record.getString("phoneId")
            val token = record.getString("token")
            require(id.isNotBlank() && id.length <= 128 && token.isNotEmpty() &&
                token.length <= 1024 && token.all { it.code in 33..126 } && origins.add(origin)) {
                "Invalid saved website registration"
            }
            ConnectedWebsite(origin, id, token, record.optBoolean("setupComplete", true))
        }
    }
}

class WebsiteStore(private val prefs: SharedPreferences) {
    fun load(): List<ConnectedWebsite> {
        prefs.getString("websites", null)?.let { return WebsiteRecords.decode(it) }
        // Preserve enrollment when upgrading from the original one-website app.
        val token = prefs.getString("token", null) ?: return emptyList()
        val legacy = ConnectedWebsite(prefs.getString("origin", "")!!,
            prefs.getString("phoneId", "")!!, token, setupComplete = true)
        val migrated = WebsiteRecords.decode(WebsiteRecords.encode(listOf(legacy)))
        save(migrated)
        return migrated
    }

    fun save(websites: List<ConnectedWebsite>) {
        val value = WebsiteRecords.encode(websites)
        WebsiteRecords.decode(value)
        check(prefs.edit().putString("websites", value).remove("origin").remove("phoneId")
            .remove("token").commit()) { "Cannot save website registration" }
    }
}
