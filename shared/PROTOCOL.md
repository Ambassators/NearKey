# NearKey login contract — version 2

The shared JavaScript module and Android `Protocol` implement this contract. Version 2 specifies Bluetooth login verification; enrollment proof remains version 1.

## Scope and state

NearKey is a 2FA provider demo with one account and one enrolled Android phone. The browser dashboard is available only after both password and Bluetooth factors succeed. A correct password creates a pending login, not an authenticated account session. First-time phone enrollment and Bluetooth permission occur during that pending login.

Node 22+ serves vanilla browser modules and a phone WebSocket channel. Android uses a foreground Kotlin app, AndroidKeyStore and OkHttp. Bluetooth must already be enabled. The phone signs automatically: this proves registered key possession, not user consent or physical distance. There is no background wake, manual proof entry or simulated verification.

Sessions, enrollment, challenges and verification activity live in memory. Restarting resets them. Enrolled phones cannot be replaced by password alone; re-enrollment requires a deliberate offline server reset and local phone reset. Defaults remain `HOST=127.0.0.1`, `PORT=5173`, `PUBLIC_ORIGIN=http://localhost:5173`, demo credentials `demo` / `demo-passive-key`; environment overrides are supported. Network deployments use the same trusted HTTPS origin on browser and phone.

## Browser HTTP API

All successful API responses are JSON. Session cookies are HttpOnly, SameSite=Strict and Secure for HTTPS. Non-GET browser routes enforce same-origin Origin; no permissive CORS or login tokens in localStorage. Password hashes use salted scrypt and timing-safe verification. Errors are `{error,message}` without secrets or stacks.

- `POST /api/login {username,password}` creates a pending session. `GET /api/session` returns `{authenticated,pending,user,setup,challenge,challengeStatus}`. A pending session lasts ten minutes; `user` remains null and `setup` contains `{phone:null|{id,label,online}}`. After verification `authenticated` is true, `pending` is false and `user` is available. Verified sessions last eight hours from verification, with the browser cookie refreshed on successful proof.
- `POST /api/logout {}` revokes the session, pairing and pending challenge and sends cancellation to the phone.
- `GET /api/account` requires completed Bluetooth authentication and returns `{user,phone,activity}`. Activity contains successful verification receipts.
- `POST /api/pairing {}` permits first-time enrollment from a live pending session and returns `{pairingId,pairingCode,expiresAt}`. The unguessable five-minute pairing code is single-use and tied to that session. Existing phones cannot be replaced. Poll session setup to detect enrollment.
- `POST /api/challenges {}` from a pending session requires a registered, online phone. It cancels previous pending work and returns `{challenge,status:'waiting_phone'}`. The immutable challenge is `{v:2,id,nonce,phoneId,expiresAt,purpose:'login',username,serviceName,sessionId}`. ID is a canonical UUID; nonce is 32 random bytes encoded unpadded base64url; sessionId is a random identifier tied to the creating pending session, never its bearer cookie. Deadline is at most 60 seconds and never exceeds session expiry.
- `GET /api/challenges/:id` from its own creating session returns `{challenge,status,phoneReady,receipt,authenticated}`. Status is `waiting_phone|waiting_bluetooth|approved|expired|cancelled`.
- `POST /api/challenges/:id/complete {signature}` verifies the enrolled phone's DER P-256 ECDSA SHA-256 signature against the exact server-owned login context. After checking deadline, ownership, pending state and key, it atomically consumes the challenge, promotes that session and returns `{status:'approved',authenticated:true,user,receipt}`. Replay cannot promote another session or add another receipt. Receipt is `{id,serviceName,username,phoneLabel,verifiedAt,createdAt}`. Browser-supplied metadata, nonce, phone IDs or public keys cannot replace stored challenge state.
- `POST /api/challenges/:id/cancel {}` cancels own pending work and sends phone cancellation.

## Phone API

Phone credentials never appear in browser responses or BLE.

- `POST /api/phones/enroll {pairingCode,publicKey,label,signature}` returns `{phoneId,deviceToken}`. Public key is canonical unpadded base64url DER SPKI for EC P-256. Enrollment signature is DER ECDSA SHA-256 over `NEARKEY-ENROLL-V1\n{pairingCode}\n{publicKey}` without a trailing newline. Validate key curve/type, signature, code deadline, originating session and single use. Label is at most 40 characters; device token is an opaque random credential of at least 256 bits.
- WebSocket `/api/phone-channel` authenticates with `Authorization: Bearer <deviceToken>`, never a query string. Server messages are `{type:'ready',phoneId}`, `{type:'challenge',challenge}` and `{type:'cancel',challengeId}`. Reconnect resends only live pending work. Server heartbeat detects loss; channel payloads are bounded and browser-origin upgrades are rejected.
- `POST /api/phone/challenges/:id/ready {}` with that bearer credential marks own live challenge ready after Android advertisement starts successfully. Status becomes `waiting_bluetooth`; readiness never extends the original deadline.

## Enrollment setup QR

The browser renders a QR after a pending login creates first-time enrollment.
Its exact URI format is:

```text
nearkey://enroll?v=1&origin=<percent-encoded-server-origin>&code=<percent-encoded-pairing-code>
```

`v=1` versions the setup URI independently of the version 2 login proof. The
origin is the exact reachable server origin, without a path. The code is the
temporary, single-use value returned by `POST /api/pairing`. The QR contains no
password, device token, session cookie or Bluetooth proof. It carries the same
enrollment authority as the displayed pairing code, so keep it private.

Android scans the QR or accepts the identical string through the explicit
`MainActivity` intent extra `enrollment_uri`. Both paths validate the setup URI
and prefill the origin and code; neither submits enrollment automatically. The
user reviews the values and taps **Enroll phone**. Manual origin/code entry
remains available. Enrollment still uses the existing phone API, key proof and
server checks, including expiry and session ownership. QR setup does not change
the Bluetooth factor required to finish the pending login.

## Signing text and BLE

The exact UTF-8 login signing text has no trailing newline:

```text
NEARKEY-LOGIN-V2
{id}
{nonce}
{phoneId}
{expiresAt}
{username}
{serviceName}
{sessionId}
```

The prefix domain-separates login from enrollment and earlier protocol signatures. `expiresAt` is its base-10 integer representation. Username, service name and phone ID must not contain CR/LF; phone ID and display fields are at most 128 characters. Session ID is 1–128 URL-safe ASCII characters. Android rejects extra challenge fields and any purpose other than `login`. It validates the challenge from the authenticated phone channel before advertising or signing.

Phone is the GATT peripheral and browser is central; UUIDs are unchanged and exported by `shared/protocol.mjs`. No login details or credentials are advertised. Private P-256 key is non-exportable in AndroidKeyStore; hardware backing is best effort and user-authentication is disabled for automatic signing.

- REQUEST is writable with response. Browser sends `{v:2,type:'prove',challengeId,nonce}` as strict newline-terminated UTF-8 JSON in ordered writes of at most 20 bytes. Maximum assembled request is 1024 bytes including newline. Version/type/id/nonce must match the phone's live immutable server challenge. The phone never signs arbitrary Bluetooth payloads.
- PROOF is readable and contains `{v:2,challengeId,signature}`. Signature is canonical unpadded base64url DER ECDSA, not IEEE-P1363. Response is ready before the final write acknowledgement. Android implements offset reads with MTU-1 slices and an empty terminal read. Browser validates response version/ID/shape and relays only the signature through its own pending session.
- One central connects at a time. Disconnect clears buffers/proof and may re-advertise before the original deadline. Cancel, expiry, logout, channel loss, app backgrounding and reset discard pending work and close GATT. Bluetooth/permission failures remain visible; the app never silently enables the radio.

## Browser flow and verification boundaries

Password → first-time enrollment if needed → Bluetooth login verification → authenticated provider dashboard. Initial permission uses an explicit click to `navigator.bluetooth.requestDevice` with the service UUID. Only the granted device ID is remembered locally. Setup advertising is bounded and cannot sign. Later logins try `getDevices()` and reconnect to a previously granted device; unsupported or missing permission requires a fresh chooser gesture. Wrong chosen phones fail cryptographic verification without replacing enrollment.

During verification show phone readiness, remaining time, service and account. Await phoneReady before requesting proof. Cancel, expiry or logout stops retries and polling. Do not fabricate success when Web Bluetooth is unavailable.

Server tests exercise real P-256 cryptography and HTTP/WS pending-to-authenticated transitions, including replay, wrong sessions/keys/context, expiry and enrollment restrictions. Browser Bluetooth tests use mocks. JVM protocol tests verify strict parsing, framing and signed context interoperability. None proves AndroidKeyStore or physical Bluetooth operation. Mac Chromium ↔ a foreground physical Android phone remains the manual hardware gate.
