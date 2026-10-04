// Lifecycle tests with mocked HTTP and BLE. No hardware is exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ChallengeFlow} from './challenge.mjs';
import {CONTRACT_VERSION} from '../shared/protocol.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const challenge = () => ({v: CONTRACT_VERSION, id: 'server-id', nonce: 'a'.repeat(43), phoneId: 'enrolled-phone',
  expiresAt: Date.now() + 60_000, purpose: 'login', username: 'demo', serviceName: 'NearKey', sessionId: 'b'.repeat(43)});
const receipt = {id: 'receipt-id', serviceName: 'NearKey', username: 'demo', phoneLabel: 'Android phone', verifiedAt: 100, createdAt: 100};
function fixture(t, overrides = {}) {
  const events = [], calls = [];
  const bluetooth = {
    busy: false, choose: async () => { calls.push(['choose']); },
    prove: async (c, signal) => { calls.push(['prove', c, signal]); return 'mock-signature'; },
    cancel: () => { calls.push(['cleanup']); }, ...overrides.bluetooth,
  };
  let ready = false;
  const api = overrides.api || (async (path, options) => {
    calls.push(['api', path, options]);
    if (path.endsWith('/complete')) return {status: 'approved', authenticated: true, receipt};
    if (path.endsWith('/cancel')) return {ok: true};
    return {status: ready ? 'waiting_bluetooth' : 'waiting_phone', phoneReady: ready};
  });
  const flow = new ChallengeFlow({api, bluetooth, onChange: state => events.push(state), pollMs: 5,
    onSessionLost: overrides.onSessionLost});
  t.after(() => flow.dispose());
  return {flow, bluetooth, calls, events, ready: () => { ready = true; }};
}

test('waits for phoneReady, freezes exact server login identity and posts ONLY signature to the original session endpoint', async t => {
  const f = fixture(t);
  const c = challenge();
  f.flow.start(c);
  c.username = 'browser edit';
  c.sessionId = 'c'.repeat(43);
  await tick();
  assert.equal(f.calls.some(call => call[0] === 'prove'), false);
  f.ready();
  await delay(15);
  assert.equal(f.flow.state.phase, 'approved');
  const proof = f.calls.find(call => call[0] === 'prove');
  assert.equal(proof[1].username, 'demo');
  assert.equal(proof[1].nonce, c.nonce);
  assert.equal(proof[1].sessionId, 'b'.repeat(43));
  const completion = f.calls.find(call => call[0] === 'api' && call[1].endsWith('/complete'));
  assert.equal(completion[1], '/api/challenges/server-id/complete');
  assert.deepEqual(completion[2].body, {signature: 'mock-signature'});
  assert.equal(f.calls.filter(call => call[0] === 'prove').length, 1);
  assert.equal(f.flow.run, null);
  assert.equal(f.flow.state.receipt, receipt);
});

test('failed automatic connection offers explicit chooser retry of SAME pending nonce; no duplicate attempt', async t => {
  let proofs = 0, release;
  const f = fixture(t, {bluetooth: {prove: async () => {
    if (++proofs === 1) throw new Error('Choose / reconnect phone');
    return new Promise(resolve => { release = resolve; });
  }}});
  const c = challenge();
  f.ready();
  f.flow.start(c);
  await tick();
  assert.equal(f.flow.state.phase, 'reconnect');
  const retry = f.flow.retry();
  assert.equal(f.calls.filter(call => call[0] === 'choose').length, 1, 'chooser called before retry returns');
  await tick();
  await f.flow.retry();
  assert.equal(proofs, 2);
  assert.equal(f.calls.filter(call => call[0] === 'choose').length, 1);
  release('mock-signature');
  await retry;
  assert.equal(f.flow.state.challenge.nonce, c.nonce);
  assert.equal(f.flow.state.phase, 'approved');
});

test('expiry aborts an in-flight proof, cleans transport/timers and ignores its late signature', async t => {
  let resolve;
  const f = fixture(t, {bluetooth: {prove: () => new Promise(r => { resolve = r; })}});
  f.ready();
  f.flow.start({...challenge(), expiresAt: Date.now() + 20});
  await tick();
  const signal = f.flow.run.controller.signal;
  await delay(30);
  assert.equal(f.flow.state.phase, 'expired');
  assert.equal(signal.aborted, true);
  assert.equal(f.flow.run, null);
  resolve('late-signature');
  await tick();
  assert.equal(f.calls.some(call => call[0] === 'api' && call[1].endsWith('/complete')), false);
  assert.ok(f.calls.filter(call => call[0] === 'cleanup').length >= 2);
});

test('cancel stops locally first, posts cancel, and ignores late phone proof', async t => {
  let resolve;
  const f = fixture(t, {bluetooth: {prove: () => new Promise(r => { resolve = r; })}});
  f.ready();
  f.flow.start(challenge());
  await tick();
  const cancelled = f.flow.cancel();
  assert.equal(f.flow.state.phase, 'cancelled');
  await cancelled;
  resolve('late-signature');
  await tick();
  assert.equal(f.calls.some(call => call[0] === 'api' && call[1].endsWith('/cancel')), true);
  assert.equal(f.calls.some(call => call[0] === 'api' && call[1].endsWith('/complete')), false);
});

test('dispose/logout suppresses late completion receipt and stale UI callbacks', async t => {
  let resolveCompletion;
  const f = fixture(t, {api: async path => {
    if (path.endsWith('/complete')) return new Promise(resolve => { resolveCompletion = resolve; });
    return {status: 'waiting_bluetooth', phoneReady: true};
  }});
  f.flow.start(challenge());
  await tick();
  assert.equal(f.flow.state.phase, 'submitting');
  const signal = f.flow.run.controller.signal;
  f.flow.dispose();
  const count = f.events.length;
  resolveCompletion({status: 'approved', authenticated: true, receipt});
  await tick();
  assert.equal(f.events.length, count);
  assert.equal(f.flow.state, null);
  assert.equal(signal.aborted, true);
});

test('stale poll cannot replace new challenge, trigger BLE or overwrite immutable metadata', async t => {
  let resolvePoll;
  const f = fixture(t, {api: path => {
    if (path.includes('old-id')) return new Promise(resolve => { resolvePoll = resolve; });
    return Promise.resolve({status: 'waiting_phone', phoneReady: false,
      challenge: {...challenge(), username: 'wrong-user', sessionId: 'wrong-session'}});
  }});
  f.flow.start({...challenge(), id: 'old-id'});
  f.flow.start({...challenge(), id: 'new-id'});
  resolvePoll({status: 'waiting_bluetooth', phoneReady: true});
  await tick();
  assert.equal(f.flow.state.challenge.id, 'new-id');
  assert.equal(f.flow.state.challenge.username, 'demo');
  assert.equal(f.calls.some(call => call[0] === 'prove'), false);
});

test('network errors visibly retry status checks; recovered readiness initiates only one attempt', async t => {
  let polls = 0;
  const f = fixture(t, {api: async path => {
    if (path.endsWith('/complete')) return {status: 'approved', authenticated: true, receipt};
    if (++polls === 1) throw new Error('Network offline');
    return {status: 'waiting_bluetooth', phoneReady: true};
  }});
  f.flow.start(challenge());
  await tick();
  assert.match(f.flow.state.message, /Network offline.*retry/);
  await delay(15);
  assert.equal(f.flow.state.phase, 'approved');
  assert.equal(f.calls.filter(call => call[0] === 'prove').length, 1);
});

test('server cancellation closes Bluetooth and does not allow retry', async t => {
  const f = fixture(t, {api: async () => ({status: 'cancelled', phoneReady: true})});
  f.flow.start(challenge());
  await tick();
  assert.equal(f.flow.state.phase, 'cancelled');
  await f.flow.retry();
  assert.equal(f.calls.some(call => call[0] === 'prove'), false);
});

test('session loss cancels work and tells the UI to sign out', async t => {
  let lost = 0;
  const f = fixture(t, {api: async () => { throw Object.assign(new Error('Session ended'), {status: 401}); },
    onSessionLost: () => { lost++; }});
  f.flow.start(challenge());
  await tick();
  assert.equal(f.flow.run, null);
  assert.equal(lost, 1);
  assert.equal(f.flow.state.phase, 'failed');
});

test('malformed server challenge is rejected before transport; already expired valid challenge stops', t => {
  const f = fixture(t);
  assert.throws(() => f.flow.start({...challenge(), v: 1}), /invalid version 2/);
  assert.equal(f.events.length, 0);
  f.flow.start({...challenge(), expiresAt: Date.now() - 1});
  assert.equal(f.flow.state.phase, 'expired');
});

test('failed cancel explains local vs server state without resurrecting the challenge', async t => {
  const f = fixture(t, {api: async path => {
    if (path.endsWith('/cancel')) throw new Error('Network offline');
    return {status: 'waiting_phone', phoneReady: false};
  }});
  f.flow.start(challenge());
  await f.flow.cancel();
  assert.match(f.flow.state.message, /Stopped locally.*Network offline.*original deadline/);
  assert.equal(f.flow.run, null);
});


test('transfer or incomplete login challenges are rejected before any Bluetooth attempt', t => {
  const f = fixture(t);
  for (const changes of [{purpose: 'transfer'}, {sessionId: ''}, {username: ''}, {serviceName: ''}]) {
    assert.throws(() => f.flow.start({...challenge(), ...changes}), /invalid.*login challenge/);
  }
  assert.equal(f.calls.length, 0);
});

test('a receipt without authenticated confirmation cannot unlock the login flow', async t => {
  const f = fixture(t, {api: async path => path.endsWith('/complete')
    ? {status: 'approved', receipt}
    : {status: 'waiting_bluetooth', phoneReady: true}});
  f.flow.start(challenge());
  await tick();
  assert.equal(f.flow.state.phase, 'reconnect');
  assert.match(f.flow.state.message, /did not confirm a verified login/);
});
