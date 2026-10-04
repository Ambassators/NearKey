package dev.nearkey.passive

import androidx.lifecycle.ViewModel

/** Keeps reviewed QR setup across rotation only. Pairing codes never enter saved state or disk. */
class EnrollmentDraft : ViewModel() {
    var setup: EnrollmentSetup? = null
        private set

    fun load(value: String): EnrollmentSetup {
        val validated = EnrollmentQr.parse(value)
        setup = validated
        return validated
    }

    fun clear() { setup = null }

    override fun onCleared() { clear() }
}
