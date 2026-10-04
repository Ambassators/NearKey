package dev.nearkey.passive

import android.content.SharedPreferences
import java.lang.reflect.Proxy
import org.junit.Assert.*
import org.junit.Test

class WebsiteStoreTest {
    @Test fun upgradeMigratesTheOriginalEnrollmentWithoutLosingItsCredential() {
        val disk = MemoryPreferences(mutableMapOf("origin" to "https://one.example", "phoneId" to "phone-one", "token" to "secret"))
        val sites = WebsiteStore(disk.preferences).load()
        assertEquals(listOf(ConnectedWebsite("https://one.example/", "phone-one", "secret", true)), sites)
        assertEquals(sites, WebsiteStore(disk.preferences).load())
        assertFalse(disk.values.containsKey("token"))
        assertFalse(disk.values.containsKey("phoneId"))
    }

    @Test fun failedMigrationKeepsTheOriginalRegistrationRecoverable() {
        val original = mutableMapOf("origin" to "https://one.example", "phoneId" to "phone-one", "token" to "secret")
        val disk = MemoryPreferences(original.toMutableMap(), commitsSucceed = false)
        assertThrows(IllegalStateException::class.java) { WebsiteStore(disk.preferences).load() }
        assertEquals(original, disk.values)
    }

    @Test fun addingAndForgettingAWebsitePreservesOtherRegistrations() {
        val disk = MemoryPreferences()
        val store = WebsiteStore(disk.preferences)
        val first = ConnectedWebsite("https://one.example/", "phone-one", "first-secret", true)
        val second = ConnectedWebsite("https://two.example/", "phone-two", "second-secret")
        store.save(listOf(first)); store.save(store.load() + second)
        assertEquals(listOf(first, second), store.load())
        store.save(store.load().filter { it.origin != second.origin })
        assertEquals(listOf(first), store.load())
        store.save(emptyList())
        assertTrue(store.load().isEmpty())
    }

    @Test fun anInvalidNewRegistrationCannotOverwriteSavedWebsites() {
        val disk = MemoryPreferences()
        val store = WebsiteStore(disk.preferences)
        val first = ConnectedWebsite("https://one.example/", "phone-one", "secret", true)
        store.save(listOf(first))
        assertThrows(IllegalArgumentException::class.java) { store.save(listOf(first, first)) }
        assertEquals(listOf(first), store.load())
    }

    /** Models atomic commit failure without invoking Android's stubbed storage implementation. */
    private class MemoryPreferences(val values: MutableMap<String, String> = mutableMapOf(), val commitsSucceed: Boolean = true) {
        val preferences = Proxy.newProxyInstance(SharedPreferences::class.java.classLoader,
            arrayOf(SharedPreferences::class.java)) { _, method, args ->
            when (method.name) {
                "getString" -> values[args!![0]] ?: args[1]
                "edit" -> editor()
                else -> error("Unexpected storage operation ${method.name}")
            }
        } as SharedPreferences
        private fun editor(): SharedPreferences.Editor {
            val changes = values.toMutableMap()
            lateinit var proxy: SharedPreferences.Editor
            proxy = Proxy.newProxyInstance(SharedPreferences.Editor::class.java.classLoader,
                arrayOf(SharedPreferences.Editor::class.java)) { _, method, args ->
                when (method.name) {
                    "putString" -> { changes[args!![0] as String] = args[1] as String; proxy }
                    "remove" -> { changes.remove(args!![0]); proxy }
                    "commit" -> {
                        if (commitsSucceed) { values.clear(); values.putAll(changes) }
                        commitsSucceed
                    }
                    else -> error("Unexpected editor operation ${method.name}")
                }
            } as SharedPreferences.Editor
            return proxy
        }
    }
}
