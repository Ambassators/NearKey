import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.mjs';
import { redisStore, StorageError } from '../server/shared-store.mjs';
import { hostedConfig } from '../server/hosted-config.mjs';
import { approvalText, enrollmentText } from '../shared/protocol.mjs';

const ORIGIN = 'https://nearkey.example';
const PASSWORD = 'a-new-demo-password';
const signed = (pair, text) => sign('sha256', Buffer.from(text), pair.privateKey).toString('base64url');
function keyPair() {
  const pair = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  return {...pair, encoded: pair.publicKey.export({format: 'der', type: 'spki'}).toString('base64url')};
}

// An Upstash REST contract fake, shared by independently constructed clients.
// It models fenced EVAL transactions, expiry and injected transport failures.
function redisBackend() {
  const data = new Map(), leases = new Map();
  const backend = {data, leases, unavailable: false, rejectCommit: false, commands: []};
  backend.fetch = async (_url, options) => {
    if (backend.unavailable) throw new Error('Offline');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    const command = JSON.parse(options.body);
    backend.commands.push(command);
    const [name, script, count, lock] = command;
    assert.equal(name, 'EVAL');
    const owner = command[3 + Number(count)];
    const lease = leases.get(lock);
    if (lease && lease.until <= Date.now()) leases.delete(lock);
    let result;
    if (script.includes("'NX'")) {
      if (leases.has(lock)) result = [0, ''];
      else {
        leases.set(lock, {owner, until: Date.now() + Number(command[6])});
        result = [1, data.get(command[4]) || ''];
      }
    } else if (script.includes("redis.call('SET', KEYS[2]")) {
      if (backend.rejectCommit || backend.rejectState?.(JSON.parse(command[6]))) {
        leases.delete(lock); backend.rejectCommit = false; backend.rejectState = null;
      }
      if (leases.get(lock)?.owner !== owner) result = 0;
      else { data.set(command[4], command[6]); leases.delete(lock); result = 1; }
    } else {
      if (leases.get(lock)?.owner === owner) { leases.delete(lock); result = 1; }
      else result = 0;
    }
    return {ok: true, json: async () => ({result})};
  };
  backend.store = (options = {}) => redisStore({url: 'https://redis.example', token: 'test-secret',
    key: 'nearkey:test', fetchImpl: backend.fetch, ...options});
  backend.state = () => JSON.parse(data.get('{nearkey:test}:state'));
  return backend;
}

async function fleet(t, backend = redisBackend()) {
  let time = Date.now();
  const servers = [];
  async function start(options = {}) {
    const app = await createApp({publicOrigin: ORIGIN, username: 'demo', password: PASSWORD,
      now: () => time, stateStore: backend.store(), channelPollMs: 20, ...options});
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    servers.push(app);
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const request = async (route, {method = 'GET', body, cookie, token, headers = {}} = {}) => {
      const merged = {...(method !== 'GET' ? {'Content-Type': 'application/json', Origin: ORIGIN} : {}),
        ...(cookie ? {Cookie: cookie} : {}), ...(token ? {Authorization: `Bearer ${token}`} : {}), ...headers};
      if (token || route === '/api/phones/enroll') delete merged.Origin;
      const response = await fetch(base + route, {method, headers: merged,
        body: body === undefined ? undefined : JSON.stringify(body)});
      const text = await response.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return {status: response.status, data, headers: response.headers};
    };
    const login = async () => {
      const result = await request('/api/login', {method: 'POST', body: {username: 'demo', password: PASSWORD}});
      assert.equal(result.status, 200);
      assert.match(result.headers.get('set-cookie'), /; Secure/);
      return result.headers.get('set-cookie').split(';')[0];
    };
    return {app, base, request, login};
  }
  t.after(async () => { for (const server of servers) await server.close(); });
  return {start, backend, advance: (ms) => { time += ms; }};
}

async function channel(t, server, path, headers) {
  const ws = new WebSocket(server.base.replace('http:', 'ws:') + path, {headers});
  const messages = [], waiters = [];
  ws.on('error', () => {});
  ws.on('message', (data) => {
    const value = JSON.parse(data);
    const waiter = waiters.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(value); } else messages.push(value);
  });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
    const waiter = {resolve, timer: setTimeout(() => reject(new Error('Channel delivery timeout')), 3000)};
    waiters.push(waiter);
  });
  t.after(() => { ws.terminate(); for (const waiter of waiters) clearTimeout(waiter.timer); });
  await once(ws, 'open');
  return {ws, next};
}
async function enroll(browser, phoneServer, cookie, body = {}) {
  const setup = await browser.request('/api/pairing', {method: 'POST', body, cookie});
  assert.equal(setup.status, 200);
  const pair = keyPair();
  const enrollment = {pairingCode: setup.data.pairingCode, publicKey: pair.encoded, label: 'Android phone',
    signature: signed(pair, enrollmentText(setup.data.pairingCode, pair.encoded))};
  const result = await phoneServer.request('/api/phones/enroll', {method: 'POST', body: enrollment});
  assert.equal(result.status, 200);
  return {...result.data, pair, setup: setup.data, enrollment};
}
async function attempt(server, cookie) {
  const result = await server.request('/api/challenges', {method: 'POST', cookie, body: {}});
  assert.equal(result.status, 200);
  return result.data.challenge;
}
const complete = (server, phone, cookie, challenge, signature = signed(phone.pair, approvalText(challenge))) =>
  server.request(`/api/challenges/${challenge.id}/complete`, {method: 'POST', cookie, body: {signature}});

// This covers the actual HTTP/WebSocket handlers using two independent server instances.
test('shared pairing, signed login, messages and apps work across instances and restarts', async (t) => {
  const f = await fleet(t), a = await f.start(), b = await f.start();
  const cookie = await a.login();
  assert.equal((await b.request('/api/session', {cookie})).data.pending, true);
  const phone = await enroll(a, b, cookie);
  const connection = await channel(t, a, '/api/phone-channel', {Authorization: `Bearer ${phone.deviceToken}`});
  assert.equal((await connection.next()).type, 'ready');
  const challenge = await attempt(b, cookie);
  assert.deepEqual((await connection.next()).challenge, challenge);
  const ready = await b.request(`/api/phone/challenges/${challenge.id}/ready`, {method: 'POST', body: {}, token: phone.deviceToken});
  assert.equal(ready.status, 200);
  const bad = await complete(b, phone, cookie, challenge, signed(keyPair(), approvalText(challenge)));
  assert.equal(bad.status, 403);
  assert.equal((await a.request('/api/account', {cookie})).status, 403);
  assert.equal((await complete(b, phone, cookie, challenge)).status, 200);
  assert.equal((await connection.next()).type, 'cancel');
  assert.equal((await a.request('/api/apps', {method: 'POST', cookie, body: {name: 'Example'}})).status, 201);
  await a.app.close();
  await b.app.close();
  const c = await f.start();
  const account = await c.request('/api/account', {cookie});
  assert.equal(account.status, 200);
  assert.equal(account.data.apps[0].name, 'Example');
  assert.equal(account.data.activity.length, 1);
  assert.equal(account.data.phone.online, false);
  const again = await channel(t, c, '/api/phone-channel', {Authorization: `Bearer ${phone.deviceToken}`});
  assert.equal((await again.next()).type, 'ready');
  const nextCookie = await c.login();
  const nextChallenge = await attempt(c, nextCookie);
  assert.equal((await again.next()).challenge.id, nextChallenge.id);
  assert.equal((await complete(c, phone, nextCookie, nextChallenge)).status, 200);
});

test('shared challenges are consumed only once by concurrent servers', async (t) => {
  const f = await fleet(t), a = await f.start(), b = await f.start();
  const cookie = await a.login(), phone = await enroll(a, b, cookie);
  const connection = await channel(t, a, '/api/phone-channel', {Authorization: `Bearer ${phone.deviceToken}`});
  await connection.next();
  const challenge = await attempt(b, cookie);
  const results = await Promise.all([complete(a, phone, cookie, challenge), complete(b, phone, cookie, challenge)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await b.request('/api/account', {cookie})).data.activity.length, 1);
});

test('shared channel replacement closes the old instance and replays the pending challenge', async (t) => {
  const f = await fleet(t), a = await f.start(), b = await f.start();
  const cookie = await a.login(), phone = await enroll(a, b, cookie);
  const first = await channel(t, a, '/api/phone-channel', {Authorization: `Bearer ${phone.deviceToken}`});
  await first.next();
  const challenge = await attempt(b, cookie);
  await first.next();
  const closed = once(first.ws, 'close');
  const second = await channel(t, b, '/api/phone-channel', {Authorization: `Bearer ${phone.deviceToken}`});
  assert.equal((await second.next()).type, 'ready');
  assert.equal((await second.next()).challenge.id, challenge.id);
  assert.equal((await closed)[1].toString(), 'Channel replaced');
  assert.equal((await a.request('/api/session', {cookie})).data.setup.phone.online, true);
  assert.equal((await complete(a, phone, cookie, challenge)).status, 200);
});

test('page pairing stays live across polling and is revoked on cross-instance logout', async (t) => {
  const f = await fleet(t), a = await f.start(), b = await f.start();
  const cookie = await a.login();
  const setup = await a.request('/api/pairing', {method: 'POST', cookie, body: {pageScoped: true}});
  const connection = await channel(t, a, `/api/pairing-channel/${setup.data.pairingId}`, {Cookie: cookie, Origin: ORIGIN});
  assert.equal((await connection.next()).type, 'pairing_ready');
  for (let i = 0; i < 80; i++) { f.advance(10_000); await delay(25); }
  assert.equal((await b.request('/api/session', {cookie})).data.pending, true);
  const closed = once(connection.ws, 'close');
  assert.equal((await b.request('/api/logout', {method: 'POST', cookie, body: {}})).status, 200);
  assert.equal((await closed)[1].toString(), 'Pairing ended');
  assert.equal(f.backend.state().pairing, null);
});

test('expired presence makes a crashed phone offline and expires a page pairing', async (t) => {
  const f = await fleet(t), a = await f.start(), b = await f.start();
  const cookie = await a.login(), phone = await enroll(a, b, cookie);
  const connection = await channel(t, a, '/api/phone-channel', {Authorization: `Bearer ${phone.deviceToken}`});
  await connection.next();
  const closed = once(connection.ws, 'close');
  f.advance(21_000);
  assert.equal((await b.request('/api/session', {cookie})).data.setup.phone.online, false);
  assert.equal((await b.request('/api/challenges', {method: 'POST', cookie, body: {}})).status, 409);
  await closed;
});

test('a failed shared commit withholds login cookies and enrollment credentials', async (t) => {
  const f = await fleet(t), a = await f.start();
  f.backend.rejectCommit = true;
  const login = await a.request('/api/login', {method: 'POST', body: {username: 'demo', password: PASSWORD}});
  assert.equal(login.status, 503);
  assert.equal(login.headers.get('set-cookie'), null);
  const cookie = await a.login();
  const setup = await a.request('/api/pairing', {method: 'POST', cookie, body: {}});
  const pair = keyPair();
  const body = {pairingCode: setup.data.pairingCode, publicKey: pair.encoded, label: 'Phone',
    signature: signed(pair, enrollmentText(setup.data.pairingCode, pair.encoded))};
  f.backend.rejectCommit = true;
  const result = await a.request('/api/phones/enroll', {method: 'POST', body});
  assert.equal(result.status, 503);
  assert.equal(result.data.deviceToken, undefined);
  assert.equal(f.backend.state().phone, null);
  assert.equal((await a.request('/api/phones/enroll', {method: 'POST', body})).status, 200);
});

test('storage outages close local phone channels and fail API requests without memory fallback', async (t) => {
  const f = await fleet(t), a = await f.start();
  const cookie = await a.login(), phone = await enroll(a, a, cookie);
  const connection = await channel(t, a, '/api/phone-channel', {Authorization: `Bearer ${phone.deviceToken}`});
  await connection.next();
  const closed = once(connection.ws, 'close');
  f.backend.unavailable = true;
  const session = await a.request('/api/session', {cookie});
  assert.equal(session.status, 503);
  assert.equal(session.data.authenticated, undefined);
  assert.equal((await a.request('/')).status, 200);
  await closed;
  f.backend.unavailable = false;
  assert.equal((await a.request('/api/session', {cookie})).data.pending, true);
});

test('shared state cannot be silently reused for another account or domain', async (t) => {
  const f = await fleet(t), a = await f.start();
  await a.login();
  const b = await f.start({publicOrigin: 'https://other.example'});
  assert.equal((await b.request('/api/session')).status, 503);
  assert.equal(f.backend.state().publicOrigin, ORIGIN);
  const c = await f.start({username: 'other'});
  assert.equal((await c.request('/api/session')).status, 503);
});

test('fenced Redis lease refuses stale commits and release never deletes a new owner', async () => {
  const backend = redisBackend();
  const store = backend.store({leaseMs: 10});
  await assert.rejects(store.transact(async () => {
    await delay(15);
    backend.leases.set('{nearkey:test}:lease', {owner: 'replacement', until: Date.now() + 1000});
    return {state: {bad: true}, value: 'success'};
  }), StorageError);
  assert.equal(backend.data.size, 0);
  assert.equal(backend.leases.get('{nearkey:test}:lease').owner, 'replacement');
});

test('Redis errors and corrupt JSON fail closed without disclosing secrets', async () => {
  const backend = redisBackend();
  backend.data.set('{nearkey:test}:state', '{broken');
  await assert.rejects(backend.store().transact(() => assert.fail('Must not run')), StorageError);
  const store = redisStore({url: 'https://redis.example', token: 'secret', fetchImpl: async () => ({ok: true,
    json: async () => ({error: 'sensitive provider details'})})});
  await assert.rejects(store.transact(() => {}), {message: 'Shared storage is unavailable; retry shortly'});
});

test('hosted configuration requires explicit HTTPS, a new password and shared storage', () => {
  const env = {PUBLIC_ORIGIN: ORIGIN, DEMO_USERNAME: 'admin', DEMO_PASSWORD: PASSWORD,
    UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 'secret'};
  const config = hostedConfig(env);
  assert.equal(config.phoneOrigin, ORIGIN);
  assert.ok(config.stateStore);
  for (const key of Object.keys(env)) assert.throws(() => hostedConfig({...env, [key]: ''}));
  assert.throws(() => hostedConfig({...env, PUBLIC_ORIGIN: 'http://localhost:5173'}));
  assert.throws(() => hostedConfig({...env, DEMO_PASSWORD: 'mint-river-otter-47'}));
  assert.throws(() => hostedConfig({...env, DEMO_PASSWORD: 'short'}));
  assert.throws(() => hostedConfig({...env, UPSTASH_REDIS_REST_URL: 'http://redis.example'}));
});


test('failed proof commit does not promote a shared browser session', async (t) => {
  const f = await fleet(t), a = await f.start(), b = await f.start();
  const cookie = await a.login(), phone = await enroll(a, b, cookie);
  const connection = await channel(t, a, '/api/phone-channel', {Authorization: `Bearer ${phone.deviceToken}`});
  await connection.next();
  const challenge = await attempt(b, cookie);
  await connection.next();
  f.backend.rejectState = (state) => state.challenges.some(([, record]) => record.status === 'approved');
  const result = await complete(b, phone, cookie, challenge);
  assert.equal(result.status, 503);
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal((await a.request('/api/account', {cookie})).status, 403);
  assert.equal((await b.request('/api/session', {cookie})).data.authenticated, false);
  assert.equal((await complete(a, phone, cookie, challenge)).status, 200);
});

test('shared phone replacement revokes old credentials and requires the new key across instances', async (t) => {
  const f = await fleet(t), a = await f.start(), b = await f.start();
  const cookie = await a.login(), old = await enroll(a, b, cookie);
  const original = await channel(t, a, '/api/phone-channel', {Authorization: `Bearer ${old.deviceToken}`});
  await original.next();
  const initial = await attempt(b, cookie);
  await original.next();
  assert.equal((await complete(b, old, cookie, initial)).status, 200);
  await original.next();
  const setup = await a.request('/api/phones/replacement', {method: 'POST', body: {}, cookie});
  assert.equal(setup.status, 200);
  const pair = keyPair();
  const closed = once(original.ws, 'close');
  const enrolled = await b.request('/api/phones/enroll', {method: 'POST', body: {
    pairingCode: setup.data.pairingCode, publicKey: pair.encoded, label: 'New phone',
    signature: signed(pair, enrollmentText(setup.data.pairingCode, pair.encoded))}});
  assert.equal(enrolled.status, 200);
  await closed;
  assert.equal((await a.request('/api/account', {cookie})).status, 403);
  assert.equal((await a.request(`/api/phone/challenges/${initial.id}/ready`, {method: 'POST', body: {}, token: old.deviceToken})).status, 401);
  const replacement = {...enrolled.data, pair};
  const connection = await channel(t, b, '/api/phone-channel', {Authorization: `Bearer ${replacement.deviceToken}`});
  await connection.next();
  const challenge = await attempt(a, cookie);
  await connection.next();
  assert.equal((await complete(a, old, cookie, challenge)).status, 403);
  assert.equal((await complete(a, replacement, cookie, challenge)).status, 200);
  await b.app.close();
  const c = await f.start();
  assert.equal((await c.request('/api/account', {cookie})).data.phone.id, replacement.phoneId);
});

test('two servers cannot enroll the same pairing code twice', async (t) => {
  const f = await fleet(t), a = await f.start(), b = await f.start();
  const cookie = await a.login();
  const setup = await a.request('/api/pairing', {method: 'POST', cookie, body: {}});
  const pair = keyPair();
  const body = {pairingCode: setup.data.pairingCode, publicKey: pair.encoded, label: 'Phone',
    signature: signed(pair, enrollmentText(setup.data.pairingCode, pair.encoded))};
  const results = await Promise.all([a.request('/api/phones/enroll', {method: 'POST', body}), b.request('/api/phones/enroll', {method: 'POST', body})]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const accepted = results.find((result) => result.status === 200);
  assert.equal(f.backend.state().phone.id, accepted.data.phoneId);
  assert.equal(f.backend.state().pairing, null);
});


test('corrupt shared enrollment is rejected rather than reopening setup', async (t) => {
  const f = await fleet(t), a = await f.start();
  const cookie = await a.login();
  await enroll(a, a, cookie);
  const original = f.backend.state();
  for (const corrupt of [null, {...original, phone: false}, {...original, phone: {...original.phone, deviceToken: 'bad'}},
    {...original, sessions: [[cookie.split('=')[1], {id: 'bad', expiresAt: Date.now() + 1000, verifiedAt: 1}]]}]) {
    f.backend.data.set('{nearkey:test}:state', JSON.stringify(corrupt));
    assert.equal((await a.request('/api/session', {cookie})).status, 503);
    assert.equal((await a.request('/api/pairing', {method: 'POST', cookie, body: {}})).status, 503);
  }
  f.backend.data.set('{nearkey:test}:state', JSON.stringify(original));
  assert.equal((await a.request('/api/session', {cookie})).data.setup.phone.id, original.phone.id);
});
