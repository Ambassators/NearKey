import {animate, createTimeline, stagger, svg, utils} from './anime.mjs';

// Hero loop timing (ms). The phone winds up, tosses its key along the dotted
// arc, the key opens the laptop's lock and the sign-in card becomes the app list.
const WIND_UP = 320;
const FLIGHT = 1050;
const LAND = WIND_UP + FLIGHT;
const RESET_AT = LAND + 1900;
const HOME = {translateX: 115, translateY: 350};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class Homepage {
  constructor(root) {
    this.root = root;
    this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.narrow = typeof matchMedia === 'function' ? matchMedia('(max-width: 540px)') : {matches: false};
    this.shown = false;
    this.introduced = false;
    this.loopReady = false;
    this.timerId = null;
    this.observer = null;
    const q = selector => root.querySelector(selector);
    this.topbar = document.getElementById('topbar');
    this.flow = q('.flow');
    this.steps = [...root.querySelectorAll('.flow-step')];
    this.deviceTimer = q('#device-timer');
    this.parts = {
      title: [...root.querySelectorAll('.hero-title .line > span')],
      copy: [q('.hero-lede'), q('.hero-actions')],
      phone: q('.hs-phone'), laptop: q('.hs-laptop'), arc: q('.hs-arc'), trail: q('.hs-trail'), flight: q('.hs-flight'),
      key: q('.hs-key'), inner: q('.hs-key-inner'), rings: [...root.querySelectorAll('.hs-ring')],
      lock: q('.hs-lock'), shackle: q('.hs-shackle'), check: q('.hs-check'), signin: q('.hs-signin'),
      apps: q('.hs-apps'), rows: [...root.querySelectorAll('.hs-row')],
    };
    this.onScroll = () => this.handleScroll();
    this.loop = this.reduced ? null : this.buildLoop();
  }

  buildLoop() {
    const {key, inner, phone, laptop, rings, lock, shackle, check, signin, apps, rows} = this.parts;
    const trail = svg.createDrawable(this.parts.trail);
    const flight = svg.createMotionPath(this.parts.flight);
    utils.set(key, {...HOME, opacity: 1});
    utils.set(inner, {scale: 1, rotate: 0});
    return createTimeline({loop: true, loopDelay: 420, autoplay: false, defaults: {ease: 'outQuart'}})
      // The phone notices the challenge: rings ripple out, the key tenses.
      .add(rings, {scale: [.45, 1.9], opacity: [.75, 0], duration: 1200, delay: stagger(170), ease: 'outQuad'}, 0)
      .add(inner, {scale: [1, 1.14], rotate: [0, -28], duration: 260, ease: 'outQuad'}, 0)
      .add(phone, {rotate: [0, -5], duration: 220, ease: 'outQuad'}, 60)
      .add(phone, {rotate: 0, duration: 460}, WIND_UP)
      // Flight along the dotted arc with one full spin and a drawn trail.
      .add(key, {translateX: flight.translateX, translateY: flight.translateY, duration: FLIGHT, ease: 'inOutSine'}, WIND_UP)
      .add(inner, {scale: 1, rotate: 332, duration: FLIGHT, ease: 'inOutSine'}, WIND_UP)
      .add(trail, {opacity: [0, .9], duration: 160, ease: 'outQuad'}, WIND_UP)
      .add(trail, {draw: ['0 0', '0 1'], duration: FLIGHT, ease: 'inOutSine'}, WIND_UP)
      // Landing: the key turns, the lock opens, the sign-in card becomes the app list.
      .add(inner, {scale: .5, rotate: 422, duration: 240}, LAND)
      .add(key, {opacity: 0, duration: 180, ease: 'outQuad'}, LAND + 150)
      .add(laptop, {scale: [1, 1.025], duration: 120, ease: 'outQuad'}, LAND)
      .add(laptop, {scale: 1, duration: 360}, LAND + 120)
      .add(trail, {draw: '1 1', duration: 440, ease: 'inQuad'}, LAND + 60)
      .add(trail, {opacity: 0, duration: 200, ease: 'outQuad'}, LAND + 330)
      .add(shackle, {translateY: -5, duration: 220}, LAND + 40)
      .add(lock, {opacity: 0, duration: 180}, LAND + 240)
      .add(check, {opacity: [0, 1], scale: [.6, 1], duration: 380, ease: 'outBack'}, LAND + 280)
      .add(signin, {opacity: 0, duration: 200}, LAND + 220)
      .add(apps, {opacity: 1, duration: 240}, LAND + 340)
      .add(rows, {translateX: [-10, 0], opacity: [0, 1], duration: 520, delay: stagger(70)}, LAND + 360)
      // Reset: the card locks again and the key reappears on the phone.
      .add(apps, {opacity: 0, duration: 240}, RESET_AT)
      .add(check, {opacity: 0, duration: 200}, RESET_AT)
      .add(signin, {opacity: 1, duration: 260}, RESET_AT + 200)
      .add(lock, {opacity: 1, duration: 220}, RESET_AT + 200)
      .add(shackle, {translateY: 0, duration: 260}, RESET_AT + 240)
      .set(key, HOME, RESET_AT + 80)
      .set(inner, {scale: .7, rotate: 0}, RESET_AT + 80)
      .add(key, {opacity: 1, duration: 240, ease: 'outQuad'}, RESET_AT + 120)
      .add(inner, {scale: 1, duration: 340}, RESET_AT + 120);
  }

  // One choreographed load: headline lines rise, copy settles, devices slide in,
  // the arc draws, then the key appears and the loop begins.
  playIntro() {
    const {title, copy, phone, laptop, key} = this.parts;
    const arc = svg.createDrawable(this.parts.arc);
    utils.set(title, {translateY: '112%'});
    utils.set(copy, {opacity: 0, translateY: 14});
    utils.set(phone, {translateX: -28, opacity: 0});
    utils.set(laptop, {translateX: 28, opacity: 0});
    utils.set(arc, {draw: '0 0'});
    utils.set(key, {opacity: 0});
    this.intro = createTimeline({
      defaults: {ease: 'outQuint'},
      onComplete: () => {
        this.loopReady = true;
        if (this.shown) this.loop.play();
      },
    })
      .add(title, {translateY: '0%', duration: 1100, ease: 'outExpo', delay: stagger(90)}, 0)
      .add(copy, {opacity: 1, translateY: 0, duration: 800, ease: 'outQuart', delay: stagger(90)}, 420)
      .add(phone, {translateX: 0, opacity: 1, duration: 900}, 320)
      .add(laptop, {translateX: 0, opacity: 1, duration: 900}, 440)
      .add(arc, {draw: ['0 0', '0 1'], duration: 950, ease: 'inOutSine'}, 760)
      .add(key, {opacity: 1, duration: 300, ease: 'outQuad'}, 1250);
  }

  // Reduced motion: show the landed state and skip every loop.
  settleStatic() {
    const {key, lock, check, signin, apps, rows} = this.parts;
    utils.set(key, {opacity: 0});
    utils.set(lock, {opacity: 0});
    utils.set(check, {opacity: 1});
    utils.set(signin, {opacity: 0});
    utils.set([apps, ...rows], {opacity: 1});
    this.flow.style.setProperty('--progress', '1');
    for (const step of this.steps) step.dataset.lit = 'true';
  }

  // Content is visible by default. Only elements still below the fold are
  // hidden, right before they are observed, so nothing ships blank.
  setupReveals() {
    if (typeof IntersectionObserver !== 'function') return;
    const viewport = window.innerHeight;
    const targets = [...this.root.querySelectorAll('[data-reveal]')].filter(el => el.getBoundingClientRect().top > viewport);
    if (!targets.length) return;
    utils.set(targets, {opacity: 0, translateY: 18});
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.observer.unobserve(entry.target);
        animate(entry.target, {opacity: 1, translateY: 0, duration: 900, ease: 'outQuart'});
      }
    }, {threshold: .15, rootMargin: '0px 0px -8% 0px'});
    for (const target of targets) this.observer.observe(target);
  }

  handleScroll() {
    this.topbar.dataset.scrolled = String(window.scrollY > 8);
    if (this.reduced) return;
    const rect = this.flow.getBoundingClientRect();
    const viewport = window.innerHeight;
    // Horizontal line fills while the section's top travels from 88% to 33% of
    // the viewport; the vertical line on phones fills as the section scrolls through.
    const progress = this.narrow.matches
      ? clamp((viewport * .8 - rect.top) / Math.max(1, rect.height - viewport * .2), 0, 1)
      : clamp((viewport * .88 - rect.top) / (viewport * .55), 0, 1);
    this.flow.style.setProperty('--progress', progress.toFixed(3));
    this.steps.forEach((step, index) => {
      step.dataset.lit = String(progress >= (index + .6) / this.steps.length);
    });
  }

  startDeviceTimer() {
    let seconds = 60;
    this.deviceTimer.textContent = `${seconds}s`;
    this.timerId = setInterval(() => {
      seconds = seconds <= 1 ? 60 : seconds - 1;
      this.deviceTimer.textContent = `${seconds}s`;
    }, 1000);
  }

  show() {
    if (this.shown) return;
    this.shown = true;
    window.addEventListener('scroll', this.onScroll, {passive: true});
    window.addEventListener('resize', this.onScroll);
    this.handleScroll();
    if (!this.reduced) this.startDeviceTimer();
    if (!this.introduced) {
      this.introduced = true;
      if (this.reduced) this.settleStatic();
      else this.playIntro();
      this.setupReveals();
    } else if (this.loopReady) {
      this.loop.play();
    }
  }

  hide() {
    if (!this.shown) return;
    this.shown = false;
    window.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('resize', this.onScroll);
    delete this.topbar.dataset.scrolled;
    clearInterval(this.timerId);
    this.timerId = null;
    this.loop?.pause();
  }
}
