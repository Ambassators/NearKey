package dev.nearkeylite
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.math.BigInteger
import java.security.*
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
object Crypto {
 private const val ALIAS="nearkey-lite-v2"
 fun enc(b:ByteArray)=Base64.getUrlEncoder().withoutPadding().encodeToString(b)
 fun dec(s:String)=Base64.getUrlDecoder().decode(s)
 fun hash(b:ByteArray)=enc(MessageDigest.getInstance("SHA-256").digest(b))
 fun publicKey(s:String):PublicKey=KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(dec(s)))
 fun ensureKey():String{val ks=KeyStore.getInstance("AndroidKeyStore").apply{load(null)};if(!ks.containsAlias(ALIAS)){val g=KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC,"AndroidKeyStore");g.initialize(KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY).setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build());g.generateKeyPair()};return enc(ks.getCertificate(ALIAS).publicKey.encoded)}
 fun sign(text:String):String{val ks=KeyStore.getInstance("AndroidKeyStore").apply{load(null)};val s=Signature.getInstance("SHA256withECDSA");s.initSign(ks.getKey(ALIAS,null) as PrivateKey);s.update(text.toByteArray());return enc(s.sign())}
 fun verify(pub:String,text:String,sig:String):Boolean=try{Signature.getInstance("SHA256withECDSA").run{initVerify(publicKey(pub));update(text.toByteArray());verify(dec(sig))}}catch(_:Exception){false}
 fun approvalText(payload:String)="NEARKEY-APPROVE-V2\n"+hash(dec(payload))
 fun enrollText(ticket:String,pub:String)="NEARKEY-ENROLL-V2\n$ticket\n$pub"
 fun code(signature:String,id:String):String{val md=MessageDigest.getInstance("SHA-256");md.update(dec(signature));md.update("\n$id".toByteArray());val d=md.digest();return BigInteger(1,d.copyOfRange(0,8)).mod(BigInteger.valueOf(100000000)).toString().padStart(8,'0')}
}
