package dev.nearkeylite
import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.os.ParcelUuid
import java.util.*
@SuppressLint("MissingPermission")
class BlePeripheral(ctx:Context,val onPacket:(String)->Unit,val onStatus:(String)->Unit){companion object{val SERVICE=UUID.fromString("c21d1001-62f5-4d8f-9f4a-35fb03dcd870");val RX=UUID.fromString("c21d1002-62f5-4d8f-9f4a-35fb03dcd870");val TX=UUID.fromString("c21d1003-62f5-4d8f-9f4a-35fb03dcd870")}
 private val manager=ctx.getSystemService(BluetoothManager::class.java);private var server:BluetoothGattServer?=null;private val codec=FrameCodec();private val queue=ArrayDeque<ByteArray>();var running=false;private set
 private val adcb=object:AdvertiseCallback(){override fun onStartSuccess(s:AdvertiseSettings){running=true;onStatus("Nearby approval ready")};override fun onStartFailure(e:Int){onStatus("BLE advertise failed: $e")}}
 private val cb=object:BluetoothGattServerCallback(){override fun onServiceAdded(status:Int,s:BluetoothGattService){if(status!=BluetoothGatt.GATT_SUCCESS)return onStatus("GATT service failed");manager.adapter.bluetoothLeAdvertiser.startAdvertising(AdvertiseSettings.Builder().setConnectable(true).setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY).build(),AdvertiseData.Builder().addServiceUuid(ParcelUuid(SERVICE)).build(),adcb)}
  override fun onCharacteristicWriteRequest(d:BluetoothDevice,id:Int,ch:BluetoothGattCharacteristic,prep:Boolean,response:Boolean,offset:Int,value:ByteArray){var status=BluetoothGatt.GATT_SUCCESS;try{require(ch.uuid==RX&&!prep&&offset==0);codec.feed(value)?.let(onPacket)}catch(_:Exception){status=BluetoothGatt.GATT_FAILURE;codec.clear()};if(response)server?.sendResponse(d,id,status,0,null)}
  override fun onCharacteristicReadRequest(d:BluetoothDevice,id:Int,offset:Int,ch:BluetoothGattCharacteristic){val value=if(ch.uuid==TX&&offset==0){synchronized(queue){if(queue.isEmpty())byteArrayOf(0)else queue.removeFirst()}}else null;server?.sendResponse(d,id,if(value==null)BluetoothGatt.GATT_FAILURE else BluetoothGatt.GATT_SUCCESS,0,value)} }
 fun start(){if(server!=null)return;val a=manager.adapter;require(a.isEnabled);require(a.isMultipleAdvertisementSupported);server=manager.openGattServer(ctx,cb);val s=BluetoothGattService(SERVICE,BluetoothGattService.SERVICE_TYPE_PRIMARY);s.addCharacteristic(BluetoothGattCharacteristic(RX,BluetoothGattCharacteristic.PROPERTY_WRITE,BluetoothGattCharacteristic.PERMISSION_WRITE));s.addCharacteristic(BluetoothGattCharacteristic(TX,BluetoothGattCharacteristic.PROPERTY_READ,BluetoothGattCharacteristic.PERMISSION_READ));server!!.addService(s);onStatus("Starting Bluetooth…")}
 fun reply(json:String){synchronized(queue){queue.clear();queue.addAll(FrameCodec.split(json))}}
 fun stop(){try{manager.adapter?.bluetoothLeAdvertiser?.stopAdvertising(adcb)}catch(_:Exception){};server?.close();server=null;running=false;codec.clear();synchronized(queue){queue.clear()}}
}
