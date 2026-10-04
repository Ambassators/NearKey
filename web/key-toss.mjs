import {createTimeline, svg, utils} from './anime.mjs';

// Loop timing (ms). The phone winds up, tosses its key along the dotted arc,
// the key turns in the computer's lock, the lock opens, then the scene resets.
const WIND_UP = 320;
const FLIGHT = 980;
const LAND = WIND_UP + FLIGHT;
const HOLD_AT = LAND + 700;
const RESET_AT = HOLD_AT + 500;
const LOOP_END = RESET_AT + 420;
const HOME = {translateX: 44, translateY: 60};
const LOCKED = {body: '#366146', screen: '#eef5e6'};
const OPEN = {body: '#4d8a5e', screen: '#d9f1c7'};

// Modes: 'loop' while verification runs, 'finish' once the login is approved
// (settles on the unlocked frame), 'rest' otherwise (static, dimmed by CSS).
export class KeyToss {
  constructor(root) {
    this.root = root;
    this.mode = null;
    this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const q = selector => root.querySelector(selector);
    const key = q('.kt-key');
    const inner = q('.kt-key-inner');
    const phone = q('.kt-phone');
    const laptop = q('.kt-laptop');
    const screen = q('.kt-screen');
    const shackle = q('.kt-shackle');
    const body = q('.kt-lock-body');
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
        // Once approved, let the key finish its throw and hold the unlocked frame.
        if (this.mode === 'finish' && tl.iterationCurrentTime >= HOLD_AT && tl.iterationCurrentTime < RESET_AT) tl.pause();
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
      // Landing: the key turns in the lock and slips in; the computer unlocks.
      .add(inner, {scale: .5, rotate: 422, duration: 240}, LAND)
      .add(key, {opacity: 0, duration: 180, ease: 'outQuad'}, LAND + 160)
      .add(laptop, {scale: [1, 1.03], duration: 120, ease: 'outQuad'}, LAND)
      .add(laptop, {scale: 1, duration: 320}, LAND + 120)
      .add(shackle, {translateY: -4, rotate: -26, duration: 300}, LAND + 120)
      .add(body, {fill: OPEN.body, duration: 220, ease: 'outQuad'}, LAND + 120)
      .add(screen, {fill: OPEN.screen, duration: 220, ease: 'outQuad'}, LAND + 120)
      .add(trail, {draw: '1 1', duration: 440, ease: 'inQuad'}, LAND + 60)
      .add(trail, {opacity: 0, duration: 200, ease: 'outQuad'}, LAND + 330)
      // Reset: the lock closes and the key reappears on the phone.
      .add(shackle, {translateY: 0, rotate: 0, duration: 260}, RESET_AT)
      .add(body, {fill: LOCKED.body, duration: 260, ease: 'outQuad'}, RESET_AT)
      .add(screen, {fill: LOCKED.screen, duration: 260, ease: 'outQuad'}, RESET_AT)
      .set(key, HOME, RESET_AT + 80)
      .set(inner, {scale: .7, rotate: 0}, RESET_AT + 80)
      .add(key, {opacity: 1, duration: 240, ease: 'outQuad'}, RESET_AT + 100)
      .add(inner, {scale: 1, duration: 320}, RESET_AT + 100);
  }

  sync(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.root.dataset.mode = mode;
    const tl = this.tl;
    if (mode === 'loop') {
      if (this.reduced) return this.freeze(0);
      if (tl.iterationCurrentTime >= HOLD_AT) tl.seek(0);
      tl.play();
    } else if (mode === 'finish') {
      // Reduced motion, or a run that was already resting, jumps straight to the unlocked frame.
      if (this.reduced || tl.paused) this.freeze(HOLD_AT);
    } else {
      this.freeze(0);
    }
  }

  freeze(time) {
    this.tl.pause();
    this.tl.seek(time);
  }
}
