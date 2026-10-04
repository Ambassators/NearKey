import {api} from './api.mjs';
import {PhoneBluetooth} from './ble.mjs';
import {ChallengeFlow} from './challenge.mjs';

const $ = id => document.getElementById(id);
const bluetooth = new PhoneBluetooth();
let session = null;
let account = null;
let pairing = null;
let timer = null;
let lifetime = new AbortController();
let epoch = 0;
let loginBusy = false;
let pairBusy = false;
let challengeBusy = false;
let chooserBusy = false;
let autoAttempted = false;
let activityKey = '';
let openingDashboard = false;
let currentVerification = null;
const pendingStatuses = new Set(['waiting_phone', 'waiting_bluetooth']);

const flow = new ChallengeFlow({api, bluetooth, onChange: state => {
  renderChallenge(state);
  if (state?.phase === 'approved') {
    currentVerification = state.receipt?.verifiedAt || state.receipt?.createdAt || null;
    const currentEpoch = epoch;
    void enterDashboard().catch(error => {if (epoch === currentEpoch) handleError(error);});
  }
}, onSessionLost: () => {
  signOutLocally();
  notice('Your sign-in session ended. Enter your password to start again.');
}});

function notice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function resetLifetime() {
  epoch++;
  lifetime.abort(new Error('Page session changed.'));
  lifetime = new AbortController();
  clearTimeout(timer);
  timer = null;
  flow.dispose();
  pairing = null;
  session = account = null;
  pairBusy = challengeBusy = chooserBusy = false;
  autoAttempted = openingDashboard = false;
  activityKey = '';
  currentVerification = null;
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
  notice(error.message);
}

function renderControls() {
  const phone = session?.setup?.phone;
  const state = flow.state;
  const running = !!flow.run;
  const problem = bluetooth.availability();
  const pending = session?.pending === true;
  $('login-view').hidden = !!account;
  $('dashboard-view').hidden = !account;
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
  $('enrollment').hidden = !!phone;
  $('bluetooth-setup').hidden = !phone;
  $('pairing').hidden = !pairing || !!phone;
  $('pair-button').disabled = pairBusy || !pending || !!phone;
  $('pair-button').firstChild.textContent = pairBusy ? 'Creating enrollment code… ' : pairing ? 'Get a fresh code ' : 'Get enrollment code ';
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
}

function renderSession() {
  const phone = session?.setup?.phone;
  if (phone && pairing) {
    pairing = null;
    $('pair-code').value = '';
    $('base-url').value = '';
    notice('Phone enrolled. Keep its app open and nearby to finish your sign-in.');
  }
  $('factor-title').innerHTML = phone ? 'One more step.<br>Keep your phone close.' : 'Meet your new<br>second factor.';
  $('phone-description').textContent = phone
    ? 'Your password is verified. Your enrolled phone must sign this login before your workspace opens.'
    : 'Enroll your Android phone first. Then verify it nearby over Bluetooth to finish signing in.';
  $('setup-phone-name').textContent = phone?.label || 'Add your Android phone';
  $('phone-status').textContent = phone ? phone.online ? 'Connected · ready to verify' : 'Offline · open the Android app' : 'One-time enrollment';
  $('setup-phone-dot').style.opacity = phone?.online ? '1' : '.3';
  $('permission-description').textContent = phone?.online
    ? 'Keep the Android app open. Your phone signs the login challenge without a code or confirmation tap.'
    : 'Open your enrolled Android app and connect it to Nearkey. To choose it in this browser, tap “Advertise setup for 60 seconds” on the phone first.';
  if (pairing) {
    $('pair-code').value = pairing.pairingCode;
    $('base-url').value = location.origin;
  }
  renderControls();
  tick();
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Verified in this session' : date.toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
}

function icon(symbol) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${symbol}`);
  svg.append(use);
  return svg;
}

function renderAccount() {
  if (!account) return;
  $('user-name').textContent = account.user.name;
  $('dashboard-phone-name').textContent = account.phone?.label || 'Phone key';
  $('dashboard-phone-status').textContent = account.phone?.online ? 'Online' : 'Enrolled';
  $('dashboard-phone-detail').textContent = account.phone?.online ? 'Connected to Nearkey' : 'Open the app for your next sign-in';
  const activity = [...(account.activity || [])].sort((a, b) => new Date(b.verifiedAt) - new Date(a.verifiedAt));
  $('session-time').textContent = currentVerification ? `Verified ${dateLabel(currentVerification)}.` : 'Both factors verified for this session.';
  const nextKey = JSON.stringify(activity);
  if (activityKey !== nextKey) {
    activityKey = nextKey;
    $('activity-list').replaceChildren(...activity.slice(0, 4).map(event => {
      const item = document.createElement('li');
      const symbol = document.createElement('span');
      symbol.className = 'activity-icon';
      symbol.append(icon('shield'));
      const description = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `${event.serviceName || 'Nearkey'} sign-in verified`;
      const subtitle = document.createElement('small');
      subtitle.textContent = `${dateLabel(event.verifiedAt || event.createdAt)} · ${event.phoneLabel || 'Enrolled phone'}`;
      description.append(title, subtitle);
      const proof = document.createElement('span');
      proof.className = 'activity-proof';
      proof.textContent = 'Bluetooth 2FA';
      item.append(symbol, description, proof);
      return item;
    }));
  }
  $('no-activity').hidden = activity.length > 0;
  renderControls();
}

async function enterDashboard() {
  if (openingDashboard || account) return;
  openingDashboard = true;
  const currentEpoch = epoch;
  try {
    // The server, not a successful password or browser permission, opens the workspace.
    const result = await api('/api/account', {signal:lifetime.signal});
    if (epoch !== currentEpoch) return;
    account = result;
    session = {...session, authenticated:true, pending:false};
    flow.dispose();
    $('password').value = '';
    notice();
    renderAccount();
    $('dashboard-title').focus({preventScroll:true});
    schedulePoll(currentEpoch);
  } finally {
    if (epoch === currentEpoch) openingDashboard = false;
  }
}

function schedulePoll(currentEpoch) {
  clearTimeout(timer);
  if (session?.pending || account) timer = setTimeout(() => void poll(currentEpoch), 3000);
}

async function poll(currentEpoch) {
  if (epoch !== currentEpoch || !session) return;
  try {
    if (account) {
      const result = await api('/api/account', {signal:lifetime.signal});
      if (epoch !== currentEpoch) return;
      account = result;
      renderAccount();
    } else {
      const result = await api('/api/session', {signal:lifetime.signal});
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
    notice(`${error.message} Status will retry shortly.`);
  } finally {
    if (epoch === currentEpoch) schedulePoll(currentEpoch);
  }
}

function renderChallenge(state) {
  if (!state) return renderControls();
  const titles = {
    waiting:'Checking your phone key.', connecting:'Checking your phone key.',
    submitting:'Verifying your signature.', reconnect:'Let’s find your phone.',
    approved:'Your sign-in is verified.', expired:'Let’s try that again.',
    cancelled:'Verification stopped.', failed:'Verification interrupted.',
  };
  $('challenge-title').textContent = titles[state.phase] || 'Checking your phone key.';
  $('challenge-message').textContent = state.message;
  $('challenge-service').textContent = state.challenge.serviceName;
  $('challenge-username').textContent = state.challenge.username;
  $('delivery-status').textContent = flow.run ? state.phoneReady
    ? 'Your phone is advertising this sign-in challenge. Keep it nearby.'
    : 'Waiting for your phone app to advertise this sign-in challenge.'
    : state.phase === 'approved' ? 'Both factors accepted. Opening your workspace…' : 'Your workspace remains locked until a login signature is verified.';
  renderControls();
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
    if (!seconds) $('pair-code').value = '';
  }
  renderControls();
}

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
  schedulePoll(epoch);
}

async function startChallenge() {
  if (challengeBusy || flow.run || !session?.pending || !session.setup?.phone?.online || account) return;
  const problem = bluetooth.availability();
  if (problem) return notice(problem);
  autoAttempted = true;
  challengeBusy = true;
  const currentEpoch = epoch;
  notice();
  renderControls();
  try {
    const result = await api('/api/challenges', {method:'POST', body:{}, signal:lifetime.signal});
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

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (loginBusy || session?.pending || account) return;
  loginBusy = true;
  const currentEpoch = epoch;
  notice();
  renderControls();
  try {
    const result = await api('/api/login', {method:'POST', body:{username:$('username').value, password:$('password').value}, signal:lifetime.signal});
    if (epoch !== currentEpoch) return;
    await acceptSession(result);
    if (epoch === currentEpoch && session?.pending) $(flow.state ? 'challenge-title' : 'factor-title').focus({preventScroll:true});
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
    await api('/api/logout', {method:'POST', body:{}});
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

$('pair-button').addEventListener('click', async () => {
  if (pairBusy || !session?.pending || session.setup?.phone) return;
  const currentEpoch = epoch;
  pairBusy = true;
  notice();
  renderControls();
  try {
    const result = await api('/api/pairing', {method:'POST', body:{}, signal:lifetime.signal});
    if (epoch !== currentEpoch || session?.setup?.phone) return;
    pairing = result;
    renderSession();
  } catch (error) {
    if (epoch === currentEpoch) handleError(error);
  } finally {
    if (epoch === currentEpoch) pairBusy = false;
    renderControls();
  }
});

$('choose-button').addEventListener('click', async () => {
  if (chooserBusy || flow.run || bluetooth.busy || !session?.setup?.phone) return;
  const currentEpoch = epoch;
  chooserBusy = true;
  renderControls();
  try {
    // requestDevice is called in this click's activation, before any network request.
    const device = await bluetooth.choose();
    if (epoch !== currentEpoch) return;
    notice(`Bluetooth access granted for ${device.name || 'your phone'}. Its login signature still needs to be verified.`);
    if (session.setup.phone.online) void startChallenge();
  } catch (error) {
    if (epoch === currentEpoch) notice(error.name === 'NotFoundError' ? 'No phone selected. Start its setup advertisement in the Android app and choose again.' : error.message);
  } finally {
    if (epoch === currentEpoch) chooserBusy = false;
    renderControls();
  }
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
    const result = await api('/api/session', {signal:lifetime.signal});
    if (epoch !== currentEpoch) return;
    if (result.authenticated) await enterDashboard();
    else if (!result.pending) flow.onSessionLost();
    else {session = result; renderSession();}
  } catch (error) {
    if (epoch === currentEpoch) handleError(error);
  }
});

const ticker = setInterval(tick, 250);
window.addEventListener('pagehide', () => {resetLifetime(); clearInterval(ticker);});
window.addEventListener('pageshow', event => {if (event.persisted) location.reload();});

async function boot() {
  loginBusy = true;
  renderControls();
  const currentEpoch = epoch;
  try {
    const result = await api('/api/session', {signal:lifetime.signal});
    if (epoch === currentEpoch) await acceptSession(result);
  } catch (error) {
    if (epoch === currentEpoch) notice(error.message);
  } finally {
    if (epoch === currentEpoch) loginBusy = false;
    renderControls();
  }
}
void boot();
