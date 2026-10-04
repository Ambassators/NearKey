package dev.nearkey.passive

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class EnrollmentQrTest {
    private fun payload(origin: String = "https%3A%2F%2Fexample.com", code: String = "pairing_code-123") =
        "nearkey://enroll?v=1&origin=$origin&code=$code"

    private fun rejects(value: String, allowHttp: Boolean = false) {
        assertThrows(Exception::class.java) { EnrollmentQr.parse(value, allowHttp) }
    }

    @Test fun validHttpsAndDebugHttpPopulateOnlySetupValues() {
        val setup = EnrollmentQr.parse(payload(), false)
        assertEquals("https://example.com/", setup.origin.toString())
        assertEquals("pairing_code-123", setup.pairingCode)
        assertEquals("http://127.0.0.1:5173/", EnrollmentQr.parse(
            payload("http%3A%2F%2F127.0.0.1%3A5173"), true).origin.toString())
        rejects(payload("http%3A%2F%2F127.0.0.1%3A5173"))
        assertEquals("https://example.com:8443/", EnrollmentQr.parse(
            payload("https%3A%2F%2Fexample.com%3A8443%2F"), false).origin.toString())
    }

    @Test fun exactTargetAndVersionRequired() {
        for (value in listOf(payload().replace("nearkey:", "https:"),
            payload().replace("enroll?", "other?"), payload().replace("enroll?", "enroll/?"),
            payload().replace("enroll?", "user@enroll?"), payload().replace("enroll?", "enroll:123?"),
            payload() + "#fragment", payload().replace("v=1", "v=2"),
            payload().replace("v=1", "v=01"), payload().replace("v=1", "v="))) rejects(value)
    }

    @Test fun duplicateMissingAndAdditionalParametersRejected() {
        for (value in listOf(payload() + "&v=1", payload() + "&action=enroll",
            payload().replace("v=1&", ""), payload().replace("&code=pairing_code-123", ""),
            payload().replace("origin=", "code="), payload().replace("origin=", "%63ode="),
            payload() + "&", payload().replace("v=1", "v=1=1"))) rejects(value)
    }

    @Test fun credentialsPathsQueriesAndFragmentsCannotEnterServerOrigin() {
        for (origin in listOf("https%3A%2F%2Fuser%3Apass%40example.com",
            "https%3A%2F%2Fexample.com%2Fapi", "https%3A%2F%2Fexample.com%3Fx%3Dy",
            "https%3A%2F%2Fexample.com%23x", "ftp%3A%2F%2Fexample.com",
            "", "https%3A%2F%2Fexample.com%0A", "https%3A%2F%2Fexample.com%20")) rejects(payload(origin))
    }

    @Test fun malformedEncodingUnsafeCodesAndOversizedPayloadsRejected() {
        for (code in listOf("", "x%0Ay", "x%0Dy", "x%00y", "x+y", "x%20y", "x%26y",
            "%C0%AF", "%FF", "%", "%2G", "x".repeat(129))) rejects(payload(code = code))
        rejects(" " + payload())
        rejects(payload() + "\n")
        rejects(payload("x".repeat(4100)))
        rejects(payload("https%3A%2F%2F" + "x".repeat(2050)))
    }

    @Test fun orderedOrEncodedFieldsKeepSameMeaningWithoutFormDecoding() {
        val setup = EnrollmentQr.parse("nearkey://enroll?code=pairing%5Fcode-123&origin=https%3a%2f%2fexample.com&v=1", false)
        assertEquals("pairing_code-123", setup.pairingCode)
        assertEquals("https://example.com/", setup.origin.toString())
    }
}
