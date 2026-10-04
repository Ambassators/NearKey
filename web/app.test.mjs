import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {PhoneBluetooth} from './ble.mjs';
import {ChallengeFlow} from './challenge.mjs';
import {CONTRACT_VERSION} from '../shared/protocol.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));

// Exercise the page's real chooser, polling and challenge lifecycle together.
// Native selection is deferred to reproduce a status update while Chrome's
// chooser is open; no physical Bluetooth or browser permissions are exercised.
test('phone coming online during selection waits for the chooser before starting verification', async t => {
  let resolveChoice;
  const choice = new Promise(resolve => { resolveChoice = resolve; });
  let transport;
  class TestBluetooth extends PhoneBluetooth {
    constructor(options) {
      super({...options, secure: true, storage: null,
        bluetooth: {requestDevice: () => choice}});
      transport = this;
    }
  }
  const elements = new Map();
  function element() {
    const listeners = new Map();
    return {listeners, children: [], firstChild: {}, style: {}, dataset: {}, value: '',
      addEventListener: (name, listener) => listeners.set(name, listener),
      setAttribute() {}, removeAttribute() {}, focus() {}, close() {}, reset() {},
      append() {}, prepend() {}, replaceChildren() {},
    };
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element,
  };
  const phone = {id: 'phone', label: 'Android phone', online: false};
  let challenges = 0;
  const context = vm.createContext({
    document, window: {addEventListener() {}},
    location: {origin: 'http://localhost:5173', hash: '#/loading', pathname: '/', search: ''},
    history: {replaceState() {}}, performance, AbortController, Date, console,
    // Page timers are driven explicitly; ChallengeFlow retains its own timers.
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    PhoneBluetooth: TestBluetooth, ChallengeFlow,
    EnrollmentQr: class {render() {} clear() {}},
    api: async path => {
      if (path === '/api/session') return {pending: true, setup: {phone: {...phone}}};
      if (path === '/api/challenges') {
        challenges++;
        return {status: 'waiting_phone', challenge: {
          v: CONTRACT_VERSION, id: 'login-id', phoneId: phone.id,
          nonce: 'a'.repeat(43), sessionId: 'b'.repeat(43),
          purpose: 'login', username: 'demo', serviceName: 'NearKey',
          expiresAt: Date.now() + 60_000,
        }};
      }
      if (path === '/api/challenges/login-id') return {status: 'waiting_phone', phoneReady: false};
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  // Supply module dependencies above while running the unchanged page body.
  const source = (await readFile(new URL('./app.mjs', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '');
  vm.runInContext(source, context);
  t.after(() => vm.runInContext('flow.dispose()', context));
  await settle();

  const selecting = elements.get('choose-button').listeners.get('click')();
  assert.equal(transport.busy, true);
  phone.online = true;
  await vm.runInContext('poll(epoch)', context);
  assert.equal(challenges, 0, 'a status poll must not start a challenge during native selection');
  assert.equal(transport.active.controller.signal.aborted, false, 'selection stays live');

  resolveChoice({id: 'chosen-phone', name: 'Android phone'});
  await selecting;
  await settle();
  assert.equal(transport.deviceId, 'chosen-phone');
  assert.equal(challenges, 1, 'successful selection starts verification once');
  assert.equal(vm.runInContext('flow.state.phase', context), 'waiting');
  await vm.runInContext('poll(epoch)', context);
  assert.equal(challenges, 1, 'later status polls do not duplicate verification');
});
