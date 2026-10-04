import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createApp, validateOrigin } from '../server/app.mjs';
import { parsePublicKey, parseSignature } from '../server/crypto.mjs';
import { approvalText, enrollmentText, CHALLENGE_TTL_MS } from '../shared/protocol.mjs';

const ORIGIN = 'http://localhost:5173';
const keyPair = (curve = 'prime256v1') => {
  const pair = generateKeyPairSync('ec', {namedCurve: curve});
  return {...pair, encoded: pair.publicKey.export({format: 'der', type: 'spki'}).toString('base64url')};
};
const signature = (pair, text, dsaEncoding = 'der') => sign('sha256', Buffer.from(text, 'utf8'),
  {key: pair.privateKey, dsaEncoding}).toString('base64url');
const proof = (pair, challenge) => signature(pair, approvalText(challenge));

class Inbox {
  constructor(ws) {
    this.messages = [];
    this.waiters = [];
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      const waiter = this.waiters.shift();
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(message); }
      else this.messages.push(message);
    });
  }
  next() {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    return new Promise((resolve, reject) => {
      const waiter = {resolve, timer: setTimeout(() => reject(new Error('WS message timeout')), 2000)};
      this.waiters.push(waiter);
    });
  }
}

async function fixture(t, options = {}) {
  const {initialTime = 1_800_000_000_000, ...appOptions} = options;
  let time = initialTime;
  const app = await createApp({now: () => time, ...appOptions});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(route, {method = 'GET', body, cookie, token, headers = {}} = {}) {
    const merged = {...(method !== 'GET' ? {'Content-Type': 'application/json', Origin: ORIGIN} : {}),
      ...(cookie ? {Cookie: cookie} : {}), ...(token ? {Authorization: `Bearer ${token}`} : {}), ...headers};
    if (token || route === '/api/phones/enroll') delete merged.Origin;
    const response = await fetch(base + route, {method, headers: merged,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)});
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return {status: response.status, data, headers: response.headers};
  }
  async function login() {
    const result = await request('/api/login', {method: 'POST', body: {username: 'demo', password: 'demo-passive-key'}});
    assert.equal(result.status, 200);
    return result.headers.get('set-cookie').split(';')[0];
  }
  async function pair(cookie = undefined, pair = keyPair()) {
    cookie ||= await login();
    const pairing = await request('/api/pairing', {method: 'POST', body: {}, cookie});
    assert.equal(pairing.status, 200);
    const body = {pairingCode: pairing.data.pairingCode, publicKey: pair.encoded, label: 'Android phone',
      signature: signature(pair, enrollmentText(pairing.data.pairingCode, pair.encoded))};
    const enrolled = await request('/api/phones/enroll', {method: 'POST', body});
    assert.equal(enrolled.status, 200);
    return {cookie, pair, ...enrolled.data, pairing: pairing.data, enrollment: body};
  }
  async function connect(token) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/phone-channel',
      {headers: {Authorization: `Bearer ${token}`}});
    ws.on('error', () => {});
    const inbox = new Inbox(ws);
    await once(ws, 'open');
    const ready = await inbox.next();
    assert.equal(ready.type, 'ready');
    return {ws, inbox, ready};
  }
  async function enrolled() {
    const phone = await pair();
    return {...phone, ...await connect(phone.deviceToken)};
  }
  async function challenge(phone) {
    const result = await request('/api/challenges', {method: 'POST', cookie: phone.cookie, body: {}});
    assert.equal(result.status, 200);
    assert.equal(result.data.status, 'waiting_phone');
    return result.data.challenge;
  }
  const complete = (phone, challenge, changes = {}) => request(`/api/challenges/${challenge.id}/complete`,
    {method: 'POST', cookie: phone.cookie, body: {signature: proof(phone.pair, challenge), ...changes}});
  const get = (phone, challenge) => request(`/api/challenges/${challenge.id}`, {cookie: phone.cookie});
  return {app, base, request, login, pair, connect, enrolled, challenge, complete, get,
    advance: (ms) => { time += ms; }, time: () => time};
}

async function rejectUpgrade(base, route, headers, expected) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + route, {headers});
  ws.on('error', () => {});
  const result = await new Promise((resolve, reject) => {
    ws.on('open', () => { ws.terminate(); reject(new Error('Upgrade unexpectedly accepted')); });
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
    ws.on('error', reject);
  });
  ws.terminate();
  assert.equal(result, expected);
}

function streamedPost(base, route, cookie, firstChunk) {
  const url = new URL(base + route);
  let req;
  const result = new Promise((resolve, reject) => {
    req = http.request(url, {method: 'POST', headers: {Origin: ORIGIN, Cookie: cookie,
      'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked'}}, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, data: JSON.parse(Buffer.concat(chunks))}));
    });
    req.on('error', reject);
    req.write(firstChunk);
  });
  return {req, result};
}

const waitTurn = () => new Promise((resolve) => setTimeout(resolve, 25));

function replacementEnrollment(pairing, pair = keyPair()) {
  return {pair, body: {pairingCode: pairing.pairingCode, publicKey: pair.encoded, label: 'Replacement phone',
    signature: signature(pair, enrollmentText(pairing.pairingCode, pair.encoded))}};
}

test('phone replacement requires an existing verified session and re-verifies the new phone', async (t) => {
  const f = await fixture(t);
  const replace = (cookie) => f.request('/api/phones/replacement', {method: 'POST', body: {}, cookie});
  assert.equal((await replace()).status, 401);
  const old = await f.enrolled();
  assert.equal((await replace(old.cookie)).status, 403);
  await f.complete(old, await f.challenge(old));
  const saved = await f.request('/api/apps', {method: 'POST', cookie: old.cookie, body: {name: 'Saved app'}});
  const second = {...old, cookie: await f.login()};
  await f.complete(second, await f.challenge(second));
  const pendingBrowser = {...old, cookie: await f.login()};
  const oldChallenge = await f.challenge(pendingBrowser);
  const ticket = await replace(old.cookie);
  assert.equal(ticket.status, 200);
  assert.equal((await f.request('/api/account', {cookie: old.cookie})).data.phone.id, old.phoneId);
  assert.equal((await f.request('/api/account', {cookie: old.cookie})).data.phone.online, true);
  assert.deepEqual((await f.request('/api/session', {cookie: old.cookie})).data.setup.replacement,
    {pairingId: ticket.data.pairingId, expiresAt: ticket.data.expiresAt});
  assert.equal((await f.request('/api/session', {cookie: second.cookie})).data.setup.replacement, undefined);
  const next = replacementEnrollment(ticket.data);
  const closed = once(old.ws, 'close');
  const result = await f.request('/api/phones/enroll', {method: 'POST', body: next.body});
  assert.equal(result.status, 200);
  await closed;
  assert.notEqual(result.data.phoneId, old.phoneId);
  assert.notEqual(result.data.deviceToken, old.deviceToken);
  const state = (await f.request('/api/session', {cookie: old.cookie})).data;
  assert.equal(state.authenticated, false);
  assert.equal(state.pending, true);
  assert.equal(state.setup.phone.id, result.data.phoneId);
  assert.equal(state.setup.replacement, undefined);
  assert.equal((await f.request('/api/account', {cookie: old.cookie})).status, 403);
  assert.equal((await f.request('/api/apps', {method: 'POST', cookie: old.cookie, body: {name: 'Premature'}})).status, 403);
  assert.equal((await f.request('/api/session', {cookie: second.cookie})).data.pending, false);
  assert.equal((await f.request('/api/account', {cookie: second.cookie})).status, 401);
  assert.equal((await f.request('/api/challenges/' + oldChallenge.id, {cookie: pendingBrowser.cookie})).status, 401);
  assert.equal((await f.request(`/api/phone/challenges/${oldChallenge.id}/ready`,
    {method: 'POST', token: old.deviceToken, body: {}})).status, 401);
  await rejectUpgrade(f.base, '/api/phone-channel', {Authorization: `Bearer ${old.deviceToken}`}, 401);
  assert.equal((await f.request('/api/phones/enroll', {method: 'POST', body: next.body})).status, 409);
  const fresh = {cookie: old.cookie, pair: next.pair, ...result.data, ...await f.connect(result.data.deviceToken)};
  const challenge = await f.challenge(fresh);
  assert.equal(challenge.phoneId, fresh.phoneId);
  assert.equal((await f.complete({...fresh, pair: old.pair}, challenge)).status, 403);
  assert.equal((await f.complete(fresh, challenge)).status, 200);
  assert.deepEqual((await f.request('/api/account', {cookie: fresh.cookie})).data.apps, [saved.data.app]);
});

test('cancelled, expired and invalid replacement setup leaves the old phone usable', async (t) => {
  const f = await fixture(t);
  const old = await f.enrolled();
  await f.complete(old, await f.challenge(old));
  const replace = () => f.request('/api/phones/replacement', {method: 'POST', body: {}, cookie: old.cookie});
  const first = replacementEnrollment((await replace()).data);
  assert.equal((await f.request('/api/phones/enroll', {method: 'POST',
    body: {...first.body, signature: signature(keyPair(), 'invalid')}})).status, 400);
  assert.equal((await f.request('/api/account', {cookie: old.cookie})).data.phone.id, old.phoneId);
  assert.equal((await f.request('/api/phones/replacement/cancel', {method: 'POST', body: {}, cookie: old.cookie})).status, 200);
  assert.equal((await f.request('/api/phones/enroll', {method: 'POST', body: first.body})).status, 409);
  const expired = replacementEnrollment((await replace()).data);
  f.advance(5 * 60_000);
  assert.equal((await f.request('/api/phones/enroll', {method: 'POST', body: expired.body})).status, 409);
  assert.equal((await f.request('/api/account', {cookie: old.cookie})).data.phone.online, true);
  const later = {...old, cookie: await f.login()};
  assert.equal((await f.complete(later, await f.challenge(later))).status, 200);
  assert.equal((await f.request('/api/account', {cookie: later.cookie})).data.phone.id, old.phoneId);
});

test('two verified browsers cannot cancel each other or consume superseded replacement tickets', async (t) => {
  const f = await fixture(t);
  const old = await f.enrolled();
  await f.complete(old, await f.challenge(old));
  const second = {...old, cookie: await f.login()};
  await f.complete(second, await f.challenge(second));
  const replace = (cookie) => f.request('/api/phones/replacement', {method: 'POST', body: {}, cookie});
  const first = replacementEnrollment((await replace(old.cookie)).data);
  const latest = replacementEnrollment((await replace(second.cookie)).data);
  await f.request('/api/phones/replacement/cancel', {method: 'POST', body: {}, cookie: old.cookie});
  assert.equal((await f.request('/api/session', {cookie: old.cookie})).data.setup.replacement, undefined);
  assert.ok((await f.request('/api/session', {cookie: second.cookie})).data.setup.replacement);
  assert.equal((await f.request('/api/phones/enroll', {method: 'POST', body: first.body})).status, 401);
  const results = await Promise.all([first, latest].map(({body}) =>
    f.request('/api/phones/enroll', {method: 'POST', body})));
  assert.notEqual(results[0].status, 200);
  assert.equal(results[1].status, 200);
  assert.equal((await f.request('/api/account', {cookie: old.cookie})).status, 401);
  assert.equal((await f.request('/api/account', {cookie: second.cookie})).status, 403);
});

test('replacement creation and cancellation recheck authorization after body upload', async (t) => {
  const f = await fixture(t);
  const old = await f.enrolled();
  await f.complete(old, await f.challenge(old));
  const upload = streamedPost(f.base, '/api/phones/replacement', old.cookie, '{');
  await waitTurn();
  f.advance(8 * 60 * 60_000);
  upload.req.end('}');
  assert.equal((await upload.result).status, 401);
  const current = {...old, cookie: await f.login()};
  await f.complete(current, await f.challenge(current));
  const ticket = await f.request('/api/phones/replacement', {method: 'POST', body: {}, cookie: current.cookie});
  const cancel = streamedPost(f.base, '/api/phones/replacement/cancel', current.cookie, '{');
  await waitTurn();
  await f.request('/api/logout', {method: 'POST', body: {}, cookie: current.cookie});
  cancel.req.end('}');
  assert.equal((await cancel.result).status, 401);
  assert.equal((await f.request('/api/phones/enroll', {method: 'POST', body: replacementEnrollment(ticket.data).body})).status, 409);
  assert.equal((await f.request('/api/session', {cookie: await f.login()})).data.setup.phone.id, old.phoneId);
});

test('wire texts, real DER signatures and canonical SPKI enforce the shared contract', () => {
  assert.equal(approvalText({id: 'id', nonce: 'nonce', phoneId: 'phone', expiresAt: 123,
    username: 'demo', serviceName: 'NearKey', sessionId: 'session'}),
  'NEARKEY-LOGIN-V2\nid\nnonce\nphone\n123\ndemo\nNearKey\nsession');
  assert.equal(enrollmentText('code', 'key'), 'NEARKEY-ENROLL-V1\ncode\nkey');
  const pair = keyPair();
  assert.equal(parsePublicKey(pair.encoded).asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.ok(parseSignature(signature(pair, 'text')).length <= 72);
  assert.throws(() => parseSignature(signature(pair, 'text', 'ieee-p1363')));
  assert.throws(() => parseSignature(Buffer.from([0x30, 6, 2, 1, 0, 2, 1, 1]).toString('base64url')));
  assert.throws(() => parseSignature(Buffer.from([0x30, 7, 2, 2, 0, 1, 2, 1, 1]).toString('base64url')));
});

test('password verifies only first factor; pending session cannot access provider dashboard', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/session')).data, {authenticated: false, pending: false,
    user: null, setup: null, challenge: null, challengeStatus: null});
  assert.equal((await f.request('/api/account')).status, 401);
  const body = {username: 'demo', password: 'wrong'};
  assert.equal((await f.request('/api/login', {method: 'POST', body})).status, 401);
  for (const origin of ['', 'https://evil.example', 'null']) {
    assert.equal((await f.request('/api/login', {method: 'POST', body, headers: {Origin: origin}})).status, 403);
  }
  assert.equal((await f.request('/api/login', {method: 'POST', body, headers: {'Sec-Fetch-Site': 'cross-site'}})).status, 403);
  const login = await f.request('/api/login', {method: 'POST', body: {username: 'demo', password: 'demo-passive-key'}});
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=28800/);
  assert.ok(!login.headers.get('set-cookie').includes('Secure'));
  assert.equal(login.data.authenticated, false);
  assert.equal(login.data.pending, true);
  assert.equal(login.data.user, null);
  assert.deepEqual(login.data.setup, {phone: null});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request('/api/session', {cookie})).data.authenticated, false);
  assert.equal((await f.request('/api/session', {cookie})).data.pending, true);
  const account = await f.request('/api/account', {cookie});
  assert.equal(account.status, 403);
  assert.equal(account.data.error, 'verification_required');
  assert.equal((await f.request('/api/account', {cookie, headers: {Origin: 'https://evil.example'}})).status, 403);
  assert.equal((await f.request('/api/pairing', {method: 'POST', body: {}, cookie, headers: {Origin: ''}})).status, 403);
  assert.equal((await f.request('/api/account', {headers: {Cookie: `${cookie}; ${cookie}`}})).status, 401);
});

test('app entries require both login factors and persist across later verified logins', async (t) => {
  const f = await fixture(t);
  const add = (body, cookie) => f.request('/api/apps', {method: 'POST', body, cookie});
  assert.equal((await add({name: 'Work'})).status, 401);
  const phone = await f.enrolled();
  assert.equal((await add({name: 'Work'}, phone.cookie)).status, 403);
  assert.equal((await f.complete(phone, await f.challenge(phone))).status, 200);
  assert.deepEqual((await f.request('/api/account', {cookie: phone.cookie})).data.apps, []);
  const saved = await add({name: '  Work account  ', url: ' HTTPS://EXAMPLE.COM/work '}, phone.cookie);
  assert.equal(saved.status, 201);
  assert.match(saved.data.app.id, /^[a-f0-9-]{36}$/);
  assert.equal(saved.data.app.name, 'Work account');
  assert.equal(saved.data.app.url, 'https://example.com/work');
  assert.equal(saved.data.app.createdAt, f.time());
  const local = await add({name: 'Local tools', url: 'http://localhost:3000'}, phone.cookie);
  assert.equal(local.status, 201);
  assert.equal(local.data.app.url, 'http://localhost:3000/');
  assert.notEqual(local.data.app.id, saved.data.app.id);
  const account = (await f.request('/api/account', {cookie: phone.cookie})).data;
  assert.deepEqual(account.apps, [saved.data.app, local.data.app]);
  assert.equal((await add({name: 'Offline notes'}, phone.cookie)).status, 201);
  const rejectedOrigin = await f.request('/api/apps', {method: 'POST', cookie: phone.cookie,
    body: {name: 'Cross-site'}, headers: {Origin: 'https://other.example'}});
  assert.equal(rejectedOrigin.status, 403);
  await f.request('/api/logout', {method: 'POST', cookie: phone.cookie, body: {}});
  assert.equal((await add({name: 'After logout'}, phone.cookie)).status, 401);
  phone.cookie = await f.login();
  assert.equal((await f.request('/api/account', {cookie: phone.cookie})).status, 403);
  assert.equal((await f.complete(phone, await f.challenge(phone))).status, 200);
  const restored = (await f.request('/api/account', {cookie: phone.cookie})).data.apps;
  assert.deepEqual(restored.slice(0, 2), account.apps);
  assert.equal(restored.length, 3);
  assert.equal(restored[2].url, null);
});

test('app metadata rejects unsafe values and duplicate entries without changing the list', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  await f.complete(phone, await f.challenge(phone));
  const add = (body) => f.request('/api/apps', {method: 'POST', body, cookie: phone.cookie});
  for (const body of [null, [], {}, {url: 'https://example.com'}, {name: 1}, {name: ' '},
    {name: 'x'.repeat(81)}, {name: 'Work\naccount'}, {name: 'Work', extra: true},
    {name: 'Work', url: null}, {name: 'Work', url: 1}]) {
    assert.equal((await add(body)).status, 400);
  }
  for (const url of ['example.com', '//example.com', 'https:example.com', 'ftp://example.com',
    'javascript:alert(1)', 'https://user:password@example.com', 'https://example.com/#settings',
    'https://example.com/#', 'https://example.com/a b', 'https://example.com/\n',
    'https://example.com/%zz', 'https://example.com/' + 'x'.repeat(2048)]) {
    assert.equal((await add({name: 'Work', url})).status, 400, url);
  }
  assert.deepEqual((await f.request('/api/account', {cookie: phone.cookie})).data.apps, []);
  assert.equal((await add({name: 'Work', url: 'https://example.com'})).status, 201);
  const duplicate = await add({name: ' work ', url: 'HTTPS://EXAMPLE.COM/'});
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error, 'app_exists');
  assert.equal((await add({name: 'Work', url: 'https://different.example'})).status, 201);
  assert.equal((await add({name: 'Notes', url: ''})).status, 201);
  assert.equal((await add({name: 'notes'})).status, 409);
  assert.equal((await f.request('/api/account', {cookie: phone.cookie})).data.apps.length, 3);
});

test('app list is bounded and expired uploads cannot add entries', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  await f.complete(phone, await f.challenge(phone));
  for (let index = 0; index < 30; index++) {
    const result = await f.request('/api/apps', {method: 'POST', cookie: phone.cookie, body: {name: `App ${index}`}});
    assert.equal(result.status, 201);
  }
  const overflow = await f.request('/api/apps', {method: 'POST', cookie: phone.cookie, body: {name: 'App 31'}});
  assert.equal(overflow.status, 409);
  assert.equal(overflow.data.error, 'app_limit');
  assert.equal((await f.request('/api/account', {cookie: phone.cookie})).data.apps.length, 30);
  const upload = streamedPost(f.base, '/api/apps', phone.cookie, '{"name":"Late');
  await new Promise((resolve) => setTimeout(resolve, 30));
  f.advance(8 * 60 * 60_000);
  upload.req.end(' app"}');
  assert.equal((await upload.result).status, 401);
  assert.equal((await f.request('/api/account', {cookie: phone.cookie})).status, 401);
  phone.cookie = await f.login();
  await f.complete(phone, await f.challenge(phone));
  assert.equal((await f.request('/api/account', {cookie: phone.cookie})).data.apps.length, 30);
});

test('configuration rejects unsafe origins and sets Secure on HTTPS sessions', async (t) => {
  for (const value of ['http://192.168.1.2:5173', 'https://auth.example/path', 'https://auth.example/',
    'https://user:password@auth.example', 'file:///tmp', 'http://localhost.evil']) assert.throws(() => validateOrigin(value));
  assert.equal(validateOrigin('http://[::1]:5173'), 'http://[::1]:5173');
  const f = await fixture(t, {publicOrigin: 'https://auth.example'});
  const result = await f.request('/api/login', {method: 'POST', body: {username: 'demo', password: 'demo-passive-key'},
    headers: {Origin: 'https://auth.example'}});
  assert.equal(result.status, 200);
  assert.match(result.headers.get('set-cookie'), /; Secure$/);
});

test('trusted pairing validates real proof, canonical curve/key and bounded labels', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const pairing = (await f.request('/api/pairing', {method: 'POST', body: {}, cookie})).data;
  assert.equal(pairing.expiresAt, f.time() + 300000);
  assert.equal(Buffer.from(pairing.pairingCode, 'base64url').length, 32);
  const pair = keyPair();
  const body = {pairingCode: pairing.pairingCode, publicKey: pair.encoded, label: 'Pixel',
    signature: signature(pair, enrollmentText(pairing.pairingCode, pair.encoded))};
  assert.equal((await f.request('/api/phones/enroll', {method: 'POST', body: {...body,
    signature: signature(keyPair(), enrollmentText(body.pairingCode, body.publicKey))}})).status, 400);
  for (const publicKey of [pair.encoded + '=', '!', keyPair('secp384r1').encoded,
    generateKeyPairSync('ed25519').publicKey.export({format: 'der', type: 'spki'}).toString('base64url'),
    Buffer.concat([Buffer.from(pair.encoded, 'base64url'), Buffer.from([0])]).toString('base64url')]) {
    assert.equal((await f.request('/api/phones/enroll', {method: 'POST', body: {...body, publicKey}})).status, 400);
  }
  for (const label of ['', 'x'.repeat(41)]) {
    assert.equal((await f.request('/api/phones/enroll', {method: 'POST', body: {...body, label}})).status, 400);
  }
  f.advance(60001); // reset the credential attempt budget without expiring pairing
  assert.equal((await f.request('/api/phones/enroll', {method: 'POST', body})).status, 200);
});

test('pairing is single-use, session-bound and cannot replace an existing phone', async (t) => {
  const f = await fixture(t);
  const phone = await f.pair();
  assert.equal(Buffer.from(phone.deviceToken, 'base64url').length, 32);
  assert.equal((await f.request('/api/pairing', {method: 'POST', body: {}, cookie: phone.cookie})).status, 409);
  const otherSession = await f.login();
  assert.equal((await f.request('/api/pairing', {method: 'POST', body: {}, cookie: otherSession})).status, 409);
  assert.equal((await f.request('/api/phones/enroll', {method: 'POST', body: phone.enrollment})).status, 409);
  assert.equal((await f.request('/api/phones/' + phone.phoneId, {method: 'DELETE', cookie: phone.cookie})).status, 404);
  assert.equal((await f.request('/api/account', {token: phone.deviceToken})).status, 401);
  assert.equal((await f.request('/api/challenges', {method: 'POST', token: phone.deviceToken,
    body: {}, headers: {origin: ORIGIN}})).status, 401);
});

test('superseded/expired/logout pairing codes and wrong enrollment domains cannot enroll', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const old = (await f.request('/api/pairing', {method: 'POST', body: {}, cookie})).data;
  const current = (await f.request('/api/pairing', {method: 'POST', body: {}, cookie})).data;
  const pair = keyPair();
  const bodyFor = (code) => ({pairingCode: code, publicKey: pair.encoded, label: 'Pixel',
    signature: signature(pair, enrollmentText(code, pair.encoded))});
  assert.equal((await f.request('/api/phones/enroll', {method: 'POST', body: bodyFor(old.pairingCode)})).status, 401);
  assert.equal((await f.request('/api/phones/enroll', {method: 'POST', body: {...bodyFor(current.pairingCode),
    signature: signature(pair, approvalText({id: current.pairingId, nonce: current.pairingCode}))}})).status, 400);
  f.advance(300000);
  assert.equal((await f.request('/api/phones/enroll', {method: 'POST', body: bodyFor(current.pairingCode)})).status, 401);
  const last = (await f.request('/api/pairing', {method: 'POST', body: {}, cookie})).data;
  await f.request('/api/logout', {method: 'POST', body: {}, cookie});
  assert.equal((await f.request('/api/phones/enroll', {method: 'POST', body: bodyFor(last.pairingCode)})).status, 401);
});

test('full HTTP/WS/DER happy path, readiness, immutable metadata and credential non-leakage', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  assert.deepEqual(phone.ready, {type: 'ready', phoneId: phone.phoneId});
  const challenge = await f.challenge(phone);
  assert.equal(challenge.v, 2);
  assert.equal(challenge.purpose, 'login');
  assert.equal(challenge.serviceName, 'NearKey');
  assert.equal(challenge.username, 'demo');
  assert.equal(Buffer.from(challenge.sessionId, 'base64url').length, 32);
  assert.equal((await f.request('/api/account', {cookie: phone.cookie})).status, 403);
  assert.equal(challenge.phoneId, phone.phoneId);
  assert.equal(challenge.expiresAt, f.time() + CHALLENGE_TTL_MS);
  assert.equal(Buffer.from(challenge.nonce, 'base64url').length, 32);
  const delivered = await phone.inbox.next();
  assert.deepEqual(delivered, {type: 'challenge', challenge});
  const before = (await f.get(phone, challenge)).data;
  assert.equal(before.phoneReady, false);
  const ready = await f.request(`/api/phone/challenges/${challenge.id}/ready`, {method: 'POST', token: phone.deviceToken, body: {}});
  assert.equal(ready.status, 200);
  const after = (await f.get(phone, challenge)).data;
  assert.equal(after.phoneReady, true);
  assert.equal(after.status, 'waiting_bluetooth');
  assert.equal(after.challenge.expiresAt, challenge.expiresAt);
  const result = await f.complete(phone, challenge);
  assert.equal(result.status, 200);
  assert.equal(result.data.status, 'approved');
  assert.deepEqual(await phone.inbox.next(), {type: 'cancel', challengeId: challenge.id});
  assert.equal(result.data.authenticated, true);
  assert.equal(result.headers.get('set-cookie').split(';')[0], phone.cookie);
  assert.match(result.headers.get('set-cookie'), /Max-Age=28800/);
  assert.equal(result.data.receipt.serviceName, challenge.serviceName);
  assert.equal(result.data.receipt.verifiedAt, f.time());
  assert.equal((await f.request('/api/session', {cookie: phone.cookie})).data.authenticated, true);
  assert.equal((await f.request('/api/challenges', {method: 'POST', cookie: phone.cookie, body: {}})).status, 409);
  const account = (await f.request('/api/account', {cookie: phone.cookie})).data;
  assert.equal(account.activity.length, 1);
  assert.equal(account.activity[0].username, 'demo');
  assert.deepEqual(account.phone, {id: phone.phoneId, label: 'Android phone', online: true});
  assert.equal((await f.get(phone, challenge)).data.status, 'approved');
  for (const exposed of [account, delivered, phone.ready, challenge, result.data]) {
    const text = JSON.stringify(exposed);
    assert.ok(!text.includes(phone.deviceToken));
    assert.ok(!text.includes(phone.pair.encoded));
    assert.ok(!text.includes('deviceToken'));
  }
  assert.equal((await f.request(`/api/phone/challenges/${challenge.id}/ready`, {method: 'POST', token: phone.deviceToken, body: {}})).status, 409);
});

test('one creating session exclusively owns read/cancel/complete, not phone bearer', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  const challenge = await f.challenge(phone);
  const cookie = await f.login();
  assert.equal((await f.request(`/api/challenges/${challenge.id}`, {cookie})).status, 404);
  for (const action of ['complete', 'cancel']) {
    assert.equal((await f.request(`/api/challenges/${challenge.id}/${action}`, {method: 'POST', cookie,
      body: action === 'complete' ? {signature: proof(phone.pair, challenge)} : {}})).status, 404);
  }
  assert.equal((await f.request(`/api/phone/challenges/${challenge.id}/ready`, {method: 'POST', cookie: phone.cookie, body: {}})).status, 403);
  assert.equal((await f.complete(phone, challenge)).status, 200);
});

test('wrong real key/nonce/id/domain and tampered metadata never authorize', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  const challenge = await f.challenge(phone);
  for (const bad of [proof(keyPair(), challenge), proof(phone.pair, {...challenge, nonce: 'wrong'}),
    proof(phone.pair, {...challenge, id: 'wrong'}), proof(phone.pair, {...challenge, sessionId: 'wrong'}),
    proof(phone.pair, {...challenge, username: 'other'}), proof(phone.pair, {...challenge, phoneId: 'other'}),
    proof(phone.pair, {...challenge, expiresAt: challenge.expiresAt + 1}),
    proof(phone.pair, {...challenge, serviceName: 'Other'}), signature(phone.pair, `NEARKEY-LOGIN-V2\r\n${challenge.id}\r\n${challenge.nonce}`)]) {
    assert.equal((await f.complete(phone, challenge, {signature: bad})).status, 403);
  }
  for (const extra of [{nonce: challenge.nonce}, {phoneId: phone.phoneId}, {publicKey: phone.pair.encoded},
    {sessionId: challenge.sessionId}, {username: 'other'}, {serviceName: 'Other'},
    {expiresAt: challenge.expiresAt + 1}, {purpose: 'login'}]) {
    assert.equal((await f.complete(phone, challenge, extra)).status, 400);
  }
  const local = structuredClone(challenge);
  local.serviceName = 'Attacker changed view';
  const result = await f.complete(phone, local);
  assert.equal(result.status, 403);
  assert.equal((await f.request('/api/account', {cookie: phone.cookie})).status, 403);
  const valid = await f.complete(phone, challenge);
  assert.equal(valid.status, 200);
  assert.equal(valid.data.receipt.serviceName, 'NearKey');
});

test('malformed signature encodings, non-DER and trailing bytes reject without authenticating', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  const challenge = await f.challenge(phone);
  const valid = proof(phone.pair, challenge);
  const trailing = Buffer.concat([Buffer.from(valid, 'base64url'), Buffer.from([0])]).toString('base64url');
  for (const bad of ['', '!', valid + '=', valid.replace(/./, '+'), null, 42, {}, 'A'.repeat(1000), trailing,
    signature(phone.pair, approvalText(challenge), 'ieee-p1363'),
    Buffer.from([0x30, 6, 2, 1, 0x80, 2, 1, 1]).toString('base64url')]) {
    assert.equal((await f.complete(phone, challenge, {signature: bad})).status, 400);
  }
  assert.equal((await f.request('/api/account', {cookie: phone.cookie})).status, 403);
  assert.equal((await f.complete(phone, challenge)).status, 200);
});

test('concurrent completion and replay authenticate exactly once, new challenge rejects old proof', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  const challenge = await f.challenge(phone);
  const results = await Promise.all([f.complete(phone, challenge), f.complete(phone, challenge), f.complete(phone, challenge)]);
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 409, 409]);
  assert.equal((await f.complete(phone, challenge)).status, 409);
  const account = (await f.request('/api/account', {cookie: phone.cookie})).data;
  phone.cookie = await f.login();
  const next = await f.challenge(phone);
  assert.equal((await f.complete(phone, next, {signature: proof(phone.pair, challenge)})).status, 403);
  assert.equal((await f.request('/api/account', {cookie: phone.cookie})).status, 403);
  assert.equal(account.activity.length, 1);
  assert.equal(account.activity[0].username, 'demo');
});

test('cancel and displaced request notify phone and invalidate signatures', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  const old = await f.challenge(phone);
  await phone.inbox.next();
  const current = await f.challenge(phone);
  assert.deepEqual(await phone.inbox.next(), {type: 'cancel', challengeId: old.id});
  assert.deepEqual(await phone.inbox.next(), {type: 'challenge', challenge: current});
  assert.equal((await f.get(phone, old)).data.status, 'cancelled');
  assert.equal((await f.complete(phone, old)).status, 409);
  assert.equal((await f.request(`/api/challenges/${current.id}/cancel`, {method: 'POST', cookie: phone.cookie, body: {}})).status, 200);
  assert.deepEqual(await phone.inbox.next(), {type: 'cancel', challengeId: current.id});
  assert.equal((await f.complete(phone, current)).status, 409);
  assert.equal((await f.request('/api/account', {cookie: phone.cookie})).status, 403);
});

test('absolute expiry cancels via maintenance timer, never extended by phone-ready', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  const challenge = await f.challenge(phone);
  await phone.inbox.next();
  f.advance(59999);
  assert.equal((await f.request(`/api/phone/challenges/${challenge.id}/ready`, {method: 'POST', token: phone.deviceToken, body: {}})).status, 200);
  assert.equal((await f.get(phone, challenge)).data.challenge.expiresAt, challenge.expiresAt);
  f.advance(1);
  assert.deepEqual(await phone.inbox.next(), {type: 'cancel', challengeId: challenge.id});
  assert.equal((await f.get(phone, challenge)).data.status, 'expired');
  assert.equal((await f.complete(phone, challenge)).status, 409);
  assert.equal((await f.request(`/api/phone/challenges/${challenge.id}/ready`, {method: 'POST', token: phone.deviceToken, body: {}})).status, 409);
});

test('logout revokes session and cancels pending phone without exposing/removing its credential', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  const challenge = await f.challenge(phone);
  await phone.inbox.next();
  const loggedOut = await f.request('/api/logout', {method: 'POST', cookie: phone.cookie, body: {}});
  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.headers.get('set-cookie'), /Max-Age=0/);
  assert.deepEqual(await phone.inbox.next(), {type: 'cancel', challengeId: challenge.id});
  assert.equal((await f.complete(phone, challenge)).status, 401);
  assert.equal((await f.request('/api/session', {cookie: phone.cookie})).data.authenticated, false);
  const cookie = await f.login();
  assert.equal((await f.request('/api/pairing', {method: 'POST', cookie, body: {}})).status, 409);
  assert.equal((await f.request('/api/account', {cookie})).status, 403);
});

test('expiry/logout during asynchronous body upload is rechecked before committing', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  let challenge = await f.challenge(phone);
  const upload = streamedPost(f.base, `/api/challenges/${challenge.id}/complete`, phone.cookie, '{"signature":"');
  await waitTurn();
  f.advance(60000);
  upload.req.end(proof(phone.pair, challenge) + '"}');
  assert.equal((await upload.result).status, 409);
  challenge = await f.challenge(phone);
  const second = streamedPost(f.base, `/api/challenges/${challenge.id}/complete`, phone.cookie, '{"signature":"');
  await waitTurn();
  await f.request('/api/logout', {method: 'POST', cookie: phone.cookie, body: {}});
  second.req.end(proof(phone.pair, challenge) + '"}');
  assert.equal((await second.result).status, 401);
  const cookie = await f.login();
  assert.equal((await f.request('/api/account', {cookie})).status, 403);
  assert.equal((await f.request('/api/session', {cookie})).data.pending, true);
});

test('session expiration and login rotation cancel original-session work', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  const challenge = await f.challenge(phone);
  await phone.inbox.next();
  const rotated = await f.request('/api/login', {method: 'POST', cookie: phone.cookie,
    body: {username: 'demo', password: 'demo-passive-key'}});
  assert.equal(rotated.status, 200);
  assert.deepEqual(await phone.inbox.next(), {type: 'cancel', challengeId: challenge.id});
  assert.equal((await f.complete(phone, challenge)).status, 401);
  phone.cookie = rotated.headers.get('set-cookie').split(';')[0];
  const next = await f.challenge(phone);
  await phone.inbox.next();
  f.advance(8 * 60 * 60000);
  assert.equal((await f.request('/api/session', {cookie: phone.cookie})).data.authenticated, false);
  assert.deepEqual(await phone.inbox.next(), {type: 'cancel', challengeId: next.id});
  assert.equal((await f.complete(phone, next)).status, 401);
});

test('pending login expires after ten minutes and proof grants a fresh eight-hour session', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  f.advance(9 * 60_000 + 59_999);
  assert.equal((await f.request('/api/session', {cookie: phone.cookie})).data.pending, true);
  f.advance(1);
  assert.equal((await f.request('/api/session', {cookie: phone.cookie})).data.pending, false);
  assert.equal((await f.request('/api/account', {cookie: phone.cookie})).status, 401);
  assert.equal((await f.request('/api/pairing', {method: 'POST', cookie: phone.cookie, body: {}})).status, 401);
  phone.cookie = await f.login();
  f.advance(9 * 60_000);
  const challenge = await f.challenge(phone);
  assert.equal((await f.complete(phone, challenge)).status, 200);
  f.advance(8 * 60 * 60_000 - 1);
  assert.equal((await f.request('/api/account', {cookie: phone.cookie})).status, 200);
  f.advance(1);
  assert.equal((await f.request('/api/account', {cookie: phone.cookie})).status, 401);
});

test('a valid verification at timestamp zero authenticates using the explicit pending sentinel', async (t) => {
  const f = await fixture(t, {initialTime: 0});
  const phone = await f.enrolled();
  const challenge = await f.challenge(phone);
  assert.equal((await f.complete(phone, challenge)).data.authenticated, true);
  assert.equal((await f.request('/api/session', {cookie: phone.cookie})).data.authenticated, true);
  assert.equal((await f.request('/api/account', {cookie: phone.cookie})).status, 200);
  assert.equal((await f.request('/api/challenges', {method: 'POST', cookie: phone.cookie, body: {}})).status, 409);
});

test('disconnect/reconnect only resends live challenge, resets readiness and keeps deadline', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  const challenge = await f.challenge(phone);
  await phone.inbox.next();
  await f.request(`/api/phone/challenges/${challenge.id}/ready`, {method: 'POST', token: phone.deviceToken, body: {}});
  const closed = once(phone.ws, 'close');
  phone.ws.close();
  await closed;
  await waitTurn();
  assert.equal((await f.request('/api/session', {cookie: phone.cookie})).data.setup.phone.online, false);
  assert.equal((await f.get(phone, challenge)).data.phoneReady, false);
  assert.equal((await f.request('/api/challenges', {method: 'POST', cookie: phone.cookie,
    body: {}})).status, 409);
  f.advance(1000);
  const connection = await f.connect(phone.deviceToken);
  assert.deepEqual(await connection.inbox.next(), {type: 'challenge', challenge});
  assert.equal((await f.get(phone, challenge)).data.status, 'waiting_phone');
  assert.equal((await f.get(phone, challenge)).data.challenge.expiresAt, challenge.expiresAt);
  assert.equal((await f.complete(phone, challenge)).status, 200);
  await connection.inbox.next();
  const closeAgain = once(connection.ws, 'close');
  connection.ws.close();
  await closeAgain;
  const after = await f.connect(phone.deviceToken);
  await waitTurn();
  assert.deepEqual(after.inbox.messages, []);
});

test('channel displacement cancels old peer and replays only live server state to new peer', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  const challenge = await f.challenge(phone);
  await phone.inbox.next();
  const oldClose = once(phone.ws, 'close');
  const fresh = await f.connect(phone.deviceToken);
  assert.deepEqual(await phone.inbox.next(), {type: 'cancel', challengeId: challenge.id});
  await oldClose;
  assert.deepEqual(await fresh.inbox.next(), {type: 'challenge', challenge});
  assert.equal((await f.request('/api/session', {cookie: phone.cookie})).data.setup.phone.online, true);
});

test('phone WebSocket requires header only, correct path, no browser Origin or query credentials', async (t) => {
  const f = await fixture(t);
  const phone = await f.pair();
  for (const [route, headers, status] of [
    ['/api/phone-channel', {}, 401],
    ['/api/phone-channel', {Cookie: phone.cookie}, 401],
    ['/api/phone-channel', {Authorization: 'Bearer wrong'}, 401],
    ['/api/phone-channel?deviceToken=' + phone.deviceToken, {}, 403],
    ['/wrong', {Authorization: `Bearer ${phone.deviceToken}`}, 403],
    ['/api/phone-channel', {Authorization: `Bearer ${phone.deviceToken}`, Origin: 'https://evil.example'}, 403],
    ['/api/phone-channel', {Authorization: `Bearer ${phone.deviceToken}`, Origin: ORIGIN}, 403],
  ]) await rejectUpgrade(f.base, route, headers, status);
  const connected = await f.connect(phone.deviceToken);
  connected.ws.send(JSON.stringify({type: 'ping'}));
  await waitTurn();
  assert.equal(connected.ws.readyState, WebSocket.OPEN);
});

test('WS rejects malformed/control/binary/oversized payloads and message flooding', async (t) => {
  const f = await fixture(t);
  const phone = await f.pair();
  for (const [message, code] of [['{', 1008], ['{"type":"approve"}', 1008],
    ['{"type":"ping","extra":true}', 1008], [Buffer.from('{"type":"ping"}'), 1008], ['x'.repeat(2049), 1009]]) {
    const connection = await f.connect(phone.deviceToken);
    const closed = once(connection.ws, 'close');
    connection.ws.send(message);
    const result = await closed;
    assert.equal(result[0], code);
  }
  const connection = await f.connect(phone.deviceToken);
  const closed = once(connection.ws, 'close');
  for (let i = 0; i < 61; i++) connection.ws.send('{"type":"ping"}');
  assert.equal((await closed)[0], 1008);
});

test('login challenge accepts no transfer or client-selected security metadata', async (t) => {
  const f = await fixture(t);
  const phone = await f.enrolled();
  const challenge = await f.challenge(phone);
  for (const body of [{recipientId: 'alex', amountCents: 1, note: ''}, {purpose: 'transfer'},
    {sessionId: challenge.sessionId}, {username: 'other'}, {serviceName: 'Other'},
    {phoneId: phone.phoneId}, {extra: true}]) {
    assert.equal((await f.request('/api/challenges', {method: 'POST', cookie: phone.cookie, body})).status, 400);
  }
  assert.equal((await f.get(phone, challenge)).data.status, 'waiting_phone');
  assert.equal((await f.complete(phone, challenge)).status, 200);
});

test('JSON errors, UTF-8/shape/content encoding and content-length/chunked body bounds', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  for (const [body, headers, expected] of [['{', {}, 400], ['[]', {}, 400], ['null', {}, 400],
    ['{}', {'Content-Type': 'text/plain'}, 415], ['{}', {'Content-Encoding': 'gzip'}, 415],
    [' '.repeat(4097), {}, 413], [{extra: true}, {}, 400]]) {
    const result = await f.request('/api/pairing', {method: 'POST', cookie, body, headers});
    assert.equal(result.status, expected);
    assert.deepEqual(Object.keys(result.data), ['error', 'message']);
    assert.ok(!JSON.stringify(result.data).includes('stack'));
  }
  const upload = streamedPost(f.base, '/api/pairing', cookie, ' '.repeat(4097));
  upload.req.end();
  assert.equal((await upload.result).status, 413);
  const malformed = streamedPost(f.base, '/api/pairing', cookie, Buffer.from([0xff]));
  malformed.req.end();
  assert.equal((await malformed.result).status, 400);
  assert.equal((await f.request('/api/account?deviceToken=secret', {cookie})).status, 400);
});

test('credential and general address rate limits return bounded useful errors', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) {
    assert.equal((await f.request('/api/login', {method: 'POST', body: {username: 'demo', password: 'wrong'}})).status, 401);
  }
  const blocked = await f.request('/api/login', {method: 'POST', body: {username: 'demo', password: 'demo-passive-key'}});
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '60');
  f.advance(60000);
  await f.login();
  for (let i = 0; i < 239; i++) assert.equal((await f.request('/api/session')).status, 200);
  assert.equal((await f.request('/api/session')).status, 429);
  f.advance(60000);
  assert.equal((await f.request('/api/session')).status, 200);
});

test('bounded session and challenge histories with account-wide single pending request', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 16; i++) {
    if (i === 9) f.advance(60001);
    await f.login();
  }
  assert.equal((await f.request('/api/login', {method: 'POST', body: {username: 'demo', password: 'demo-passive-key'}})).status, 429);
  f.advance(8 * 60 * 60000);
  const phone = await f.enrolled();
  const first = await f.challenge(phone);
  for (let i = 0; i < 100; i++) await f.challenge(phone);
  assert.equal((await f.get(phone, first)).status, 404);
  assert.equal((await f.request('/api/account', {cookie: phone.cookie})).status, 403);
});

test('serves explicit web inventory and shared module, not traversal, source files or symlinks', async (t) => {
  const root = fileURLToPath(new URL('./fixtures/static/', import.meta.url));
  const f = await fixture(t, {root});
  assert.match((await f.request('/')).data, /NearKey/);
  assert.match((await f.request('/web/styles.css')).data, /demo/);
  assert.equal((await f.request('/styles.css')).status, 200);
  assert.match((await f.request('/shared/protocol.mjs')).data, /NEARKEY-LOGIN-V2/);
  for (const route of ['/web/leak.css', '/server/app.mjs', '/shared/PROTOCOL.md', '/secret.txt', '/web/%2e%2e/secret.txt']) {
    assert.equal((await f.request(route)).status, 404);
  }
});


test('serves only the two bundled fonts through explicit same-origin asset routes', async (t) => {
  const f = await fixture(t);
  for (const name of ['dm-sans.ttf', 'manrope.ttf']) {
    const asset = await f.request(`/web/fonts/${name}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('content-type'), 'font/ttf');
    const bytes = new Uint8Array(await (await fetch(f.base + `/web/fonts/${name}`)).arrayBuffer());
    assert.ok(bytes.length > 1000);
    assert.deepEqual([...bytes.subarray(0, 4)], [0, 1, 0, 0]);
    assert.equal((await f.request(`/web/fonts/${name}`, {headers: {Origin: 'https://evil.example'}})).status, 403);
  }
  assert.equal((await f.request('/web/fonts/dm-sans-OFL.txt')).status, 404);
  assert.equal((await f.request('/web/fonts/other.ttf')).status, 404);
});
