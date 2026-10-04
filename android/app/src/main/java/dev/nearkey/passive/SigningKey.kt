package dev.nearkey.passive

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

class SigningKey {
    private val alias = "nearkey-passive-v1"
    private val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun ensure() {
        if (store.containsAlias(alias)) return
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
            initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build())
        }.generateKeyPair()
    }

    // X.509 SubjectPublicKeyInfo (DER), not a raw EC point.
    fun publicKey(): String = Protocol.base64(store.getCertificate(alias).publicKey.encoded)

    // Android SHA256withECDSA emits ASN.1 DER, not IEEE-P1363.
    fun sign(text: String): String = Protocol.base64(Signature.getInstance("SHA256withECDSA").run {
        initSign(store.getKey(alias, null) as PrivateKey)
        update(text.toByteArray(Charsets.UTF_8))
        sign()
    })

    @Suppress("DEPRECATION")
    fun backing(): String = try {
        val key = store.getKey(alias, null) as PrivateKey
        val info = KeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java)
        if (info.isInsideSecureHardware) "Hardware-backed Keystore" else "Software-backed Keystore"
    } catch (_: Exception) { "Keystore (hardware backing unknown)" }

    fun delete() { if (store.containsAlias(alias)) store.deleteEntry(alias) }
}
