import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// A fenced lease serializes this small demo's account state across instances.
// Responses and channel effects are released only after the fenced commit.
const ACQUIRE = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return {1, redis.call('GET', KEYS[2]) or ''}
end
return {0, ''}`;
const COMMIT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('DEL', KEYS[1])
return 1`;
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

export class StorageError extends Error {
  constructor(message = 'Shared storage is unavailable; retry shortly') { super(message); }
}

export function redisStore({url, token, key = 'nearkey:v1', fetchImpl = fetch,
  leaseMs = 30_000, waitMs = 5000} = {}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('UPSTASH_REDIS_REST_URL must be an HTTPS origin');
  }
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('Redis REST token is required');
  if (!/^[a-zA-Z0-9:_-]{1,120}$/.test(key)) throw new Error('Invalid NEARKEY_STATE_KEY');
  // Keep both keys in one Redis Cluster hash slot.
  const stateKey = `{${key}}:state`;
  const leaseKey = `{${key}}:lease`;
  async function command(args) {
    try {
      const response = await fetchImpl(endpoint, {method: 'POST',
        headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify(args), signal: AbortSignal.timeout(5000)});
      if (!response.ok) throw new StorageError();
      const result = await response.json();
      if (result.error || !Object.hasOwn(result, 'result')) throw new StorageError();
      return result.result;
    } catch { throw new StorageError(); }
  }
  return {
    async transact(operation) {
      const owner = randomUUID();
      const deadline = Date.now() + waitMs;
      let raw;
      while (true) {
        const acquired = await command(['EVAL', ACQUIRE, '2', leaseKey, stateKey, owner, String(leaseMs)]);
        if (acquired?.[0] === 1) { raw = acquired[1]; break; }
        if (Date.now() >= deadline) throw new StorageError('Shared storage is busy; retry shortly');
        await delay(30 + Math.random() * 40);
      }
      let committedOK = false;
      try {
        let state = null;
        if (raw) {
          try {
            state = JSON.parse(raw);
            if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error();
          }
          catch { throw new StorageError('Saved shared state is invalid'); }
        }
        const {state: next, value} = await operation(state);
        const committed = await command(['EVAL', COMMIT, '2', leaseKey, stateKey, owner, JSON.stringify(next)]);
        if (committed !== 1) throw new StorageError('Shared storage lease expired; retry shortly');
        committedOK = true;
        return value;
      } finally {
        // Never delete a lease now owned by a different instance.
        if (!committedOK) await command(['EVAL', RELEASE, '1', leaseKey, owner]).catch(() => {});
      }
    },
  };
}

// Buffer small API responses until their shared state has committed successfully.
export function bufferedResponse() {
  return {
    destroyed: false, writableEnded: false, headersSent: false, status: 200, headers: {}, data: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(data = '') { this.data = data; this.writableEnded = true; },
    flush(res) {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(this.status, this.headers);
      res.end(this.data);
    },
  };
}
