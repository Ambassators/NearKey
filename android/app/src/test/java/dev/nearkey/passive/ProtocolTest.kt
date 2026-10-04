package dev.nearkey.passive

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec

class ProtocolTest {
    private val id = "c95a3bc8-b185-48df-90dd-b5d3b0238f54"
    private val nonce = Protocol.base64(ByteArray(32))
    private val now = 1_700_000_000_000L
    private fun json() = JSONObject().put("v", 2).put("id", id).put("nonce", nonce)
        .put("phoneId", "phone-1").put("expiresAt", now + 60_000)
        .put("purpose", "login").put("username", "demo").put("serviceName", "NearKey")
        .put("sessionId", "session-1")
    private fun challenge() = Protocol.challenge(json(), "phone-1", now)
    private fun request() = JSONObject().put("v", 2).put("type", "prove").put("challengeId", id).put("nonce", nonce)
    private fun rejects(action: () -> Unit) { assertThrows(Exception::class.java) { action() } }

    @Test fun exactUtf8DomainSeparation() {
        assertEquals("NEARKEY-LOGIN-V2\n$id\n$nonce\nphone-1\n${now + 60_000}\ndemo\nNearKey\nsession-1", Protocol.approvalText(challenge()))
        assertEquals("NEARKEY-ENROLL-V1\ncode\nspki", Protocol.enrollmentText("code", "spki"))
        assertFalse(Protocol.approvalText(challenge()).endsWith("\n"))
        assertEquals("café ☕", Protocol.utf8("café ☕".toByteArray(Charsets.UTF_8)))
        rejects { Protocol.utf8(byteArrayOf(0xc0.toByte(), 0xaf.toByte())) }
    }

    @Test fun challengeMatchesServerState() {
        val c = challenge()
        assertEquals(id, c.id)
        assertEquals("demo", c.username)
        assertEquals("NearKey", c.serviceName)
        assertEquals("session-1", c.sessionId)
        Protocol.checkRequest(request().toString().toByteArray(), c, now)
    }

    @Test fun rejectInvalidServerChallenges() {
        for (bad in listOf(json().put("v", 1), json().put("v", 1.5), json().put("phoneId", "other"),
            json().put("id", "not-a-uuid"), json().put("nonce", nonce + "="),
            json().put("nonce", "A".repeat(42) + "B"), json().put("expiresAt", now),
            json().put("expiresAt", now + 60_001), json().put("expiresAt", "1700000060000"),
            json().put("purpose", "transfer"), json().put("username", "demo\nother"),
            json().put("serviceName", ""), json().put("sessionId", "session\nother"),
            json().put("operation", JSONObject()))) {
            rejects { Protocol.challenge(bad, "phone-1", now) }
        }
    }

    @Test fun setupAndExpiredNeverSign() {
        rejects { Protocol.checkRequest(request().toString().toByteArray(), null, now) }
        rejects { Protocol.checkRequest(request().toString().toByteArray(), challenge(), now + 60_000) }
    }

    @Test fun wrongVersionIdNonceTypeAndFieldsRejected() {
        for (bad in listOf(request().put("v", 1), request().put("v", "2"), request().put("type", "approve"),
            request().put("challengeId", "another"), request().put("nonce", Protocol.base64(ByteArray(32) { 1 })),
            request().put("amountCents", 1), request().apply { remove("nonce") })) {
            rejects { Protocol.checkRequest(bad.toString().toByteArray(), challenge(), now) }
        }
        rejects { Protocol.checkRequest("not JSON".toByteArray(), challenge(), now) }
    }

    @Test fun twentyByteChunkAssembly() {
        val expected = request().toString().toByteArray(Charsets.UTF_8)
        val wire = expected + byteArrayOf(10)
        val buffer = RequestBuffer()
        var frame: ByteArray? = null
        for (chunk in wire.toList().chunked(20)) frame = buffer.append(chunk.toByteArray())
        assertArrayEquals(expected, frame)
        rejects { buffer.append(byteArrayOf(10)) }
        buffer.clear()
        assertArrayEquals(byteArrayOf(123, 125), buffer.append(byteArrayOf(123, 125, 10)))
    }

    @Test fun assemblyBoundsAndTermination() {
        rejects { RequestBuffer().append(ByteArray(21)) }
        rejects { RequestBuffer().append(byteArrayOf()) }
        rejects { RequestBuffer().append(byteArrayOf(10, 123)) }
        val max = RequestBuffer()
        repeat(51) { assertNull(max.append(ByteArray(20) { 65 })) }
        assertEquals(1023, max.append(byteArrayOf(65, 65, 65, 10))!!.size)
        val tooLarge = RequestBuffer()
        repeat(51) { tooLarge.append(ByteArray(20) { 65 }) }
        rejects { tooLarge.append(ByteArray(5) { 65 }) }
    }

    @Test fun longReadReassemblesAtDefaultAndLargerMtu() {
        val proof = Protocol.proof(challenge(), Protocol.base64(ByteArray(72) { it.toByte() }))
        val parsed = JSONObject(Protocol.utf8(proof))
        assertEquals(2L, Protocol.integer(parsed, "v"))
        assertEquals(id, parsed.getString("challengeId"))
        for (mtu in listOf(23, 40, 185, 517)) {
            var offset = 0
            val output = ArrayList<Byte>()
            do {
                // Android clips the app response using the link's negotiated
                // MTU; the client stops on a short packet, even for invalid JSON.
                val slice = proofReadResponse(proof, offset).take(mtu - 1)
                output.addAll(slice.toList())
                offset += slice.size
            } while (slice.size == mtu - 1)
            assertArrayEquals(proof, output.toByteArray())
            assertEquals(0, proofReadResponse(proof, offset).size)
        }
        rejects { proofReadResponse(proof, -1) }
        rejects { proofReadResponse(proof, proof.size + 1) }
        rejects { proofReadResponse(ByteArray(513), 0) }
    }

    @Test fun exactMultipleLongReadHasEmptyTerminalResponse() {
        val proof = ByteArray(44) { it.toByte() }
        assertEquals(22, proofReadResponse(proof, 0).take(22).size)
        assertEquals(22, proofReadResponse(proof, 22).take(22).size)
        assertEquals(0, proofReadResponse(proof, 44).size)
    }

    @Test fun jvmP256DerVectorsForNodeContractVerification() {
        // JVM crypto compatibility test, NOT an Android Keystore or hardware test.
        val pair = KeyPairGenerator.getInstance("EC").apply {
            initialize(ECGenParameterSpec("secp256r1"))
        }.generateKeyPair()
        val publicKey = Protocol.base64(pair.public.encoded)
        val code = "fixture-enrollment-code-not-live"
        val approval = Protocol.approvalText(challenge())
        val enrollment = Protocol.enrollmentText(code, publicKey)
        fun sign(text: String) = Signature.getInstance("SHA256withECDSA").run {
            initSign(pair.private); update(text.toByteArray(Charsets.UTF_8)); sign()
        }
        val approvalSignature = sign(approval)
        val enrollmentSignature = sign(enrollment)
        assertEquals(0x30, approvalSignature[0].toInt())
        assertTrue(approvalSignature.size in 8..72)
        assertTrue(Signature.getInstance("SHA256withECDSA").run {
            initVerify(pair.public); update(approval.toByteArray(Charsets.UTF_8)); verify(approvalSignature)
        })
        val vectors = JSONObject().put("v", Protocol.VERSION).put("service", Protocol.SERVICE)
            .put("request", Protocol.REQUEST).put("proof", Protocol.PROOF)
            .put("challenge", json()).put("id", id).put("nonce", nonce).put("publicKey", publicKey).put("pairingCode", code)
            .put("approvalText", approval).put("enrollmentText", enrollment)
            .put("approvalSignature", Protocol.base64(approvalSignature))
            .put("enrollmentSignature", Protocol.base64(enrollmentSignature))
        System.getProperty("contractVectors")?.let { path ->
            File(path).apply { parentFile?.mkdirs(); writeText(vectors.toString(), Charsets.UTF_8) }
        }
    }
}
