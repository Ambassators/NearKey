import {CONTRACT_VERSION} from '../shared/protocol.mjs';

const pendingStatuses = new Set(['waiting_phone', 'waiting_bluetooth']);

export function validateChallenge(challenge) {
  if (challenge?.v !== CONTRACT_VERSION || typeof challenge.id !== 'string' || !challenge.id
      || typeof challenge.phoneId !== 'string' || !challenge.phoneId
      || typeof challenge.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce)
      || !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt <= 0
      || typeof challenge.operation?.recipientId !== 'string' || !challenge.operation.recipientId
      || typeof challenge.operation?.recipientName !== 'string' || !challenge.operation.recipientName
      || !Number.isSafeInteger(challenge.operation?.amountCents) || challenge.operation.amountCents <= 0
      || typeof challenge.operation?.note !== 'string' || challenge.operation.note.length > 120) {
    throw new Error('Server returned an invalid version 1 challenge. No Bluetooth request was sent.');
  }
  return Object.freeze({...challenge, operation: Object.freeze({...challenge.operation})});
}

// Owns a single server challenge; all callbacks and in-flight results are lifetime guarded.
export class ChallengeFlow {
  constructor({api, bluetooth, onChange, onSessionLost = () => {}, pollMs = 1000}) {
    Object.assign(this, {api, bluetooth, onChange, onSessionLost, pollMs});
    this.run = null;
    this.state = null;
  }

  start(challenge) {
    const immutable = validateChallenge(challenge);
    this.dispose();
    const run = {challenge: immutable, controller: new AbortController(), ready: false,
      attempted: false, attempting: false, polling: false, pollTimer: null, deadline: null};
    this.run = run;
    this.state = {challenge: immutable, phase: 'waiting', phoneReady: false,
      message: 'Delivering the server challenge to your foreground phone app.', receipt: null};
    if (Date.now() < immutable.expiresAt) {
      run.deadline = setTimeout(() => this.finish(run, 'expired'), immutable.expiresAt - Date.now());
    }
    this.emit();
    if (this.live(run)) void this.poll(run);
  }

  live(run) {
    if (!run || this.run !== run || run.controller.signal.aborted) return false;
    if (Date.now() >= run.challenge.expiresAt) {
      this.finish(run, 'expired');
      return false;
    }
    return true;
  }

  emit() { this.onChange(this.state); }

  update(run, changes) {
    if (!this.live(run)) return;
    this.state = {...this.state, ...changes, challenge: run.challenge};
    this.emit();
  }

  async poll(run) {
    if (!this.live(run) || run.polling) return;
    clearTimeout(run.pollTimer);
    run.pollTimer = null;
    run.polling = true;
    try {
      const data = await this.api(`/api/challenges/${encodeURIComponent(run.challenge.id)}`, {signal: run.controller.signal});
      if (!this.live(run)) return;
      if (data.status === 'approved') return this.finish(run, 'approved', data.receipt);
      if (data.status === 'expired' || data.status === 'cancelled') return this.finish(run, data.status);
      if (!pendingStatuses.has(data.status)) throw new Error('Server returned an unknown challenge status.');
      // Never replace the original immutable challenge with a later poll's metadata.
      run.ready = data.phoneReady === true;
      this.update(run, {phoneReady: run.ready,
        ...(this.state.phase === 'waiting' ? {message: run.ready
          ? 'Phone is advertising. Connecting to your permitted Bluetooth device…'
          : 'Waiting for the phone to start advertising. Keep its app in the foreground.'} : {}),
      });
      if (run.ready && !run.attempted) void this.attempt(run);
    } catch (error) {
      if (!this.live(run)) return;
      if (error.status === 401) {
        this.finish(run, 'failed', null, 'Session ended. Sign in again.');
        this.onSessionLost();
        return;
      }
      this.update(run, {message: `${error.message} Status checks will retry until expiry.`});
    } finally {
      run.polling = false;
      if (this.live(run)) {
        run.pollTimer = setTimeout(() => {
          run.pollTimer = null;
          void this.poll(run);
        }, this.pollMs);
      }
    }
  }

  // choose=true is reached directly from a user click, before any await.
  async attempt(run, choose = false) {
    if (!this.live(run) || !run.ready || run.attempting) return;
    run.attempting = true;
    run.attempted = true;
    this.update(run, {phase: 'connecting', message: choose
      ? 'Choose the enrolled phone. It must be advertising this challenge.'
      : 'Waiting for Bluetooth handshake. Your phone signs passively; no phone confirmation is needed.'});
    try {
      if (choose) await this.bluetooth.choose();
      if (!this.live(run)) return;
      const signature = await this.bluetooth.prove(run.challenge, run.controller.signal);
      if (!this.live(run)) return;
      this.update(run, {phase: 'submitting', message: 'Phone signed. Verifying with the bank server…'});
      const result = await this.api(`/api/challenges/${encodeURIComponent(run.challenge.id)}/complete`, {
        method: 'POST', body: {signature}, signal: run.controller.signal,
      });
      if (!this.live(run)) return;
      if (result.status !== 'approved' || !result.receipt) throw new Error('Bank did not return a transfer receipt.');
      this.finish(run, 'approved', result.receipt);
    } catch (error) {
      if (!this.live(run)) return;
      if (error.status === 401) {
        this.finish(run, 'failed', null, 'Session ended. Sign in again.');
        this.onSessionLost();
        return;
      }
      this.update(run, {phase: 'reconnect', message: error.name === 'NotFoundError'
        ? 'No phone selected. Choose / reconnect phone to retry the same pending challenge.'
        : error.message});
    } finally {
      run.attempting = false;
    }
  }

  retry() {
    if (this.run) return this.attempt(this.run, true);
    return Promise.resolve();
  }

  async cancel() {
    const run = this.run;
    if (!run) return;
    this.finish(run, 'cancelled');
    const terminal = this.state;
    try {
      await this.api(`/api/challenges/${encodeURIComponent(run.challenge.id)}/cancel`, {method: 'POST', body: {}});
    } catch (error) {
      if (this.state !== terminal) return;
      this.state = {...terminal, message: `Stopped locally. ${error.message} The phone challenge expires at its original deadline.`};
      this.emit();
    }
  }

  finish(run, phase, receipt = null, message = '') {
    if (this.run !== run) return;
    this.stop(run);
    this.run = null;
    this.state = {...this.state, phase, receipt, message: message || {
      approved: 'Transfer complete. Your phone signed the server challenge over Bluetooth.',
      expired: 'The 60-second challenge expired. No further proof will be sent. Start a new transfer to retry.',
      cancelled: 'Handshake stopped. Cancellation requested; any proof already sent is reconciled from the account.',
    }[phase]};
    this.emit();
  }

  stop(run) {
    clearTimeout(run.pollTimer);
    clearTimeout(run.deadline);
    run.controller.abort(new Error('Challenge stopped.'));
    this.bluetooth.cancel();
  }

  dispose() {
    if (this.run) this.stop(this.run);
    else this.bluetooth.cancel();
    this.run = null;
    this.state = null;
  }
}
