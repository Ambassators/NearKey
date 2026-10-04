# Passive hardware-key rewrite decisions

- Branch: `rewrite-passive-hardware-key`, based on `dev`; main/dev preserve the old export. Contract version1 in `shared/protocol.mjs` and `shared/PROTOCOL.md`.
- User-approved: Bluetooth pre-enabled; one-time browser permission; MacBook Chromium demo; foreground native Android app first;60-second challenge; background wake-up, optional phone approval and transaction limits deferred.
- Security: server-generated nonce associated with immutable transaction and original session; single-use atomic execution. No extra transaction bearer token. Phone signs only authenticated server-delivered pending challenge. BLE isn't distance bounding or transaction consent.
- Stack: Node22+ HTTP/WS, one `ws` dependency, vanilla web modules, Kotlin Android Keystore/OkHttp/GATT. No simulator, framework layers, or background service baseline.
- Demo shortcuts: fictional account/money, explicit demo password, in-memory server state. Trusted initial enrollment; no password-only replacement endpoint. Local server restart reset is deliberate demo lifecycle, not production security.
- Shared protocol is parent-owned; agents request changes. PLAN.md is local workflow state and is never committed. Repository build config is not personal/chezmoi configuration and remains repo-managed.
