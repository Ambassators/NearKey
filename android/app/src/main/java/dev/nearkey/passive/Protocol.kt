package dev.nearkey.passive

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.Base64
import java.util.UUID

/** Literal version-2 login wire encodings from shared/protocol.mjs. */
object Protocol {
    const val VERSION = 2
    const val SERVICE = "c7c50001-6c6c-4e4b-9b89-9e96a12a9f01"
    const val REQUEST = "c7c50002-6c6c-4e4b-9b89-9e96a12a9f01"
    const val PROOF = "c7c50003-6c6c-4e4b-9b89-9e96a12a9f01"
    fun approvalText(challenge: Challenge) = "NEARKEY-LOGIN-V2\n${challenge.id}\n${challenge.nonce}\n${challenge.phoneId}\n${challenge.expiresAt}\n${challenge.username}\n${challenge.serviceName}\n${challenge.sessionId}"
    fun enrollmentText(code: String, publicKey: String) = "NEARKEY-ENROLL-V1\n$code\n$publicKey"
    fun base64(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun utf8(bytes: ByteArray): String = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes)).toString()

    fun integer(json: JSONObject, key: String): Long {
        val value = json.get(key)
        require(value is Int || value is Long) { "Invalid $key" }
        val number = (value as Number).toLong()
        require(number in -9_007_199_254_740_991L..9_007_199_254_740_991L) { "Invalid $key" }
        return number
    }

    private fun string(json: JSONObject, key: String): String {
        val value = json.get(key)
        require(value is String) { "Invalid $key" }
        return value
    }

    fun challenge(json: JSONObject, phoneId: String, now: Long): Challenge {
        require(json.keys().asSequence().toSet() == setOf("v", "id", "nonce", "phoneId", "expiresAt", "purpose", "username", "serviceName", "sessionId")) {
            "Unexpected challenge fields"
        }
        require(integer(json, "v") == VERSION.toLong()) { "Unsupported challenge version" }
        val id = string(json, "id")
        require(UUID.fromString(id).toString() == id) { "Invalid challenge ID" }
        val nonce = string(json, "nonce")
        require(nonce.matches(Regex("[A-Za-z0-9_-]{43}"))) { "Invalid nonce" }
        val decoded = Base64.getUrlDecoder().decode(nonce)
        require(decoded.size == 32 && base64(decoded) == nonce) { "Invalid nonce encoding" }
        require(phoneId.isNotEmpty() && phoneId.length <= 128 && phoneId.none { it == '\n' || it == '\r' } &&
            string(json, "phoneId") == phoneId) { "Challenge is for another phone" }
        val expiry = integer(json, "expiresAt")
        require(now >= 0 && expiry > now && expiry - now <= 60_000) { "Expired challenge or phone clock is incorrect" }
        require(string(json, "purpose") == "login") { "Unsupported challenge purpose" }
        val username = string(json, "username")
        val serviceName = string(json, "serviceName")
        val sessionId = string(json, "sessionId")
        require(listOf(username, serviceName).all { it.isNotBlank() && it.length <= 128 &&
            it.none { char -> char == '\n' || char == '\r' } } &&
            sessionId.matches(Regex("[A-Za-z0-9_-]{1,128}"))) { "Invalid login context" }
        return Challenge(id, nonce, phoneId, expiry, username, serviceName, sessionId)
    }

    fun checkRequest(bytes: ByteArray, challenge: Challenge?, now: Long) {
        require(challenge != null && now < challenge.expiresAt) { "No live server challenge" }
        require(bytes.isNotEmpty() && bytes.size <= 1023) { "Invalid BLE request size" }
        val text = utf8(bytes)
        // Android JSONObject is lenient (comments, single quotes, trailing data). This
        // frame has exactly four flat string/integer members, so validate strict JSON
        // syntax first; the key-set check also rejects duplicate members.
        val jsonString = """"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*""""
        val space = """[ \t\r\n]*"""
        val member = "$jsonString$space:$space(?:$jsonString|-?(?:0|[1-9][0-9]*))"
        require(Regex("$space\\{$space$member(?:$space,$space$member){3}$space\\}$space").matches(text)) {
            "Malformed BLE request"
        }
        val json = JSONObject(text)
        require(json.keys().asSequence().toSet() == setOf("v", "type", "challengeId", "nonce")) { "Unexpected request fields" }
        require(integer(json, "v") == VERSION.toLong() && json.get("type") == "prove")
        require(json.get("challengeId") == challenge.id && json.get("nonce") == challenge.nonce) {
            "Request does not match the pending server challenge"
        }
    }

    fun proof(challenge: Challenge, signature: String): ByteArray = JSONObject()
        .put("v", VERSION).put("challengeId", challenge.id).put("signature", signature)
        .toString().toByteArray(Charsets.UTF_8)
}

data class Challenge(val id: String, val nonce: String, val phoneId: String, val expiresAt: Long,
    val username: String, val serviceName: String, val sessionId: String)

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
