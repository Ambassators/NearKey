import {api} from './api.mjs';
import {PhoneBluetooth} from './ble.mjs';
import {ChallengeFlow} from './challenge.mjs';
import {amountCents, money} from './format.mjs';

const $ = id => document.getElementById(id);
const bluetooth = new PhoneBluetooth();
let account = null;
let pairing = null;
let accountTimer = null;
let lifetime = new AbortController();
let epoch = 0;
let loginBusy = false;
let pairBusy = false;
let transferBusy = false;
let chooserBusy = false;
let recipientKey = '';
let ledgerKey = '';

const flow = new ChallengeFlow({api, bluetooth, onChange: async state => {
  renderChallenge(state);
  if (state?.phase !== 'approved' || !account) return;
  const currentEpoch = epoch;
  try {
    const result = await api('/api/account', {signal: lifetime.signal});
    if (epoch !== currentEpoch) return;
    account = result;
    renderAccount();
  } catch (error) {
    if (epoch !== currentEpoch) return;
    if (error.status === 401) return flow.onSessionLost();
    notice(`Transfer approved. ${error.message} Balance and ledger will retry shortly.`);
  }
}, onSessionLost: () => {
  signOutLocally();
  notice('Your session ended. Sign in again.');
}});

function notice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function resetLifetime() {
  epoch++;
  lifetime.abort(new Error('Page session changed.'));
  lifetime = new AbortController();
  clearTimeout(accountTimer);
  accountTimer = null;
  flow.dispose();
  pairing = null;
  pairBusy = transferBusy = chooserBusy = false;
}

function signOutLocally() {
  resetLifetime();
  loginBusy = false;
  account = null;
  $('pair-code').value = '';
  $('base-url').value = '';
  $('pair-time').textContent = '';
  $('pairing').hidden = true;
  $('bank-view').hidden = true;
  $('logout').hidden = true;
  $('login-view').hidden = false;
  $('password').value = '';
  renderControls();
}

function renderControls() {
  const state = flow.state;
  const inChallenge = !!state;
  const running = !!flow.run;
  const problem = bluetooth.availability();
  $('login-button').disabled = loginBusy;
  $('login-button').textContent = loginBusy ? 'Signing in…' : 'Sign in to Nearkey ↗';
  $('pair-button').disabled = pairBusy || !account || !!account.phone;
  $('pair-button').textContent = pairBusy ? 'Creating enrollment code…' : pairing ? 'Get a fresh enrollment code' : 'Get enrollment code';
  $('choose-button').disabled = chooserBusy || running || bluetooth.busy || !account?.phone || !!problem;
  $('choose-button').textContent = chooserBusy ? 'Waiting for the Bluetooth chooser…' : bluetooth.deviceId
    ? 'Choose / reconnect phone' : 'Choose phone / Enable Bluetooth 2FA';
  $('transfer-button').disabled = transferBusy || inChallenge || !account?.phone?.online || !bluetooth.deviceId || !!problem || chooserBusy || bluetooth.busy;
  $('transfer-button').textContent = transferBusy ? 'Creating server challenge…' : 'Start Bluetooth transfer ↗';
  $('reconnect-button').hidden = !running || state.phase !== 'reconnect';
  $('reconnect-button').disabled = !state?.phoneReady || bluetooth.busy;
  $('cancel-button').hidden = !running;
  $('new-transfer-button').hidden = running;
  $('transfer-panel').hidden = inChallenge;
  $('challenge-panel').hidden = !inChallenge;
  $('bluetooth-setup').hidden = !account?.phone || running;
  $('bluetooth-problem').hidden = !problem;
  $('bluetooth-problem').textContent = problem || '';
  if (!account) return;
  $('transfer-help').textContent = !account.phone ? 'Enroll your phone first to enable Bluetooth transfers.'
    : problem || (!bluetooth.deviceId ? 'Choose your enrolled phone to enable browser Bluetooth permission.'
      : !account.phone.online ? 'Open your phone app and reconnect it to the bank before starting.'
        : 'Your phone is online. Start a transfer and keep its app nearby in the foreground.');
  $('permission-description').textContent = !bluetooth.deviceId ? 'Keep Bluetooth enabled and the native Android app in the foreground. Tap “Advertise setup for 60 seconds” on the phone, then choose it here to grant this browser Bluetooth access. This permission is separate from phone enrollment.'
    : bluetooth.bluetooth?.getDevices
      ? 'A phone ID is remembered by this browser. Transfers try its permitted device automatically, then offer a chooser if unavailable.'
      : 'This browser cannot retrieve saved devices automatically. Choose / reconnect after each page reload. This page can reuse your current selection.';
}

function renderAccount() {
  if (!account) return;
  $('user-name').textContent = account.user.name;
  $('balance').textContent = money(account.balanceCents);
  $('phone-status').textContent = account.phone ? account.phone.online ? 'Online' : 'Offline' : 'Not enrolled';
  $('phone-status').classList.toggle('online', account.phone?.online === true);
  $('phone-description').textContent = account.phone
    ? `${account.phone.label} · ${account.phone.online ? 'Connected to the bank. Keep the Android app in the foreground.' : 'Open the Android app to connect its authenticated phone channel.'}`
    : 'Open the native Android app with Bluetooth already enabled. Paste a fresh enrollment code and the reachable HTTPS bank URL, then tap “Enroll phone”. Its non-exportable Keystore key signs only pending bank challenges.';
  $('enrollment').hidden = !!account.phone;
  if (account.phone) {
    const enrollmentDetected = !!pairing;
    pairing = null;
    $('pair-code').value = '';
    $('base-url').value = '';
    $('pair-time').textContent = '';
    if (enrollmentDetected) notice('Phone enrolled. Keep its app open, tap “Advertise setup for 60 seconds”, then choose the phone here to enable browser Bluetooth access.');
  }
  $('pairing').hidden = !pairing || !!account.phone;
  if (pairing) {
    $('pair-code').value = pairing.pairingCode;
    $('base-url').value = location.origin;
  }
  const nextRecipients = JSON.stringify(account.recipients);
  if (recipientKey !== nextRecipients) {
    recipientKey = nextRecipients;
    $('recipient').replaceChildren(...account.recipients.map(recipient => {
      const option = document.createElement('option');
      option.value = recipient.id;
      option.textContent = recipient.name;
      return option;
    }));
  }
  const nextLedger = JSON.stringify(account.transactions);
  if (ledgerKey !== nextLedger) {
    ledgerKey = nextLedger;
    $('transactions').replaceChildren(...[...account.transactions].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5).map(transaction => {
      const item = document.createElement('li');
      const description = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = transaction.recipientName;
      const subtitle = document.createElement('small');
      subtitle.textContent = `${new Date(transaction.createdAt).toLocaleString()}${transaction.note ? ` · ${transaction.note}` : ''}`;
      description.append(title, subtitle);
      const amount = document.createElement('span');
      amount.className = 'debit';
      amount.textContent = `−${money(transaction.amountCents)}`;
      item.append(description, amount);
      return item;
    }));
  }
  $('no-transactions').hidden = account.transactions.length !== 0;
  renderControls();
}

async function pollAccount(currentEpoch) {
  if (epoch !== currentEpoch || !account) return;
  try {
    const result = await api('/api/account', {signal: lifetime.signal});
    if (epoch !== currentEpoch) return;
    account = result;
    if ($('notice').textContent.endsWith(' Account status will retry shortly.')) notice();
    renderAccount();
  } catch (error) {
    if (epoch !== currentEpoch) return;
    if (error.status === 401) {
      signOutLocally();
      notice('Your session ended. Sign in again.');
      return;
    }
    notice(`${error.message} Account status will retry shortly.`);
  } finally {
    if (epoch === currentEpoch && account) accountTimer = setTimeout(() => void pollAccount(currentEpoch), 3000);
  }
}

async function enterBank() {
  resetLifetime();
  const currentEpoch = epoch;
  const result = await api('/api/account', {signal: lifetime.signal});
  if (epoch !== currentEpoch) return;
  account = result;
  $('login-view').hidden = true;
  $('bank-view').hidden = false;
  $('logout').hidden = false;
  $('password').value = '';
  notice();
  renderAccount();
  accountTimer = setTimeout(() => void pollAccount(currentEpoch), 3000);
}

function renderChallenge(state) {
  if (!state || !account) return;
  const {challenge, phase, receipt} = state;
  const titles = {
    waiting: 'Waiting for Bluetooth handshake', connecting: 'Waiting for Bluetooth handshake',
    submitting: 'Verifying phone signature', reconnect: 'Reconnect your phone',
    approved: 'Transfer complete', expired: 'Challenge expired', cancelled: 'Transfer stopped', failed: 'Transfer failed',
  };
  $('challenge-title').textContent = titles[phase] || 'Waiting for Bluetooth handshake';
  $('challenge-message').textContent = state.message;
  $('challenge-recipient').textContent = challenge.operation.recipientName;
  $('challenge-amount').textContent = money(challenge.operation.amountCents);
  $('challenge-note').textContent = challenge.operation.note || '—';
  $('challenge-version').textContent = String(challenge.v);
  $('challenge-id').textContent = challenge.id;
  $('challenge-phone').textContent = challenge.phoneId;
  $('challenge-nonce').textContent = challenge.nonce;
  $('challenge-recipient-id').textContent = challenge.operation.recipientId;
  $('challenge-cents').textContent = String(challenge.operation.amountCents);
  $('challenge-expires').textContent = `${new Date(challenge.expiresAt).toISOString()} (${challenge.expiresAt})`;
  $('delivery-status').textContent = flow.run ? state.phoneReady
    ? 'Phone delivery: ready · the phone started advertising this challenge.'
    : 'Phone delivery: waiting for advertisement readiness.' : 'Bluetooth attempt closed. Balance and ledger come from the bank server.';
  $('receipt').hidden = !receipt;
  if (receipt) {
    $('receipt-details').textContent = `${money(receipt.amountCents)} to ${receipt.recipientName} · ${new Date(receipt.createdAt).toLocaleString()}${receipt.note ? ` · ${receipt.note}` : ''}`;
    $('receipt-id').textContent = receipt.id;
  }
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
    $('pair-time').textContent = seconds ? `Enrollment code expires in ${Math.floor(seconds / 60)}m ${seconds % 60}s.` : 'Enrollment code expired. Get a fresh code to continue.';
    if (!seconds) $('pair-code').value = '';
  }
  renderControls();
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (loginBusy || account) return;
  loginBusy = true;
  let currentEpoch = epoch;
  notice();
  renderControls();
  try {
    await api('/api/login', {method: 'POST', body: {username: $('username').value, password: $('password').value}, signal: lifetime.signal});
    if (epoch !== currentEpoch) return;
    const entering = enterBank();
    currentEpoch = epoch;
    await entering;
  } catch (error) {
    if (epoch === currentEpoch && !account) notice(error.message);
  } finally {
    if (epoch === currentEpoch) {
      loginBusy = false;
      renderControls();
    }
  }
});

$('logout').addEventListener('click', async () => {
  if (!account || loginBusy) return;
  signOutLocally();
  const currentEpoch = epoch;
  loginBusy = true;
  notice('Signing out and revoking the pending server challenge…');
  renderControls();
  try {
    await api('/api/logout', {method: 'POST', body: {}});
    if (epoch === currentEpoch) notice('Signed out. Bluetooth connections and local timers are closed.');
  } catch (error) {
    if (epoch === currentEpoch) notice(`Stopped locally, but server sign-out was not confirmed. ${error.message} Reload to check the session; any pending challenge retains its original expiry.`);
  } finally {
    if (epoch === currentEpoch) loginBusy = false;
    renderControls();
  }
});

$('pair-button').addEventListener('click', async () => {
  if (pairBusy || !account || account.phone) return;
  const currentEpoch = epoch;
  pairBusy = true;
  notice();
  renderControls();
  try {
    const result = await api('/api/pairing', {method: 'POST', body: {}, signal: lifetime.signal});
    if (epoch !== currentEpoch) return;
    // Enrollment may have been detected by the account poll while this request ran.
    if (account?.phone) return;
    pairing = result;
    notice('Paste this enrollment code and the bank URL into the native Android app, then tap “Enroll phone”. Keep Bluetooth enabled and the app open; this page checks enrollment automatically.');
    renderAccount();
    tick();
  } catch (error) {
    if (epoch !== currentEpoch) return;
    if (error.status === 401) {
      signOutLocally();
      notice('Your session ended. Sign in again.');
    } else notice(error.message);
  } finally {
    if (epoch === currentEpoch) pairBusy = false;
    renderControls();
  }
});

$('choose-button').addEventListener('click', async () => {
  if (chooserBusy || flow.run || bluetooth.busy || !account?.phone) return;
  const currentEpoch = epoch;
  chooserBusy = true;
  renderControls();
  try {
    // Must remain in this click's activation, not behind a fetch or a timer.
    const device = await bluetooth.choose();
    if (epoch !== currentEpoch) return;
    notice(`Bluetooth access granted for ${device.name || 'the selected phone'}. Permission alone does not verify enrollment; the bank verifies its signature on each transfer.`);
  } catch (error) {
    if (epoch === currentEpoch) notice(error.name === 'NotFoundError'
      ? 'No phone selected. Start the phone’s setup advertisement and choose again.' : error.message);
  } finally {
    if (epoch === currentEpoch) chooserBusy = false;
    renderControls();
  }
});

$('transfer-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (transferBusy || flow.state || !account?.phone?.online || chooserBusy || bluetooth.busy) return;
  const problem = bluetooth.availability();
  if (problem || !bluetooth.deviceId) {
    notice(problem || 'Choose your enrolled phone to enable browser Bluetooth permission first.');
    return;
  }
  const currentEpoch = epoch;
  transferBusy = true;
  notice();
  renderControls();
  try {
    const result = await api('/api/challenges', {method: 'POST', body: {
      recipientId: $('recipient').value, amountCents: amountCents($('amount').value), note: $('note').value,
    }, signal: lifetime.signal});
    if (epoch !== currentEpoch) return;
    if (result.status !== 'waiting_phone') throw new Error('Server returned an unexpected challenge status.');
    flow.start(result.challenge);
  } catch (error) {
    if (epoch !== currentEpoch) return;
    if (error.status === 401) return flow.onSessionLost();
    notice(error.message);
  } finally {
    if (epoch === currentEpoch) transferBusy = false;
    renderControls();
  }
});

$('reconnect-button').addEventListener('click', () => {
  if (!flow.run || flow.state?.phase !== 'reconnect' || !flow.state.phoneReady || bluetooth.busy) return;
  notice();
  // Keep the chooser call in this fresh user activation.
  void flow.retry();
});
$('cancel-button').addEventListener('click', async () => {
  if (!flow.run) return;
  const currentEpoch = epoch;
  await flow.cancel();
  if (epoch !== currentEpoch || !account) return;
  try {
    // A completion already sent may win the cancellation race; only the bank knows the balance.
    const result = await api('/api/account', {signal: lifetime.signal});
    if (epoch !== currentEpoch) return;
    account = result;
    renderAccount();
  } catch (error) {
    if (epoch !== currentEpoch) return;
    if (error.status === 401) return flow.onSessionLost();
    notice(`${error.message} Balance and ledger will retry shortly.`);
  }
});
$('new-transfer-button').addEventListener('click', () => {
  if (flow.run || transferBusy || !account) return;
  flow.dispose();
  notice();
  renderControls();
  $('amount').focus();
});

const ticker = setInterval(tick, 250);
window.addEventListener('pagehide', () => {
  resetLifetime();
  clearInterval(ticker);
});
// A bfcache restore must check a fresh server session, never resume a stale challenge.
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

async function boot() {
  loginBusy = true;
  renderControls();
  let currentEpoch = epoch;
  try {
    const session = await api('/api/session', {signal: lifetime.signal});
    if (epoch !== currentEpoch) return;
    if (session.authenticated) {
      const entering = enterBank();
      currentEpoch = epoch;
      await entering;
    }
  } catch (error) {
    if (epoch === currentEpoch && !account) notice(error.message);
  } finally {
    if (epoch === currentEpoch) {
      loginBusy = false;
      renderControls();
    }
  }
}
void boot();
