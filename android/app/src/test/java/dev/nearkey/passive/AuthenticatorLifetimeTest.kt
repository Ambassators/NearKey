package dev.nearkey.passive

import org.junit.Assert.*
import org.junit.Test

class AuthenticatorLifetimeTest {
    @Test fun screenOffAndClosingTheScreenKeepServiceOwnedConnectionsAlive() {
        val events = mutableListOf<String>()
        val lifetime = AuthenticatorLifetime({ events.add("start") }, { events.add("stop") })
        lifetime.attachUi()
        lifetime.serviceStarted()
        lifetime.detachUi() // Home, screen lock, Back, or task removal.
        assertTrue(lifetime.running)
        assertEquals(listOf("start"), events)
        lifetime.attachUi() // Reopening must not reconnect sockets or replace the GATT server.
        lifetime.detachUi()
        assertEquals(listOf("start"), events)
        lifetime.serviceStopped()
        assertFalse(lifetime.running)
        assertEquals(listOf("start", "stop"), events)
    }

    @Test fun rotationRetainsServiceOwnershipAndDoesNotDuplicateConnections() {
        var starts = 0
        var stops = 0
        val lifetime = AuthenticatorLifetime({ starts++ }, { stops++ })
        lifetime.serviceStarted()
        lifetime.serviceStarted() // Repeated start commands are idempotent.
        lifetime.attachUi()
        lifetime.attachUi()
        lifetime.detachUi()
        lifetime.detachUi()
        assertEquals(1, starts)
        assertEquals(0, stops)
    }

    @Test fun setupWithoutServiceStopsWhenTheLastScreenLeaves() {
        val events = mutableListOf<String>()
        val lifetime = AuthenticatorLifetime({ events.add("start") }, { events.add("stop") })
        lifetime.attachUi()
        lifetime.detachUi()
        assertEquals(listOf("start", "stop"), events)
        assertFalse(lifetime.running)
    }

    @Test fun serviceRestartResumesWithoutAnyActivity() {
        val events = mutableListOf<String>()
        val lifetime = AuthenticatorLifetime({ events.add("start") }, { events.add("stop") })
        lifetime.serviceStarted()
        lifetime.serviceStopped()
        lifetime.serviceStarted()
        assertTrue(lifetime.running)
        assertEquals(listOf("start", "stop", "start"), events)
    }
}
