// Mocked fetch: verifies session-cookie requests, error recovery and abort cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import {api, ApiError} from './api.mjs';
import {amountCents, money} from './format.mjs';

function mockFetch(t, implementation) { t.mock.method(globalThis, 'fetch', implementation); }
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

test('HTTP calls use same-origin cookies and JSON, without browser bearer tokens', async t => {
  mockFetch(t, async (path, options) => {
    assert.equal(path, '/api/challenges/id/complete');
    assert.equal(options.credentials, 'same-origin');
    assert.deepEqual(options.headers, {'Content-Type': 'application/json'});
    assert.deepEqual(JSON.parse(options.body), {signature: 'DER-base64url'});
    return json({status: 'approved'});
  });
  assert.deepEqual(await api('/api/challenges/id/complete', {method: 'POST', body: {signature: 'DER-base64url'}}), {status: 'approved'});
});

test('server JSON failures retain human explanation and authentication status', async t => {
  mockFetch(t, async () => json({error: 'session_required', message: 'Please log in'}, 401));
  await assert.rejects(api('/api/account'), error => error instanceof ApiError && error.status === 401 && error.message === 'Please log in');
});

test('offline / malformed responses recover with a visible connection explanation', async t => {
  mockFetch(t, async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(api('/api/account'), /Cannot reach the bank server/);
  t.mock.restoreAll();
  mockFetch(t, async () => new Response('not JSON'));
  await assert.rejects(api('/api/account'), /Cannot reach the bank server/);
});

test('timed out fetch aborts its signal and rejects instead of freezing controls', async t => {
  let signal;
  mockFetch(t, (_, options) => new Promise((_, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(signal.reason), {once: true});
  }));
  await assert.rejects(api('/api/account', {timeoutMs: 10}), /timed out/);
  assert.equal(signal.aborted, true);
});

test('session lifetime cancellation aborts in-flight fetch and removes the parent listener', async t => {
  const controller = new AbortController();
  let adds = 0, removes = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  t.mock.method(controller.signal, 'addEventListener', (...args) => { adds++; return add(...args); });
  t.mock.method(controller.signal, 'removeEventListener', (...args) => { removes++; return remove(...args); });
  mockFetch(t, (_, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true});
  }));
  const request = api('/api/account', {signal: controller.signal});
  controller.abort(new Error('Logged out'));
  await assert.rejects(request, /Logged out/);
  assert.equal(adds, 1);
  assert.equal(removes, 1);
});

test('USD input converts decimal strings to integer cents without arbitrary limits', () => {
  for (const [input, expected] of [['25', 2500], ['25.00', 2500], ['0.01', 1], ['1.2', 120], [' 12.34 ', 1234], ['100000', 10_000_000]]) {
    assert.equal(amountCents(input), expected);
  }
  for (const invalid of ['0', '-1', '1e2', 'NaN', 'Infinity', '1,000', '0.001', '1.', '', '9999999999999999999']) {
    assert.throws(() => amountCents(invalid));
  }
  assert.equal(money(1234), '$12.34');
});
