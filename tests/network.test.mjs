import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePhoneOrigin, wifiAddress} from '../server/network.mjs';

test('phone HTTP origins are restricted to loopback and private IPv4 networks', () => {
  for (const value of ['http://localhost:5173', 'http://[::1]:5173', 'http://10.1.2.3:5173',
    'http://172.16.7.150:5173', 'http://192.168.1.2:5173', 'https://auth.example']) {
    assert.equal(validatePhoneOrigin(value), value);
  }
  for (const value of ['http://8.8.8.8', 'http://172.15.1.1', 'http://172.32.1.1',
    'http://192.169.1.1', 'http://auth.example', 'http://192.168.1.2/path',
    'http://192.168.1.2/', 'http://user:password@192.168.1.2', 'http://192.168.1.2?x=1',
    'file:///tmp', 'ws://192.168.1.2']) {
    assert.throws(() => validatePhoneOrigin(value), value);
  }
});

test('Wi-Fi address selection prefers the physical network and skips VPN and loopback', () => {
  const address = (ip, internal = false) => ({address: ip, family: 'IPv4', internal});
  const interfaces = {utun0: [address('10.0.0.2')], lo0: [address('127.0.0.1', true)],
    en1: [address('192.168.2.3')], en0: [address('172.16.7.150')]};
  assert.equal(wifiAddress(interfaces), '172.16.7.150');
  delete interfaces.en0;
  assert.equal(wifiAddress(interfaces), '192.168.2.3');
  assert.throws(() => wifiAddress({utun0: [address('10.0.0.2')], en0: [address('8.8.8.8')]}), /No local network address/);
});
