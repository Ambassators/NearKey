// Mocked Web Bluetooth transport only: not Mac/Android hardware verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign, verify} from 'node:crypto';
import {PhoneBluetooth, requestChunks, parseProof} from './ble.mjs';
import {BLE_SERVICE_UUID, BLE_REQUEST_UUID, BLE_PROOF_UUID, bleRequest, approvalText} from '../shared/protocol.mjs';

const key = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
const challenge = () => ({v: 1, id: 'd056d573-7739-45a3-9d8b-6ea70fded8df', nonce: 'a'.repeat(43), expiresAt: Date.now() + 60_000});
const signatureFor = c => sign('sha256', Buffer.from(approvalText(c.id, c.nonce)), key.privateKey).toString('base64url');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
function proofView(proof) {
  const json = new TextEncoder().encode(JSON.stringify(proof));
  const padded = new Uint8Array(json.length + 9);
  padded.set(json, 5);
  return new DataView(padded.buffer, 5, json.length);
}
function storage(initial = null) {
  const values = new Map(initial ? [['nearkey.bluetoothDeviceId', initial]] : []);
  return {values, getItem: k => values.get(k), setItem: (k, v) => values.set(k, v)};
}
function phone(c, options = {}) {
  const device = new EventTarget();
  device.id = 'permitted-phone';
  device.name = 'Mock phone';
  const calls = [];
  const writes = [];
  const signature = signatureFor(c);
  const server = {getPrimaryService: async uuid => {
    calls.push(['service', uuid]);
    assert.equal(uuid, BLE_SERVICE_UUID);
    return {getCharacteristic: async characteristic => {
      calls.push(['characteristic', characteristic]);
      if (characteristic === BLE_REQUEST_UUID) return {writeValueWithResponse: async bytes => {
        calls.push(['write', bytes.length]);
        writes.push(Buffer.from(bytes));
        await options.write?.(device, bytes);
      }};
      assert.equal(characteristic, BLE_PROOF_UUID);
      return {readValue: async () => {
        calls.push(['read']);
        return options.read ? options.read() : proofView({v: 1, challengeId: c.id, signature});
      }};
    }};
  }};
  device.gatt = {
    connected: false,
    connect: async () => {
      calls.push(['connect']);
      if (options.connect) await options.connect();
      device.gatt.connected = true;
      return server;
    },
    disconnect: () => {
      calls.push(['disconnect']);
      if (device.gatt.connected) {
        device.gatt.connected = false;
        device.dispatchEvent(new Event('gattserverdisconnected'));
      }
    },
  };
  return {device, calls, writes, signature};
}

 test('mock BLE chunks are <=20 bytes, ordered UTF-8 and newline JSON using bleRequest exactly', () => {
  const c = {...challenge(), id: 'multibyte-☃-📱'.repeat(3)};
  const chunks = requestChunks(c);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(bytes => bytes.length > 0 && bytes.length <= 20));
  assert.equal(Buffer.concat(chunks).toString('utf8'), `${JSON.stringify(bleRequest(c))}\n`);
  assert.throws(() => requestChunks({...c, id: 'x'.repeat(1024)}), /too large/);
});

test('full offset DataView proof preserves real P-256 DER SHA-256 base64url signature', () => {
  const c = challenge();
  const signature = signatureFor(c);
  const value = proofView({v: 1, challengeId: c.id, signature});
  assert.ok(value.byteLength > 20);
  assert.equal(parseProof(value, c.id), signature);
  assert.ok(verify('sha256', Buffer.from(approvalText(c.id, c.nonce)), key.publicKey, Buffer.from(signature, 'base64url')));
  assert.equal(approvalText('id', 'nonce'), 'NEARKEY-PASSIVE-V1\nid\nnonce');
});

test('proof rejects wrong version/id, incomplete JSON, invalid UTF-8, padding and P1363', () => {
  const c = challenge();
  const signature = signatureFor(c);
  for (const proof of [{v: 2, challengeId: c.id, signature}, {v: 1, challengeId: 'another', signature},
    {v: 1, challengeId: c.id, signature: `${signature}=`}, {v: 1, challengeId: c.id, signature: '-'},
    {v: 1, challengeId: c.id, signature: Buffer.alloc(64).toString('base64url')},
    {v: 1, challengeId: c.id, signature: Buffer.from([0x30, 6, 2, 1, 0, 2, 1, 1]).toString('base64url')}]) {
    assert.throws(() => parseProof(proofView(proof), c.id));
  }
  assert.throws(() => parseProof(new DataView(new TextEncoder().encode('{').buffer), c.id), /malformed/);
  assert.throws(() => parseProof(new DataView(Uint8Array.of(0xff).buffer), c.id), /malformed/);
  assert.throws(() => parseProof(new DataView(new ArrayBuffer(1025)), c.id), /invalid/);
});

test('chooser runs synchronously from caller and scopes the granted service; only device ID is stored', async () => {
  const saved = storage();
  const c = challenge();
  const mock = phone(c);
  let called = false;
  const bluetooth = new PhoneBluetooth({secure: true, storage: saved, bluetooth: {
    requestDevice: options => {
      called = true;
      assert.deepEqual(options, {filters: [{services: [BLE_SERVICE_UUID]}]});
      return Promise.resolve(mock.device);
    },
  }});
  const choice = bluetooth.choose();
  assert.equal(called, true);
  await choice;
  await tick();
  assert.deepEqual([...saved.values], [['nearkey.bluetoothDeviceId', mock.device.id]]);
  assert.equal(await bluetooth.prove(c), mock.signature);
  assert.equal(bluetooth.busy, false);
});

test('remembered permitted device automatically connects, writes with response then reads full proof and disconnects', async () => {
  const c = challenge();
  const mock = phone(c);
  let chooserCalls = 0;
  const bluetooth = new PhoneBluetooth({secure: true, storage: storage(mock.device.id), bluetooth: {
    requestDevice: () => { chooserCalls++; }, getDevices: async () => [mock.device],
  }});
  assert.equal(await bluetooth.prove(c), mock.signature);
  assert.equal(chooserCalls, 0);
  assert.equal(Buffer.concat(mock.writes).toString(), `${JSON.stringify(bleRequest(c))}\n`);
  assert.ok(mock.calls.findIndex(call => call[0] === 'read') > mock.calls.findLastIndex(call => call[0] === 'write'));
  assert.equal(mock.device.gatt.connected, false);
});

for (const [name, getDevices] of [['getDevices unavailable', undefined], ['remembered permission missing', async () => []]]) {
  test(`mock fallback: ${name} requires a new chooser gesture, never silent requestDevice`, async () => {
    let choices = 0;
    const bluetooth = new PhoneBluetooth({secure: true, storage: storage('old-phone'), bluetooth: {
      requestDevice: () => { choices++; }, getDevices,
    }});
    await assert.rejects(bluetooth.prove(challenge()), /Choose \/ reconnect phone/);
    assert.equal(choices, 0);
  });
}

test('connection failure releases controls and permits retry of the same pending challenge', async () => {
  const c = challenge();
  let attempt = 0;
  const mock = phone(c, {connect: async () => { if (++attempt === 1) throw new Error('out of range'); }});
  const bluetooth = new PhoneBluetooth({secure: true, storage: storage(mock.device.id), bluetooth: {
    requestDevice: async () => mock.device, getDevices: async () => [mock.device],
  }});
  await assert.rejects(bluetooth.prove(c), /out of range/);
  await tick();
  assert.equal(bluetooth.busy, false);
  assert.equal(await bluetooth.prove(c), mock.signature);
});

test('mock disconnect during write stops later chunks/read and disconnects', async () => {
  const c = challenge();
  const mock = phone(c, {write: async device => device.gatt.disconnect()});
  const bluetooth = new PhoneBluetooth({secure: true, storage: storage(mock.device.id), bluetooth: {
    requestDevice() {}, getDevices: async () => [mock.device],
  }});
  await assert.rejects(bluetooth.prove(c), /disconnected/);
  assert.equal(mock.writes.length, 1);
  assert.equal(mock.calls.some(call => call[0] === 'read'), false);
  assert.equal(bluetooth.busy, false);
});

test('cancelled native connect keeps the lock, rejects duplicates, and disconnects its late result', async () => {
  const c = challenge();
  const connection = deferred();
  const mock = phone(c, {connect: () => connection.promise});
  const bluetooth = new PhoneBluetooth({secure: true, storage: storage(mock.device.id), bluetooth: {
    requestDevice() {}, getDevices: async () => [mock.device],
  }});
  const attempt = bluetooth.prove(c);
  await tick();
  await assert.rejects(bluetooth.prove(c), /still closing/);
  bluetooth.cancel();
  await assert.rejects(attempt, /cancelled/);
  assert.equal(bluetooth.busy, true);
  await assert.rejects(bluetooth.choose(), /still closing/);
  connection.resolve();
  await tick();
  assert.equal(mock.device.gatt.connected, false);
  assert.equal(mock.writes.length, 0);
  assert.equal(bluetooth.busy, false);
});

test('expired / pre-cancelled challenges never connect', async () => {
  let calls = 0;
  const bluetooth = new PhoneBluetooth({secure: true, storage: storage(), bluetooth: {
    requestDevice() {}, getDevices: async () => { calls++; return []; },
  }});
  await assert.rejects(bluetooth.prove({...challenge(), expiresAt: Date.now() - 1}), /expired/);
  await assert.rejects(bluetooth.prove(challenge(), AbortSignal.abort()), /cancelled/);
  assert.equal(calls, 0);
});

test('mock Bluetooth timeout stops work, disconnects late native operations and recovers lock', async () => {
  const c = challenge();
  const read = deferred();
  const mock = phone(c, {read: () => read.promise});
  const bluetooth = new PhoneBluetooth({secure: true, timeoutMs: 15, storage: storage(mock.device.id), bluetooth: {
    requestDevice() {}, getDevices: async () => [mock.device],
  }});
  await assert.rejects(bluetooth.prove(c), /timed out/);
  assert.equal(mock.device.gatt.connected, false);
  assert.equal(bluetooth.busy, true);
  read.resolve(proofView({v: 1, challengeId: c.id, signature: mock.signature}));
  await tick();
  assert.equal(bluetooth.busy, false);
});

test('mismatched proof fails and always disconnects', async () => {
  const c = challenge();
  const mock = phone(c, {read: () => proofView({v: 1, challengeId: 'wrong', signature: signatureFor(c)})});
  const bluetooth = new PhoneBluetooth({secure: true, storage: storage(mock.device.id), bluetooth: {
    requestDevice() {}, getDevices: async () => [mock.device],
  }});
  await assert.rejects(bluetooth.prove(c), /does not match/);
  assert.equal(mock.device.gatt.connected, false);
});

test('insecure context and unsupported browser fail visibly; denied storage does not prevent permission', async () => {
  for (const options of [{secure: false, bluetooth: {}}, {secure: true, bluetooth: undefined}]) {
    const bluetooth = new PhoneBluetooth({...options, storage: null});
    assert.ok(bluetooth.availability());
    await assert.rejects(bluetooth.choose(), /HTTPS|unavailable/);
    await assert.rejects(bluetooth.prove(challenge()), /HTTPS|unavailable/);
  }
  const mock = phone(challenge());
  const bluetooth = new PhoneBluetooth({secure: true, bluetooth: {requestDevice: async () => mock.device}, storage: {
    getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); },
  }});
  await bluetooth.choose();
  assert.equal(bluetooth.deviceId, mock.device.id);
});

test('cancelled chooser ignores its late result and cannot overwrite remembered device', async () => {
  const choice = deferred();
  const saved = storage('original');
  const bluetooth = new PhoneBluetooth({secure: true, storage: saved, bluetooth: {requestDevice: () => choice.promise}});
  const attempt = bluetooth.choose();
  bluetooth.cancel();
  await assert.rejects(attempt, /cancelled/);
  choice.resolve(phone(challenge()).device);
  await tick();
  assert.equal(bluetooth.deviceId, 'original');
  assert.equal(bluetooth.busy, false);
});
