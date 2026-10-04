# NearKey Android authenticator

Native Kotlin app with background Bluetooth verification for **Bluetooth login verification**, implementing
[`shared/PROTOCOL.md`](../shared/PROTOCOL.md) version 2. A connected-device foreground service owns the authenticated website
channels and Bluetooth peripheral. No Compose, phone confirmation, biometrics,
simulator or manual proof path.

## Phone screens

The phone opens a three-step setup wizard: introduction, scan/review a website,
and enable Bluetooth. **Connect website** saves the enrollment; **Connect Bluetooth & finish**
requests Nearby devices access and starts setup advertising. Once advertising has
actually started and the website's authenticated phone channel is online, the app
opens **Your websites** automatically. Browser selection and login verification
still finish in the browser. A website that is paired but has unfinished Bluetooth
setup resumes the last step when the app is reopened.

The list shows all enrolled website origins and their live connection status.
The full-width **Add website** button at the bottom opens setup for another website. Each
origin keeps its own credential and authenticated channel; adding a website
preserves existing registrations. The demo server still supports one account and
one phone per server instance. Dashboard app metadata does not create a phone
registration for a third-party website.

Tap a website for connection retry, Bluetooth setup, connection details, or
**Forget website**. Forgetting removes only that origin's local credential; its
server registration still needs an offline reset before pairing again. The phone
key is retained while any registrations remain. Existing single-server app
credentials migrate into the list on upgrade. Pairing codes stay in memory.

After Bluetooth permission is granted, the service keeps channels and Bluetooth
available when the UI is backgrounded, closed or removed from Recents and when the
screen is locked/off. Concurrent login
requests from different origins use the Bluetooth peripheral one at a time and
keep their original server deadlines.

## Background and screen-off operation

Open NearKey once after installing/upgrading, with saved websites and Nearby
devices permission granted. The service shows **NearKey is running** and starts
automatically after initial Bluetooth setup. Notification permission is requested
on Android 13+; denying it does not disable the service, but hides its notification
from the notification drawer (Android still lists active foreground apps).

After setup, use the **Verify with the screen off** prompt, or tap a website →
**Background settings** → **Open battery settings**. Find NearKey and choose
**Don't optimize**/**Unrestricted**, depending on the phone. Without this setting,
Android Doze can suspend the WebSocket network channel even with a foreground
service. Some manufacturers also require allowing autostart/background activity
in their own battery settings. Bluetooth and the phone's internet or local Wi-Fi
connection must remain available.

A partial wake lock keeps the CPU available for WebSocket and GATT callbacks
without keeping the screen lit; it is released when the service stops. Continuous
availability uses extra battery. Challenge expiry is scheduled only while work
is pending; UI countdown/shake detection stops when the screen leaves the app.

**Pause** in the running notification stops background verification until NearKey
is reopened. Reopening resumes it. The service asks Android to restart it after
process reclamation and resumes saved, completed setups after reboot (once the
phone is unlocked) or an app upgrade. These restarts are best effort under Android
and manufacturer restrictions. A powered-off phone cannot run the app;
force-stopping it or using Android's active-app **Stop** requires reopening NearKey.
Resetting the demo or forgetting the last website stops the service and Bluetooth.

`AuthenticatorLifetimeTest` covers screen lock/task removal, reopening, rotation,
repeated service starts, foreground-only setup and service restart ownership.
Protocol validation, signing text, stale callback checks, server deadlines, and
cancellation/channel-loss proof cleanup remain in force in the background.

Manual phone verification after installing the APK:

1. Finish enrollment and Bluetooth setup, allow notifications and remove battery
   optimization. Verify the running notification appears.
2. Press Home, start a browser login and complete real Bluetooth verification.
   Repeat after locking the phone and after removing NearKey from Recents.
3. Leave the phone unplugged and idle long enough for Doze (or force Doze with
   Android debug tools), then repeat a fresh login with the screen still off.
   Check both network and Bluetooth; a wake lock alone does not exempt networking.
4. Cancel and expire pending logins with the screen off; old BLE requests/proofs
   must fail. Disconnect Wi-Fi/server, restore it, and verify a fresh challenge.
5. Reboot/unlock and test a new login before opening NearKey. Repeat after an app
   upgrade without clearing enrollment. Check reopening after process reclamation
   does not create duplicate authenticated channels or GATT peripherals.
6. Pause from the notification and verify background requests stop; reopen to
   resume. Reset the demo/forget the last website and check the notification,
   sockets, Bluetooth and wake lock all stop. Force-stop requires reopening.

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
server origin and code; review them and tap **Connect website** to submit enrollment.

## Demo setup

For Wi-Fi debug setup, run `npm run start:wifi` on the computer and connect the
phone to the same Wi-Fi network before scanning the QR. Keep the Mac browser at
`http://localhost:5173`; the QR supplies the computer's private network address
to the phone. Local-address HTTP and WebSocket traffic uses the phone's Wi-Fi
network even when Android selects cellular for internet access. No USB forwarding
is needed. Guest Wi-Fi can block connections between devices; use a shared
hotspot if the phone cannot reach the computer. The app reports missing Wi-Fi
before sending enrollment and reconnects enrolled websites after Wi-Fi returns.

1. Use the USB debug workflow above or deploy the server at a reachable HTTPS
   origin with a trusted certificate. The setup QR carries that origin; manual
   entry takes the origin, not a path.
   Without adb reverse, `localhost` means the phone itself. Release requires HTTPS;
   TLS trust and hostname checks remain enabled. The app has no preset server URL.
2. Start a pending password login in Mac Chromium and create enrollment. Tap
   **Scan setup QR code** in the app and scan the browser's QR. Review the server
   address; no code entry is needed. **Enter details manually** opens the optional
   pairing-code and server-origin fields. Tap
   **Connect website**. The P-256 private key lives in
   AndroidKeyStore, non-exportable, without user-authentication requirements.
   Hardware backing is best effort, reported from KeyInfo, never guaranteed.
   Enrollment sends DER SPKI and DER SHA256withECDSA proof with unpadded base64url.
   The returned phone token lives in app-private preferences; backup is disabled.
3. Complete initial setup with the phone app visible. Bluetooth must already be enabled. Tap
   **Connect Bluetooth & finish**, granting Nearby devices permissions if
   prompted, then explicitly click the browser's first-time Bluetooth chooser.
   Setup mode advertises the service UUID plus the phone's configured Bluetooth
   name in a separate scan response, so the browser chooser shows a recognizable
   phone instead of “Unknown or Unsupported Device.” It **cannot sign**.
   Device names must fit the 29-byte UTF-8 name field; the app shows a specific
   error if the name is empty or too long. It never changes the phone's name.
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
use when **Connect website** is tapped. Scanning does not authorize a login or skip
Bluetooth verification.

The scanner runs locally using ZXing and requests Camera permission when opened.
Manual entry remains available if camera access is denied or unavailable.

The request buffer is bounded at 1024 bytes. ID, nonce, version, type, server
pending state and wall/monotonic deadlines are checked before signing the exact
UTF-8 version 2 login text defined in the shared contract, binding challenge ID,
nonce, phone ID, expiry, username, service name and pending-session identifier.
The prefix is `NEARKEY-LOGIN-V2`; enrollment retains `NEARKEY-ENROLL-V1`.
Proof exists before the final write ACK. GATT reads return the remaining proof at each offset, including an empty terminal
read. Android's ATT stack clips packets to the actual negotiated MTU, avoiding a stale app-side MTU on reused links.
The service keeps one GATT service and advertisement available between
logins so Android does not replace the private BLE address remembered by the
browser. The browser also retains its successful GATT link while the page stays
open, reusing it for fresh challenges and disconnecting on page teardown.
Idle advertising cannot sign. Only one central is accepted. Disconnect
clears buffers/proof. Cancel, expiry and channel loss immediately discard the
pending signing challenge and its proof; each new challenge retains its own
original wall-clock and monotonic deadline. Repeated readiness requests do not
extend that deadline. Losing every website connection, local reset or stopping the runtime
closes GATT/advertising. Leaving the UI preserves service-owned connections. A new browser page still needs explicit phone
selection when its browser does not support the permitted-device API.

Reconnect uses bounded exponential delay while the runtime is active and accepts only live
challenges resent by the authenticated server. Old socket and HTTP callbacks
cannot mutate a new channel/session. Radio/permission/peripheral failures are
shown, never silently toggle Bluetooth. Open a website’s **Bluetooth setup** after enabling Bluetooth or granting
permissions; use **Retry website connection** after a network failure. Keep the phone clock synchronized with the server; the app rejects
expired challenges or challenges appearing more than 60 seconds in the future.

## Reset and verification boundaries

Shake the phone while NearKey is open to reveal a circular **reset demo** overlay
in the top-right corner of any screen. The button stays visible across screen changes and rotation. Tap it and
confirm to stop Bluetooth and website connections, erase every local registration
and the phone key, and return to the first setup screen. It is disabled while
enrollment is in progress. This resets the phone only; reset server pairing
offline before enrolling again. A single bump or ordinary motion does not reveal
the button, and shake detection stops while the app is paused.

The demo server preserves phone registration in its private pairing file across
restarts; sign-in sessions and temporary challenges reset. Open the app once after upgrading to enable background verification
using the saved registration. **Forget website**
erases that website’s local token, not the server’s registration. The key is
erased only after the last website is forgotten. Existing phone
replacement is never automatic. Coordinate an explicit offline reset of the server's pairing file and
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
background/screen-off continuity and channel-loss cleanup, permission denial, disabled radio and a phone
without peripheral support. Also check QR camera capture, cancellation, Camera
permission denial/manual fallback, and explicit enrollment after scan or adb
prefill. Server API/replay/session tests run separately.
Installing or launching the APK does not establish that Bluetooth verification works.
Also verify shaking reveals **reset demo** on setup and website screens, cancelling
keeps registrations, and confirming returns to setup with no connections remaining.
