package dev.nearkey.passive

import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import org.junit.Assert.*
import org.junit.Test

class EnrollmentDraftTest {
    private val uri = "nearkey://enroll?v=1&origin=https%3A%2F%2Fexample.com&code=qr_lifecycle_probe"

    @Test fun activityRecreationKeepsValidatedSetupUntilStoreIsCleared() {
        val store = ViewModelStore()
        val factory = ViewModelProvider.NewInstanceFactory()
        val first = ViewModelProvider(store, factory)[EnrollmentDraft::class.java]
        val setup = first.load(uri)
        val recreated = ViewModelProvider(store, factory)[EnrollmentDraft::class.java]
        assertSame(first, recreated)
        assertEquals(setup, recreated.setup)
        store.clear()
        assertNull(first.setup)
    }

    @Test fun malformedScanCannotReplaceAValidatedDraftAndExplicitClearRemovesIt() {
        val draft = EnrollmentDraft()
        val setup = draft.load(uri)
        assertThrows(Exception::class.java) { draft.load(uri + "&unexpected=1") }
        assertEquals(setup, draft.setup)
        draft.clear()
        assertNull(draft.setup)
    }
}
