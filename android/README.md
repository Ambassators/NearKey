# NearKey Android authenticator

Foreground native Kotlin app for **Bluetooth login verification**, implementing
[`shared/PROTOCOL.md`](../shared/PROTOCOL.md) version 2. No Compose, background
service, phone confirmation, biometrics, simulator or manual proof path.

## Build

Use JDK 17 or 21 and an existing Android SDK containing
`platforms/android-37.0` and `build-tools/37.0.0`. For this workspace, the existing
SDK is `/Users/jambe/Documents/Foreground/Tiktok CTF clone/tools/android-sdk`.
From the repository root on this Mac:

```sh
export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
export ANDROID_HOME='/Users/jambe/Documents/Foreground/Tiktok CTF clone/tools/android-sdk'
cd android
./gradlew --console=plain --no-daemon :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
node tools/check-contract.mjs
```

On another machine, set those variables to its installed JDK/SDK. APK:
`app/build/outputs/apk/debug/app-debug.apk`. Gradle 8.13, AGP 8.11.1, Kotlin 2.2.21,
OkHttp 4.12.0, AndroidX Activity 1.9.3, ZXing Embedded 4.3.0 and test
dependencies are pinned. SDK downloads are disabled.

`compileSdk = 37` with `compileSdkMinor = 0` resolves the installed
`android-37.0` platform; do not rename SDK folders. AGP emits a compatibility
warning because it was tested up to SDK 36.0. Target SDK is 36, minimum phone API
is 26 and Java/Kotlin bytecode targets 17. Build, unit tests and lint check the
configured combination; they do not test physical Bluetooth.

## USB debug workflow

For a local demo, connect an authorized Android device over USB. From the
repository root after building:

```sh
"$ANDROID_HOME/platform-tools/adb" devices
"$ANDROID_HOME/platform-tools/adb" install -r android/app/build/outputs/apk/debug/app-debug.apk
"$ANDROID_HOME/platform-tools/adb" reverse tcp:5173 tcp:5173
"$ANDROID_HOME/platform-tools/adb" reverse --list
"$ANDROID_HOME/platform-tools/adb" shell am start -n dev.nearkey.passive/.MainActivity
npm start
```

If several devices are connected, add `-s <device-serial>` to each adb command.
Open `http://localhost:5173` in Mac Chromium and scan its enrollment QR in the
phone's **NearKey Authenticator** app, or enter that same origin manually. The reverse mapping forwards the phone's
localhost port to the Mac server; it supports the phone HTTP requests and
WebSocket channel. Keep USB connected and restore the mapping after reconnecting.

The debug manifest and API client allow HTTP for this local workflow. Release
builds require HTTPS/WSS. USB carries the network channel only: login still
requires a real Bluetooth GATT proof. Installation with `-r` preserves local
app credentials and keys. The application ID and Keystore alias retain their
existing names so an upgrade does not silently discard enrollment.

To prefill the same enrollment details over adb, pass the browser's setup URI as
an explicit activity extra. Preserve the inner quotes around the complete URI so
its `&` characters stay inside the remote shell argument:

```sh
"$ANDROID_HOME/platform-tools/adb" shell \
  "am start -n dev.nearkey.passive/.MainActivity --es enrollment_uri 'nearkey://enroll?v=1&origin=http%3A%2F%2Flocalhost%3A5173&code=REPLACE_WITH_PAIRING_CODE'"
```

Replace the example code with the current pairing code. The URI only prefills the
server origin and code; review them and tap **Enroll phone** to submit enrollment.

## Demo setup

1. Use the USB debug workflow above or deploy the server at a reachable HTTPS
   origin with a trusted certificate. The setup QR carries that origin; manual
   entry takes the origin, not a path.
   Without adb reverse, `localhost` means the phone itself. Release requires HTTPS;
   TLS trust and hostname checks remain enabled. The app has no preset server URL.
2. Start a pending password login in Mac Chromium and create enrollment. Tap
   **Scan setup QR code** in the app and scan the browser's QR. Review the server
   address; no code entry is needed. **Enter details manually** opens the optional
   pairing-code and server-origin fields. Tap
   **Enroll phone**. The P-256 private key lives in
   AndroidKeyStore, non-exportable, without user-authentication requirements.
   Hardware backing is best effort, reported from KeyInfo, never guaranteed.
   Enrollment sends DER SPKI and DER SHA256withECDSA proof with unpadded base64url.
   The returned phone token lives in app-private preferences; backup is disabled.
3. Keep the phone app visible. Bluetooth must already be enabled. Tap
   **Advertise setup for 60 seconds**, granting Nearby devices permissions if
   prompted, then explicitly click the browser's first-time Bluetooth chooser.
   Setup mode advertises only the service UUID and **cannot sign**.
4. Continue login verification in the browser. Only an authenticated phone-channel
   login challenge enables signing. The app displays the service, account and countdown,
   advertises for the remaining server deadline, and POSTs readiness only after
   Android's `onStartSuccess`. The browser tries its remembered permitted device
   or offers its user-gesture chooser, writes <=20-byte newline JSON chunks with
   response, reads the proof, and relays only the DER signature to its pending session.
   There is no browser approval token in this app, BLE, or advertisement.

Enrollment QR scanning and the `enrollment_uri` activity extra use the same strict
setup URI parser. Invalid setup links leave the existing fields unchanged. A QR
contains the temporary origin and pairing code, never a password, phone token or
Bluetooth login proof. The server still checks the pairing deadline and single
use when **Enroll phone** is tapped. Scanning does not authorize a login or skip
Bluetooth verification.

The scanner runs locally using ZXing and requests Camera permission when opened.
Manual entry remains available if camera access is denied or unavailable.

The request buffer is bounded at 1024 bytes. ID, nonce, version, type, server
pending state and wall/monotonic deadlines are checked before signing the exact
UTF-8 version 2 login text defined in the shared contract, binding challenge ID,
nonce, phone ID, expiry, username, service name and pending-session identifier.
The prefix is `NEARKEY-LOGIN-V2`; enrollment retains `NEARKEY-ENROLL-V1`.
Proof exists before the final write ACK. GATT reads support offsets and MTU-1 slices, including an empty terminal
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

`EnrollmentQrTest` checks valid setup links, malformed encodings, unexpected or
duplicate fields, unsafe origins and debug-only HTTP. `ProtocolTest` exercises
domain texts, challenge/request rejection, setup/expiry, chunk bounds and
long-read slices. It also produces ephemeral **JVM** P-256
vectors; `tools/check-contract.mjs` verifies them with Node against the actual
shared module. These tests do not exercise AndroidKeyStore, Bluetooth,
permissions, lifecycle on a physical phone, or the sibling server end-to-end.

**Manual hardware gate:** install the APK on a peripheral-
capable phone and use Mac Chromium. Verify first chooser permission, remembered
reconnect and chooser fallback, dashboard locked before verification, one login
completion only, wrong phone/nonce/session context rejection,
long proof reads at default MTU, disconnect/retry, cancel/logout/expiry, app
background/channel-loss cleanup, permission denial, disabled radio and a phone
without peripheral support. Also check QR camera capture, cancellation, Camera
permission denial/manual fallback, and explicit enrollment after scan or adb
prefill. Server API/replay/session tests run separately.
Installing or launching the APK does not establish that Bluetooth verification works.
