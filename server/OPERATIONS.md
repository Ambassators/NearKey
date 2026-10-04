# NearKey 2FA demo server

Run Node 22+ with `npm ci`, then `npm start`. `npm test` discovers server and browser tests. Runtime dependency is `ws`.

Defaults: `HOST=127.0.0.1`, `PORT=5173`, `PUBLIC_ORIGIN=http://localhost:5173`. Fixture credentials: `demo` / `demo-passive-key`; override `DEMO_USERNAME` and `DEMO_PASSWORD` for a deployment. A password match creates a ten-minute pending login. Only an enrolled phone's valid Bluetooth login proof promotes it to an eight-hour authenticated session. Protected account/dashboard data requires that completed second factor.

For Android, use a trusted HTTPS endpoint reachable by both devices. Set `PUBLIC_ORIGIN` to that exact browser-facing origin and configure the app with the same origin. The reverse proxy must forward WebSocket upgrades and Authorization headers. The server does not trust forwarded headers, allow CORS or permit non-local HTTP browser origins. HTTP localhost supports local development, not the cross-device hardware gate.

All data lives in memory. Restart resets sessions, verification activity, enrollment and phone credentials. Re-enrollment requires stopping the server offline, resetting the Android local credential/key, then restarting and pairing again. No password-only phone replacement/removal API exists. This reset is a demo lifecycle operation, not durable account recovery.

Bounds: 4 KiB JSON bodies, 8 KiB headers, five-second body timeout, 16 live sessions, one five-minute pairing code, one 60-second active login challenge, 100 recent challenge records and 1,000 successful verification activity records. Older challenge IDs return not-found after eviction. Each address has 240 HTTP requests/minute, 10 combined login/enrollment attempts/minute and 20 phone upgrades/minute. A reverse proxy shares these budgets because forwarded addresses are not trusted. Address limiter is bounded to 1,024 buckets. WS payloads are at most 2 KiB; only `{type:'ping'}` messages are accepted, at most 60 per heartbeat interval.

Deadlines are absolute; readiness and reconnect never extend them. Session revocation, channel heartbeat failure and expiry cancel pending phone work. Signature verification and session promotion complete synchronously after body parsing, preventing concurrent duplicate completion. Version 2 signatures bind server-owned login context; enrollment remains version 1.

Static resources are regular top-level web assets inventoried at startup, with no symlinks, subdirectories or arbitrary paths. `/` serves `web/index.html`; `/shared/protocol.mjs` is the only exposed shared resource. Restart after adding static assets.

Automated tests exercise real P-256 keys, DER SPKI/DER ECDSA, HTTP/WebSocket and pending-login security transitions. They do not exercise Bluetooth radio behavior. Mac Chromium ↔ foreground Android GATT/Keystore is a separate manual hardware gate. This prototype does not integrate external relying-party services or provide production account recovery.
