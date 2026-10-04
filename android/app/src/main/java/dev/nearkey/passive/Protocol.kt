package dev.nearkey.passive

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.Base64
import java.util.UUID

/** Literal version-1 wire encodings from shared/protocol.mjs. */
object Protocol {
    const val VERSION = 1
    const val SERVICE = "c7c50001-6c6c-4e4b-9b89-9e96a12a9f01"
    const val REQUEST = "c7c50002-6c6c-4e4b-9b89-9e96a12a9f01"
    const val PROOF = "c7c50003-6c6c-4e4b-9b89-9e96a12a9f01"
    fun approvalText(id: String, nonce: String) = "NEARKEY-PASSIVE-V1\n$id\n$nonce"
    fun enrollmentText(code: String, publicKey: String) = "NEARKEY-ENROLL-V1\n$code\n$publicKey"
    fun base64(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun utf8(bytes: ByteArray): String = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes)).toString()

    fun integer(json: JSONObject, key: String): Long {
        val value = json.get(key)
        require(value is Int || value is Long) { "Invalid $key" }
        return (value as Number).toLong()
    }

    fun challenge(json: JSONObject, phoneId: String, now: Long): Challenge {
        require(integer(json, "v") == VERSION.toLong()) { "Unsupported challenge version" }
        val id = json.getString("id")
        require(UUID.fromString(id).toString() == id) { "Invalid challenge ID" }
        val nonce = json.getString("nonce")
        require(nonce.matches(Regex("[A-Za-z0-9_-]{43}"))) { "Invalid nonce" }
        val decoded = Base64.getUrlDecoder().decode(nonce)
        require(decoded.size == 32 && base64(decoded) == nonce) { "Invalid nonce encoding" }
        require(json.getString("phoneId") == phoneId) { "Challenge is for another phone" }
        val expiry = integer(json, "expiresAt")
        require(expiry > now && expiry - now <= 60_000) { "Expired challenge or phone clock is incorrect" }
        val operation = json.getJSONObject("operation")
        val amount = integer(operation, "amountCents")
        require(amount > 0) { "Invalid operation" }
        return Challenge(id, nonce, phoneId, expiry, operation.getString("recipientId"),
            operation.getString("recipientName"), amount, operation.getString("note"))
    }

    fun checkRequest(bytes: ByteArray, challenge: Challenge?, now: Long) {
        require(challenge != null && now < challenge.expiresAt) { "No live server challenge" }
        val json = JSONObject(utf8(bytes))
        require(json.keys().asSequence().toSet() == setOf("v", "type", "challengeId", "nonce")) { "Unexpected request fields" }
        require(integer(json, "v") == VERSION.toLong() && json.getString("type") == "prove")
        require(json.getString("challengeId") == challenge.id && json.getString("nonce") == challenge.nonce) {
            "Request does not match the pending server challenge"
        }
    }

    fun proof(challenge: Challenge, signature: String): ByteArray = JSONObject()
        .put("v", VERSION).put("challengeId", challenge.id).put("signature", signature)
        .toString().toByteArray(Charsets.UTF_8)
}

data class Challenge(val id: String, val nonce: String, val phoneId: String, val expiresAt: Long,
    val recipientId: String, val recipientName: String, val amountCents: Long, val note: String)

/** One newline-delimited frame, <=20-byte writes with response, <=1024-byte total. */
class RequestBuffer {
    private val bytes = ByteArrayOutputStream()
    private var finished = false

    fun append(chunk: ByteArray): ByteArray? {
        require(!finished && chunk.isNotEmpty() && chunk.size <= 20) { "Invalid BLE chunk" }
        require(bytes.size() + chunk.size <= 1024) { "BLE request too large" }
        val newline = chunk.indexOf(10.toByte())
        require(newline < 0 || newline == chunk.lastIndex) { "Only one terminated request allowed" }
        bytes.write(chunk)
        if (newline < 0) return null
        finished = true
        return bytes.toByteArray().dropLast(1).toByteArray()
    }

    fun clear() { bytes.reset(); finished = false }
}

/** ATT Read/Read Blob payload is MTU-1, including the zero-length terminal read. */
fun proofSlice(proof: ByteArray, offset: Int, mtu: Int): ByteArray {
    require(offset in 0..proof.size) { "Invalid read offset" }
    return proof.copyOfRange(offset, minOf(proof.size, offset + mtu.coerceIn(23, 517) - 1))
}
