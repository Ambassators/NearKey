> **Earlier commit history:** [View the commit logs in the original repository](https://github.com/Quinntyx/nearkey/commits).

# NearKey, a Bluetooth 2FA provider

NearKey is a two-factor authentication provider demo. Its setup wizard guides you through password sign-in, Android phone enrollment and Bluetooth verification. The dashboard then shows your saved app list.

**Continue with Google** is a fake sign-in button that skips the password and opens the same phone enrollment and Bluetooth authentication flow. It does not use Google OAuth. The dashboard opens only after the phone verification succeeds.

A correct password opens a pending login. The provider dashboard and account API stay locked until the phone completes the Bluetooth factor. On the first login, enroll your phone and grant browser Bluetooth permission before verification.

The browser has three pages: `#/login` for password or fake Google sign-in, `#/loading` for phone enrollment and Bluetooth authentication, and `#/dashboard` for the verified account and app list. Refreshing resumes the server-confirmed step; changing the route cannot skip verification.

“Connect a different phone” lets a signed-in demo visitor show a new setup QR without verifying the previous demo phone. Setup hides the shared phone’s device card and uses a generic device label. The old phone stays enrolled until the new phone completes enrollment with a valid key proof; then its credential and other browser sessions are revoked. The new phone must still complete Bluetooth verification before the dashboard opens. This is a shared demo: one visitor replacing the phone interrupts other visitors.

Demo phone setup is enabled by default in the local and hosted entry points. Set `DEMO_PHONE_SETUP=false` to require current-phone verification before replacement. This relaxed setup policy is for demo accounts only.

## Demo scope

- Mac Chromium browser; native Android app with background Bluetooth verification; Bluetooth already enabled.
- One account and one enrolled phone, with one-time enrollment and browser permission.
- Server-initiated, single-use login challenges lasting at most 60 seconds and bound to the original pending session.
- Automatic phone signatures over immutable account, service, phone and session context; browser relays the proof.

Phone pairing survives server restarts. The server saves the enrolled phone's identity, public key and connection credential in `.data/phone.json`; the Android private key remains in AndroidKeyStore. Restarting clears sign-in sessions, saved apps and verification history, so a fresh sign-in still requires both factors. Automatic signatures prove key possession, not user consent; BLE does not prevent relays or prove distance. Phone keys are non-exportable in AndroidKeyStore; hardware backing is not guaranteed.

The default pairing file is relative to the repository, independent of the working directory. `PAIRING_FILE` can select another location. Keep this file private and backed up: it contains the phone connection credential and is excluded from Git. Only run one server against a given pairing file. A corrupt file or a changed account/browser origin stops startup rather than silently forgetting the phone. Pairings created by an older server that only stored them in memory need one final enrollment after upgrading; subsequent restarts preserve them.

For Wi-Fi pairing with the Android **debug** app, run `npm run start:wifi` and keep both devices on the same network. This listens on all interfaces and puts the Mac's private IPv4 address into the setup QR. Keep the Mac browser at `http://localhost:5173` so Bluetooth remains available. Set `PHONE_ORIGIN` to an exact reachable origin if automatic address selection needs an override. Release Android builds require HTTPS.

For a network phone demo, put the server behind a trusted HTTPS reverse proxy that forwards WebSocket upgrades, and open that same public origin on the Mac:

```sh
PUBLIC_ORIGIN=https://demo.example.com DEMO_PASSWORD='choose-a-demo-password' npm start
```

`PUBLIC_ORIGIN` must be the exact origin, without a path or trailing slash. Forward HTTPS/WSS to `127.0.0.1:5173`. Configure the origin explicitly; the server does not trust forwarded headers. Use a trusted certificate. For USB debug testing, run `adb reverse tcp:5173 tcp:5173` and use `http://localhost:5173` on both devices. Without that mapping, `localhost` on Android means the phone itself.

## Deploy the website to Vercel

The included Vercel entry point uses Upstash Redis for sessions, pairing, saved
apps and phone messages across server instances. Import this repository into a new
Vercel project using the Other framework preset and the repository root. The
included [vercel.json](vercel.json) provides the build and routing settings.

Create an Upstash Redis database and set the production environment variables
listed in [.env.example](.env.example): `PUBLIC_ORIGIN`, `DEMO_USERNAME`,
`DEMO_PASSWORD`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and
`NEARKEY_STATE_KEY`. Use the stable HTTPS production origin without a trailing
slash, a new nonempty demo password, and the read-write Redis REST
token. Keep preview deployments on a separate state key.

Connecting Upstash through Vercel's Storage integration supplies `KV_REST_API_URL`
and `KV_REST_API_TOKEN` automatically; the app accepts these in place of the
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` variables.

Deploy after saving the settings, open the production website and enroll the
phone using its new QR code. Local phone pairing is not imported. Hosted sessions
and apps survive deployments; local mode still resets them on restart.

## Build the phone app

The native iPhone app is in [ios/](ios/README.md). It uses the iPhone Secure
Enclave and the same v2 Bluetooth protocol. See its setup guide, or run
`./ios/tools/install.sh` with one unlocked iPhone connected after configuring
your Apple development account in Xcode. Keep NearKey open during iPhone sign-in.

See [android/README.md](android/README.md) for existing SDK and JDK requirements. From `android/`:

```sh
./gradlew --no-daemon :app:assembleDebug
```

Install `android/app/build/outputs/apk/debug/app-debug.apk` on a physical Android phone with BLE peripheral/advertising support. Its launcher name is **NearKey Authenticator**. Install with
`adb install -r android/app/build/outputs/apk/debug/app-debug.apk` from the
repository root, then use `adb reverse tcp:5173 tcp:5173` for USB access to the
local server.

## Demo walkthrough

1. Open NearKey in Mac Chromium and enter the demo credentials. The login awaits Bluetooth verification.
2. On the first login, the page creates a setup QR automatically. Tap **Scan setup QR code** in the Android app and scan the browser's QR. Review the server address, tap **Enroll phone**, and keep the phone online; verification continues in the background after Bluetooth setup. **Enter details manually** opens the optional manual fallback. The code stays valid while the setup page is connected; closing, reloading or leaving the page ends that code.
3. Grant Nearby devices permission on the phone when prompted and select it in the browser's first-time Bluetooth chooser. If the browser asks you to advertise setup before a login challenge starts, tap **Advertise setup for 60 seconds** on the phone. Setup advertising cannot sign login requests.
4. Continue Bluetooth verification. The server sends a login challenge to the phone, which advertises and acknowledges readiness. The browser connects, reads the signed login proof and submits it.
5. After verification, the dashboard opens with your app list. Use **Add app** at the top or the **+** button below the list to save an app name and optional HTTP/HTTPS URL. Log out and sign in again to verify that the Bluetooth factor runs at login.

Saved app entries are account metadata, not live third-party 2FA integrations.
The list starts empty, supports up to 30 entries and persists across logins until
the demo server restarts. Adding an app requires completed Bluetooth
authentication; duplicate name/URL pairs are rejected. No app credentials are
collected and app URLs are not fetched by the server.

Remembered reconnection is attempted when Chromium exposes `getDevices()` and retains permission. Otherwise an explicit chooser gesture is required. Offline phone, denied permission and expired challenges fail visibly; first-time permission does not guarantee silent reconnection in every browser.

The setup QR contains only the phone server origin and a temporary, single-use pairing code. Its lifetime is tied to the setup page's browser connection instead of a countdown. It fills in enrollment details; it does not log you in or replace the Bluetooth factor. Treat the QR like the pairing code and scan it only on the phone you intend to enroll. Replacement-phone codes still expire after five minutes. Wi-Fi mode advertises the Mac's private network address; local USB testing still needs adb reverse.

Android also accepts the setup link from camera or scanner apps that can open
`nearkey://enroll` links. The same validation and **Enroll phone** confirmation
apply. Reviewed QR details survive screen rotation in memory; pairing codes are
not written to saved state or disk.
