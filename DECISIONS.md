# Bluetooth 2FA provider decisions

- NearKey is a 2FA provider. Password entry starts a pending login; Bluetooth phone verification completes authentication before any dashboard or protected account data is accessible. Initial enrollment occurs inside the pending login.
- Contract version 2 in `shared/protocol.mjs` and `shared/PROTOCOL.md` specifies login verification. Immutable server login context includes challenge ID, nonce, phone, expiry, username, service and pending-session identifier. `NEARKEY-LOGIN-V2` domain-separates signatures; enrollment remains `NEARKEY-ENROLL-V1`.
- User-approved baseline: Bluetooth pre-enabled; one-time browser permission; Mac Chromium; foreground native Android app; 60-second challenge. Background wake and optional explicit phone approval remain deferred.
- Security: server-generated nonce, pending-session ownership, single-use atomic authentication and no extra bearer approval token. Phone signs only authenticated server-delivered login work. BLE proves registered key possession, not distance or consent. Password alone cannot replace an enrolled phone.
- Stack: Node 22+ HTTP/WS, `ws`, vanilla browser modules and Kotlin AndroidKeyStore/OkHttp/GATT. No simulated proof, background service or framework layers.
- Demo lifecycle: one fixture account, explicit demo password and in-memory state. Offline server restart resets enrollment, sessions and verification activity; it is a deliberate demo reset, not account recovery or persistence.
- Browser provider dashboard presents authenticator status, setup details and verification activity. Protected data is available only after completed login verification.
- PLAN.md is local workflow state and is never committed. Repository build configuration is repo-managed.
