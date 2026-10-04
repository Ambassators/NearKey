# NearKey — passive phone-key demo

A fictional bank transfer protected by a registered Android phone key. This is a
hackathon demo, not production banking software or proof of physical proximity.

## Demo scope

- Mac Chromium browser; native Android app kept open; Bluetooth already enabled.
- Password login, one-time phone enrollment and browser Bluetooth permission.
- Server-initiated, 60-second challenges. The phone automatically advertises and
  signs the server nonce; the browser relays the proof over the logged-in session.
- Single-use, session-bound challenges with immutable transfer details.
- No background push, biometrics, phone approval, transaction limits or simulator.

The server stores everything in memory. Restarting clears the account, enrolled
phone, sessions and transfer ledger. Automatic signatures prove key possession,
not transaction consent; BLE does not prevent relays or prove distance. Phone
keys are non-exportable in AndroidKeyStore; hardware backing is not guaranteed.

## Run the server and browser

Requires Node 22+:

```sh
npm ci
npm start
```

Local browser: <http://localhost:5173>. Demo credentials: `demo` /
`demo-passive-key`. The server listens on `127.0.0.1:5173` by default. `HOST`,
`PORT`, `PUBLIC_ORIGIN`, `DEMO_USERNAME` and `DEMO_PASSWORD` are environment
variables; `.env` files are not automatically loaded.

For a phone demo, put the server behind a trusted HTTPS reverse proxy that also
forwards WebSocket upgrades, and open that **same public origin** on the Mac:

```sh
PUBLIC_ORIGIN=https://demo.example.com DEMO_PASSWORD='choose-a-demo-password' npm start
```

`PUBLIC_ORIGIN` must be the exact origin, without a path or trailing slash.
Forward HTTPS/WSS to `127.0.0.1:5173`. Configure the origin explicitly: the server
does not trust forwarded headers. Use a trusted certificate; do not bypass TLS
verification. `localhost` on the Android phone means the phone, not the server.

## Build the phone app

See [android/README.md](android/README.md) for the existing Android SDK and JDK
requirements. From `android/`:

```sh
./gradlew --no-daemon :app:assembleDebug
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`. Install it on a physical
Android phone with BLE peripheral/advertising support.

## Demo walkthrough

1. Open the bank page in Mac Chromium and sign in.
2. Create an enrollment code. Enter the server origin and code in the Android app;
   tap **Enroll phone**. Keep the app visible and online.
3. Tap **Advertise setup for 60 seconds** on the phone. Grant Nearby devices
   permissions, then use the browser's Bluetooth chooser to select the phone.
   Setup advertising cannot sign transaction requests.
4. Submit a fictional transfer. The page shows **Waiting for Bluetooth handshake**.
   The server sends the challenge to the phone, which advertises and acknowledges
   readiness; the browser connects, obtains the signed nonce and submits it.
5. Successful verification executes the transfer once and updates the balance and
   ledger. An offline phone, denied permission or expired challenge fails visibly.

Remembered reconnection is attempted when Chromium exposes `getDevices()` and
retains permission. Otherwise the page offers a user-gesture chooser fallback;
first-time permission does not guarantee silent reconnection in every browser.

## Existing checks

```sh
npm test
cd android
./gradlew --no-daemon :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
node tools/check-contract.mjs
```

Run the cross-language contract check **after** the Android unit tests, which
produce its vectors. Browser Bluetooth checks are mocks; the JVM tests are not
AndroidKeyStore or radio tests. A successful physical Mac-to-Android transaction
remains the final demo gate.

[shared/PROTOCOL.md](shared/PROTOCOL.md) defines the signing payload and BLE
framing. Background wake, explicit phone approval and configurable transaction
limits remain stretch goals, not implemented features.
