# NearKey passive Android demo

Foreground native Kotlin app for **fictional transfers**, implementing the unchanged
[`shared/PROTOCOL.md`](../shared/PROTOCOL.md) version 1. No Compose, background
service, phone confirmation, biometrics, simulator or manual proof path.

## Build

Use JDK 21 and an existing Android SDK with `platforms/android-37.0` and
`build-tools/37.0.0`:

```sh
cd android
export ANDROID_HOME=/opt/android-sdk   # or your installed SDK
./gradlew --console=plain --no-daemon assembleDebug testDebugUnitTest lintDebug
node tools/check-contract.mjs
```

APK: `app/build/outputs/apk/debug/app-debug.apk`. The official Gradle 8.13 wrapper
scripts/JAR and distribution SHA-256 are checked in. AGP 8.11.1, Kotlin 2.2.21,
OkHttp 4.12.0 and test dependencies are pinned. Project dependencies can download;
automatic SDK downloads are disabled. No SDK folder renaming or system installs.
Build configs are repository files, deliberately outside personal chezmoi management.

The installed platform has a **minor API** suffix. `compileSdk = 37` plus
`compileSdkMinor = 0` resolves `android-37.0`; integer `compileSdk = 37` alone
would look for `android-37`. The minor property exists in the installed AGP
8.11.1 API (verified from its Gradle API JAR); the current
[official CommonExtension docs](https://developer.android.com/reference/tools/gradle-api/8.11/com/android/build/api/dsl/CommonExtension#compileSdkMinor())
describe that property (their added-version annotation says 8.11.2).
AGP 8.11.1 was tested up to SDK 36.0, so it emits an **unsuppressed compatibility
warning** for 37.0. This is not a claim of official SDK 37 validation. Compilation,
unit tests and lint determine what actually works on this host. Target SDK is 36,
minimum phone API is 26; Java/Kotlin bytecode targets 17 while the build uses JDK 21.

## Demo setup

1. Deploy the sibling server with a reachable HTTPS origin and a publicly trusted
   certificate. Paste that origin, not a path, into the phone. Never paste a token.
   The release variant rejects HTTP; **debug only** permits HTTP for local testing.
   `localhost` on the phone is the phone itself, not the Mac. TLS trust and hostname
   checks are not disabled. The app contains no deployment URL or credentials.
2. Password-login in Mac Chromium, create enrollment and paste its pairing code
   into the app. Tap **Enroll phone**. The P-256 private key lives in
   AndroidKeyStore, non-exportable, without user-authentication requirements.
   Hardware backing is best effort, reported from KeyInfo, never guaranteed.
   Enrollment sends DER SPKI and DER SHA256withECDSA proof with unpadded base64url.
   The returned phone token lives in app-private preferences; backup is disabled.
3. Keep the phone app visible. Bluetooth must already be enabled. Tap
   **Advertise setup for 60 seconds**, granting Nearby devices permissions if
   prompted, then explicitly click the browser's first-time Bluetooth chooser.
   Setup mode advertises only the service UUID and **cannot sign**.
4. Create a fictional transfer in the browser. Only an authenticated phone-channel
   challenge enables signing. The app displays immutable metadata and countdown,
   advertises for the remaining server deadline, and POSTs readiness only after
   Android's `onStartSuccess`. The browser tries its remembered permitted device
   or offers its user-gesture chooser, writes <=20-byte newline JSON chunks with
   response, reads the proof, and relays only the DER signature to its own session.
   There is no browser approval token in this app, BLE, or advertisement.

The request buffer is bounded at 1024 bytes. ID, nonce, version, type, server
pending state and wall/monotonic deadlines are checked before signing the exact
UTF-8 `NEARKEY-PASSIVE-V1\n{id}\n{nonce}` text. Proof exists before the final write
ACK. GATT reads support offsets and MTU-1 slices, including an empty terminal
read; the server stays open while a central reads after advertising stops.
Only one central is accepted. Disconnect clears buffers/proof and readvertises
only before the original deadline. Cancel, expiry, channel loss, local reset and
leaving foreground close GATT/advertising and discard the pending challenge.

Reconnect uses bounded exponential delay while foreground and accepts only live
challenges resent by the authenticated server. Old socket and HTTP callbacks
cannot mutate a new channel/session. Radio/permission/peripheral failures are
shown, never silently toggle Bluetooth. Use retry advertising after enabling
Bluetooth or granting permissions; use retry online connection after a network
failure. Keep the phone clock synchronized with the server; the app rejects
expired challenges or challenges appearing more than 60 seconds in the future.

## Reset and verification boundaries

The demo server's in-memory state resets on restart. **Forget local enrollment**
erases this phone's token/key, not the server's registration. Existing phone
replacement is never automatic. Coordinate an explicit offline server reset and
forget local enrollment before pairing anew. An interrupted enrollment may have
committed on the server without saving the token locally; resolve it with the
same offline reset, not password-only replacement.

`ProtocolTest` exercises domain texts, challenge/request rejection, setup/expiry,
chunk bounds and long-read slices. It also produces ephemeral **JVM** P-256
vectors; `tools/check-contract.mjs` verifies them with Node against the actual
parent-owned shared module. These tests do not exercise AndroidKeyStore, Bluetooth,
permissions, lifecycle on a physical phone, or the sibling server end-to-end.

**Manual hardware gate (not tested from SSH):** install the APK on a peripheral-
capable phone and use Mac Chromium. Verify first chooser permission, remembered
reconnect and chooser fallback, one transfer only, wrong phone/nonce rejection,
long proof reads at default MTU, disconnect/retry, cancel/logout/expiry, app
background/channel-loss cleanup, permission denial, disabled radio and a phone
without peripheral support. Server API/replay/session tests belong to the server
stream. No claim of real Bluetooth testing is made here.
