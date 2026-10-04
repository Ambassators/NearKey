package dev.nearkey.passive

/** Only literal private IPv4 destinations use the Wi-Fi demo transport. */
object LocalNetwork {
    const val WIFI_REQUIRED = "Connect this phone to the same Wi-Fi network as your computer, then retry the website connection. Cellular data cannot reach this local website."
    const val UNREACHABLE = "Cannot reach the website over Wi-Fi. Check that both devices are on the same network and the computer's Wi-Fi server is running. If the network blocks devices from connecting to each other, use a shared hotspot."

    fun isPrivateIpv4(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4 || parts.any { !it.matches(Regex("[0-9]{1,3}")) || it.toInt() > 255 }) return false
        val a = parts[0].toInt(); val b = parts[1].toInt()
        return a == 10 || a == 192 && b == 168 || a == 172 && b in 16..31
    }
}
