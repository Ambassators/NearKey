# NearKey — Bluetooth 2FA provider

NearKey is a two-factor authentication provider demo. Sign in with a password, then verify the login using your enrolled Android phone over Bluetooth. The dashboard shows your authenticator and recent successful verifications.

A correct password opens a pending login. The provider dashboard and account API stay locked until the phone completes the Bluetooth factor. On the first login, enroll your phone and grant browser Bluetooth permission before verification.

## Demo scope

- Mac Chromium browser; foreground native Android app; Bluetooth already enabled.
- One account and one enrolled phone, with one-time enrollment and browser permission.
- Server-initiated, single-use login challenges lasting at most 60 seconds and bound to the original pending session.
- Automatic phone signatures over immutable account, service, phone and session context; browser relays the proof.

This is an in-memory authentication demo. Restarting clears the enrolled phone, sessions and verification history. Automatic signatures prove key possession, not user consent; BLE does not prevent relays or prove distance. Phone keys are non-exportable in AndroidKeyStore; hardware backing is not guaranteed.

## Run the server and browser

Requires Node 22+:

```sh
npm ci
npm start
```

Local browser: <http://localhost:5173>. Demo credentials: `demo` / `demo-passive-key`. The server listens on `127.0.0.1:5173` by default. `HOST`, `PORT`, `PUBLIC_ORIGIN`, `DEMO_USERNAME` and `DEMO_PASSWORD` are environment variables; `.env` files are not automatically loaded.

For a network phone demo, put the server behind a trusted HTTPS reverse proxy that forwards WebSocket upgrades, and open that same public origin on the Mac:

```sh
PUBLIC_ORIGIN=https://demo.example.com DEMO_PASSWORD='choose-a-demo-password' npm start
```

`PUBLIC_ORIGIN` must be the exact origin, without a path or trailing slash. Forward HTTPS/WSS to `127.0.0.1:5173`. Configure the origin explicitly; the server does not trust forwarded headers. Use a trusted certificate. For USB debug testing, [configure adb reverse](android/README.md#usb-debug-workflow) and use `http://localhost:5173` on both devices. Without that mapping, `localhost` on Android means the phone itself.

## Build the phone app

See [android/README.md](android/README.md) for existing SDK and JDK requirements. From `android/`:

```sh
./gradlew --no-daemon :app:assembleDebug
```

Install `android/app/build/outputs/apk/debug/app-debug.apk` on a physical Android phone with BLE peripheral/advertising support. Its launcher name is **NearKey Authenticator**. The [USB debug workflow](android/README.md#usb-debug-workflow) includes installation and local server access.

## Demo walkthrough

1. Open NearKey in Mac Chromium and enter the demo credentials. The login awaits Bluetooth verification.
2. On the first login, create an enrollment code. Tap **Scan setup QR code** in the Android app and scan the browser's QR. Review the server address, tap **Enroll phone**, and keep the app visible and online. **Enter details manually** opens the optional manual fallback.
3. For first-time browser permission, tap **Advertise setup for 60 seconds** on the phone, grant Nearby devices permission, and select the phone in the browser chooser. Setup advertising cannot sign login requests.
4. Continue Bluetooth verification. The server sends a login challenge to the phone, which advertises and acknowledges readiness. The browser connects, reads the signed login proof and submits it.
5. After verification, the provider dashboard opens and records the successful login. Log out and sign in again to verify that the Bluetooth factor runs at login.

Remembered reconnection is attempted when Chromium exposes `getDevices()` and retains permission. Otherwise an explicit chooser gesture is required. Offline phone, denied permission and expired challenges fail visibly; first-time permission does not guarantee silent reconnection in every browser.

The setup QR contains only the server origin and a temporary, single-use pairing code. It fills in enrollment details; it does not log you in or replace the Bluetooth factor. Treat the QR like the pairing code and scan it only on the phone you intend to enroll. The origin must be reachable from the phone; local USB testing still needs adb reverse.

QR encoding runs locally in the browser using the vendored `qrcode-generator`
2.0.4 module; its MIT license is in `web/qrcode-generator-LICENSE.txt`. No external
QR service receives the pairing code.

## Checks

```sh
npm test
cd android
./gradlew --no-daemon :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
node tools/check-contract.mjs
```

Run the cross-language contract check after Android unit tests generate its vectors. Browser Bluetooth tests are mocks; JVM tests do not exercise AndroidKeyStore or radios. A successful physical Mac-to-Android login remains the final demo gate.

[shared/PROTOCOL.md](shared/PROTOCOL.md) defines the version 2 login payload and BLE framing. Background wake and explicit phone approval are not implemented.
