package dev.nearkey.passive

import kotlin.math.sqrt

/** Requires three distinct acceleration peaks, so a single bump does not reveal reset. */
class ShakeDetector {
    private var peaks = 0
    private var firstPeak = 0L
    private var lastPeak: Long? = null
    private var aboveThreshold = false
    private var cooldownUntil = 0L

    fun reset() {
        peaks = 0; firstPeak = 0L; lastPeak = null
        aboveThreshold = false; cooldownUntil = 0L
    }

    fun sample(x: Float, y: Float, z: Float, timeMillis: Long): Boolean {
        val force = sqrt(x * x + y * y + z * z) / 9.80665f
        if (force < 1.5f) aboveThreshold = false
        if (force < 2.5f || aboveThreshold || timeMillis < cooldownUntil) return false
        aboveThreshold = true
        if (lastPeak?.let { timeMillis - it < 100 } == true) return false
        if (peaks == 0 || timeMillis - firstPeak > 800) {
            peaks = 0; firstPeak = timeMillis
        }
        lastPeak = timeMillis
        peaks++
        if (peaks < 3) return false
        peaks = 0
        cooldownUntil = timeMillis + 1_000
        return true
    }
}
