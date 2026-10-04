# NearKey for iPhone

Native SwiftUI companion for the existing NearKey v2 server and Mac Chromium
Bluetooth flow. Requires a physical iPhone on iOS 17 or later, Bluetooth enabled,
and Developer Mode for development installs. No third-party Swift dependencies.

## Run on your iPhone

Open `NearKey.xcodeproj` in Xcode. Select your Apple development team under
Signing & Capabilities, select your connected iPhone, and run the `NearKey`
scheme. The included project currently selects the local developer's Personal
Team; change it when building under a different Apple account. A Personal Team
development installation expires after seven days and must be rebuilt/reinstalled.

After the first Xcode account setup, connect and unlock one iPhone and run
`./ios/tools/install.sh` from the repository root to build, install, and open it
in one command. Pass a phone UDID if multiple iPhones are connected. Enable
Developer Mode and trust the development app in iPhone Settings when Apple asks.

For the local demo, run `npm run start:wifi` from the repository root. Put the
Mac and iPhone on the same Wi-Fi. Open `http://localhost:5173/#/login` in Mac
Chromium, sign in with the README's demo account, and keep its setup page open.
The QR contains the Mac's LAN origin, not localhost. iPhone does not use Android's
`adb reverse` USB forwarding.

1. In NearKey on the iPhone, tap **Connect your first website → Scan setup QR code**.
2. Review the website address and tap **Connect website**. Allow camera,
   Local Network, and Bluetooth access when prompted. Manual origin/code entry
   and `nearkey://enroll` camera links are also supported.
3. Keep NearKey open. In Mac Chromium, select **NearKey iPhone** in the Bluetooth
   chooser and continue verification. The iPhone signs only a live challenge
   received over its authenticated website connection.

The app supports up to 30 independent website registrations sharing the phone
signing key. Enrollment codes remain in memory and are cleared after enrollment
or cancellation. Device connection tokens and the Secure Enclave's opaque key
representation are stored in Keychain with `WhenUnlockedThisDeviceOnly` access.
An existing enrolled key is never silently replaced. Debug builds allow HTTP
only for private/local origins; release builds require HTTPS and retain normal
certificate verification. Authenticated requests do not follow redirects.

## iPhone lifecycle

Keep NearKey in the foreground during sign-in. The screen stays awake while the
app is open with an enrolled website, then returns to the normal system behavior
when you leave. When the app goes into the background it closes phone channels,
discards challenges and proof, and stops advertising; reopening reconnects.

iOS background peripheral advertising moves service UUIDs into an overflow area,
which is not discoverable by the Mac Chromium flow. iOS also suspends persistent
networking. This version therefore does not promise Android-style screen-off
verification. See Apple's [Core Bluetooth background behavior](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/CoreBluetoothBackgroundProcessingForIOSApps/PerformingTasksWhileYourAppIsInTheBackground.html).

## Build and checks

```sh
swift test --package-path ios
npm test
xcodebuild -project ios/NearKey.xcodeproj -scheme NearKey \
  -configuration Debug -destination 'id=YOUR_IPHONE_UDID' \
  -derivedDataPath ios/build -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration build
xcrun devicectl device install app --device YOUR_IPHONE_UDID \
  ios/build/Build/Products/Debug-iphoneos/NearKey.app
xcrun devicectl device process launch --device YOUR_IPHONE_UDID \
  dev.nearkey.authenticator.ios
```

Core tests exercise QR and origin validation, bounded Bluetooth frames,
challenge identity/context/expiry, and actual CryptoKit P-256 SPKI and DER ECDSA
signature interoperability against the repository's Node verifier and browser
proof parser. Simulator signing uses a test-only software key; physical iPhones
require the Secure Enclave. Tests cannot establish physical Bluetooth behavior;
complete a real Mac-to-iPhone login to validate the radio path.

## Troubleshooting

- **Localhost QR:** use the Wi-Fi server command and its new QR; localhost on
  iPhone refers to the phone itself.
- **Cannot reach website:** check both devices' Wi-Fi, macOS firewall rules,
  iPhone Local Network permission, and whether the server's LAN address changed.
- **App won't open:** enable Developer Mode under Settings → Privacy & Security,
  restart and confirm; trust the development account under Settings → General →
  VPN & Device Management if iOS asks.
- **Invalid signing entitlements despite a matching profile:** restore Apple Root
  CA and Apple Worldwide Developer Relations certificate trust settings on the
  Mac to **Use System Defaults**, then rebuild. Custom code-signing trust overrides
  can cause signatures to lose their team identifier. See Apple's
  [signing troubleshooting guide](https://developer.apple.com/library/archive/technotes/tn2250/_index.html).
- **Old phone already enrolled:** use **Connect a different phone** from an
  authenticated browser. Installing this app does not bypass the current factor.
- **Phone absent from chooser:** bring NearKey to the foreground, allow Bluetooth,
  then tap Reconnect in the app and select **NearKey iPhone** on the Mac.
