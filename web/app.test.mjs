import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {PhoneBluetooth} from './ble.mjs';
import {ChallengeFlow} from './challenge.mjs';
import {EnrollmentQr} from './enrollment.mjs';
import {CONTRACT_VERSION} from '../shared/protocol.mjs';
import {DemoSession} from './demo-session.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));

async function pairingPage(t, scene = null) {
  const elements = new Map();
  const pageEvents = new Map();
  const timers = new Map();
  const sockets = [];
  const state = {pending: true, authenticated: false, phone: null, offline: false, requests: 0,
    accountRequests: 0, failOpen: false, clock: Date.now()};
  let nextTimer = 0;
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
    }, createElement: element,
  };
  class TestSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => {
        if (state.failOpen) this.close();
        else {
          this.readyState = 1;
          this.dispatchEvent(new Event('open'));
        }
      });
    }
    close(code = 1006, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      const event = new Event('close');
      Object.assign(event, {code, reason});
      this.dispatchEvent(event);
    }
  }
  const context = vm.createContext({
    document, window: {addEventListener: (name, listener) => pageEvents.set(name, listener)},
    location: {origin: 'http://localhost:5173', hash: '#/loading', pathname: '/', search: ''},
    history: {replaceState() {}}, performance, AbortController,
    Date: class extends Date { static now() { return state.clock; } }, console,
    WebSocket: TestSocket,
    TestKeyToss: class { constructor() { return scene; } },
    DemoSession: class extends DemoSession {
      constructor() { super({getItem: () => null, setItem() {}}); }
    },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, {fn, delay}); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 1, clearInterval() {},
    PhoneBluetooth: class extends PhoneBluetooth {
      constructor(options) { super({...options, secure: false, storage: null, bluetooth: null}); }
    }, ChallengeFlow,
    EnrollmentQr: class extends EnrollmentQr {
      constructor(options) { super({...options, encode: () => '<svg></svg>'}); }
    },
    serverApi: async path => {
      if (state.offline) throw new Error('Server offline');
      if (path === '/api/session') return {pending: state.pending, authenticated: state.authenticated, setup: {phone: state.phone}};
      if (path === '/api/account') {
        state.accountRequests++;
        return {phone: state.phone, apps: []};
      }
      if (path === '/api/pairing') {
        state.requests++;
        return {pairingId: `pair-${state.requests}`, pairingCode: `code-${state.requests}`, pageScoped: true};
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  let source = (await readFile(new URL('./app.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
  if (scene) source = source.replace("import('./key-toss.mjs')", 'Promise.resolve({KeyToss: TestKeyToss})');
  vm.runInContext(source, context);
  t.after(() => pageEvents.get('pagehide')());
  await settle();
  return {state, sockets, elements, pageEvents, context,
    retry: async () => {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === 3000);
      assert.ok(entry, 'a status retry is scheduled');
      timers.delete(entry[0]);
      state.clock += entry[1].delay;
      await entry[1].fn();
      await settle();
    },
  };
}

test('Google opens the demo dashboard synchronously while the server is offline', async t => {
  const page = await pairingPage(t);
  page.state.offline = true;
  page.elements.get('google-signin').listeners.get('click')();
  assert.equal(page.elements.get('dashboard-view').hidden, false);
  assert.equal(page.elements.get('auth-view').hidden, true);
  assert.equal(page.elements.get('dashboard-phone-status').textContent, 'Signed in');
  assert.equal(page.elements.get('dashboard-replace-phone-button').hidden, true);
  assert.equal(page.state.accountRequests, 0, 'demo entry never requests protected account data');
  assert.equal(page.sockets[0].readyState, 3, 'pending enrollment is cancelled');
  await page.elements.get('logout').listeners.get('click')();
  assert.equal(page.elements.get('login-view').hidden, false, 'sign-out works offline');
  assert.equal(vm.runInContext('demoSession.active', page.context), false);
});

test('Google remains available during session restoration and ignores its late response', async t => {
  const page = await pairingPage(t);
  vm.runInContext('signOutLocally(); restoringSession = true;', page.context);
  let finish;
  page.context.serverApi = () => new Promise(resolve => { finish = resolve; });
  const restoring = vm.runInContext('boot()', page.context);
  assert.equal(page.elements.get('google-signin').disabled, false);
  page.elements.get('google-signin').listeners.get('click')();
  assert.equal(page.elements.get('dashboard-view').hidden, false);
  finish({authenticated: false, pending: false});
  await restoring;
  assert.equal(page.elements.get('dashboard-view').hidden, false, 'a stale restoration cannot undo demo sign-in');
});

test('a dropped pairing channel replaces the QR automatically and ignores stale socket events', async t => {
  const page = await pairingPage(t);
  assert.equal(page.elements.get('pair-code').value, 'code-1');
  page.sockets[0].close();
  assert.equal(page.elements.get('pair-code').value, '', 'the disconnected code is removed immediately');
  assert.equal(page.elements.get('pairing-state').hidden, false, 'the card shows a reconnecting state');
  assert.equal(page.elements.get('pairing-state-message').textContent, 'Reconnecting…');
  await settle();
  assert.equal(page.state.requests, 1, 'recovery waits before making another connection');
  await page.retry();
  assert.equal(page.state.requests, 2);
  assert.equal(page.elements.get('pair-code').value, 'code-2');
  assert.equal(page.elements.get('pairing-state').hidden, true);
  assert.equal(page.elements.get('notice').hidden, true, 'recovery does not show a reload banner');
  page.sockets[0].dispatchEvent(new Event('close'));
  await settle();
  assert.equal(page.state.requests, 2, 'an old socket cannot invalidate the replacement');
  assert.equal(page.elements.get('pair-code').value, 'code-2');
  page.pageEvents.get('pagehide')();
  await settle();
  assert.equal(page.state.requests, 2, 'closing the page must not create another pairing');
  assert.equal(page.sockets[1].readyState, 3);
});

test('pairing recovery waits through an outage and retries when the server returns', async t => {
  const page = await pairingPage(t);
  page.state.offline = true;
  page.sockets[0].close();
  await settle();
  assert.equal(page.elements.get('pairing-state').hidden, false);
  assert.equal(page.elements.get('notice').hidden, true);
  await page.retry();
  assert.equal(page.state.requests, 1, 'an unavailable session cannot issue a new code');
  page.state.offline = false;
  await page.retry();
  assert.equal(page.elements.get('pair-code').value, 'code-2');
});

test('failed pairing channel setup retries without publishing a disconnected code', async t => {
  const page = await pairingPage(t);
  page.state.failOpen = true;
  page.sockets[0].close();
  await settle();
  await page.retry();
  assert.equal(page.state.requests, 2);
  assert.equal(page.elements.get('pair-code').value, '');
  assert.equal(page.elements.get('pairing-state').hidden, false);
  page.state.failOpen = false;
  await page.retry();
  assert.equal(page.state.requests, 2, 'repeated failures increase the retry delay');
  await page.retry();
  assert.equal(page.elements.get('pair-code').value, 'code-3');
});

test('a channel closed by successful enrollment advances without creating another pairing', async t => {
  const page = await pairingPage(t);
  page.state.phone = {id: 'enrolled-phone', label: 'Android phone', online: false};
  page.sockets[0].close(1000, 'Pairing ended');
  await settle();
  assert.equal(page.state.requests, 1);
  assert.equal(page.elements.get('enrollment').hidden, true);
  assert.equal(page.elements.get('bluetooth-setup').hidden, false);
  assert.equal(page.elements.get('factor-title').textContent, 'Verify phone');
});

test('a superseded setup page never takes the code back without a user action', async t => {
  const page = await pairingPage(t);
  page.sockets[0].close(1000, 'Pairing ended');
  await settle();
  for (let i = 0; i < 25; i++) await page.retry();
  assert.equal(page.state.requests, 1, 'polling cannot replace the newer page’s code');
  assert.equal(page.elements.get('pair-code').value, '');
  assert.equal(page.elements.get('pairing-state-spinner').hidden, true);
  assert.equal(page.elements.get('pairing-resume').hidden, false);
  await page.elements.get('pairing-resume').listeners.get('click')();
  await settle();
  assert.equal(page.state.requests, 2, 'an explicit action can move setup back to this page');
  assert.equal(page.elements.get('pair-code').value, 'code-2');
});

test('a lost sign-in session stops pairing recovery', async t => {
  const page = await pairingPage(t);
  page.state.pending = false;
  page.sockets[0].close();
  await settle();
  assert.equal(page.state.requests, 1);
  assert.equal(page.elements.get('auth-view').hidden, true);
  assert.equal(page.elements.get('login-view').hidden, false);
});

test('verified pairing waits for the final animation even when authenticated status polls arrive', async t => {
  let finish;
  const completion = new Promise(resolve => { finish = resolve; });
  const modes = [];
  const page = await pairingPage(t, {sync(mode) { modes.push(mode); return mode === 'finish' ? completion : null; }});
  page.state.authenticated = true;
  const opening = vm.runInContext(`
    flow.state = {phase: 'approved', challenge: {id: 'animation-login', expiresAt: Date.now() + 60000}};
    renderChallenge(flow.state);
    enterDashboard();
  `, page.context);
  await settle();
  assert.equal(modes.at(-1), 'finish');
  assert.equal(page.elements.get('auth-view').hidden, false);
  assert.equal(page.elements.get('dashboard-view').hidden, true);
  assert.equal(vm.runInContext('account', page.context), null);
  await page.retry();
  assert.equal(page.state.accountRequests, 1, 'status polling cannot bypass the animation or duplicate navigation');
  assert.equal(page.elements.get('dashboard-view').hidden, true);
  finish(true);
  await opening;
  assert.equal(page.elements.get('dashboard-view').hidden, false);
});

test('leaving pairing cancels the pending animation and suppresses late dashboard navigation', async t => {
  let finish;
  let finishing = false;
  const completion = new Promise(resolve => { finish = resolve; });
  const page = await pairingPage(t, {sync(mode) {
    if (mode === 'finish') finishing = true;
    if (mode === 'rest' && finishing) finish(false);
    return mode === 'finish' ? completion : null;
  }});
  const opening = vm.runInContext(`
    flow.state = {phase: 'approved', challenge: {id: 'animation-login', expiresAt: Date.now() + 60000}};
    enterDashboard();
  `, page.context);
  await settle();
  vm.runInContext('signOutLocally()', page.context);
  await opening;
  assert.equal(page.elements.get('login-view').hidden, false);
  assert.equal(page.elements.get('dashboard-view').hidden, true);
  assert.equal(vm.runInContext('account', page.context), null);
});

test('failed, interrupted, expired and cancelled pairing show the phone error scene', async t => {
  const modes = [];
  const page = await pairingPage(t, {sync(mode) { modes.push(mode); }});
  for (const phase of ['reconnect', 'expired', 'cancelled', 'failed']) {
    vm.runInContext(`flow.state = {phase: '${phase}', challenge: {id: 'failed-login', expiresAt: Date.now() + 60000}}; renderControls()`, page.context);
    assert.equal(modes.at(-1), 'fail', phase);
    assert.equal(page.elements.get('challenge-panel').hidden, false);
  }
});

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
    DemoSession: class extends DemoSession {
      constructor() { super({getItem: () => null, setItem() {}}); }
    },
    serverApi: async path => {
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

test('reset button appears only while Command and Shift are held and hides on blur', async t => {
  const page = await pairingPage(t);
  const button = page.elements.get('reset-demo');
  page.pageEvents.get('keydown')({metaKey: true, shiftKey: false});
  assert.equal(button.hidden, true);
  page.pageEvents.get('keydown')({metaKey: true, shiftKey: true});
  assert.equal(button.hidden, false);
  page.pageEvents.get('keyup')({metaKey: false, shiftKey: true});
  assert.equal(button.hidden, true);
  page.pageEvents.get('keydown')({metaKey: true, shiftKey: true});
  page.pageEvents.get('blur')();
  assert.equal(button.hidden, true);
});
