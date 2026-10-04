package dev.nearkey.passive

import org.junit.Assert.*
import org.junit.Test

class WebsiteRecordsTest {
    @Test fun preservesAllRegistrationsAndSetupProgress() {
        val websites = listOf(ConnectedWebsite("https://one.example/", "phone-one", "token-one", true),
            ConnectedWebsite("https://two.example:8443/", "phone-two", "token-two", false))
        assertEquals(websites, WebsiteRecords.decode(WebsiteRecords.encode(websites)))
        assertEquals("two.example:8443", websites[1].address)
        assertEquals("one.example", websites[0].address)
    }
    @Test fun olderRecordsDefaultToCompletedSetup() {
        val record = """[{"origin":"https://one.example","phoneId":"phone-one","token":"token-one"}]"""
        assertTrue(WebsiteRecords.decode(record).single().setupComplete)
        assertEquals("https://one.example/", WebsiteRecords.decode(record).single().origin)
    }
    @Test fun rejectsDuplicateOriginsAfterNormalization() {
        rejects(listOf(ConnectedWebsite("https://one.example", "a", "a"), ConnectedWebsite("https://one.example/", "b", "b")))
    }
    @Test fun rejectsUnsafeSavedCredentialsAndOrigins() {
        rejects(listOf(ConnectedWebsite("https://one.example/", "phone", "bad\ntoken")))
        rejects(listOf(ConnectedWebsite("https://one.example/", "", "token")))
        rejects(listOf(ConnectedWebsite("https://one.example/path", "phone", "token")))
        rejects(listOf(ConnectedWebsite("https://user:pass@one.example/", "phone", "token")))
    }
    @Test fun rejectsMoreThanThirtyWebsites() {
        rejects((1..31).map { ConnectedWebsite("https://$it.example/", "phone-$it", "token-$it") })
    }
    private fun rejects(websites: List<ConnectedWebsite>) {
        try { WebsiteRecords.decode(WebsiteRecords.encode(websites)); fail("Expected invalid registration rejection") }
        catch (_: IllegalArgumentException) { }
    }
}
