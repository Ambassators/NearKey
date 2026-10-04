// Verify JVM-generated Android protocol vectors against the unchanged parent contract.
// This tests UTF-8 and SPKI/DER interoperability, not Android Keystore or real BLE.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicKey, verify } from 'node:crypto';
import {
  CONTRACT_VERSION, BLE_SERVICE_UUID, BLE_REQUEST_UUID, BLE_PROOF_UUID,
  approvalText, enrollmentText, bleRequest,
} from '../../shared/protocol.mjs';

const vectors = JSON.parse(await readFile(new URL('../app/build/contract-vectors.json', import.meta.url), 'utf8'));
assert.equal(vectors.v, CONTRACT_VERSION);
assert.equal(vectors.service, BLE_SERVICE_UUID);
assert.equal(vectors.request, BLE_REQUEST_UUID);
assert.equal(vectors.proof, BLE_PROOF_UUID);
assert.equal(vectors.approvalText, approvalText(vectors.id, vectors.nonce));
assert.equal(vectors.enrollmentText, enrollmentText(vectors.pairingCode, vectors.publicKey));
assert.deepEqual(bleRequest({ id: vectors.id, nonce: vectors.nonce }), {
  v: vectors.v, type: 'prove', challengeId: vectors.id, nonce: vectors.nonce,
});
for (const field of ['publicKey', 'approvalSignature', 'enrollmentSignature']) {
  assert.match(vectors[field], /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(vectors[field], 'base64url').toString('base64url'), vectors[field]);
}
const publicKey = createPublicKey({ key: Buffer.from(vectors.publicKey, 'base64url'), format: 'der', type: 'spki' });
assert.equal(publicKey.asymmetricKeyType, 'ec');
assert.equal(publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
const options = { key: publicKey, dsaEncoding: 'der' };
assert(verify('sha256', Buffer.from(approvalText(vectors.id, vectors.nonce), 'utf8'), options,
  Buffer.from(vectors.approvalSignature, 'base64url')));
assert(verify('sha256', Buffer.from(enrollmentText(vectors.pairingCode, vectors.publicKey), 'utf8'), options,
  Buffer.from(vectors.enrollmentSignature, 'base64url')));
assert(!verify('sha256', Buffer.from(approvalText(vectors.id, `${vectors.nonce}x`), 'utf8'), options,
  Buffer.from(vectors.approvalSignature, 'base64url')));
assert(!verify('sha256', Buffer.from(enrollmentText(vectors.pairingCode, vectors.publicKey), 'utf8'), options,
  Buffer.from(vectors.approvalSignature, 'base64url')));
console.log('PASS: Android JVM protocol vectors match shared v1; Node verifies P-256 SPKI / DER ECDSA SHA-256.');
