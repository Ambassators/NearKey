import {createTimeline, svg, utils} from './anime.mjs';

// Loop timing (ms). The phone winds up, tosses its key along the dotted arc,
// the key turns in the computer's lock, then the scene resets while waiting.
const WIND_UP = 320;
const FLIGHT = 980;
const LAND = WIND_UP + FLIGHT;
const HOLD_AT = LAND + 700;
const RESET_AT = HOLD_AT + 500;
const LOOP_END = RESET_AT + 420;
const HOME = {translateX: 44, translateY: 60};
const LOCKED_SCREEN = '#eef5e6';
const OPEN_SCREEN = '#d9f1c7';

// Modes: 'loop' while verification runs, 'finish' once the login is approved
// (settles on a green checkmark), 'fail' for a red X on the phone, 'rest' otherwise.
export class KeyToss {
  constructor(root) {
    this.root = root;
    this.mode = null;
    this.completion = null;
    this.resolveCompletion = null;
    this.resultTimeline = null;
    this.resultStarted = false;
    this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const q = selector => root.querySelector(selector);
    const key = q('.kt-key');
    const inner = q('.kt-key-inner');
    const phone = q('.kt-phone');
    const laptop = q('.kt-laptop');
    const screen = q('.kt-screen');
    this.parts = {key, screen, lock: q('.kt-lock'), success: q('.kt-success'), error: q('.kt-error')};
    const arc = q('.kt-arc');
    const trail = svg.createDrawable(q('.kt-trail'));
    const flight = svg.createMotionPath(q('.kt-flight'));
    utils.set(key, {...HOME, opacity: 1});
    utils.set(inner, {scale: 1, rotate: 0});

    this.tl = createTimeline({
      loop: true,
      loopDelay: 180,
      autoplay: false,
      defaults: {ease: 'outQuart'},
      onUpdate: tl => {
        // Approval finishes the throw before revealing the final result.
        if (this.mode === 'finish' && tl.iterationCurrentTime >= HOLD_AT) this.showSuccess();
      },
    })
      // Dots drift toward the computer for the whole loop (7.6 = one dash period).
      .add(arc, {strokeDashoffset: [0, -7.6 * 12], duration: LOOP_END, ease: 'linear'}, 0)
      // Wind-up: the phone leans back and the key tenses.
      .add(inner, {scale: [1, 1.14], rotate: [0, -28], duration: 260, ease: 'outQuad'}, 0)
      .add(phone, {rotate: [0, -7], duration: 220, ease: 'outQuad'}, 60)
      .add(phone, {rotate: 0, duration: 420}, WIND_UP)
      // Flight along the dotted arc, one full spin, leaving a trail.
      .add(key, {translateX: flight.translateX, translateY: flight.translateY, duration: FLIGHT, ease: 'inOutSine'}, WIND_UP)
      .add(inner, {scale: 1, rotate: 332, duration: FLIGHT, ease: 'inOutSine'}, WIND_UP)
      .add(trail, {opacity: [0, .9], duration: 160, ease: 'outQuad'}, WIND_UP)
      .add(trail, {draw: ['0 0', '0 1'], duration: FLIGHT, ease: 'inOutSine'}, WIND_UP)
      // Landing: the key turns in the lock and slips in.
      .add(inner, {scale: .5, rotate: 422, duration: 240}, LAND)
      .add(key, {opacity: 0, duration: 180, ease: 'outQuad'}, LAND + 160)
      .add(laptop, {scale: [1, 1.03], duration: 120, ease: 'outQuad'}, LAND)
      .add(laptop, {scale: 1, duration: 320}, LAND + 120)
      .add(trail, {draw: '1 1', duration: 440, ease: 'inQuad'}, LAND + 60)
      .add(trail, {opacity: 0, duration: 200, ease: 'outQuad'}, LAND + 330)
      // Reset: the key reappears on the phone.
      .set(key, HOME, RESET_AT + 80)
      .set(inner, {scale: .7, rotate: 0}, RESET_AT + 80)
      .add(key, {opacity: 1, duration: 240, ease: 'outQuad'}, RESET_AT + 100)
      .add(inner, {scale: 1, duration: 320}, RESET_AT + 100);
  }

  sync(mode) {
    if (mode === this.mode) return this.completion;
    this.resultTimeline?.pause();
    this.resultTimeline = null;
    this.resolveCompletion?.(false);
    this.completion = this.resolveCompletion = null;
    this.resultStarted = false;
    this.mode = mode;
    this.root.dataset.mode = mode;
    const {lock, screen, success, error, key} = this.parts;
    utils.set(lock, {opacity: 1});
    utils.set(screen, {fill: LOCKED_SCREEN});
    utils.set([success, error], {opacity: 0, scale: 1});
    const tl = this.tl;
    if (mode === 'loop') {
      if (this.reduced) return this.freeze(0);
      if (tl.iterationCurrentTime >= HOLD_AT) tl.seek(0);
      tl.play();
    } else if (mode === 'finish') {
      this.completion = new Promise(resolve => { this.resolveCompletion = resolve; });
      if (this.reduced) this.showSuccess();
      else {
        // Approval during reset starts a complete final throw instead of cutting it short.
        if (tl.paused || tl.iterationCurrentTime >= HOLD_AT) tl.seek(0);
        tl.play();
      }
      return this.completion;
    } else if (mode === 'fail') {
      this.freeze(0);
      utils.set(key, {opacity: 0});
      if (this.reduced) utils.set(error, {opacity: 1});
      else this.resultTimeline = createTimeline().add(error, {
        opacity: [0, 1], scale: [.65, 1], duration: 260, ease: 'outBack',
      });
    } else {
      this.freeze(0);
    }
  }

  showSuccess() {
    if (this.resultStarted || this.mode !== 'finish') return;
    this.resultStarted = true;
    this.freeze(HOLD_AT);
    const {lock, screen, success} = this.parts;
    const complete = () => {
      this.resolveCompletion?.(true);
      this.resolveCompletion = null;
    };
    if (this.reduced) {
      utils.set(lock, {opacity: 0});
      utils.set(screen, {fill: OPEN_SCREEN});
      utils.set(success, {opacity: 1, scale: 1});
      complete();
      return;
    }
    this.resultTimeline = createTimeline({onComplete: complete})
      .add(lock, {opacity: 0, duration: 160}, 0)
      .add(screen, {fill: OPEN_SCREEN, duration: 220}, 0)
      .add(success, {opacity: [0, 1], scale: [.65, 1], duration: 320, ease: 'outBack'}, 100)
      // Keep the checkmark visible briefly before allowing navigation.
      .add({hold: 0}, {hold: 1, duration: 450}, 420);
  }

  freeze(time) {
    this.tl.pause();
    this.tl.seek(time);
  }
}
