import { validateOrigin } from './app.mjs';
import { redisStore } from './shared-store.mjs';

export function hostedConfig(env = process.env) {
  for (const key of ['PUBLIC_ORIGIN', 'DEMO_USERNAME', 'DEMO_PASSWORD',
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
    if (!env[key]) throw new Error(`Set ${key} before deploying NearKey`);
  }
  validateOrigin(env.PUBLIC_ORIGIN);
  if (!env.PUBLIC_ORIGIN.startsWith('https://')) throw new Error('Hosted NearKey requires an HTTPS PUBLIC_ORIGIN');
  if (env.DEMO_PASSWORD.length < 16 || env.DEMO_PASSWORD.length > 256
      || env.DEMO_PASSWORD === 'mint-river-otter-47') {
    throw new Error('Set a new DEMO_PASSWORD containing 16–256 characters');
  }
  return {publicOrigin: env.PUBLIC_ORIGIN, phoneOrigin: env.PUBLIC_ORIGIN,
    username: env.DEMO_USERNAME, password: env.DEMO_PASSWORD,
    stateStore: redisStore({url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN,
      key: env.NEARKEY_STATE_KEY || 'nearkey:production:v1'})};
}
