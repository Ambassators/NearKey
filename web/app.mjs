import {api} from './api.mjs';
import {PhoneBluetooth} from './ble.mjs';
import {ChallengeFlow} from './challenge.mjs';
import {EnrollmentQr} from './enrollment.mjs';

const $ = id => document.getElementById(id);
const diagnostics = {transport: 'Idle', observed: new Map(), challenge: null, startedAt: null, endedAt: null};
const bluetooth = new PhoneBluetooth({onProgress: stage => {
  diagnostics.transport = stage;
  renderDebug();
}});
let keyToss = null;
// An optional animation must not prevent sign-in when its assets are unavailable.
void import('./key-toss.mjs').then(({KeyToss}) => {
  keyToss = new KeyToss($('key-toss'));
  renderControls();
}).catch(() => {});
const enrollmentQr = new EnrollmentQr({container: $('pair-qr'), message: $('pair-instruction'),
  codeInput: $('pair-code'), originInput: $('base-url'), manual: $('pair-manual')});
const replacementQr = new EnrollmentQr({container: $('replacement-qr'), message: $('replacement-instruction'),
  codeInput: $('replacement-code'), originInput: $('replacement-origin'), manual: $('replacement-manual')});
let session = null;
let account = null;
let pairing = null;
let pollTimer = null;
let lifetime = new AbortController();
let epoch = 0;
let loginBusy = false;
let pairBusy = false;
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
let currentVerification = null;
let restoringSession = true;
let visiblePage = null;
const pendingStatuses = new Set(['waiting_phone', 'waiting_bluetooth']);
const challengeTitles = {
  waiting: 'Checking your phone key.',
  connecting: 'Checking your phone key.',
  submitting: 'Verifying your signature.',
  reconnect: 'Let’s find your phone.',
  approved: 'Your sign-in is verified.',
  expired: 'Let’s try that again.',
  cancelled: 'Verification stopped.',
  failed: 'Verification interrupted.',
};

const flow = new ChallengeFlow({api, bluetooth, onChange: state => {
  renderChallenge(state);
  if (state?.phase === 'approved') {
    currentVerification = state.receipt?.verifiedAt || state.receipt?.createdAt || null;
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
function notice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
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
  $('debug-deadline').textContent = state && flow.run ? `${Math.max(0, (state.challenge.expiresAt - Date.now()) / 1000).toFixed(1)}s` : 'Not running';
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
  enrollmentQr.clear();
  replacementQr.clear();
  replacementPairing = null;
  replacementBusy = replacementRequested = false;
  $('replace-phone-dialog').close();
  $('replacement-qr-dialog').close();
  session = account = null;
  pairBusy = challengeBusy = chooserBusy = appBusy = false;
  autoAttempted = openingDashboard = false;
  appsKey = '';
  accountRevision++;
  $('app-dialog').close();
  $('app-form').reset();
  $('app-form-error').hidden = true;
  appOpener = null;
  currentVerification = null;
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
  notice(error.message);
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
  $('login-view').hidden = page !== 'login';
  $('auth-view').hidden = page !== 'loading';
  $('dashboard-view').hidden = page !== 'dashboard';
  document.title = `${page === 'login' ? 'Sign in' : page === 'loading' ? 'Set up your phone' : 'Your apps'} - Nearkey`;
  if (!restoringSession) {
    // Dashboard section anchors remain available once both factors are verified.
    const section = page === 'dashboard' && ['#overview', '#activity', '#how-it-works'].includes(location.hash);
    const route = `#/${page}`;
    if (!section && location.hash !== route) history.replaceState(null, '', `${location.pathname}${location.search}${route}`);
  }
  const state = flow.state;
  const phone = session?.setup?.phone;
  let title = 'Set up your phone key.';
  let summary = 'Scan the setup QR code, then tap “Enroll phone” in the Android app to continue to step 3.';
  if (phone) {
    title = phone.online ? 'Verifying your sign-in.' : 'Waiting for your phone.';
    summary = phone.online ? 'Keep your Android app open and your phone nearby while we verify your second factor.'
      : 'Open the Nearkey Android app to reconnect your phone and continue verification.';
  }
  if (state) {
    title = challengeTitles[state.phase] || 'Verifying your sign-in.';
    summary = state.message || summary;
  }
  if (replacementRequested && pending) {
    summary = 'Verify your current phone first. Then we’ll show a setup QR code for your new phone.';
  }
  if (restoringSession) {
    title = 'Checking your session…';
    summary = 'Checking where to resume your sign-in.';
  }
  $('auth-view').dataset.stage = restoringSession ? 'restoring' : state?.phase || 'setup';
  $('auth-page-title').textContent = title;
  $('auth-page-summary').textContent = summary;
  const step = account ? 4 : restoringSession ? 0 : !pending ? 1 : phone ? 3 : 2;
  ['account', 'enroll', 'verify', 'ready'].forEach((name, index) => {
    const item = $(`wizard-${name}-step`);
    item.className = index + 1 < step ? 'complete' : index + 1 === step ? 'active' : '';
    if (index + 1 === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
  $('wizard-step-label').textContent = restoringSession ? 'Checking your session'
    : `Step ${step} of 4: ${['', 'Account', 'Enroll your phone', 'Verify nearby phone', 'Ready'][step]}`;
  $('auth-spinner').hidden = !(restoringSession || openingDashboard || challengeBusy
    || flow.run && ['waiting', 'connecting', 'submitting'].includes(state?.phase));
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
  $('logout').hidden = !session?.pending && !account;
  $('credentials-panel').hidden = pending;
  $('factor-panel').hidden = !pending;
  $('password-step').className = pending ? 'complete' : 'active';
  $('phone-step').className = pending ? 'active' : '';
  $('login-button').disabled = loginBusy;
  $('login-button').firstChild.textContent = loginBusy ? 'Checking your session… ' : 'Continue ';
  $('username').disabled = loginBusy;
  $('password').disabled = loginBusy;
  $('setup-panel').hidden = !!state;
  $('challenge-panel').hidden = !state;
  // The key-toss scene loops while the phone is signing, settles unlocked on approval, and rests otherwise.
  keyToss?.sync(!state ? 'rest' : state.phase === 'approved' ? 'finish' : running && state.phase !== 'reconnect' ? 'loop' : 'rest');
  $('enrollment').hidden = !!phone;
  $('bluetooth-setup').hidden = !phone;
  $('pairing').hidden = !pairing || !!phone;
  enrollmentQr.render(pending && !phone ? pairing : null, location.origin);
  $('pair-button').disabled = pairBusy || !pending || !!phone;
  $('pair-button').firstChild.textContent = pairBusy ? 'Creating setup QR code… ' : pairing ? 'Get a fresh QR code ' : 'Show setup QR code ';
  $('choose-button').disabled = chooserBusy || running || bluetooth.busy || !phone || !!problem;
  $('choose-button').firstChild.textContent = chooserBusy ? 'Opening Bluetooth chooser… ' : bluetooth.deviceId ? 'Choose / reconnect phone ' : 'Choose your phone ';
  $('verify-button').disabled = challengeBusy || chooserBusy || bluetooth.busy || !phone?.online || !!problem;
  $('verify-button').firstChild.textContent = challengeBusy ? 'Starting verification… ' : 'Verify nearby phone ';
  $('reconnect-button').hidden = !running || state?.phase !== 'reconnect';
  $('reconnect-button').disabled = chooserBusy || !state?.phoneReady || bluetooth.busy;
  $('cancel-button').hidden = !running;
  $('retry-button').hidden = !state || running || state.phase === 'approved';
  $('retry-button').disabled = challengeBusy || chooserBusy || bluetooth.busy || !phone?.online || !!problem;
  $('back-button').disabled = loginBusy;
  $('bluetooth-problem').hidden = !problem;
  $('bluetooth-problem').textContent = problem || '';
  $('add-app-button').disabled = $('add-app-plus').disabled = !account || appBusy;
  $('app-save').disabled = $('app-name').disabled = $('app-url').disabled = appBusy;
  $('app-dialog-close').disabled = appBusy;
  $('replace-phone-button').hidden = !pending || !phone;
  $('replace-phone-button').disabled = chooserBusy || bluetooth.busy || replacementBusy;
  $('dashboard-replace-phone-button').disabled = !account || appBusy || replacementBusy;
  $('replace-phone-confirm').disabled = $('replace-phone-close').disabled = replacementBusy;
  $('replacement-refresh').disabled = $('replacement-cancel').disabled = replacementBusy;
  replacementQr.render(account ? replacementPairing : null, location.origin);
  $('app-save').firstChild.textContent = appBusy ? 'Saving app… ' : 'Save app ';
  renderDebug();
}

function renderSession() {
  const phone = session?.setup?.phone;
  if (phone && pairing) {
    pairing = null;
    $('pair-code').value = '';
    $('base-url').value = '';
    notice('Phone enrolled. Keep its app open and nearby to finish your sign-in.');
  }
  $('factor-title').textContent = phone ? 'Keep your phone nearby.' : 'Scan to enroll your phone.';
  $('phone-description').textContent = phone
    ? 'Your password is verified. Your enrolled phone must sign this login before your workspace opens.'
    : 'Enroll your Android phone first. Then verify it nearby over Bluetooth to finish signing in.';
  $('setup-phone-name').textContent = phone?.label || 'Add your Android phone';
  $('phone-status').textContent = phone ? phone.online ? 'Connected · ready to verify' : 'Offline · open the Android app' : 'One-time enrollment';
  $('setup-phone-dot').style.opacity = phone?.online ? '1' : '.3';
  $('permission-description').textContent = phone?.online
    ? 'Keep the Android app open. Your phone signs the login challenge without a code or confirmation tap.'
    : 'Open your enrolled Android app and connect it to Nearkey. To choose it in this browser, tap “Advertise setup for 60 seconds” on the phone first.';
  tick();
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Verified in this session' : date.toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
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
  const subtitle = document.createElement('small');
  subtitle.textContent = app.url ? new URL(app.url).host : 'Saved to your app list';
  description.append(title, subtitle);
  const status = document.createElement('span');
  status.className = 'site-status';
  status.textContent = 'Added';
  item.append(symbol, description, status);
  return item;
}

function renderAccount() {
  if (!account) return;
  $('user-name').textContent = account.user.name;
  $('dashboard-phone-name').textContent = account.phone?.label || 'Phone key';
  $('dashboard-phone-status').textContent = account.phone?.online ? 'Online' : 'Enrolled';
  $('dashboard-phone-detail').textContent = account.phone?.online ? 'Connected to Nearkey' : 'Open the app for your next sign-in';
  const apps = account.apps || [];
  $('session-time').textContent = currentVerification ? `Verified ${dateLabel(currentVerification)}.` : 'Both factors verified for this session.';
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
    account = result;
    session = {...session, authenticated: true, pending: false};
    flow.dispose();
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
    if (epoch === currentEpoch) openingDashboard = false;
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
        if (session.setup?.phone?.online && !bluetooth.availability() && !flow.state && !autoAttempted) void startChallenge();
      }
    }
  } catch (error) {
    if (epoch !== currentEpoch) return;
    if (error.status === 401) return flow.onSessionLost();
    if (error.code === 'verification_required') return void resumeSetup();
    notice(`${error.message} Status will retry shortly.`);
  } finally {
    if (epoch === currentEpoch) schedulePoll(currentEpoch);
  }
}

function renderChallenge(state) {
  if (!state) return renderControls();
  $('challenge-title').textContent = challengeTitles[state.phase] || challengeTitles.waiting;
  $('challenge-message').textContent = state.message;
  $('challenge-service').textContent = state.challenge.serviceName;
  $('challenge-username').textContent = state.challenge.username;
  $('delivery-status').textContent = flow.run ? state.phoneReady
    ? 'Your phone is advertising this sign-in challenge. Keep it nearby.'
    : 'Waiting for your phone app to advertise this sign-in challenge.'
    : state.phase === 'approved' ? 'Both factors accepted. Opening your workspace…' : 'Your workspace remains locked until a login signature is verified.';
  tick();
}

function tick() {
  if (flow.state) {
    const seconds = Math.max(0, Math.ceil((flow.state.challenge.expiresAt - Date.now()) / 1000));
    $('countdown').hidden = !flow.run;
    $('countdown').textContent = `${seconds}s left`;
  }
  if (pairing) {
    const seconds = Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000));
    $('pair-time').textContent = seconds ? `Expires in ${Math.floor(seconds / 60)}m ${seconds % 60}s. This code enrolls your phone; it does not sign you in.` : 'Code expired. Get a fresh enrollment code to continue.';
  }
  if (replacementPairing) {
    const seconds = Math.max(0, Math.ceil((replacementPairing.expiresAt - Date.now()) / 1000));
    $('replacement-time').textContent = seconds
      ? `Expires in ${Math.floor(seconds / 60)}m ${seconds % 60}s. Your current phone stays enrolled until the new phone finishes enrollment.`
      : 'Code expired. Get a new QR code to continue. Your current phone is still enrolled.';
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
    if (epoch === currentEpoch) notice(error.message);
  } finally {
    if (epoch === currentEpoch) loginBusy = false;
    renderControls();
  }
});

async function logout() {
  if (loginBusy || (!session?.pending && !account)) return;
  signOutLocally();
  const currentEpoch = epoch;
  loginBusy = true;
  renderControls();
  try {
    await api('/api/logout', {method: 'POST', body: {}});
    if (epoch === currentEpoch) notice('Signed out. Your next sign-in will verify both factors.');
  } catch (error) {
    if (epoch === currentEpoch) notice(`Server sign-out was not confirmed. ${error.message} Reload to check your session.`);
  } finally {
    if (epoch === currentEpoch) loginBusy = false;
    renderControls();
  }
}
$('logout').addEventListener('click', () => void logout());
$('back-button').addEventListener('click', () => void logout());

async function createPairing() {
  if (pairBusy || !session?.pending || session.setup?.phone) return;
  const currentEpoch = epoch;
  pairBusy = true;
  notice();
  renderControls();
  try {
    const result = await api('/api/pairing', {method: 'POST', body: {}, signal: lifetime.signal});
    if (epoch !== currentEpoch || session?.setup?.phone) return;
    pairing = result;
    renderSession();
  } catch (error) {
    if (epoch === currentEpoch) handleError(error);
  } finally {
    if (epoch === currentEpoch) pairBusy = false;
    renderControls();
  }
}
$('pair-button').addEventListener('click', () => void createPairing());

function openPhoneReplacement() {
  if (replacementBusy || (!account && !session?.setup?.phone)) return;
  if (account && replacementPairing) return $('replacement-qr-dialog').showModal();
  $('replace-phone-error').hidden = true;
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
  $('replace-phone-error').hidden = true;
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
    if ($('replacement-qr-dialog').open) notice(error.message);
    else {
      $('replace-phone-error').textContent = error.message;
      $('replace-phone-error').hidden = false;
      if (!$('replace-phone-dialog').open) $('replace-phone-dialog').showModal();
    }
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
  $('app-form-error').hidden = true;
  appOpener = event.currentTarget;
  $('app-dialog').showModal();
  $('app-name').focus();
}
$('add-app-button').addEventListener('click', openAppForm);
$('add-app-plus').addEventListener('click', openAppForm);
$('app-dialog-close').addEventListener('click', () => $('app-dialog').close());
$('app-dialog').addEventListener('cancel', event => {
  if (appBusy) event.preventDefault();
});
$('app-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!account || appBusy) return;
  const body = {name: $('app-name').value.trim(), url: $('app-url').value.trim()};
  if (!body.name) {
    $('app-form-error').textContent = 'Enter an app name.';
    $('app-form-error').hidden = false;
    $('app-name').focus();
    return;
  }
  const currentEpoch = epoch;
  appBusy = true;
  // Invalidate account reads already in flight before the save began.
  accountRevision++;
  $('app-form-error').hidden = true;
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
    $('app-form-error').textContent = error.message;
    $('app-form-error').hidden = false;
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

const ticker = setInterval(tick, 250);
window.addEventListener('pagehide', () => {
  resetLifetime();
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
    }
  }
}
void boot();
