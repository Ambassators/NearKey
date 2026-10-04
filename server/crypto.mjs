import { createPublicKey, randomBytes, scrypt, timingSafeEqual, verify } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function decodeBase64url(value, min, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3)
      || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < min || bytes.length > max || bytes.toString('base64url') !== value) {
    throw new Error('Invalid base64url');
  }
  return bytes;
}

export function parsePublicKey(encoded) {
  const der = decodeBase64url(encoded, 80, 128);
  const key = createPublicKey({key: der, format: 'der', type: 'spki'});
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1'
      || !key.export({format: 'der', type: 'spki'}).equals(der)) {
    throw new Error('Expected canonical P-256 DER SPKI');
  }
  return key;
}

export function parseSignature(encoded) {
  const der = decodeBase64url(encoded, 8, 72);
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error('Invalid DER signature');
  let offset = 2;
  for (let i = 0; i < 2; i++) {
    if (der[offset++] !== 0x02) throw new Error('Invalid DER integer');
    const size = der[offset++];
    const value = der.subarray(offset, offset + size);
    if (size < 1 || size > 33 || value.length !== size || value[0] & 0x80
        || (size > 1 && value[0] === 0 && !(value[1] & 0x80))) {
      throw new Error('Invalid DER integer');
    }
    const scalar = BigInt(`0x${value.toString('hex')}`);
    if (scalar === 0n || scalar >= P256_ORDER) throw new Error('Invalid P-256 scalar');
    offset += size;
  }
  if (offset !== der.length) throw new Error('Trailing DER bytes');
  return der;
}

export function verifyProof(key, text, signature) {
  return verify('sha256', Buffer.from(text, 'utf8'), {key, dsaEncoding: 'der'}, parseSignature(signature));
}

export async function passwordRecord(password) {
  const salt = randomBytes(16);
  return {salt, hash: await derive(password, salt, 32)};
}

export async function passwordMatches(password, record) {
  return timingSafeEqual(await derive(password, record.salt, 32), record.hash);
}
