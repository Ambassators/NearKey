import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parsePublicKey, verifyProof} from '../../server/crypto.mjs';
import {approvalText, enrollmentText, bleRequest} from '../../shared/protocol.mjs';
import {parseProof, requestChunks} from '../../web/ble.mjs';

const vector = JSON.parse(await readFile(process.argv[2], 'utf8'));
const key = parsePublicKey(vector.publicKey);
assert.equal(vector.approvalText, approvalText(vector.challenge));
assert(verifyProof(key, enrollmentText(vector.pairingCode, vector.publicKey), vector.enrollmentSignature));
assert(verifyProof(key, approvalText(vector.challenge), vector.loginSignature));
assert.equal(verifyProof(key, approvalText({...vector.challenge, sessionId: 'another_session'}), vector.loginSignature), false);
const proof = new TextEncoder().encode(vector.proof);
assert.equal(parseProof(new DataView(proof.buffer), vector.challenge.id), vector.loginSignature);
const request = Buffer.concat(requestChunks(vector.challenge).map(chunk => Buffer.from(chunk))).toString();
assert.deepEqual(JSON.parse(request), bleRequest(vector.challenge));
console.log('iPhone CryptoKit keys and DER proofs match the Node server and Chromium protocol.');
