package dev.nearkey.passive

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.Handler
import android.os.ParcelUuid
import android.os.SystemClock
import java.util.UUID

/** All state and callbacks run on the activity's main handler. No background service. */
@SuppressLint("MissingPermission")
class BlePeripheral(
    private val context: Context,
    private val handler: Handler,
    private val challenge: Challenge?, // null is chooser-only setup; never signs
    private val sign: (String) -> String,
    private val onReady: () -> Unit,
    private val onStatus: (String) -> Unit,
    private val onError: (String) -> Unit
) {
    private var active = false
    private var server: BluetoothGattServer? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var peer: BluetoothDevice? = null
    private val buffer = RequestBuffer()
    private var proof: ByteArray? = null
    private var advertisement: AdvertiseCallback? = null
    private var stopAtElapsed = 0L
    private val expire = Runnable { fail("Bluetooth window expired") }

    private fun live(): Boolean = active && SystemClock.elapsedRealtime() < stopAtElapsed &&
        (challenge == null || System.currentTimeMillis() < challenge.expiresAt)

    fun start() {
        try {
            val manager = context.getSystemService(BluetoothManager::class.java)
            val adapter = manager?.adapter ?: error("Bluetooth is not available")
            check(adapter.isEnabled) { "Bluetooth is disabled. Enable it in phone settings." }
            check(adapter.isMultipleAdvertisementSupported) { "This phone does not support BLE peripheral advertising" }
            advertiser = adapter.bluetoothLeAdvertiser ?: error("BLE advertiser unavailable")
            val remaining = challenge?.let { it.expiresAt - System.currentTimeMillis() } ?: 60_000L
            check(remaining in 1..60_000) { "Challenge expired or phone clock is incorrect" }
            stopAtElapsed = SystemClock.elapsedRealtime() + remaining
            active = true
            server = manager.openGattServer(context, callback) ?: error("Cannot open GATT server")
            val service = BluetoothGattService(UUID.fromString(Protocol.SERVICE), BluetoothGattService.SERVICE_TYPE_PRIMARY)
            service.addCharacteristic(BluetoothGattCharacteristic(UUID.fromString(Protocol.REQUEST),
                BluetoothGattCharacteristic.PROPERTY_WRITE, BluetoothGattCharacteristic.PERMISSION_WRITE))
            service.addCharacteristic(BluetoothGattCharacteristic(UUID.fromString(Protocol.PROOF),
                BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ))
            check(server!!.addService(service)) { "Cannot add GATT service" }
            handler.postDelayed(expire, remaining)
            onStatus("Preparing GATT service")
        } catch (e: Exception) { fail(e.message ?: "Bluetooth setup failed") }
    }

    private fun advertise() {
        if (!live() || peer != null || advertisement != null) return
        try {
            val bleAdvertiser = advertiser ?: error("BLE advertiser unavailable")
            val deviceName = context.getSystemService(BluetoothManager::class.java)?.adapter?.name
            check(!deviceName.isNullOrBlank()) { "Set a Bluetooth device name in phone settings, then retry." }
            // A legacy scan response has 31 bytes, including the name field's two-byte header.
            check(deviceName.toByteArray(Charsets.UTF_8).size <= 29) {
                "Shorten the Bluetooth device name in phone settings (maximum 29 UTF-8 bytes), then retry."
            }
            val cb = object : AdvertiseCallback() {
                override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
                    handler.post {
                        if (advertisement !== this || !live()) {
                            try { bleAdvertiser.stopAdvertising(this) } catch (_: Exception) { }
                            return@post
                        }
                        if (peer != null) stopAdvertising()
                        else onStatus(if (challenge == null) "Setup advertising (60 seconds; no signing)" else "Advertising for pending challenge")
                        if (!active) return@post
                        // Only actual onStartSuccess earns a readiness ACK; starting GATT is not enough.
                        onReady()
                    }
                }
                override fun onStartFailure(errorCode: Int) {
                    handler.post {
                        if (advertisement === this && active) fail(
                            if (errorCode == ADVERTISE_FAILED_DATA_TOO_LARGE)
                                "Bluetooth device name is too long. Shorten it in phone settings, then retry."
                            else "BLE advertising failed (code $errorCode)"
                        )
                    }
                }
            }
            advertisement = cb
            val remaining = (stopAtElapsed - SystemClock.elapsedRealtime()).coerceIn(1, 60_000).toInt()
            val settings = AdvertiseSettings.Builder().setConnectable(true)
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM).setTimeout(remaining).build()
            // Keep the service UUID in the primary packet so browser service filters still match.
            val data = AdvertiseData.Builder().addServiceUuid(ParcelUuid(UUID.fromString(Protocol.SERVICE)))
                .setIncludeDeviceName(false).setIncludeTxPowerLevel(false).build()
            // The separate name packet gives Chrome's chooser a recognizable phone label.
            // Neither packet contains login details, key identifiers, nonces or credentials.
            val scanResponse = AdvertiseData.Builder()
                .setIncludeDeviceName(true).setIncludeTxPowerLevel(false).build()
            bleAdvertiser.startAdvertising(settings, data, scanResponse, cb)
        } catch (e: Exception) { fail(e.message ?: "Cannot advertise") }
    }

    private val callback = object : BluetoothGattServerCallback() {
        override fun onServiceAdded(status: Int, service: BluetoothGattService) {
            handler.post {
                if (!active) return@post
                if (!live()) fail("Bluetooth window expired")
                else if (status != BluetoothGatt.GATT_SUCCESS) fail("GATT service registration failed ($status)")
                else advertise()
            }
        }

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            handler.post {
                if (!active) return@post
                try {
                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        if (!live() || status != BluetoothGatt.GATT_SUCCESS || (peer != null && peer != device)) {
                            server?.cancelConnection(device)
                            return@post
                        }
                        // A duplicate connected callback must not erase an in-progress request or proof.
                        if (peer == device) return@post
                        peer = device
                        buffer.clear(); proof = null
                        stopAdvertising()
                        if (!active) return@post
                        onStatus(if (challenge == null) "Setup central connected; signing disabled" else "Central connected; waiting for handshake")
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED && peer == device) {
                        peer = null
                        buffer.clear(); proof = null
                        onStatus("Central disconnected")
                        if (live()) advertise() else fail("Bluetooth window expired")
                    }
                } catch (e: Exception) { fail(e.message ?: "Bluetooth connection failed") }
            }
        }

        override fun onCharacteristicWriteRequest(device: BluetoothDevice, requestId: Int,
            characteristic: BluetoothGattCharacteristic, preparedWrite: Boolean, responseNeeded: Boolean,
            offset: Int, value: ByteArray) {
            val chunk = value.copyOf()
            handler.post {
                if (!active) return@post
                if (peer != device) {
                    respond(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null, responseNeeded)
                    try { server?.cancelConnection(device) } catch (_: SecurityException) { fail("Bluetooth permission was revoked") }
                    return@post
                }
                var status = BluetoothGatt.GATT_SUCCESS
                try {
                    require(live() && peer == device && challenge != null) { "No live pending challenge" }
                    require(characteristic.uuid == UUID.fromString(Protocol.REQUEST) && responseNeeded &&
                        !preparedWrite && offset == 0) { "Only request writes with response are supported" }
                    val frame = buffer.append(chunk)
                    if (frame != null) {
                        Protocol.checkRequest(frame, challenge, System.currentTimeMillis())
                        check(live()) { "Challenge expired" }
                        // Sign ONLY immutable state received from the authenticated phone channel.
                        val signature = sign(Protocol.approvalText(challenge))
                        check(live()) { "Challenge expired during signing" }
                        proof = Protocol.proof(challenge, signature).also { check(it.size <= 512) }
                        onStatus("Proof ready for browser relay")
                    }
                } catch (_: Exception) {
                    buffer.clear(); proof = null
                    status = BluetoothGatt.GATT_FAILURE
                    onStatus("Rejected BLE request (setup, invalid, mismatched or expired)")
                }
                // Proof is stored before acknowledging the terminating newline write.
                respond(device, requestId, status, 0, null, responseNeeded)
                if (status != BluetoothGatt.GATT_SUCCESS && peer == device) {
                    try { server?.cancelConnection(device) } catch (_: SecurityException) { fail("Bluetooth permission was revoked") }
                }
            }
        }

        override fun onCharacteristicReadRequest(device: BluetoothDevice, requestId: Int, offset: Int,
            characteristic: BluetoothGattCharacteristic) {
            handler.post {
                if (!active) return@post
                val result = proof
                if (!live() || challenge == null || peer != device || result == null ||
                    characteristic.uuid != UUID.fromString(Protocol.PROOF)) {
                    respond(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null)
                } else if (offset !in 0..result.size) {
                    respond(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null)
                } else {
                    // Android's ATT stack clips this suffix to the negotiated MTU.
                    // A cached/default MTU can be stale on an existing Mac link;
                    // pre-slicing to 22 bytes then looks like end-of-value to it.
                    respond(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, proofReadResponse(result, offset))
                }
            }
        }

        override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
            handler.post {
                if (active) respond(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, 0, null)
            }
        }
    }

    private fun respond(device: BluetoothDevice, id: Int, status: Int, offset: Int, value: ByteArray?, needed: Boolean = true) {
        if (!needed) return
        try {
            if (server?.sendResponse(device, id, status, offset, value) != true) fail("GATT response failed")
        } catch (_: SecurityException) { fail("Bluetooth permission was revoked") }
    }

    private fun stopAdvertising() {
        val cb = advertisement
        advertisement = null
        try {
            if (cb != null) advertiser?.stopAdvertising(cb)
        } catch (e: Exception) {
            // Detach first so fail -> close cannot recursively stop the same advertisement.
            if (active) fail(if (e is SecurityException) "Bluetooth permission was revoked" else "Cannot stop BLE advertising")
        }
    }

    private fun fail(message: String) { close(); onError(message) }

    fun close() {
        active = false
        handler.removeCallbacks(expire)
        stopAdvertising()
        val gatt = server
        server = null
        peer?.let { try { gatt?.cancelConnection(it) } catch (_: Exception) { } }
        peer = null
        buffer.clear(); proof = null
        // Adapter shutdown can also throw IllegalStateException; still attempt every release.
        try { gatt?.clearServices() } catch (_: Exception) { }
        try { gatt?.close() } catch (_: Exception) { }
        advertiser = null
    }
}
