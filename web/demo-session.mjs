// Google is a browser-only demo entry point; it never grants server access.
export class DemoSession {
  constructor(storage) {
    try { this.storage = storage ?? globalThis.sessionStorage; } catch {}
    this.data = {active: false, apps: []};
    try {
      const saved = JSON.parse(this.storage?.getItem('nearkey-google-demo') || 'null');
      if (saved && typeof saved.active === 'boolean' && Array.isArray(saved.apps)) this.data = saved;
    } catch {}
  }

  get active() { return this.data.active; }

  save() {
    // Restricted browser storage must not prevent entering or using the demo.
    try { this.storage?.setItem('nearkey-google-demo', JSON.stringify(this.data)); } catch {}
  }

  signIn() {
    this.data.active = true;
    this.save();
    return this.session();
  }

  session() {
    return {authenticated: this.active, pending: false, user: this.active ? {id: 'google-demo', name: 'Demo User'} : null,
      setup: null, challenge: null, challengeStatus: null};
  }

  account() {
    return {user: this.session().user, phone: null, activity: [], apps: [...this.data.apps]};
  }

  async request(path, {method = 'GET', body, signal} = {}) {
    signal?.throwIfAborted();
    if (path === '/api/session' && method === 'GET') return this.session();
    if (path === '/api/account' && method === 'GET') return this.account();
    if (path === '/api/logout' && method === 'POST') {
      this.data.active = false;
      this.save();
      return {ok: true};
    }
    if (path === '/api/demo/reset' && method === 'POST') {
      this.data = {active: false, apps: []};
      this.save();
      return {ok: true};
    }
    if (path === '/api/apps' && method === 'POST') {
      const name = body?.name?.trim();
      if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Enter an app name with 1–80 characters.');
      if (this.data.apps.length >= 30) throw new Error('Your app list is full (30 apps).');
      let url = null;
      if (body.url?.trim()) {
        let parsed;
        try { parsed = new URL(body.url.trim()); } catch { throw new Error('Enter a complete HTTP or HTTPS app URL.'); }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash
            || parsed.href.length > 2048) throw new Error('Use an HTTP or HTTPS app URL without credentials or a fragment.');
        url = parsed.href;
      }
      const app = {id: `demo-${Date.now()}-${this.data.apps.length}`, name, url};
      this.data.apps.push(app);
      this.save();
      return {app};
    }
    throw new Error('Sign in with your password to connect a phone.');
  }
}
