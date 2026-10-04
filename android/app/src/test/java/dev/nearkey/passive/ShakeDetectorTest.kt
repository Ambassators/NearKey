package dev.nearkey.passive

import org.junit.Assert.*
import org.junit.Test

class ShakeDetectorTest {
    private val detector = ShakeDetector()

    private fun peak(time: Long): Boolean {
        detector.sample(0f, 0f, 9.80665f, time - 1)
        return detector.sample(30f, 0f, 0f, time)
    }

    @Test fun threeQuickPeaksDetectAShakeInAnyDirection() {
        assertFalse(peak(100))
        detector.sample(0f, 0f, 9.80665f, 299)
        assertFalse(detector.sample(0f, -30f, 0f, 300))
        detector.sample(0f, 0f, 9.80665f, 499)
        assertTrue(detector.sample(0f, 0f, 30f, 500))
    }

    @Test fun normalMotionAndOneSustainedBumpDoNotDetectAShake() {
        for (time in 0L..1000L step 20) assertFalse(detector.sample(5f, 5f, 9.8f, time))
        for (time in 1100L..1500L step 20) assertFalse(detector.sample(30f, 0f, 0f, time))
    }

    @Test fun separatedBumpsAndVeryFastSamplesDoNotAccumulate() {
        assertFalse(peak(100)); assertFalse(peak(120)); assertFalse(peak(140))
        assertFalse(peak(1100)); assertFalse(peak(2100))
    }

    @Test fun cooldownAndLifecycleResetDiscardPreviousPeaks() {
        assertFalse(peak(100)); assertFalse(peak(300)); assertTrue(peak(500))
        assertFalse(peak(700)); assertFalse(peak(900)); assertFalse(peak(1100))
        detector.reset()
        assertFalse(peak(1500)); assertFalse(peak(1700))
        detector.reset()
        assertFalse(peak(1900)); assertFalse(peak(2100)); assertTrue(peak(2300))
    }
}
