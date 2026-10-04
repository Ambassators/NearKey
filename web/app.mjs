import {api} from './api.mjs';
import {PhoneBluetooth} from './ble.mjs';
import {ChallengeFlow} from './challenge.mjs';
import {EnrollmentQr} from './enrollment.mjs';

const $ = id => document.getElementById(id);
const diagnostics = {transport: 'Idle', observed: new Map(), challenge: null, startedAt: null, endedAt: null};
const bluetooth = new PhoneBluetooth({onProgress: stage => {
  diagnostics.transport = stage;
  console.debug('[NearKey Bluetooth]', stage);
  renderDebug();
}});
let keyToss = null;
// An optional animation must not prevent sign-in when its assets are unavailable.
const keyTossReady = import('./key-toss.mjs').then(({KeyToss}) => {
  keyToss = new KeyToss($('key-toss'));
  renderControls();
  return keyToss;
}).catch(() => null);
const enrollmentQr = new EnrollmentQr({container: $('pair-qr'), message: $('pair-instruction'),
  codeInput: $('pair-code'), originInput: $('base-url'), manual: $('pair-manual')});
const replacementQr = new EnrollmentQr({container: $('replacement-qr'), message: $('replacement-instruction'),
  codeInput: $('replacement-code'), originInput: $('replacement-origin'), manual: $('replacement-manual')});
let session = null;
let account = null;
let pairing = null;
let pairingSocket = null;
let pollTimer = null;
let lifetime = new AbortController();
let epoch = 0;
let loginBusy = false;
let pairBusy = false;
let pairingReconnect = false;
let pairingRetryAt = 0;
let pairingFailures = 0;
let pairingConnectedAt = 0;
let pairingElsewhere = false;
let challengeBusy = false;
let chooserBusy = false;
let autoAttempted = false;
let appsKey = '';
let appBusy = false;
let appOpener = null;
let accountRevision = 0;
let replacementPairing = null;
let replacementBusy = false;
let replacementRequested = false;
let openingDashboard = false;
let finishingVerification = false;
let restoringSession = true;
let visiblePage = null;
let noticeTimer = null;
let noticeFrame = null;
let shownBluetoothProblem = null;
const pendingStatuses = new Set(['waiting_phone', 'waiting_bluetooth']);
const challengeTitles = {
  waiting: 'Verifying phone',
  connecting: 'Connecting phone',
  submitting: 'Verifying phone',
  reconnect: 'Reconnect phone',
  approved: 'Verified',
  expired: 'Verification expired',
  cancelled: 'Verification cancelled',
  failed: 'Verification interrupted',
};

const flow = new ChallengeFlow({api, bluetooth, onChange: state => {
  renderChallenge(state);
  if (state?.phase === 'approved') {
    const currentEpoch = epoch;
    void enterDashboard().catch(error => {
      if (epoch === currentEpoch) handleError(error);
    });
  }
}, onSessionLost: () => {
  signOutLocally();
  notice('Your sign-in session ended. Enter your password to start again.');
}});

// Session lifecycle and feedback.
function notice(message = '', {error = false} = {}) {
  clearTimeout(noticeTimer);
  noticeTimer = null;
  if (noticeFrame !== null) cancelAnimationFrame(noticeFrame);
  noticeFrame = null;
  const toast = $('notice');
  toast.hidePopover?.();
  toast.textContent = message;
  toast.hidden = !message;
  toast.dataset.tone = error ? 'error' : 'status';
  if (message) {
    toast.showPopover?.();
    // Follow the card while it resizes, without changing the page layout.
    if (typeof requestAnimationFrame === 'function') {
      const position = () => {
        if (toast.hidden) return;
        const card = document.querySelector('dialog[open]') || document.querySelector('.login-card');
        const bounds = card?.getClientRects().length ? card.getBoundingClientRect() : null;
        const height = toast.getBoundingClientRect().height;
        toast.style.top = `${Math.max(16, Math.min(bounds ? bounds.bottom + 16 : window.innerHeight - height - 24,
          window.innerHeight - height - 16))}px`;
        noticeFrame = requestAnimationFrame(position);
      };
      position();
    }
    noticeTimer = setTimeout(() => {
      notice();
    }, 4000);
  }
  if (message) observeDebug('notice', message);
}

// Only display status text: never serialize requests, credentials, keys or proofs.
function debugEvent(message) {
  const list = $('debug-events');
  if (!list) return;
  if (!diagnostics.observed.size && list.children.length === 1) list.replaceChildren();
  const item = document.createElement('li');
  const time = document.createElement('span');
  time.className = 'debug-event-time';
  time.textContent = new Date().toLocaleTimeString([], {hour12: false});
  const text = document.createElement('span');
  text.textContent = String(message).replace(/https?:\/\/\S+/g, '[URL]').replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]').slice(0, 300);
  item.append(time, text);
  list.prepend(item);
  while (list.children.length > 20) list.lastElementChild.remove();
}

function observeDebug(key, value, message = value) {
  if (diagnostics.observed.get(key) === value) return;
  debugEvent(message);
  diagnostics.observed.set(key, value);
}

function renderDebug() {
  if (!$('debug-session')) return;
  const state = flow.state;
  const phone = account?.phone || session?.setup?.phone;
  const sessionStatus = account ? 'Both factors verified' : session?.pending ? 'Password accepted · 2FA pending'
    : loginBusy ? 'Checking session' : 'Password required';
  const phoneStatus = phone ? `${phone.label || 'Enrolled phone'} · ${phone.online ? 'server online' : 'server offline'}` : 'Not enrolled in this session';
  $('debug-session').textContent = sessionStatus;
  $('debug-phone').textContent = phoneStatus;
  observeDebug('session', sessionStatus, `Session: ${sessionStatus}`);
  observeDebug('phone', phoneStatus, `Phone: ${phoneStatus}`);
  const problem = bluetooth.availability();
  $('debug-bluetooth').textContent = problem ? 'Unavailable in this browser'
    : bluetooth.device?.gatt?.connected ? 'Phone link connected'
    : bluetooth.busy ? 'Browser operation in progress'
    : bluetooth.deviceId ? 'Phone permitted · link disconnected' : 'No phone permission yet';
  const idleStage = !session?.pending ? 'Ready' : !phone ? 'Waiting for phone enrollment'
    : phone.online ? 'Ready to verify' : 'Waiting for phone to come online';
  let stage = challengeBusy ? 'Requesting login challenge' : pairing ? 'Waiting for QR enrollment'
    : chooserBusy ? diagnostics.transport === 'Idle' ? 'Choosing phone' : diagnostics.transport : state ? {
      waiting: state.phoneReady ? 'Phone advertising' : 'Waiting for phone advertisement',
      connecting: diagnostics.transport === 'Idle' ? 'Starting Bluetooth' : diagnostics.transport,
      submitting: 'Server verifying signature',
      reconnect: 'Reconnect needed', approved: 'Login verified', expired: 'Challenge expired',
      cancelled: 'Verification cancelled', failed: 'Verification failed',
    }[state.phase] : idleStage;
  $('debug-stage').textContent = stage || 'Ready';
  observeDebug('stage', stage, `Stage: ${stage}`);
  if (state && diagnostics.challenge !== state.challenge.id) {
    diagnostics.challenge = state.challenge.id;
    diagnostics.startedAt = performance.now();
    diagnostics.endedAt = null;
    debugEvent('Observing login challenge · original deadline retained');
  }
  if (state && !flow.run && diagnostics.endedAt === null) diagnostics.endedAt = performance.now();
  const elapsed = diagnostics.startedAt === null ? 0 : ((diagnostics.endedAt ?? performance.now()) - diagnostics.startedAt) / 1000;
  $('debug-elapsed').textContent = `${elapsed.toFixed(1)}s`;
  $('debug-deadline').textContent = state && flow.run ? `${Math.max(0, (state.challenge.expiresAt - Date.now()) / 1000).toFixed(1)}s` : '—';
  if (state?.message) observeDebug('flow-message', state.message);
}

function resetLifetime() {
  epoch++;
  lifetime.abort(new Error('Page session changed.'));
  lifetime = new AbortController();
  clearTimeout(pollTimer);
  pollTimer = null;
  flow.dispose();
  pairing = null;
  pairingSocket?.close();
  pairingSocket = null;
  enrollmentQr.clear();
  replacementQr.clear();
  replacementPairing = null;
  replacementBusy = replacementRequested = false;
  $('replace-phone-dialog').close();
  $('replacement-qr-dialog').close();
  session = account = null;
  pairBusy = challengeBusy = chooserBusy = appBusy = false;
  pairingReconnect = false;
  pairingRetryAt = pairingFailures = pairingConnectedAt = 0;
  pairingElsewhere = false;
  autoAttempted = openingDashboard = false;
  finishingVerification = false;
  keyToss?.sync('rest');
  appsKey = '';
  accountRevision++;
  $('app-dialog').close();
  $('app-form').reset();
  appOpener = null;
  diagnostics.challenge = diagnostics.startedAt = diagnostics.endedAt = null;
  diagnostics.transport = 'Idle';
  restoringSession = false;
}

function signOutLocally() {
  resetLifetime();
  loginBusy = false;
  $('pair-code').value = '';
  $('base-url').value = '';
  $('password').value = '';
  renderControls();
}

function handleError(error) {
  if (error.status === 401) return flow.onSessionLost();
  if (error.code === 'verification_required') return void resumeSetup();
  notice(error.message, {error: true});
}

async function resumeSetup() {
  const currentEpoch = epoch;
  try {
    const result = await api('/api/session', {signal: lifetime.signal});
    if (epoch !== currentEpoch || result.authenticated) return;
    const changedPhone = account?.phone?.id && result.setup?.phone?.id !== account.phone.id;
    if (changedPhone) bluetooth.forget();
    resetLifetime();
    await acceptSession(result);
    notice(result.pending ? changedPhone ? 'New phone enrolled. Verify it nearby to finish connecting it.'
      : 'Finish phone verification to return to your apps.' : 'Sign in to return to your apps.');
  } catch (error) {
    if (epoch === currentEpoch) handleError(error);
  }
}

// Routes describe server-confirmed access; changing a URL never grants a factor.
function renderPage(pending) {
  const page = restoringSession ? 'loading' : account ? 'dashboard' : pending ? 'loading' : 'login';
  $('signin-stage').hidden = page === 'dashboard';
  $('login-view').hidden = page !== 'login';
  $('auth-view').hidden = page !== 'loading';
  $('dashboard-view').hidden = page !== 'dashboard';
  document.title = `Nearkey — ${page === 'login' ? 'Sign in' : page === 'loading' ? 'Phone setup' : 'Your apps'}`;
  if (!restoringSession) {
    // Dashboard section anchors remain available once both factors are verified.
    const section = page === 'dashboard' && ['#overview', '#activity', '#how-it-works'].includes(location.hash);
    const route = `#/${page}`;
    if (!section && location.hash !== route) history.replaceState(null, '', `${location.pathname}${location.search}${route}`);
  }
  const state = flow.state;
  const phone = session?.setup?.phone;
  $('auth-view').dataset.stage = restoringSession ? 'restoring' : state?.phase || 'setup';
  $('auth-page-title').textContent = restoringSession ? 'Checking session' : phone ? 'Verify phone' : 'Connect your phone';
  $('session-loading').hidden = !restoringSession;
  $('wizard-layout')?.setAttribute('aria-busy', String(restoringSession));
  if (visiblePage !== page) {
    visiblePage = page;
    $(page === 'login' ? 'login-title' : page === 'loading' ? 'auth-page-title' : 'dashboard-title').focus({preventScroll: true});
  }
}

// Rendering keeps account access separate from pending phone setup.
function renderControls() {
  const phone = session?.setup?.phone;
  const state = flow.state;
  const running = !!flow.run;
  const problem = bluetooth.availability();
  const pending = session?.pending === true;
  renderPage(pending);
  $('logout').hidden = !account;
  $('back-to-login').disabled = loginBusy;
  $('credentials-panel').hidden = pending;
  $('factor-panel').hidden = !pending;
  $('login-button').disabled = loginBusy;
  $('google-signin').disabled = $('apple-signin').disabled = loginBusy;
  $('login-button').firstChild.textContent = loginBusy ? 'Signing in… ' : 'Continue ';
  $('username').disabled = loginBusy;
  $('password').disabled = loginBusy;
  $('setup-panel').hidden = !!state;
  $('challenge-panel').hidden = !state;
  // Keep the result scene visible until its final checkmark has finished.
  keyToss?.sync(!state ? 'rest' : finishingVerification || state.phase === 'approved' ? 'finish'
    : ['reconnect', 'expired', 'cancelled', 'failed'].includes(state.phase) ? 'fail' : running ? 'loop' : 'rest');
  $('enrollment').hidden = !!phone;
  $('bluetooth-setup').hidden = !phone;
  $('factor-status').hidden = !phone;
  $('pairing').hidden = !pairing || !!phone;
  $('pairing-state').hidden = !pending || !!phone || !!pairing;
  $('pairing-state-spinner').hidden = pairingElsewhere;
  $('pairing-state-message').textContent = pairingElsewhere ? 'Phone setup is open in another window.'
    : pairingReconnect ? 'Reconnecting…' : 'Preparing QR code…';
  $('pairing-state-detail').hidden = !pairingReconnect && !pairingElsewhere;
  $('pairing-state-detail').textContent = pairingElsewhere ? 'Continue here to show a QR code in this window.'
    : 'Trying again automatically.';
  $('pairing-resume').hidden = !pairingElsewhere;
  enrollmentQr.render(pending && !phone ? pairing : null, pairing?.origin || location.origin);
  $('choose-button').disabled = chooserBusy || running || bluetooth.busy || !phone || !!problem;
  $('choose-button').firstChild.textContent = chooserBusy ? 'Connecting… ' : bluetooth.deviceId ? 'Reconnect phone ' : 'Connect phone ';
  $('verify-button').disabled = challengeBusy || chooserBusy || bluetooth.busy || !phone?.online || !!problem;
  $('verify-button').firstChild.textContent = challengeBusy ? 'Verifying… ' : 'Verify phone ';
  $('reconnect-button').hidden = finishingVerification || !running || state?.phase !== 'reconnect';
  $('reconnect-button').disabled = chooserBusy || !state?.phoneReady || bluetooth.busy;
  $('cancel-button').hidden = finishingVerification || !running;
  $('retry-button').hidden = !state || running || finishingVerification || state.phase === 'approved';
  $('retry-button').disabled = challengeBusy || chooserBusy || bluetooth.busy || !phone?.online || !!problem;
  const activeProblem = pending && phone ? problem : null;
  if (activeProblem && activeProblem !== shownBluetoothProblem) notice(activeProblem, {error: true});
  shownBluetoothProblem = activeProblem;
  $('add-app-button').disabled = !account || appBusy;
  $('app-save').disabled = $('app-name').disabled = $('app-url').disabled = appBusy;
  $('app-dialog-close').disabled = appBusy;
  $('replace-phone-button').hidden = !pending || !phone;
  $('replace-phone-button').disabled = chooserBusy || bluetooth.busy || replacementBusy;
  $('dashboard-replace-phone-button').disabled = !account || appBusy || replacementBusy;
  $('replace-phone-confirm').disabled = $('replace-phone-close').disabled = replacementBusy;
  $('replacement-refresh').disabled = $('replacement-cancel').disabled = replacementBusy;
  replacementQr.render(account ? replacementPairing : null, replacementPairing?.origin || location.origin);
  $('app-save').firstChild.textContent = appBusy ? 'Saving app… ' : 'Save app ';
  renderDebug();
}

function renderSession() {
  const phone = session?.setup?.phone;
  if (phone && (pairing || pairingSocket)) {
    pairing = null;
    const socket = pairingSocket;
    pairingSocket = null;
    socket?.close();
    pairingReconnect = false;
    $('pair-code').value = '';
    $('base-url').value = '';
    notice();
  }
  $('factor-title').textContent = phone ? 'Verify phone' : 'Connect your phone';
  $('setup-phone-name').textContent = phone?.label || 'Add your Android phone';
  $('phone-status').textContent = phone?.online ? 'Connected' : 'Offline';
  $('setup-phone-dot').style.opacity = phone?.online ? '1' : '.3';
  $('permission-description').textContent = phone?.online
    ? 'Keep the Android app open and your phone nearby.'
    : 'Open the Android app. Tap “Advertise setup for 60 seconds” to connect.';
  tick();
}

function appItem(app) {
  const item = document.createElement('li');
  item.className = 'site-card';
  const symbol = document.createElement('span');
  symbol.className = 'site-icon';
  symbol.setAttribute('aria-hidden', 'true');
  symbol.textContent = [...app.name][0]?.toUpperCase() || '+';
  const description = document.createElement('div');
  description.className = 'site-info';
  const title = document.createElement('strong');
  title.textContent = app.name;
  description.append(title);
  if (app.url) {
    const subtitle = document.createElement('small');
    subtitle.textContent = new URL(app.url).host;
    description.append(subtitle);
  }
  item.append(symbol, description);
  return item;
}

function renderAccount() {
  if (!account) return;
  $('dashboard-phone-name').textContent = account.phone?.label || 'Phone key';
  $('dashboard-phone-status').textContent = account.phone?.online ? 'Online' : 'Enrolled';
  const apps = account.apps || [];
  const nextKey = JSON.stringify(apps);
  if (appsKey !== nextKey) {
    appsKey = nextKey;
    $('connected-sites').replaceChildren(...apps.map(appItem));
  }
  $('site-count').textContent = `${apps.length} app${apps.length === 1 ? '' : 's'}`;
  $('no-connected-sites').hidden = apps.length > 0;
  renderControls();
}

// Server-backed dashboard access and status polling.
async function enterDashboard() {
  if (openingDashboard || account) return;
  openingDashboard = true;
  const currentEpoch = epoch;
  try {
    // The server, not a successful password or browser permission, opens the workspace.
    const result = await api('/api/account', {signal: lifetime.signal});
    if (epoch !== currentEpoch) return;
    if (flow.state) {
      finishingVerification = true;
      renderControls();
      const scene = keyToss || await keyTossReady;
      if (epoch !== currentEpoch) return;
      const completed = await scene?.sync('finish');
      if (epoch !== currentEpoch || completed === false) return;
    }
    account = result;
    session = {...session, authenticated: true, pending: false};
    flow.dispose();
    finishingVerification = false;
    $('password').value = '';
    notice();
    renderAccount();
    $('dashboard-title').focus({preventScroll: true});
    schedulePoll(currentEpoch);
    if (replacementRequested) {
      replacementRequested = false;
      void startReplacement();
    }
  } finally {
    if (epoch === currentEpoch) {
      openingDashboard = false;
      finishingVerification = false;
    }
  }
}

function schedulePoll(currentEpoch) {
  clearTimeout(pollTimer);
  if (session?.pending || account) pollTimer = setTimeout(() => void poll(currentEpoch), 3000);
}

async function poll(currentEpoch) {
  if (epoch !== currentEpoch || !session) return;
  try {
    if (account) {
      if (appBusy || replacementBusy) return;
      const revision = accountRevision;
      const result = await api('/api/account', {signal: lifetime.signal});
      if (epoch !== currentEpoch || revision !== accountRevision) return;
      account = result;
      renderAccount();
    } else {
      const result = await api('/api/session', {signal: lifetime.signal});
      if (epoch !== currentEpoch) return;
      if (result.authenticated) await enterDashboard();
      else if (!result.pending) return flow.onSessionLost();
      else {
        session = result;
        renderSession();
        if (!session.setup?.phone && !pairing) void createPairing();
        if (session.setup?.phone?.online && !bluetooth.availability() && !flow.state && !autoAttempted) void startChallenge();
      }
    }
  } catch (error) {
    if (epoch !== currentEpoch) return;
    if (error.status === 401) return flow.onSessionLost();
    if (error.code === 'verification_required') return void resumeSetup();
    if (session?.pending && !session.setup?.phone) {
      pairingReconnect = true;
      renderControls();
      observeDebug('pairing-network', 'Waiting for the server; pairing will retry.');
    } else notice(`${error.message} Status will retry shortly.`);
  } finally {
    if (epoch === currentEpoch) schedulePoll(currentEpoch);
  }
}

function renderChallenge(state) {
  if (!state) return renderControls();
  $('challenge-title').textContent = challengeTitles[state.phase] || challengeTitles.waiting;
  $('challenge-message').textContent = state.phase === 'approved' ? 'Finishing phone verification…' : state.message;
  tick();
}

function tick() {
  if (flow.state) {
    const seconds = Math.max(0, Math.ceil((flow.state.challenge.expiresAt - Date.now()) / 1000));
    $('countdown').hidden = !flow.run;
    $('countdown').textContent = `${seconds}s left`;
  }
  if (pairing) {
    $('pair-time').hidden = pairing.pageScoped === true;
    const seconds = Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000));
    $('pair-time').textContent = seconds ? `Expires in ${Math.floor(seconds / 60)}m ${seconds % 60}s` : 'Code expired. Create a new code.';
  }
  if (replacementPairing) {
    const seconds = Math.max(0, Math.ceil((replacementPairing.expiresAt - Date.now()) / 1000));
    $('replacement-time').textContent = seconds
      ? `Expires in ${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : 'Code expired. Create a new code.';
  }
  renderControls();
}

// Restore or create the password-accepted sign-in flow.
async function acceptSession(result) {
  session = result;
  $('password').value = '';
  if (result.authenticated) return enterDashboard();
  if (!result.pending) return renderControls();
  renderSession();
  // Reloads keep the original challenge identity and deadline.
  if (result.challenge) {
    autoAttempted = true;
    flow.start(result.challenge);
    if (!pendingStatuses.has(result.challengeStatus) && result.challengeStatus !== 'approved' && flow.run) {
      flow.finish(flow.run, result.challengeStatus || 'failed');
    }
  } else if (result.setup?.phone?.online && !bluetooth.availability()) void startChallenge();
  else if (!result.setup?.phone) void createPairing();
  schedulePoll(epoch);
}

async function startChallenge() {
  // Polling must not replace a chooser that is still using the native transport.
  if (challengeBusy || chooserBusy || bluetooth.busy || flow.run || !session?.pending || !session.setup?.phone?.online || account) return;
  const problem = bluetooth.availability();
  if (problem) return notice(problem);
  autoAttempted = true;
  challengeBusy = true;
  const currentEpoch = epoch;
  notice();
  renderControls();
  try {
    const result = await api('/api/challenges', {method: 'POST', body: {}, signal: lifetime.signal});
    if (epoch !== currentEpoch) return;
    if (!pendingStatuses.has(result.status)) throw new Error('Nearkey returned an unexpected login challenge status.');
    flow.start(result.challenge);
  } catch (error) {
    if (epoch === currentEpoch) handleError(error);
  } finally {
    if (epoch === currentEpoch) challengeBusy = false;
    renderControls();
  }
}

// User actions: Bluetooth selection stays inside a fresh click activation.
for (const [id, provider] of [['google-signin', 'Google'], ['apple-signin', 'Apple']]) {
  $(id).addEventListener('click', () => {
    if (!loginBusy) notice(`${provider} sign-in isn’t available in this demo.`);
  });
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (loginBusy || session?.pending || account) return;
  loginBusy = true;
  const currentEpoch = epoch;
  notice();
  renderControls();
  try {
    const result = await api('/api/login', {
      method: 'POST',
      body: {username: $('username').value, password: $('password').value},
      signal: lifetime.signal,
    });
    if (epoch !== currentEpoch) return;
    await acceptSession(result);
    if (epoch === currentEpoch && session?.pending) {
      $(flow.state ? 'challenge-title' : 'factor-title').focus({preventScroll: true});
    }
  } catch (error) {
    if (epoch === currentEpoch) notice(error.message, {error: true});
  } finally {
    if (epoch === currentEpoch) loginBusy = false;
    renderControls();
  }
});

async function logout({announce = true} = {}) {
  if (loginBusy || (!session?.pending && !account)) return;
  signOutLocally();
  const currentEpoch = epoch;
  loginBusy = true;
  renderControls();
  try {
    await api('/api/logout', {method: 'POST', body: {}});
    if (epoch === currentEpoch && announce) notice('Signed out.');
  } catch (error) {
    if (epoch === currentEpoch) notice(`Server sign-out was not confirmed. ${error.message} Reload to check your session.`);
  } finally {
    if (epoch === currentEpoch) loginBusy = false;
    renderControls();
  }
}
$('logout').addEventListener('click', () => void logout());
$('back-to-login').addEventListener('click', () => void logout({announce: false}));

const resetDemo = $('reset-demo');
function showResetDemo(event) {
  resetDemo.hidden = !(event.metaKey && event.shiftKey);
}
window.addEventListener('keydown', showResetDemo);
window.addEventListener('keyup', showResetDemo);
window.addEventListener('blur', () => { resetDemo.hidden = true; });
window.addEventListener('visibilitychange', () => { resetDemo.hidden = true; });
resetDemo.addEventListener('click', async () => {
  if (resetDemo.disabled || !window.confirm('Reset the demo? This clears phone pairing, sign-in sessions, saved apps, and activity.')) return;
  resetDemo.disabled = true;
  try {
    await api('/api/demo/reset', {method: 'POST', body: {}});
    signOutLocally();
    notice('Demo reset. Sign in to enroll your phone again.');
  } catch (error) {
    notice(error.message, {error: true});
  } finally {
    resetDemo.disabled = false;
  }
});

async function createPairing() {
  if (pairBusy || pairing || pairingElsewhere || Date.now() < pairingRetryAt || !session?.pending || session.setup?.phone) return;
  const currentEpoch = epoch;
  pairBusy = true;
  notice();
  renderControls();
  try {
    const result = await api('/api/pairing', {method: 'POST', body: {pageScoped: true}, signal: lifetime.signal});
    if (epoch !== currentEpoch || session?.setup?.phone) return;
    const socket = await openPairingChannel(result.pairingId, currentEpoch);
    if (epoch !== currentEpoch || session?.setup?.phone) return;
    if (pairingSocket !== socket || socket.readyState !== WebSocket.OPEN) throw new Error('Pairing connection closed.');
    pairing = result;
    pairingReconnect = false;
    pairingConnectedAt = Date.now();
    renderSession();
  } catch (error) {
    if (epoch !== currentEpoch) return;
    if (error.status === 401 || error.code === 'verification_required') return handleError(error);
    delayPairingRetry();
    observeDebug('pairing-network', 'Pairing connection interrupted; retrying automatically.');
  } finally {
    if (epoch === currentEpoch) {
      pairBusy = false;
      renderControls();
      schedulePoll(currentEpoch);
    }
  }
}
$('pairing-resume').addEventListener('click', () => {
  pairingElsewhere = false;
  pairingRetryAt = pairingFailures = 0;
  void poll(epoch);
});
function delayPairingRetry() {
  pairingReconnect = true;
  pairingRetryAt = Date.now() + Math.min(60000, 3000 * 2 ** Math.min(pairingFailures++, 5));
}
function openPairingChannel(pairingId, currentEpoch) {
  const signal = lifetime.signal;
  const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/pairing-channel/${pairingId}`);
  pairingSocket?.close();
  pairingSocket = socket;
  socket.addEventListener('close', event => {
    if (epoch !== currentEpoch || pairingSocket !== socket) return;
    const wasPublished = !!pairing;
    pairing = null;
    pairingSocket = null;
    if (event.code === 1000 && event.reason === 'Pairing ended') {
      // A newer setup page owns the code, or enrollment has completed. Do not
      // replace its code automatically; the session poll distinguishes these.
      pairingElsewhere = true;
    } else if (wasPublished) {
      if (Date.now() - pairingConnectedAt > 30000) pairingFailures = 0;
      delayPairingRetry();
    }
    renderControls();
    // Enrollment also closes this channel. Confirm the session before issuing
    // another code, so a successful enrollment advances to verification.
    if (!pairBusy) void poll(currentEpoch);
  });
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('error', failed);
      socket.removeEventListener('close', failed);
      if (error) {
        if (pairingSocket === socket) pairingSocket = null;
        socket.close();
        reject(error);
      } else resolve(socket);
    };
    const opened = () => finish();
    const failed = () => finish(new Error('Pairing connection interrupted.'));
    const abort = () => finish(signal.reason);
    const timer = setTimeout(failed, 8000);
    socket.addEventListener('open', opened);
    socket.addEventListener('error', failed);
    socket.addEventListener('close', failed);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
  });
}

function openPhoneReplacement() {
  if (replacementBusy || (!account && !session?.setup?.phone)) return;
  if (account && replacementPairing) return $('replacement-qr-dialog').showModal();
  $('replace-phone-description').textContent = account
    ? 'Scan a setup QR code with your new phone. Your current phone stays enrolled until the new phone finishes enrollment. Then verify the new phone nearby.'
    : 'Verify your current phone first to approve this change. Then we’ll show a setup QR code for your new phone. Keep Nearkey open on your current phone.';
  $('replace-phone-confirm').firstChild.textContent = account ? 'Show new phone QR code ' : 'Verify current phone first ';
  $('replace-phone-dialog').showModal();
}

async function startReplacement() {
  if (!account || replacementBusy) return;
  const currentEpoch = epoch;
  replacementBusy = true;
  accountRevision++;
  renderControls();
  try {
    const result = await api('/api/phones/replacement', {method: 'POST', body: {}, signal: lifetime.signal});
    if (epoch !== currentEpoch || !account) return;
    replacementPairing = result;
    $('replace-phone-dialog').close();
    if (!$('replacement-qr-dialog').open) $('replacement-qr-dialog').showModal();
    tick();
  } catch (error) {
    if (epoch !== currentEpoch) return;
    if (error.status === 401) return flow.onSessionLost();
    if (error.code === 'verification_required') return void resumeSetup();
    notice(error.message, {error: true});
  } finally {
    if (epoch === currentEpoch) replacementBusy = false;
    renderControls();
  }
}

async function cancelReplacement() {
  if (replacementBusy || !account) return;
  const currentEpoch = epoch;
  replacementBusy = true;
  accountRevision++;
  renderControls();
  try {
    await api('/api/phones/replacement/cancel', {method: 'POST', body: {}, signal: lifetime.signal});
    if (epoch !== currentEpoch) return;
    replacementPairing = null;
    replacementQr.clear();
    $('replacement-qr-dialog').close();
    notice('Phone change cancelled. Your current phone stays connected.');
    $('dashboard-replace-phone-button').focus();
  } catch (error) {
    if (epoch === currentEpoch) handleError(error);
  } finally {
    if (epoch === currentEpoch) replacementBusy = false;
    renderControls();
  }
}

$('replace-phone-button').addEventListener('click', openPhoneReplacement);
$('dashboard-replace-phone-button').addEventListener('click', openPhoneReplacement);
$('replace-phone-close').addEventListener('click', () => $('replace-phone-dialog').close());
$('replace-phone-dialog').addEventListener('cancel', event => {
  if (replacementBusy) event.preventDefault();
});
$('replace-phone-confirm').addEventListener('click', () => {
  if (replacementBusy) return;
  if (account) return void startReplacement();
  replacementRequested = true;
  $('replace-phone-dialog').close();
  notice('Verify your current phone first. The new phone QR code will open after verification.');
  if (!flow.run) {
    flow.dispose();
    autoAttempted = false;
    void startChallenge();
  }
  renderControls();
  $('auth-page-title').focus();
});
$('replacement-refresh').addEventListener('click', () => void startReplacement());
$('replacement-cancel').addEventListener('click', () => void cancelReplacement());
$('replacement-qr-dialog').addEventListener('cancel', event => {
  event.preventDefault();
  void cancelReplacement();
});

function openAppForm(event) {
  if (!account || appBusy || $('app-dialog').open) return;
  $('app-form').reset();
  appOpener = event.currentTarget;
  $('app-dialog').showModal();
  $('app-name').focus();
}
$('add-app-button').addEventListener('click', openAppForm);
$('app-dialog-close').addEventListener('click', () => $('app-dialog').close());
$('app-dialog').addEventListener('cancel', event => {
  if (appBusy) event.preventDefault();
});
$('app-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!account || appBusy) return;
  const body = {name: $('app-name').value.trim(), url: $('app-url').value.trim()};
  if (!body.name) {
    notice('Enter an app name.', {error: true});
    $('app-name').focus();
    return;
  }
  const currentEpoch = epoch;
  appBusy = true;
  // Invalidate account reads already in flight before the save began.
  accountRevision++;
  renderControls();
  try {
    const {app} = await api('/api/apps', {method: 'POST', body, signal: lifetime.signal});
    if (epoch !== currentEpoch || !account) return;
    accountRevision++;
    account = {...account, apps: [...(account.apps || []).filter(item => item.id !== app.id), app]};
    renderAccount();
    $('app-dialog').close();
    $('app-form').reset();
    notice(`${app.name} added to your app list.`);
  } catch (error) {
    if (epoch !== currentEpoch) return;
    if (error.status === 401) return flow.onSessionLost();
    if (error.code === 'verification_required') return void resumeSetup();
    notice(error.message, {error: true});
  } finally {
    if (epoch === currentEpoch) appBusy = false;
    renderControls();
    if (epoch === currentEpoch && account) {
      if (!$('app-dialog').open) appOpener?.focus();
      else $('app-name').focus();
    }
  }
});

$('choose-button').addEventListener('click', async () => {
  if (chooserBusy || flow.run || bluetooth.busy || !session?.setup?.phone) return;
  const currentEpoch = epoch;
  let selected = false;
  chooserBusy = true;
  renderControls();
  try {
    // requestDevice is called in this click's activation, before any network request.
    const device = await bluetooth.choose();
    if (epoch !== currentEpoch) return;
    selected = true;
    notice(`Bluetooth access granted for ${device.name || 'your phone'}. Its login signature still needs to be verified.`);
  } catch (error) {
    if (epoch === currentEpoch) notice(error.name === 'NotFoundError' ? 'No phone selected. Start its setup advertisement in the Android app and choose again.' : error.message);
  } finally {
    if (epoch === currentEpoch) chooserBusy = false;
    renderControls();
  }
  if (epoch === currentEpoch && selected && session?.setup?.phone?.online) void startChallenge();
});
$('verify-button').addEventListener('click', () => void startChallenge());
$('retry-button').addEventListener('click', () => {
  if (!flow.run && !challengeBusy && session?.setup?.phone?.online) {
    flow.dispose();
    void startChallenge();
  }
});
$('reconnect-button').addEventListener('click', () => {
  if (!flow.run || flow.state?.phase !== 'reconnect' || !flow.state.phoneReady || bluetooth.busy) return;
  notice();
  // Keep the chooser inside the fresh user activation.
  void flow.retry();
});
$('cancel-button').addEventListener('click', async () => {
  if (!flow.run) return;
  const currentEpoch = epoch;
  await flow.cancel();
  if (epoch !== currentEpoch) return;
  // Proof already sent can win a cancel race; reconcile against server authentication.
  try {
    const result = await api('/api/session', {signal: lifetime.signal});
    if (epoch !== currentEpoch) return;
    if (result.authenticated) await enterDashboard();
    else if (!result.pending) flow.onSessionLost();
    else {
      session = result;
      renderSession();
    }
  } catch (error) {
    if (epoch === currentEpoch) handleError(error);
  }
});

function animateCardSizes() {
  if (typeof ResizeObserver === 'undefined') return () => {};
  const card = document.querySelector('.login-card');
  const content = card.firstElementChild;
  let height = null;
  const observer = new ResizeObserver(() => {
    if (!card.getClientRects().length) return;
    const style = getComputedStyle(card);
    const target = content.getBoundingClientRect().height
      + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    if (height !== null && Math.abs(target - height) < .5) return;
    // Keep one persistent shell. CSS retargets an interrupted transition from
    // its current size instead of cancelling and briefly revealing auto height.
    height = target;
    card.style.height = `${target}px`;
  });
  observer.observe(content);
  return () => observer.disconnect();
}

const stopCardMotion = animateCardSizes();
const ticker = setInterval(tick, 250);
window.addEventListener('pagehide', () => {
  notice();
  resetLifetime();
  bluetooth.disconnect();
  stopCardMotion();
  clearInterval(ticker);
});
window.addEventListener('pageshow', event => {
  if (event.persisted) location.reload();
});
window.addEventListener('hashchange', () => renderControls());

async function boot() {
  loginBusy = true;
  renderControls();
  const currentEpoch = epoch;
  try {
    const result = await api('/api/session', {signal: lifetime.signal});
    if (epoch === currentEpoch) await acceptSession(result);
  } catch (error) {
    if (epoch === currentEpoch) notice(error.message);
  } finally {
    if (epoch === currentEpoch) {
      loginBusy = false;
      restoringSession = false;
      renderControls();
      // The first session and font layout should appear at their final size.
      // Enable motion only after ResizeObserver has measured that initial view.
      void (document.fonts?.ready || Promise.resolve()).then(() => {
        if (typeof requestAnimationFrame !== 'function') return;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const card = document.querySelector('.login-card');
          if (card) card.dataset.sizeMotion = 'ready';
        }));
      });
    }
  }
}
void boot();
