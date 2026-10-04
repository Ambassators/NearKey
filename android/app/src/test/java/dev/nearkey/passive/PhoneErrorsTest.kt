package dev.nearkey.passive

import org.junit.Assert.*
import org.junit.Test

class PhoneErrorsTest {
    @Test fun expiredOrReplacedPairingHasFixedFreshQrInstructions() {
        val body = """{"error":"invalid_pairing","message":"secret-token-never-render","pairingCode":"secret-code"}""".toByteArray()
        val message = PhoneErrors.response(401, body)
        assertTrue(message.contains("Refresh the QR code"))
        assertTrue(message.contains("tap Enroll phone"))
        assertFalse(message.contains("secret"))
    }

    @Test fun phoneExistsDoesNotSuggestOverwritingExistingEnrollment() {
        val message = PhoneErrors.response(409, """{"error":"phone_exists"}""".toByteArray())
        assertTrue(message.contains("cannot replace"))
        assertTrue(message.contains("enrolled phone"))
    }

    @Test fun unknownMalformedOversizedOrWrongStatusErrorsNeverEchoServerBodies() {
        for (body in listOf(null, byteArrayOf(0xff.toByte()), "not-json-secret".toByteArray(),
            """{"error":"unexpected_secret","message":"secret"}""".toByteArray(),
            """{"error":"invalid_pairing"}""".toByteArray(), ByteArray(8193))) {
            assertEquals("Server rejected request (HTTP 500)", PhoneErrors.response(500, body))
        }
        assertEquals("Server rejected request (HTTP 401)", PhoneErrors.response(401, ByteArray(8193)))
    }
}
