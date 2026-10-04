package dev.nearkey.passive

import org.junit.Assert.*
import org.junit.Test

class LocalNetworkTest {
    @Test fun onlyPrivateIpv4UsesWifiTransport() {
        for (host in listOf("10.0.0.1", "172.16.7.150", "172.31.255.255", "192.168.1.1")) {
            assertTrue(host, LocalNetwork.isPrivateIpv4(host))
        }
        // Loopback must retain adb reverse; public HTTPS retains the normal network route.
        for (host in listOf("localhost", "127.0.0.1", "::1", "auth.example", "8.8.8.8",
            "172.15.1.1", "172.32.1.1", "192.169.1.1", "10.0.0.256", "10.0.0", "10.a.0.1")) {
            assertFalse(host, LocalNetwork.isPrivateIpv4(host))
        }
    }
}
