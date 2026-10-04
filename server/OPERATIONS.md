# Fictional demo server

Run Node 22+ with `npm ci`, then `npm start`. `npm test` discovers server tests and any
browser `*.test.mjs` tests present after stream integration. Runtime dependency: `ws` only.

Defaults: `HOST=127.0.0.1`, `PORT=5173`, `PUBLIC_ORIGIN=http://localhost:5173`.
Fixture login: `demo` / `demo-passive-key`. Override with `DEMO_USERNAME` and
`DEMO_PASSWORD`. The credentials are intentionally public demo fixtures, not real banking credentials.

For the native Android app on a phone, put the demo behind a trusted HTTPS endpoint
reachable by both devices. Set `PUBLIC_ORIGIN` to that exact browser-facing HTTPS origin;
configure the app with the same HTTPS base URL (WSS for its channel). A reverse proxy
must forward the WebSocket upgrade and Authorization header. The server does not trust
forwarded headers, allow CORS, or permit non-local HTTP browser origins. HTTP localhost
is suitable for server tests/local browser development, not the cross-device hardware gate.

All data is in memory. **Restart resets** sessions, balance, transaction history,
enrollment and phone channel credentials. For re-enrollment, stop the server offline,
reset the Android app's local credential/key, then restart and pair again. There is no
password-only phone replacement/removal API. A restart is a deliberate demo reset,
not persistence or a secure real-account recovery process.

Bounds: 4 KiB JSON bodies, 8 KiB HTTP headers, five-second body read timeout, 16 live
sessions (eight-hour TTL), one five-minute pairing code, one 60-second active challenge,
100 recent challenge records, 1,000 fictional transfers. Older challenge IDs return
not-found after eviction. Each client address has 240 HTTP requests/minute, 10 combined
login/enrollment attempts/minute and 20 phone upgrades/minute. No forwarded address
trust: a reverse proxy shares these demo budgets. WS payloads are at most 2 KiB; only
`{type:'ping'}` messages are accepted, at most 60 per 30-second heartbeat interval.
The address limiter is bounded to 1,024 buckets. All deadlines are absolute; phone-ready
and reconnect do not extend them. Heartbeats terminate dead channels; expiry and session
revocation cancel pending phone work. Signature verification and single debit execute
synchronously after body parsing, preventing concurrent double completion.

Static resources are regular top-level web assets inventoried at startup (no symlinks,
subdirectories or arbitrary filesystem paths), available at `/web/<name>` and `/<name>`;
`/` serves `web/index.html`. `/shared/protocol.mjs` is the only shared resource served.
The browser stream must be integrated before the root page exists; restart after adding assets.

Automated tests use real generated P-256 keys with DER SPKI and DER ECDSA signatures.
They validate HTTP, WebSocket, cryptography and adversarial state transitions, not
Bluetooth radio behavior. Mac Chromium ↔ foreground Android GATT/Keystore remains a
separate manual hardware gate. Never use this intentionally small fictional demo for
real funds or accounts.
