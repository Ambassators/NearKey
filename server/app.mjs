import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { approvalText, enrollmentText, CONTRACT_VERSION, CHALLENGE_TTL_MS } from '../shared/protocol.mjs';
import { randomToken, decodeBase64url, parsePublicKey, verifyProof, passwordRecord, passwordMatches } from './crypto.mjs';
import { validatePhoneOrigin } from './network.mjs';
import { phoneStore } from './phone-store.mjs';
import { StorageError, bufferedResponse } from './shared-store.mjs';
import { SharedChannels } from './shared-channels.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SESSION_TTL_MS = 8 * 60 * 60_000;
const PENDING_SESSION_TTL_MS = 10 * 60_000;
const PAIRING_TTL_MS = 5 * 60_000;
const BODY_LIMIT = 4096;
const APP_LIMIT = 30;
const USER = Object.freeze({id: 'demo', name: 'Demo User'});
const pending = (record) => record && ['waiting_phone', 'waiting_bluetooth'].includes(record.status);

class ApiError extends Error {
  constructor(status, error, message) {
    super(message);
    this.status = status;
    this.error = error;
  }
}
const fail = (status, error, message) => { throw new ApiError(status, error, message); };

export function validateOrigin(value) {
  const origin = new URL(value);
  if (origin.origin !== value || origin.username || origin.password
      || !['http:', 'https:'].includes(origin.protocol)
      || (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin, or local HTTP origin');
  }
  return value;
}

function json(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers});
  res.end(data);
}

function exactFields(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== fields.length
      || fields.some((field) => !Object.hasOwn(body, field))) {
    fail(400, 'invalid_body', `Expected fields: ${fields.join(', ') || 'none'}`);
  }
}

function appDetails(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || !Object.hasOwn(body, 'name') || Object.keys(body).some((field) => !['name', 'url'].includes(field))) {
    fail(400, 'invalid_body', 'Expected app name and optional URL');
  }
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80
      || /[\u0000-\u001f\u007f]/.test(body.name)) {
    fail(400, 'invalid_app_name', 'App name must contain 1–80 characters without control characters');
  }
  const name = body.name.trim();
  let url = null;
  if (Object.hasOwn(body, 'url')) {
    if (typeof body.url !== 'string' || /[\u0000-\u001f\u007f]/.test(body.url)) {
      fail(400, 'invalid_app_url', 'Enter an HTTP or HTTPS app URL without control characters');
    }
    const value = body.url.trim();
    if (value) {
      let parsed;
      try { parsed = new URL(value); } catch { fail(400, 'invalid_app_url', 'Enter a complete HTTP or HTTPS app URL'); }
      if (value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value) || /%(?![a-f0-9]{2})/i.test(value)
          || !/^https?:\/\//i.test(value) || !['http:', 'https:'].includes(parsed.protocol)
          || parsed.username || parsed.password || parsed.hash || value.includes('#')) {
        fail(400, 'invalid_app_url', 'Use an HTTP or HTTPS app URL without credentials or a fragment');
      }
      url = parsed.href;
    }
  }
  return {name, url};
}

function readJson(req) {
  if (!/^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*$/i.test(req.headers['content-type'] || '')) {
    fail(415, 'json_required', 'Send application/json');
  }
  if (req.headers['content-encoding']) fail(415, 'encoding_unsupported', 'Compressed bodies are not supported');
  if (Number(req.headers['content-length']) > BODY_LIMIT) fail(413, 'body_too_large', 'JSON body exceeds 4096 bytes');
  if (req.destroyed || req.aborted) fail(400, 'invalid_body', 'Could not read body');
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const rejectBody = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      chunks.length = 0;
      req.resume();
      reject(error);
    };
    const onError = () => rejectBody(new ApiError(400, 'invalid_body', 'Could not read body'));
    const onAborted = onError;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) return rejectBody(new ApiError(413, 'body_too_large', 'JSON body exceeds 4096 bytes'));
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks));
        resolve(JSON.parse(text));
      } catch { reject(new ApiError(400, 'invalid_json', 'Expected valid UTF-8 JSON')); }
    };
    const timer = setTimeout(() => rejectBody(new ApiError(408, 'body_timeout', 'Body read timed out')), 5000);
    req.on('data', onData).on('end', onEnd).on('error', onError).on('aborted', onAborted);
  });
}

// Files are explicitly inventoried at startup: no arbitrary filesystem paths or symlinks.
async function staticFiles(root) {
  const files = new Map([['/shared/protocol.mjs', {file: path.join(ROOT, 'shared/protocol.mjs'), type: 'text/javascript'}]]);
  const types = {'.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
    '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'};
  const web = path.join(root, 'web');
  let names;
  try {
    // Checking each asset is not enough if its parent directory is a symlink.
    if (!(await lstat(web)).isDirectory()) return files;
    names = await readdir(web);
  } catch (error) { if (error.code === 'ENOENT') return files; throw error; }
  for (const name of names) {
    if (!/^[a-zA-Z0-9_-]+\.(html|mjs|js|css|svg|png|ico)$/.test(name) || name.includes('.test.')) continue;
    const file = path.join(web, name);
    if (!(await lstat(file)).isFile()) continue;
    const asset = {file, type: types[path.extname(name)]};
    files.set(`/web/${name}`, asset);
    // The vanilla app can use either /web/foo.mjs or relative /foo.mjs imports.
    files.set(`/${name}`, asset);
    if (name === 'index.html') files.set('/', asset);
  }
  const fonts = path.join(web, 'fonts');
  let fontDirectory;
  try { fontDirectory = await lstat(fonts); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (fontDirectory?.isDirectory()) {
    for (const name of ['dm-sans.ttf', 'manrope.ttf']) {
      const file = path.join(fonts, name);
      let entry;
      try { entry = await lstat(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (entry?.isFile()) files.set(`/web/fonts/${name}`, {file, type: 'font/ttf'});
    }
  }
  return files;
}

export async function createApp({publicOrigin = 'http://localhost:5173', phoneOrigin = publicOrigin, username = 'admin',
  password = 'mint-river-otter-47', now = Date.now, root = ROOT, pairingFile = null, stateStore = null, channelPollMs = 2000} = {}) {
  if (stateStore && pairingFile) throw new Error('Choose shared storage or a local pairing file');
  validateOrigin(publicOrigin);
  validatePhoneOrigin(phoneOrigin);
  if (typeof username !== 'string' || !username.trim() || username.length > 80 || /[\r\n]/.test(username)) {
    throw new Error('Demo username must contain 1–80 characters without line breaks');
  }
  const credentials = await passwordRecord(password);
  const assets = await staticFiles(root);
  const sessions = new Map();
  const challenges = new Map();
  const rates = new Map();
  let pairing = null;
  const savedPhone = phoneStore(pairingFile, {username, publicOrigin});
  let phone = savedPhone.load();
  let activeId = null;
  const activity = [];
  // These are saved account app entries, not credentials or live integrations.
  const apps = [];
  let closing = false;
  let transactionQueue = Promise.resolve();
  const channels = stateStore ? new SharedChannels({now, transact: withState, sweep,
    disconnected: disconnectChannel, pollMs: channelPollMs}) : null;

  function restoreState(saved) {
    if (saved !== null && (saved.version !== 1 || saved.username !== username || saved.publicOrigin !== publicOrigin
        || !Array.isArray(saved.sessions) || !Array.isArray(saved.challenges) || !Array.isArray(saved.rates)
        || !Array.isArray(saved.activity) || !Array.isArray(saved.apps) || !Array.isArray(saved.channels)
        || !Object.hasOwn(saved, 'phone') || !Object.hasOwn(saved, 'pairing') || !Object.hasOwn(saved, 'activeId')
        || (saved.phone !== null && (typeof saved.phone !== 'object' || Array.isArray(saved.phone)))
        || (saved.pairing !== null && (typeof saved.pairing !== 'object' || Array.isArray(saved.pairing)))
        || (saved.activeId !== null && typeof saved.activeId !== 'string'))) {
      throw new StorageError('Shared state belongs to a different account or origin; use a separate state key');
    }
    for (const entries of [saved?.sessions, saved?.challenges, saved?.rates]) {
      if (entries && (entries.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
          || !entry[1] || typeof entry[1] !== 'object') || new Set(entries.map(([key]) => key)).size !== entries.length)) {
        throw new StorageError('Saved state records are invalid');
      }
    }
    channels.restore(saved?.channels);
    for (const [map, entries] of [[sessions, saved?.sessions], [challenges, saved?.challenges], [rates, saved?.rates]]) {
      map.clear();
      for (const [key, value] of entries || []) map.set(key, value);
    }
    if (sessions.size > 16 || challenges.size > 100 || rates.size > 1024
        || (saved?.apps.length || 0) > APP_LIMIT || (saved?.activity.length || 0) > 1000) {
      throw new StorageError('Saved shared state exceeds account limits');
    }
    for (const [token, session] of sessions) {
      try { decodeBase64url(token, 32, 32); decodeBase64url(session.id, 32, 32); }
      catch { throw new StorageError('Saved session is invalid'); }
      if (typeof session.id !== 'string' || !Number.isFinite(session.expiresAt)
          || (session.verifiedAt !== null && !Number.isFinite(session.verifiedAt))) throw new StorageError('Saved session is invalid');
    }
    pairing = saved?.pairing ? {...saved.pairing, socket: channels.proxy(saved.pairing.socketId)} : null;
    if (pairing && (!Number.isFinite(pairing.expiresAt) || typeof pairing.pairingId !== 'string'
        || typeof pairing.pairingCode !== 'string' || !sessions.has(pairing.session))) throw new StorageError('Saved pairing is invalid');
    try {
      if (saved?.phone) {
        const entry = saved.phone;
        if (typeof entry.id !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.id)
            || typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 40) throw new Error();
        decodeBase64url(entry.deviceToken, 32, 32);
      }
      phone = saved?.phone ? {...saved.phone, key: parsePublicKey(saved.phone.publicKey), socket: channels.proxy(saved.phone.socketId)} : null;
    } catch { throw new StorageError('Saved phone key is invalid'); }
    for (const [id, record] of challenges) {
      if (!record.challenge || record.challenge.id !== id || !Number.isFinite(record.challenge.expiresAt)
          || !['waiting_phone', 'waiting_bluetooth', 'approved', 'expired', 'cancelled'].includes(record.status)
          || typeof record.session !== 'string' || typeof record.phoneReady !== 'boolean') throw new StorageError('Saved challenge is invalid');
    }
    for (const rate of rates.values()) if (!Number.isFinite(rate.until) || !Number.isFinite(rate.count)) throw new StorageError('Saved rate limit is invalid');
    activeId = saved?.activeId || null;
    activity.splice(0, activity.length, ...(saved?.activity || []));
    apps.splice(0, apps.length, ...(saved?.apps || []));
  }
  function snapshotState() {
    const savedPairing = pairing ? {...pairing, socketId: pairing.socket?.id || null} : null;
    if (savedPairing) delete savedPairing.socket;
    return {version: 1, username, publicOrigin, sessions: [...sessions], challenges: [...challenges], rates: [...rates],
      pairing: savedPairing, phone: phone ? {id: phone.id, label: phone.label, deviceToken: phone.deviceToken,
        publicKey: phone.key.export({format: 'der', type: 'spki'}).toString('base64url'), socketId: phone.socket?.id || null} : null,
      activeId, activity, apps, channels: channels.snapshot()};
  }
  function withState(operation) {
    const run = transactionQueue.then(() => stateStore.transact(async (saved) => {
      restoreState(saved);
      sweep();
      let value, error;
      try { value = await operation(); } catch (caught) { error = caught; }
      return {state: snapshotState(), value: {value, error}};
    })).then(({value, error}) => { if (error) throw error; return value; });
    transactionQueue = run.catch(() => {});
    return run;
  }
  function disconnectChannel(id) {
    if (phone?.socket?.id === id) {
      phone.socket = null;
      const record = challenges.get(activeId);
      if (pending(record)) { record.phoneReady = false; record.status = 'waiting_phone'; }
    }
    if (pairing?.socket?.id === id) clearPairing();
  }

  const cookie = (token = '', {sessionOnly = false} = {}) => `nearkey_session=${token}; Path=/; HttpOnly; SameSite=Strict${sessionOnly && token ? '' : `; Max-Age=${token ? SESSION_TTL_MS / 1000 : 0}`}${publicOrigin.startsWith('https:') ? '; Secure' : ''}`;
  function sendPhone(message, socket = phone?.socket) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    // A transport failure must not turn an already committed API operation into a 500.
    try {
      socket.send(JSON.stringify(message), (error) => { if (error) socket.terminate(); });
    } catch { socket.terminate(); }
  }
  function endChallenge(record, status) {
    if (!pending(record)) return;
    record.status = status;
    record.phoneReady = false;
    if (activeId === record.challenge.id) activeId = null;
    sendPhone({type: 'cancel', challengeId: record.challenge.id});
  }
  function revokeSession(token) {
    sessions.delete(token);
    if (pairing?.session === token) clearPairing();
    for (const record of challenges.values()) {
      if (record.session === token) endChallenge(record, 'cancelled');
    }
  }
  function clearPairing() {
    const previous = pairing;
    pairing = null;
    previous?.socket?.close(1000, 'Pairing ended');
  }
  function sweep() {
    const time = now();
    // A page-owned code remains live only while its browser connection is open.
    if (pairing?.pageScoped && pairing.socket?.readyState === WebSocket.OPEN) {
      if (channels) pairing.expiresAt = channels.records.get(pairing.socket.id).expiresAt;
      const login = sessions.get(pairing.session);
      if (login?.verifiedAt === null) login.expiresAt = time + PENDING_SESSION_TTL_MS;
    }
    if (channels) {
      if (phone?.socket && phone.socket.readyState !== WebSocket.OPEN) disconnectChannel(phone.socket.id);
      if (pairing?.socket && pairing.socket.readyState !== WebSocket.OPEN) disconnectChannel(pairing.socket.id);
    }
    for (const [token, session] of sessions) if (session.expiresAt <= time) revokeSession(token);
    if (pairing?.expiresAt <= time) clearPairing();
    if (pairing?.replacementPhoneId && (phone?.id !== pairing.replacementPhoneId
        || sessions.get(pairing.session)?.verifiedAt == null)) clearPairing();
    for (const record of challenges.values()) {
      if (pending(record) && record.challenge.expiresAt <= time) endChallenge(record, 'expired');
    }
    for (const [key, rate] of rates) if (rate.until <= time) rates.delete(key);
  }
  function rateLimit(req, category, limit) {
    const key = `${category}:${stateStore ? 'shared-account' : req.socket.remoteAddress}`;
    let rate = rates.get(key);
    if (!rate) {
      if (rates.size >= 1024) fail(429, 'rate_limited', 'Please retry later');
      rate = {count: 0, until: now() + 60_000};
      rates.set(key, rate);
    }
    if (++rate.count > limit) fail(429, 'rate_limited', 'Too many requests; retry in a minute');
  }
  function sameOrigin(req, mutation = false) {
    if ((mutation && req.headers.origin !== publicOrigin)
        || (req.headers.origin !== undefined && req.headers.origin !== publicOrigin)
        || req.headers['sec-fetch-site'] === 'cross-site') {
      fail(403, 'origin_rejected', 'Use the configured same-origin browser');
    }
  }
  function sessionToken(req) {
    const values = (req.headers.cookie || '').split(';').map((part) => part.trim())
      .filter((part) => part.startsWith('nearkey_session='));
    return values.length === 1 ? values[0].slice('nearkey_session='.length) : '';
  }
  function requireSession(req) {
    const token = sessionToken(req);
    if (!sessions.has(token)) fail(401, 'session_required', 'Please log in');
    return token;
  }
  function requireAuthenticated(token) {
    if (sessions.get(token)?.verifiedAt == null) {
      fail(403, 'verification_required', 'Complete Bluetooth verification to finish signing in');
    }
  }
  const phoneStatus = () => phone ? {id: phone.id, label: phone.label,
    online: phone.socket?.readyState === WebSocket.OPEN} : null;
  function sessionState(token) {
    const session = sessions.get(token);
    const authenticated = Boolean(session && session.verifiedAt !== null);
    const record = session ? challenges.get(session.challengeId) : null;
    const replacement = pairing?.replacementPhoneId && pairing.session === token
      ? {pairingId: pairing.pairingId, expiresAt: pairing.expiresAt} : null;
    return {authenticated, pending: Boolean(session && !authenticated), user: authenticated ? USER : null,
      setup: session ? {phone: phoneStatus(), ...(replacement ? {replacement} : {})} : null, challenge: record?.challenge || null,
      challengeStatus: record?.status || null};
  }
  function requirePhone(req) {
    // Native phone requests do not need browser cookies or CORS.
    if (req.headers.origin !== undefined) fail(403, 'origin_rejected', 'Phone channel is native-app only');
    if (!phone || req.headers.authorization !== `Bearer ${phone.deviceToken}`) {
      fail(401, 'phone_auth_required', 'Valid phone Authorization header required');
    }
    return phone;
  }
  function ownChallenge(id, session) {
    const record = challenges.get(id);
    if (!record || record.session !== session) fail(404, 'challenge_not_found', 'Challenge not found');
    return record;
  }
  function requirePending(record) {
    if (!pending(record)) fail(409, 'challenge_not_pending', `Challenge is ${record.status}`);
  }

  async function handleRequest(req, res, stateful = true) {
    // Aborted uploads can emit an error after body-reader listeners are cleaned up.
    req.on('error', () => {});
    try {
      if (stateful) { sweep(); rateLimit(req, 'http', 240); }
      // Both browser fetch and native OkHttp send origin-form request targets.
      // Check the raw target before URL parsing can discard fragments or controls.
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')
          || /[\u0000-\u0020\u007f\\?#]/.test(req.url) || /%(?![a-f0-9]{2})/i.test(req.url)) {
        fail(400, 'invalid_url', 'Use a path without query strings, fragments or foreign URLs');
      }
      let url;
      try { url = new URL(req.url, publicOrigin); }
      catch { fail(400, 'invalid_url', 'Invalid request URL'); }
      if (url.origin !== publicOrigin || url.search || url.hash) fail(400, 'invalid_url', 'Query strings and foreign URLs are not supported');
      const route = url.pathname;
      if (req.method === 'GET' && assets.has(route)) {
        sameOrigin(req);
        const asset = assets.get(route);
        let data;
        try { data = await readFile(asset.file); } catch { fail(404, 'not_found', 'Asset not found'); }
        res.writeHead(200, {'Content-Type': asset.type.startsWith('font/') ? asset.type : `${asset.type}; charset=utf-8`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
        res.end(data);
        return;
      }
      const isPhoneRoute = route === '/api/phones/enroll' || route.startsWith('/api/phone/');
      if (isPhoneRoute) {
        if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] === 'cross-site') {
          fail(403, 'origin_rejected', 'Phone API is native-app only');
        }
      } else sameOrigin(req, req.method !== 'GET');
      if (req.method === 'POST' && route === '/api/demo/reset') {
        // Offline demo recovery is restricted to the local browser, including in Wi-Fi mode.
        const localAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
        if (!localAddresses.includes(req.socket.remoteAddress)
            || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(publicOrigin).hostname)) {
          fail(403, 'local_only', 'Reset the demo from the local browser');
        }
        exactFields(await readJson(req), []);
        savedPhone.clear();
        for (const record of challenges.values()) endChallenge(record, 'cancelled');
        clearPairing();
        const oldSocket = phone?.socket;
        phone = null;
        oldSocket?.terminate();
        sessions.clear();
        challenges.clear();
        activeId = null;
        apps.length = 0;
        activity.length = 0;
        json(res, 200, {ok: true}, {'Set-Cookie': cookie()});
        return;
      }
      if (req.method === 'POST' && ['/api/login', '/api/phones/enroll'].includes(route)) {
        rateLimit(req, 'credentials', 10);
      }
      if (req.method === 'POST' && route === '/api/login') {
        const body = await readJson(req);
        exactFields(body, ['username', 'password']);
        if (typeof body.username !== 'string' || body.username.length > 80
            || typeof body.password !== 'string' || body.password.length > 256) {
          fail(400, 'invalid_credentials', 'Invalid credential format');
        }
        const passwordOK = await passwordMatches(body.password, credentials);
        if (!passwordOK || body.username !== username) fail(401, 'invalid_credentials', 'Incorrect username or password');
        sweep();
        const old = sessionToken(req);
        if (sessions.has(old)) revokeSession(old);
        if (sessions.size >= 16) fail(429, 'session_limit', 'Too many live demo sessions');
        const token = randomToken();
        sessions.set(token, {id: randomToken(), expiresAt: now() + PENDING_SESSION_TTL_MS, verifiedAt: null, challengeId: null});
        json(res, 200, sessionState(token), {'Set-Cookie': cookie(token)});
        return;
      }
      if (req.method === 'GET' && route === '/api/session') {
        json(res, 200, sessionState(sessionToken(req)));
        return;
      }
      if (req.method === 'POST' && route === '/api/phones/enroll') {
        if (req.headers.origin) fail(403, 'origin_rejected', 'Enrollment is native-app only');
        const body = await readJson(req);
        exactFields(body, ['pairingCode', 'publicKey', 'label', 'signature']);
        sweep();
        if (phone && !pairing?.replacementPhoneId) {
          fail(409, 'phone_exists', 'Use Connect a different phone from a verified browser session');
        }
        if (typeof body.pairingCode !== 'string' || body.pairingCode.length > 128
            || !pairing || body.pairingCode !== pairing.pairingCode
            || pairing.expiresAt <= now() || !sessions.has(pairing.session)) {
          fail(401, 'invalid_pairing', 'Pairing code expired or invalid');
        }
        if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 40) {
          fail(400, 'invalid_label', 'Phone label must contain 1–40 characters');
        }
        const enrollment = pairing;
        const previousPhone = phone;
        if (enrollment.replacementPhoneId && (previousPhone?.id !== enrollment.replacementPhoneId
            || sessions.get(enrollment.session)?.verifiedAt == null)) {
          fail(401, 'invalid_pairing', 'Pairing code expired or invalid');
        }
        let key;
        try {
          key = parsePublicKey(body.publicKey);
          if (!verifyProof(key, enrollmentText(body.pairingCode, body.publicKey), body.signature)) throw new Error();
        } catch { fail(400, 'invalid_enrollment_proof', 'Expected P-256 SPKI key and valid DER proof of possession'); }
        // Proof verification must not let a code or its originating session outlive its deadline.
        sweep();
        if (pairing !== enrollment || enrollment.expiresAt <= now() || !sessions.has(enrollment.session)
            || (enrollment.replacementPhoneId && (phone !== previousPhone
              || sessions.get(enrollment.session)?.verifiedAt == null))) {
          fail(401, 'invalid_pairing', 'Pairing code expired or invalid');
        }
        const nextPhone = {id: randomUUID(), label: body.label.trim(), key, deviceToken: randomToken(), socket: null};
        // Persist before acknowledging or revoking the previous phone. Synchronous
        // commit keeps concurrent enrollment requests from consuming the same code.
        savedPhone.save(nextPhone);
        if (enrollment.replacementPhoneId) {
          // Commit replacement only after the new phone proves possession of its key.
          // The initiating session must prove the new phone before regaining account access.
          for (const record of challenges.values()) endChallenge(record, 'cancelled');
          for (const token of sessions.keys()) if (token !== enrollment.session) revokeSession(token);
          const login = sessions.get(enrollment.session);
          login.verifiedAt = null;
          login.expiresAt = now() + PENDING_SESSION_TTL_MS;
          login.challengeId = null;
          const oldSocket = previousPhone.socket;
          previousPhone.socket = null;
          if (oldSocket) oldSocket.terminate();
        }
        phone = nextPhone;
        clearPairing();
        json(res, 200, {phoneId: phone.id, deviceToken: phone.deviceToken});
        return;
      }
      const ready = /^\/api\/phone\/challenges\/([a-f0-9-]{36})\/ready$/.exec(route);
      if (req.method === 'POST' && ready) {
        const owner = requirePhone(req);
        const channel = owner.socket;
        const body = await readJson(req);
        exactFields(body, []);
        sweep();
        const record = challenges.get(ready[1]);
        if (!record || record.challenge.phoneId !== owner.id) fail(404, 'challenge_not_found', 'Challenge not found');
        requirePending(record);
        // An ACK whose body was still uploading when the channel was replaced is stale.
        if (phone !== owner || owner.socket !== channel || channel?.readyState !== WebSocket.OPEN) {
          fail(409, 'phone_offline', 'Connect the foreground phone channel first');
        }
        record.phoneReady = true;
        record.status = 'waiting_bluetooth';
        json(res, 200, {ok: true});
        return;
      }
      if (!route.startsWith('/api/')) fail(404, 'not_found', 'Resource not found');
      const session = requireSession(req);
      if (req.method === 'GET' && route === '/api/account') {
        requireAuthenticated(session);
        json(res, 200, {user: USER, phone: phoneStatus(), activity, apps});
        return;
      }
      if (req.method === 'POST' && route === '/api/apps') {
        requireAuthenticated(session);
        const details = appDetails(await readJson(req));
        // An upload cannot outlive the verified session that authorized it.
        sweep();
        if (!sessions.has(session)) fail(401, 'session_required', 'Please log in');
        requireAuthenticated(session);
        if (apps.some((app) => app.name.toLowerCase() === details.name.toLowerCase()
            && (app.url || '').toLowerCase() === (details.url || '').toLowerCase())) {
          fail(409, 'app_exists', 'This app is already in your list');
        }
        if (apps.length >= APP_LIMIT) fail(409, 'app_limit', 'You can add up to 30 apps in this demo');
        const app = Object.freeze({id: randomUUID(), ...details, createdAt: now()});
        apps.push(app);
        json(res, 201, {app});
        return;
      }
      if (req.method === 'POST' && route === '/api/logout') {
        exactFields(await readJson(req), []);
        revokeSession(session);
        json(res, 200, {ok: true}, {'Set-Cookie': cookie()});
        return;
      }
      if (req.method === 'POST' && route === '/api/pairing') {
        const body = await readJson(req);
        exactFields(body, Object.hasOwn(body || {}, 'pageScoped') ? ['pageScoped'] : []);
        if (Object.hasOwn(body, 'pageScoped') && body.pageScoped !== true) fail(400, 'invalid_body', 'pageScoped must be true');
        sweep();
        if (!sessions.has(session)) fail(401, 'session_required', 'Please log in');
        if (phone) fail(409, 'phone_exists', 'Use Connect a different phone from a verified browser session');
        clearPairing();
        pairing = {pairingId: randomUUID(), pairingCode: randomToken(),
          expiresAt: now() + (body.pageScoped ? 30_000 : PAIRING_TTL_MS), session,
          ...(body.pageScoped ? {pageScoped: true} : {})};
        const {pairingId, pairingCode, expiresAt} = pairing;
        json(res, 200, {pairingId, pairingCode, expiresAt, origin: phoneOrigin, ...(pairing.pageScoped ? {pageScoped: true} : {})},
          pairing.pageScoped ? {'Set-Cookie': cookie(session, {sessionOnly: true})} : {});
        return;
      }
      if (req.method === 'POST' && ['/api/phones/replacement', '/api/phones/replacement/cancel'].includes(route)) {
        requireAuthenticated(session);
        exactFields(await readJson(req), []);
        sweep();
        if (!sessions.has(session)) fail(401, 'session_required', 'Please log in');
        requireAuthenticated(session);
        if (route.endsWith('/cancel')) {
          if (pairing?.replacementPhoneId && pairing.session === session) clearPairing();
          json(res, 200, {ok: true});
          return;
        }
        if (!phone) fail(409, 'phone_required', 'Enroll a phone before replacing it');
        clearPairing();
        pairing = {pairingId: randomUUID(), pairingCode: randomToken(), expiresAt: now() + PAIRING_TTL_MS,
          session, replacementPhoneId: phone.id};
        const {pairingId, pairingCode, expiresAt} = pairing;
        json(res, 200, {pairingId, pairingCode, expiresAt, origin: phoneOrigin});
        return;
      }
      if (req.method === 'POST' && route === '/api/challenges') {
        const body = await readJson(req);
        exactFields(body, []);
        sweep();
        if (!sessions.has(session)) fail(401, 'session_required', 'Please log in');
        const login = sessions.get(session);
        if (login.verifiedAt !== null) fail(409, 'already_authenticated', 'This session has already completed verification');
        if (!phone || phone.socket?.readyState !== WebSocket.OPEN) fail(409, 'phone_offline', 'Connect the enrolled foreground phone first');
        endChallenge(challenges.get(activeId), 'cancelled');
        while (challenges.size >= 100) challenges.delete(challenges.keys().next().value);
        const challenge = Object.freeze({v: CONTRACT_VERSION, id: randomUUID(), nonce: randomToken(), phoneId: phone.id,
          expiresAt: Math.min(now() + CHALLENGE_TTL_MS, login.expiresAt), purpose: 'login',
          sessionId: login.id, username, serviceName: 'NearKey'});
        const record = {challenge, status: 'waiting_phone', phoneReady: false, receipt: null, session};
        challenges.set(challenge.id, record);
        login.challengeId = challenge.id;
        activeId = challenge.id;
        sendPhone({type: 'challenge', challenge});
        json(res, 200, {challenge, status: record.status});
        return;
      }
      const match = /^\/api\/challenges\/([a-f0-9-]{36})(?:\/(complete|cancel))?$/.exec(route);
      if (match) {
        const record = ownChallenge(match[1], session);
        if (req.method === 'GET' && !match[2]) {
          json(res, 200, {challenge: record.challenge, status: record.status, phoneReady: record.phoneReady, receipt: record.receipt,
            authenticated: sessions.get(session).verifiedAt !== null});
          return;
        }
        if (req.method === 'POST' && match[2] === 'cancel') {
          exactFields(await readJson(req), []);
          sweep();
          if (!sessions.has(session)) fail(401, 'session_required', 'Please log in');
          endChallenge(record, 'cancelled');
          json(res, 200, {ok: true});
          return;
        }
        if (req.method === 'POST' && match[2] === 'complete') {
          const body = await readJson(req);
          exactFields(body, ['signature']);
          // Proof consumption and session promotion are synchronous after the final await.
          // No interleaving request can consume the record twice.
          sweep();
          if (!sessions.has(session)) fail(401, 'session_required', 'Please log in');
          requirePending(record);
          if (record.challenge.sessionId !== sessions.get(session).id) {
            fail(403, 'invalid_proof', 'Challenge does not match this login session');
          }
          if (record.challenge.phoneId !== phone?.id) fail(409, 'phone_changed', 'Challenge phone is no longer enrolled');
          let valid;
          try { valid = verifyProof(phone.key, approvalText(record.challenge), body.signature); }
          catch { fail(400, 'invalid_signature', 'Expected an unpadded base64url DER P-256 signature'); }
          if (!valid) fail(403, 'invalid_proof', 'Signature does not match this challenge and phone');
          // Recheck deadline and session after cryptographic work, before atomic promotion.
          sweep();
          if (!sessions.has(session)) fail(401, 'session_required', 'Please log in');
          requirePending(record);
          const verifiedAt = now();
          const receipt = Object.freeze({id: randomUUID(), serviceName: record.challenge.serviceName,
            username: record.challenge.username, phoneLabel: phone.label, verifiedAt, createdAt: verifiedAt});
          const login = sessions.get(session);
          login.verifiedAt = verifiedAt;
          login.expiresAt = verifiedAt + SESSION_TTL_MS;
          activity.unshift(receipt);
          if (activity.length > 1000) activity.pop();
          record.receipt = receipt;
          record.status = 'approved';
          record.phoneReady = false;
          if (activeId === record.challenge.id) activeId = null;
          sendPhone({type: 'cancel', challengeId: record.challenge.id});
          json(res, 200, {status: 'approved', authenticated: true, user: USER, receipt},
            {'Set-Cookie': cookie(session)});
          return;
        }
      }
      fail(404, 'not_found', 'API route not found');
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const known = error instanceof ApiError;
        // Close on unread/invalid bodies so slow or oversized uploads cannot linger.
        const headers = req.method === 'POST' ? {Connection: 'close'} : {};
        if (known && error.status === 429) headers['Retry-After'] = '60';
        json(res, known ? error.status : 500, {error: known ? error.error : 'internal_error',
          message: known ? error.message : 'Request could not be completed'}, headers);
        req.resume();
      }
    }
  }
  const server = http.createServer({maxHeaderSize: 8192, requestTimeout: 15_000,
    headersTimeout: 10_000, keepAliveTimeout: 5000}, async (req, res) => {
    if (!stateStore) return handleRequest(req, res);
    if (req.method === 'GET' && assets.has(req.url)) return handleRequest(req, res, false);
    const buffered = bufferedResponse();
    try {
      await withState(() => handleRequest(req, buffered));
      buffered.flush(res);
    } catch {
      json(res, 503, {error: 'storage_unavailable', message: 'Shared storage is unavailable; retry shortly'}, {'Retry-After': '5'});
      req.resume();
    }
  });

  const wss = new WebSocketServer({noServer: true, maxPayload: 2048, perMessageDeflate: false});
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (stateStore) { void sharedUpgrade(req, socket, head); return; }
    try {
      if (closing) fail(503, 'server_closing', 'Server is shutting down');
      sweep();
      rateLimit(req, 'upgrade', 20);
      if (/^\/api\/pairing-channel\/[0-9a-f-]{36}$/.test(req.url)) {
        sameOrigin(req, true);
        const session = requireSession(req);
        const pairingId = req.url.slice('/api/pairing-channel/'.length);
        if (!pairing?.pageScoped || pairing.pairingId !== pairingId || pairing.session !== session) {
          fail(401, 'invalid_pairing', 'Pairing page is no longer active');
        }
        if (pairing.socket) fail(409, 'channel_exists', 'Pairing page is already connected');
        const owner = pairing;
        wss.handleUpgrade(req, socket, head, (ws) => {
          owner.socket = ws;
          owner.expiresAt = Infinity;
          ws.alive = true;
          ws.on('error', () => {});
          ws.on('pong', () => { ws.alive = true; });
          ws.on('message', () => ws.close(1008, 'No messages supported'));
          ws.on('close', () => { if (pairing === owner) clearPairing(); });
          ws.send(JSON.stringify({type: 'pairing_ready'}));
        });
        return;
      }
      if (req.url !== '/api/phone-channel' || req.headers.origin !== undefined) {
        fail(403, 'channel_rejected', 'Native phone channel only');
      }
      const owner = requirePhone(req);
      wss.handleUpgrade(req, socket, head, (ws) => {
        const previous = owner.socket;
        if (previous && previous.readyState !== WebSocket.CLOSED) {
          const record = challenges.get(activeId);
          if (pending(record)) sendPhone({type: 'cancel', challengeId: record.challenge.id}, previous);
          if (previous.readyState === WebSocket.OPEN) previous.close(1000, 'Channel replaced');
          const replacementTimer = setTimeout(() => previous.terminate(), 1000);
          replacementTimer.unref();
          previous.once('close', () => clearTimeout(replacementTimer));
        }
        owner.socket = ws;
        ws.alive = true;
        ws.on('error', () => {});
        ws.on('pong', () => { ws.alive = true; });
        ws.on('message', (data, binary) => {
          if (owner.socket !== ws || ws.readyState !== WebSocket.OPEN) return;
          let message;
          try { message = JSON.parse(data.toString('utf8')); } catch { ws.close(1008, 'Invalid message'); return; }
          if (binary || !message || Array.isArray(message) || message.type !== 'ping' || Object.keys(message).length !== 1) {
            ws.close(1008, 'Only ping is supported');
            return;
          }
          ws.messageCount = (ws.messageCount || 0) + 1;
          if (ws.messageCount > 60) ws.close(1008, 'Too many messages');
        });
        ws.on('close', () => {
          if (owner.socket !== ws) return;
          owner.socket = null;
          const record = challenges.get(activeId);
          if (pending(record)) { record.phoneReady = false; record.status = 'waiting_phone'; }
        });
        sendPhone({type: 'ready', phoneId: owner.id}, ws);
        sweep();
        const record = challenges.get(activeId);
        if (pending(record)) {
          record.phoneReady = false;
          record.status = 'waiting_phone';
          sendPhone({type: 'challenge', challenge: record.challenge}, ws);
        }
      });
    } catch (error) {
      const known = error instanceof ApiError;
      const status = known ? error.status : 400;
      const body = JSON.stringify({error: known ? error.error : 'channel_rejected',
        message: known ? error.message : 'Channel rejected'});
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => socket.destroy());
    }
  });
  async function sharedUpgrade(req, socket, head) {
    let channel;
    try {
      if (closing) fail(503, 'server_closing', 'Server is shutting down');
      let kind;
      await withState(() => {
        rateLimit(req, 'upgrade', 20);
        if (/^\/api\/pairing-channel\/[0-9a-f-]{36}$/.test(req.url)) {
          sameOrigin(req, true);
          const session = requireSession(req);
          if (!pairing?.pageScoped || pairing.pairingId !== req.url.slice('/api/pairing-channel/'.length)
              || pairing.session !== session) fail(401, 'invalid_pairing', 'Pairing page is no longer active');
          if (pairing.socket?.readyState === WebSocket.OPEN) fail(409, 'channel_exists', 'Pairing page is already connected');
          channel = channels.create();
          pairing.socket = channel;
          pairing.expiresAt = channels.records.get(channel.id).expiresAt;
          channel.send(JSON.stringify({type: 'pairing_ready'}));
          kind = 'pairing';
        } else {
          if (req.url !== '/api/phone-channel' || req.headers.origin !== undefined) fail(403, 'channel_rejected', 'Native phone channel only');
          const owner = requirePhone(req);
          channel = channels.create();
          owner.socket?.close(1000, 'Channel replaced');
          owner.socket = channel;
          sendPhone({type: 'ready', phoneId: owner.id});
          const record = challenges.get(activeId);
          if (pending(record)) {
            record.phoneReady = false;
            record.status = 'waiting_phone';
            sendPhone({type: 'challenge', challenge: record.challenge});
          }
          kind = 'phone';
        }
      });
      // The upgrade and its messages become visible only after the shared commit.
      if (socket.destroyed) throw new Error('Upgrade disconnected');
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.alive = true;
        ws.on('error', () => {});
        ws.on('pong', () => { ws.alive = true; });
        ws.on('message', (data, binary) => {
          let message;
          try { message = JSON.parse(data.toString('utf8')); } catch { ws.close(1008, 'Invalid message'); return; }
          if (kind !== 'phone' || binary || !message || Array.isArray(message)
              || message.type !== 'ping' || Object.keys(message).length !== 1) {
            ws.close(1008, 'Only ping is supported'); return;
          }
          ws.messageCount = (ws.messageCount || 0) + 1;
          if (ws.messageCount > 60) ws.close(1008, 'Too many messages');
        });
        // Reconnect before Vercel's five-minute function deadline.
        const rotation = setTimeout(() => ws.close(1012, 'Reconnect channel'), 280_000);
        rotation.unref();
        ws.once('close', () => clearTimeout(rotation));
        channels.attach(channel, ws, kind);
      });
    } catch (error) {
      if (channel) void withState(() => { disconnectChannel(channel.id); channels.records.delete(channel.id); }).catch(() => {});
      const known = error instanceof ApiError;
      const status = known ? error.status : 503;
      const body = JSON.stringify({error: known ? error.error : 'storage_unavailable', message: known ? error.message : 'Channel unavailable; retry shortly'});
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => socket.destroy());
    }
  }
  const expiryTimer = stateStore ? null : setInterval(sweep, 1000);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!ws.alive || (!stateStore && phone?.socket !== ws && pairing?.socket !== ws)) { ws.terminate(); continue; }
      ws.alive = false;
      ws.messageCount = 0;
      try { ws.ping(); } catch { ws.terminate(); }
    }
  }, 30_000);
  expiryTimer?.unref();
  heartbeat.unref();
  server.on('close', () => { channels?.stop(); clearInterval(expiryTimer); clearInterval(heartbeat); });

  return {
    server,
    async close() {
      if (closing) return;
      closing = true;
      channels?.stop();
      if (channels) await withState(() => {
        for (const id of channels.local.keys()) { disconnectChannel(id); channels.records.delete(id); }
      }).catch(() => {});
      clearInterval(expiryTimer);
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve, reject) => {
        server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
