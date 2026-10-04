// Relative URL resolves to /shared/protocol.mjs in the browser; also works in Node tests.
import {
  CONTRACT_VERSION, BLE_SERVICE_UUID, BLE_REQUEST_UUID, BLE_PROOF_UUID, bleRequest,
} from '../shared/protocol.mjs';

const DEVICE_KEY = 'nearkey.bluetoothDeviceId';
const encoder = new TextEncoder();

export function requestChunks(challenge) {
  if (challenge?.v !== CONTRACT_VERSION || typeof challenge.id !== 'string' || !challenge.id
      || typeof challenge.nonce !== 'string' || !challenge.nonce) {
    throw new Error('Invalid server Bluetooth challenge.');
  }
  const bytes = encoder.encode(`${JSON.stringify(bleRequest(challenge))}\n`);
  if (bytes.length > 1024) throw new Error('Bluetooth request is too large.');
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 20) chunks.push(bytes.slice(i, i + 20));
  return chunks;
}

export function parseProof(value, challengeId) {
  if (!(value instanceof DataView) || value.byteLength > 1024) {
    throw new Error('Phone returned an invalid Bluetooth proof.');
  }
  let proof;
  try {
    proof = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(value));
  } catch {
    throw new Error('Phone proof was incomplete or malformed. Reconnect and retry.');
  }
  if (proof?.v !== CONTRACT_VERSION || proof.challengeId !== challengeId) {
    throw new Error('Phone proof does not match this server challenge.');
  }
  const signature = proof.signature;
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]+$/.test(signature)
      || signature.length > 96 || signature.length % 4 === 1) {
    throw new Error('Phone signature is not unpadded base64url DER.');
  }
  const binary = atob(signature.replace(/-/g, '+').replace(/_/g, '/'));
  if (btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== signature) {
    throw new Error('Phone signature has a non-canonical encoding.');
  }
  // Keep DER intact (never convert to IEEE-P1363); the server verifies the key/signature.
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  if (bytes.length < 8 || bytes.length > 72 || bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) {
    throw new Error('Phone signature is not a DER ECDSA signature.');
  }
  let offset = 2;
  for (let i = 0; i < 2; i++) {
    if (bytes[offset++] !== 2) throw new Error('Invalid DER signature integer.');
    const length = bytes[offset++];
    const integer = bytes.slice(offset, offset + length);
    if (length < 1 || length > 33 || integer.length !== length || integer[0] & 0x80
        || (length > 1 && integer[0] === 0 && !(integer[1] & 0x80))
        || (length === 33 && integer[0] !== 0) || !integer.some(b => b !== 0)) {
      throw new Error('Invalid DER signature integer.');
    }
    offset += length;
  }
  if (offset !== bytes.length) throw new Error('Invalid DER signature length.');
  return signature;
}

export class PhoneBluetooth {
  constructor({bluetooth = globalThis.navigator?.bluetooth,
    secure = globalThis.isSecureContext, storage,
    timeoutMs = 12_000, onProgress = () => {}} = {}) {
    this.bluetooth = bluetooth;
    this.secure = secure;
    try { this.storage = storage === undefined ? globalThis.localStorage : storage; } catch { this.storage = null; }
    this.timeoutMs = timeoutMs;
    this.onProgress = onProgress;
    this.device = null;
    this.active = null;
    try { this.deviceId = this.storage?.getItem(DEVICE_KEY) || null; } catch { this.deviceId = null; }
  }

  get busy() { return this.active !== null; }

  availability() {
    if (!this.secure) return 'Bluetooth needs HTTPS or localhost in Chromium. Open the secure demo URL.';
    if (!this.bluetooth?.requestDevice) return 'Web Bluetooth is unavailable. Use MacBook Chromium with Web Bluetooth enabled.';
    return null;
  }

  // Called directly by a click handler: no asynchronous work before requestDevice.
  choose() {
    const problem = this.availability();
    if (problem) return Promise.reject(new Error(problem));
    if (this.busy) return Promise.reject(new Error('Bluetooth is still closing its previous connection. Try again shortly.'));
    const token = {controller: new AbortController(), device: null, pending: new Set()};
    this.active = token;
    let selection;
    try {
      this.onProgress('Choosing phone');
      selection = this.bluetooth.requestDevice({filters: [{services: [BLE_SERVICE_UUID]}]});
    } catch (error) {
      this.active = null;
      this.onProgress('Phone selection interrupted');
      return Promise.reject(error);
    }
    return this.step(token, selection).then(device => {
      this.device = device;
      this.deviceId = device.id;
      try { this.storage?.setItem(DEVICE_KEY, device.id); } catch { /* permission works for this page */ }
      this.onProgress('Bluetooth permission granted');
      return device;
    }).catch(error => {
      this.onProgress('Phone selection interrupted');
      throw error;
    }).finally(() => this.release(token));
  }

  async remembered(token) {
    if (this.device && this.device.id === this.deviceId) return this.device;
    if (!this.bluetooth?.getDevices) {
      throw new Error('This browser cannot reconnect saved devices automatically. Click Choose / reconnect phone.');
    }
    const devices = await this.step(token, () => this.bluetooth.getDevices());
    const device = devices.find(d => d.id === this.deviceId);
    if (!device) throw new Error('No remembered permitted phone is available. Click Choose / reconnect phone.');
    return device;
  }

  async prove(challenge, signal) {
    const problem = this.availability();
    if (problem) throw new Error(problem);
    // Snapshot the server identity/deadline once; retries never extend its lifetime.
    challenge = {v: challenge?.v, id: challenge?.id, nonce: challenge?.nonce, expiresAt: challenge?.expiresAt};
    if (!Number.isFinite(challenge.expiresAt) || signal?.aborted || Date.now() >= challenge.expiresAt) {
      throw new Error('This challenge has expired or was cancelled.');
    }
    if (this.busy) throw new Error('Bluetooth is still closing its previous connection. Try again shortly.');
    const chunks = requestChunks(challenge);
    const token = {controller: new AbortController(), device: null, pending: new Set(), expiresAt: challenge.expiresAt};
    this.active = token;
    const cancel = () => this.abort(token, 'Bluetooth attempt cancelled.');
    signal?.addEventListener('abort', cancel, {once: true});
    const timer = setTimeout(() => this.abort(token, Date.now() >= token.expiresAt
      ? 'Challenge expired before the phone proof arrived.'
      : 'Bluetooth connection timed out. Choose / reconnect phone to retry.'),
      Math.min(this.timeoutMs, token.expiresAt - Date.now()));
    const disconnected = () => this.abort(token, 'Phone disconnected. Reconnect to retry this pending challenge.');
    try {
      this.onProgress('Finding permitted phone');
      const device = await this.remembered(token);
      token.device = device;
      device.addEventListener('gattserverdisconnected', disconnected);
      // Late native connect results are disconnected too; never leak a cancelled connection.
      this.onProgress('Connecting Bluetooth');
      const server = await this.step(token, () => device.gatt.connect().then(server => {
        if (token.controller.signal.aborted) device.gatt.disconnect();
        return server;
      }));
      this.onProgress('Discovering phone service');
      const service = await this.step(token, () => server.getPrimaryService(BLE_SERVICE_UUID));
      const request = await this.step(token, () => service.getCharacteristic(BLE_REQUEST_UUID));
      const proof = await this.step(token, () => service.getCharacteristic(BLE_PROOF_UUID));
      this.onProgress('Sending login challenge');
      for (const chunk of chunks) {
        await this.step(token, () => request.writeValueWithResponse(chunk));
      }
      // Android stores the full proof before acknowledging the final newline write.
      // The native stack assembles offset reads into the full characteristic value.
      this.onProgress('Reading phone signature');
      const value = await this.step(token, () => proof.readValue());
      if (token.controller.signal.aborted) throw token.controller.signal.reason;
      if (Date.now() >= challenge.expiresAt) throw new Error('Challenge expired before the phone proof arrived.');
      this.onProgress(`Phone proof received (${value.byteLength} bytes)`);
      const signature = parseProof(value, challenge.id);
      this.onProgress('Phone signature received');
      return signature;
    } catch (error) {
      this.onProgress(token.controller.signal.aborted ? 'Bluetooth attempt stopped' : 'Bluetooth attempt interrupted');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      token.device?.removeEventListener('gattserverdisconnected', disconnected);
      try { token.device?.gatt?.disconnect(); } catch { /* disconnected/unavailable native device */ }
      this.release(token);
    }
  }

  async step(token, operation) {
    const signal = token.controller.signal;
    if (Date.now() >= token.expiresAt) this.abort(token, 'Challenge expired before the phone proof arrived.');
    if (signal.aborted) throw signal.reason;
    const pending = Promise.resolve(typeof operation === 'function' ? operation() : operation);
    token.pending.add(pending);
    pending.then(() => token.pending.delete(pending), () => token.pending.delete(pending));
    let listener;
    try {
      const value = await Promise.race([pending, new Promise((_, reject) => {
        listener = () => reject(signal.reason);
        signal.addEventListener('abort', listener, {once: true});
        // A native operation can synchronously disconnect/cancel before registration.
        if (signal.aborted) listener();
      })]);
      if (Date.now() >= token.expiresAt) this.abort(token, 'Challenge expired before the phone proof arrived.');
      if (signal.aborted) throw signal.reason;
      return value;
    } finally {
      signal.removeEventListener('abort', listener);
      if (signal.aborted) {
        try { token.device?.gatt?.disconnect(); } catch { /* preserve cancellation reason */ }
      }
    }
  }

  abort(token, message) {
    if (token.controller.signal.aborted) return;
    token.controller.abort(new Error(message));
    try { token.device?.gatt?.disconnect(); } catch { /* release still waits for native work */ }
  }

  cancel() {
    if (this.active) this.abort(this.active, 'Bluetooth attempt cancelled.');
  }

  forget() {
    this.cancel();
    try { this.device?.gatt?.disconnect(); } catch { /* native connection already closed */ }
    this.device = null;
    this.deviceId = null;
    try { this.storage?.removeItem(DEVICE_KEY); } catch { /* unavailable browser storage */ }
  }

  release(token) {
    // Native Bluetooth promises are not abortable. Keep the lock until they settle,
    // preventing a second connect/write racing a late result from the old attempt.
    Promise.allSettled([...token.pending]).then(() => {
      if (this.active === token) this.active = null;
    });
  }
}
