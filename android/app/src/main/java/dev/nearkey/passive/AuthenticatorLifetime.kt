package dev.nearkey.passive

/** UI visibility and foreground-service ownership are independent lifetimes. */
class AuthenticatorLifetime(private val start: () -> Unit, private val stop: () -> Unit) {
    private var visibleClients = 0
    var serviceRunning = false
        private set
    var running = false
        private set

    fun attachUi() { visibleClients++; reconcile() }
    fun detachUi() { check(visibleClients > 0); visibleClients--; reconcile() }
    fun serviceStarted() { serviceRunning = true; reconcile() }
    fun serviceStopped() { serviceRunning = false; reconcile() }

    private fun reconcile() {
        val next = visibleClients > 0 || serviceRunning
        if (next == running) return
        running = next
        if (next) start() else stop()
    }
}
