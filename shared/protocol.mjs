// Shared, dependency-free wire contract. Android implements identical UTF-8 text.
export const CONTRACT_VERSION = 2;
export const CHALLENGE_TTL_MS = 60_000;
export const BLE_SERVICE_UUID = 'c7c50001-6c6c-4e4b-9b89-9e96a12a9f01';
export const BLE_REQUEST_UUID = 'c7c50002-6c6c-4e4b-9b89-9e96a12a9f01';
export const BLE_PROOF_UUID = 'c7c50003-6c6c-4e4b-9b89-9e96a12a9f01';
export function approvalText(challenge) {
  return `NEARKEY-LOGIN-V2\n${challenge.id}\n${challenge.nonce}\n${challenge.phoneId}\n${challenge.expiresAt}\n${challenge.username}\n${challenge.serviceName}\n${challenge.sessionId}`;
}
export function enrollmentText(pairingCode, publicKey) {
  return `NEARKEY-ENROLL-V1\n${pairingCode}\n${publicKey}`;
}
export function bleRequest(challenge) {
  return {v: CONTRACT_VERSION, type: 'prove', challengeId: challenge.id, nonce: challenge.nonce};
}
