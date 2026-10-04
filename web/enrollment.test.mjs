import test from 'node:test';
import assert from 'node:assert/strict';
import {enrollmentUrl, enrollmentSvg, EnrollmentQr} from './enrollment.mjs';

const origin = 'http://localhost:5173';
const pairing = (code = 'temporary-code', expiresAt = 1000) => ({pairingCode: code, expiresAt});

function fixture(encode) {
  const container = {hidden: true, innerHTML: '', replaceChildren() {this.innerHTML = '';}};
  const message = {textContent: ''};
  const codeInput = {value: ''};
  const originInput = {value: ''};
  const manual = {open: false};
  const qr = new EnrollmentQr({container, message, codeInput, originInput, manual, encode});
  return {qr, container, message, codeInput, originInput, manual};
}

test('QR link encodes exactly the version, origin and temporary code', () => {
  const code = 'code+/=&?%';
  const url = new URL(enrollmentUrl('https://login.example:8443', code));
  assert.equal(url.protocol, 'nearkey:');
  assert.equal(url.hostname, 'enroll');
  assert.deepEqual([...url.searchParams], [
    ['v', '1'], ['origin', 'https://login.example:8443'], ['code', code],
  ]);
});

test('QR SVG has an accessible title, black modules and a four-module white quiet zone', () => {
  const svg = enrollmentSvg(enrollmentUrl(origin, 'a'.repeat(43)));
  assert.match(svg, /role="img" aria-labelledby="enrollment-qr-title"/);
  assert.match(svg, /<title id="enrollment-qr-title">Scan to enroll your phone with Nearkey<\/title>/);
  assert.match(svg, /fill="white"/);
  assert.match(svg, /fill="black"/);
  const size = Number(svg.match(/viewBox="0 0 (\d+) \d+"/)[1]);
  const positions = [...svg.matchAll(/M(\d+),(\d+)l4,0 0,4/g)].map(match => [Number(match[1]), Number(match[2])]);
  assert.ok(positions.length > 100);
  assert.equal(Math.min(...positions.flat()), 16);
  assert.equal(Math.max(...positions.flat()) + 4, size - 16);
});

test('repeated status polls reuse a QR; a fresh code replaces the old secret', () => {
  const calls = [];
  const f = fixture(url => {calls.push(url); return `<svg>${url}</svg>`;});
  f.qr.render(pairing('first'), origin, 0);
  f.manual.open = true;
  f.qr.render(pairing('first'), origin, 500);
  assert.equal(calls.length, 1);
  assert.equal(f.manual.open, true);
  f.qr.render(pairing('second'), origin, 500);
  assert.equal(calls.length, 2);
  assert.equal(f.manual.open, false);
  assert.equal(f.codeInput.value, 'second');
  assert.equal(f.container.innerHTML.includes('first'), false);
});

test('expiry clears QR and manual fields at the precise deadline, including later polls', () => {
  const f = fixture(url => `<svg>${url}</svg>`);
  f.qr.render(pairing(), origin, 999);
  assert.equal(f.container.hidden, false);
  assert.equal(f.originInput.value, origin);
  f.qr.render(pairing(), origin, 1000);
  assert.equal(f.container.hidden, true);
  assert.equal(f.container.innerHTML, '');
  assert.equal(f.codeInput.value, '');
  assert.equal(f.originInput.value, '');
  assert.match(f.message.textContent, /expired/);
  f.qr.render(pairing(), origin, 2000);
  assert.equal(f.container.innerHTML, '');
});

test('enrollment, logout or page disposal removes all rendered enrollment material', () => {
  const f = fixture(url => `<svg>${url}</svg>`);
  f.qr.render(pairing(), origin, 0);
  f.qr.render(null, origin, 0);
  assert.equal(f.container.hidden, true);
  assert.equal(f.container.innerHTML, '');
  assert.equal(f.codeInput.value, '');
  assert.equal(f.originInput.value, '');
  assert.equal(f.message.textContent, '');
  f.qr.render(pairing('fresh'), origin, 0);
  f.qr.clear();
  assert.equal(f.container.innerHTML, '');
  assert.equal(f.codeInput.value, '');
});

test('encoder failure provides manual fallback and retries only for a fresh code', () => {
  let calls = 0;
  const f = fixture(() => {calls++; throw new Error('cannot encode');});
  f.qr.render(pairing(), origin, 0);
  f.qr.render(pairing(), origin, 500);
  assert.equal(calls, 1);
  assert.equal(f.container.hidden, true);
  assert.equal(f.container.innerHTML, '');
  assert.equal(f.manual.open, true);
  assert.equal(f.codeInput.value, 'temporary-code');
  assert.match(f.message.textContent, /Enter the details/);
  f.qr.render(pairing('fresh'), origin, 500);
  assert.equal(calls, 2);
});
