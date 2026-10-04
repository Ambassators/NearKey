import {CONTRACT_VERSION} from '../shared/protocol.mjs';

const pendingStatuses = new Set(['waiting_phone', 'waiting_bluetooth']);

export function validateChallenge(challenge) {
  if (challenge?.v !== CONTRACT_VERSION || typeof challenge.id !== 'string' || !challenge.id
      || typeof challenge.phoneId !== 'string' || !challenge.phoneId
      || typeof challenge.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce)
      || !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt <= 0
      || challenge.purpose !== 'login'
      || typeof challenge.username !== 'string' || !challenge.username || challenge.username.length > 80
      || typeof challenge.serviceName !== 'string' || !challenge.serviceName || challenge.serviceName.length > 80
      || typeof challenge.sessionId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge.sessionId)) {
    throw new Error(`Server returned an invalid version ${CONTRACT_VERSION} login challenge. No Bluetooth request was sent.`);
  }
  return Object.freeze({...challenge});
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
      message: 'Keep the Android app open and your phone nearby.', receipt: null};
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
      if (data.status === 'approved') {
        if (data.authenticated !== true || !data.receipt) throw new Error('Provider did not confirm a verified login.');
        return this.finish(run, 'approved', data.receipt);
      }
      if (data.status === 'expired' || data.status === 'cancelled') return this.finish(run, data.status);
      if (!pendingStatuses.has(data.status)) throw new Error('Server returned an unknown challenge status.');
      // Never replace the original immutable challenge with a later poll's metadata.
      run.ready = data.phoneReady === true;
      this.update(run, {phoneReady: run.ready,
        ...(this.state.phase === 'waiting' ? {message: run.ready
          ? 'Connecting over Bluetooth…'
          : 'Keep the Android app open and your phone nearby.'} : {}),
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
      ? 'Select your enrolled phone.'
      : 'Keep your phone nearby while it connects.'});
    try {
      if (choose) await this.bluetooth.choose();
      if (!this.live(run)) return;
      const signature = await this.bluetooth.prove(run.challenge, run.controller.signal);
      if (!this.live(run)) return;
      this.update(run, {phase: 'submitting', message: 'Checking phone verification…'});
      const result = await this.api(`/api/challenges/${encodeURIComponent(run.challenge.id)}/complete`, {
        method: 'POST', body: {signature}, signal: run.controller.signal,
      });
      if (!this.live(run)) return;
      if (result.status !== 'approved' || result.authenticated !== true || !result.receipt) {
        throw new Error('Provider did not confirm a verified login.');
      }
      this.finish(run, 'approved', result.receipt);
    } catch (error) {
      if (!this.live(run)) return;
      if (error.status === 401) {
        this.finish(run, 'failed', null, 'Session ended. Sign in again.');
        this.onSessionLost();
        return;
      }
      this.update(run, {phase: 'reconnect', message: error.name === 'NotFoundError'
        ? 'No phone selected. Tap “Reconnect phone” to try again.'
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
      approved: 'Opening your apps…',
      expired: 'Tap “Try again” to continue.',
      cancelled: 'Login verification stopped. Any proof already submitted will be checked against your session.',
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
