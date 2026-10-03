import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
export const random = (n=32) => randomBytes(n).toString('base64url');
export const hash = bytes => createHash('sha256').update(bytes).digest('base64url');
export const decode = value => Buffer.from(value, 'base64url');
export const encodeJson = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export const parseJson = value => JSON.parse(decode(value).toString('utf8'));
export const keys = () => generateKeyPairSync('ec', {namedCurve:'prime256v1'});
export const exportPublic = key => key.export({type:'spki',format:'der'}).toString('base64url');
export function importPublic(value) {
  const key = createPublicKey({key:decode(value),type:'spki',format:'der'});
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('P-256 key required');
  return key;
}
export const signBytes = (key, bytes, format='ieee-p1363') => sign('sha256', bytes, {key,dsaEncoding:format}).toString('base64url');
export function verifyBytes(key, bytes, signature, format='ieee-p1363') {
  try { return verify('sha256', bytes, {key:typeof key==='string'?importPublic(key):key,dsaEncoding:format}, decode(signature)); }
  catch { return false; }
}
export function signEnvelope(privateKey, object) {
  const payload = encodeJson(object);
  return {payload, signature: signBytes(privateKey, decode(payload))};
}
export const enrollText = (ticket, publicKey) => `NEARKEY-ENROLL-V2\n${ticket}\n${publicKey}`;
export const approvalText = payload => `NEARKEY-APPROVE-V2\n${hash(decode(payload))}`;
export function confirmationCode(signature, challengeId) {
  const digest = createHash('sha256').update(decode(signature)).update('\n').update(challengeId).digest();
  let n = 0n; for (const b of digest.subarray(0,8)) n = (n << 8n) | BigInt(b);
  return (n % 100000000n).toString().padStart(8,'0');
}
