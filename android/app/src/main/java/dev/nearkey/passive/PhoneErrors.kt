package dev.nearkey.passive

import org.json.JSONObject

/** Fixed messages only: never expose server-provided messages, bodies, or credential fields. */
object PhoneErrors {
    fun response(status: Int, body: ByteArray?): String {
        val code = try {
            if (body == null || body.size > 8192) null
            else JSONObject(Protocol.utf8(body)).opt("error") as? String
        } catch (_: Exception) { null }
        return when {
            status == 401 && code == "invalid_pairing" ->
                "This setup QR code expired or was replaced. Refresh the QR code in your browser, scan it again, then tap Enroll phone"
            status == 409 && code == "phone_exists" ->
                "This server already has an enrolled phone. A setup QR code cannot replace it. Use the enrolled phone or ask for a server reset"
            status == 429 && code == "rate_limited" ->
                "Too many attempts. Wait a minute, refresh the setup QR code, then try again"
            else -> "Server rejected request (HTTP $status)"
        }
    }
}
