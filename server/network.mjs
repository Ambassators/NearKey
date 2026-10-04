import {networkInterfaces} from 'node:os';

export function isPrivateIpv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
}

export function wifiAddress(interfaces = networkInterfaces()) {
  const entries = Object.entries(interfaces).sort(([a], [b]) =>
    Number(b === 'en0' || b === 'wlan0') - Number(a === 'en0' || a === 'wlan0'));
  for (const [name, addresses] of entries) {
    if (/^(utun|tun|docker|veth|lo)/.test(name)) continue;
    const candidate = addresses?.find(address => !address.internal && address.family === 'IPv4' && isPrivateIpv4(address.address));
    if (candidate) return candidate.address;
  }
  throw new Error('No local network address found. Connect to Wi-Fi or set PHONE_ORIGIN explicitly.');
}

export function validatePhoneOrigin(value) {
  const origin = new URL(value);
  if (origin.origin !== value || origin.username || origin.password
      || !['http:', 'https:'].includes(origin.protocol)
      || origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && !isPrivateIpv4(origin.hostname)) {
    throw new Error('PHONE_ORIGIN must be an exact HTTPS, loopback, or private-network HTTP origin');
  }
  return value;
}
