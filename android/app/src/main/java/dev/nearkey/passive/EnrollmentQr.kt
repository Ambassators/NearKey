package dev.nearkey.passive

import okhttp3.HttpUrl
import java.io.ByteArrayOutputStream
import java.net.URI

data class EnrollmentSetup(val origin: HttpUrl, val pairingCode: String)

/** A QR code only prepares enrollment fields; it never enrolls or replaces a phone. */
object EnrollmentQr {
    fun parse(value: String, allowHttp: Boolean = BuildConfig.DEBUG): EnrollmentSetup {
        require(value.length in 1..4096 && value.all { it.code in 33..126 }) { "Invalid setup QR code" }
        val uri = try { URI(value) } catch (_: Exception) { error("Invalid setup QR code") }
        require(uri.scheme == "nearkey" && uri.rawAuthority == "enroll" &&
            uri.rawPath.isNullOrEmpty() && uri.rawFragment == null) { "Scan a NearKey setup QR code" }
        val parts = uri.rawQuery?.split('&') ?: error("Incomplete setup QR code")
        require(parts.size == 3) { "Unexpected setup QR fields" }
        val fields = mutableMapOf<String, String>()
        for (part in parts) {
            val separator = part.indexOf('=')
            require(separator > 0 && separator == part.lastIndexOf('=')) { "Invalid setup QR field" }
            val name = decode(part.substring(0, separator))
            require(name in setOf("v", "origin", "code") && !fields.containsKey(name)) { "Unexpected setup QR fields" }
            fields[name] = decode(part.substring(separator + 1))
        }
        require(fields["v"] == "1") { "Unsupported setup QR version" }
        val code = fields.getValue("code")
        require(code.matches(Regex("[A-Za-z0-9_-]{1,128}"))) { "Invalid pairing code in setup QR" }
        val origin = fields.getValue("origin")
        require(origin.length in 1..2048 && origin.all { it.code in 33..126 }) { "Invalid server origin in setup QR" }
        return EnrollmentSetup(PhoneOrigin.parse(origin, allowHttp), code)
    }

    private fun decode(value: String): String {
        val bytes = ByteArrayOutputStream()
        var index = 0
        while (index < value.length) {
            val char = value[index]
            if (char == '%') {
                require(index + 2 < value.length) { "Invalid setup QR encoding" }
                val high = value[index + 1].digitToIntOrNull(16)
                val low = value[index + 2].digitToIntOrNull(16)
                require(high != null && low != null) { "Invalid setup QR encoding" }
                bytes.write(high * 16 + low)
                index += 3
            } else {
                // Match encodeURIComponent rather than form encoding, where '+' means a space.
                bytes.write(char.code)
                index++
            }
        }
        return try { Protocol.utf8(bytes.toByteArray()) } catch (_: Exception) { error("Invalid setup QR encoding") }
    }
}
