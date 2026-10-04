import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { StorageError } from './shared-store.mjs';

// Only channel IDs and queued messages cross instances; actual sockets stay local.
export class SharedChannels {
  constructor({now, transact, sweep, disconnected, pollMs = 2000}) {
    this.now = now;
    this.transact = transact;
    this.sweep = sweep;
    this.disconnected = disconnected;
    this.records = new Map();
    this.local = new Map();
    this.proxies = new Map();
    this.ttl = Math.max(20_000, pollMs * 5);
    this.timer = setInterval(() => this.poll(), pollMs);
    this.timer.unref();
  }
  restore(entries = []) {
    if (!Array.isArray(entries) || entries.length > 64) throw new StorageError('Saved channels are invalid');
    this.records = new Map(entries);
    this.proxies.clear();
    for (const [id, entry] of this.records) {
      if (entry.id !== id || !Number.isFinite(entry.expiresAt) || !Array.isArray(entry.messages)
          || entry.messages.length > 128 || entry.messages.some((message) => typeof message.id !== 'string'
            || typeof message.text !== 'string')) throw new StorageError('Saved channels are invalid');
    }
  }
  snapshot() { return [...this.records]; }
  create() {
    // Expired/closed channel records are disposable; their owners are swept first.
    for (const [id, entry] of this.records) {
      if (entry.expiresAt <= this.now() || (entry.closed && !this.local.has(id))) this.records.delete(id);
    }
    if (this.records.size >= 64) throw new StorageError('Too many active channels; retry shortly');
    const id = randomUUID();
    this.records.set(id, {id, expiresAt: this.now() + this.ttl, messages: []});
    return this.proxy(id);
  }
  proxy(id) {
    if (!id) return null;
    if (this.proxies.has(id)) return this.proxies.get(id);
    const runtime = this;
    const proxy = {
      id,
      get readyState() {
        const entry = runtime.records.get(id);
        return entry && !entry.closed && entry.expiresAt > runtime.now() ? WebSocket.OPEN : WebSocket.CLOSED;
      },
      send(text, callback) {
        const entry = runtime.records.get(id);
        if (this.readyState !== WebSocket.OPEN) return callback?.(new Error('Channel closed'));
        if (entry.messages.length >= 128) { this.terminate(); return callback?.(new Error('Channel backlog')); }
        entry.messages.push({id: randomUUID(), text});
        callback?.();
      },
      close(code = 1000, reason = 'Channel closed') {
        const entry = runtime.records.get(id);
        if (entry) entry.closed = {code, reason};
      },
      terminate() { this.close(1012, 'Reconnect channel'); },
    };
    this.proxies.set(id, proxy);
    return proxy;
  }
  attach(proxy, ws, kind) {
    const id = proxy.id;
    const local = {ws, kind, delivered: new Set()};
    this.local.set(id, local);
    ws.on('close', () => {
      if (this.local.get(id) !== local) return;
      this.local.delete(id);
      this.transact(() => {
        this.disconnected(id);
        this.records.delete(id);
      }).catch(() => {}); // Presence expires if the store or instance disappears.
    });
    void this.poll();
  }
  async poll() {
    if (this.polling || !this.local.size || this.stopped) return;
    this.polling = true;
    try {
      const deliveries = await this.transact(() => {
        for (const [id, local] of this.local) {
          const entry = this.records.get(id);
          if (!entry || entry.closed || entry.expiresAt <= this.now()) {
            this.disconnected(id);
            continue;
          }
          entry.messages = entry.messages.filter((message) => !local.delivered.has(message.id));
          entry.expiresAt = this.now() + this.ttl;
        }
        this.sweep();
        return [...this.local.keys()].map((id) => {
          const entry = this.records.get(id);
          return !entry || entry.closed || entry.expiresAt <= this.now()
            ? {id, closed: entry?.closed || {code: 1012, reason: 'Reconnect channel'}}
            : {id, messages: [...entry.messages]};
        });
      });
      for (const delivery of deliveries) {
        const local = this.local.get(delivery.id);
        if (!local || local.ws.readyState !== WebSocket.OPEN) continue;
        if (delivery.closed) {
          local.ws.close(delivery.closed.code, delivery.closed.reason);
          continue;
        }
        local.delivered.clear();
        for (const message of delivery.messages) {
          local.ws.send(message.text, (error) => { if (error) local.ws.terminate(); });
          local.delivered.add(message.id);
        }
      }
    } catch {
      // Never keep advertising an online phone when shared state cannot be checked.
      for (const {ws} of this.local.values()) ws.terminate();
    } finally { this.polling = false; }
  }
  stop() { this.stopped = true; clearInterval(this.timer); }
}
