#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
iphone_id="${1:-}"
if [[ -z "$iphone_id" ]]; then
    devices_file="$(mktemp -t nearkey-devices)"
    trap 'rm -f "$devices_file"' EXIT
    xcrun devicectl list devices --json-output "$devices_file" >/dev/null
    iphone_id="$(python3 - "$devices_file" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1]))['result']['devices']
connected = []
for device in devices:
    properties = device.get('properties', {})
    hardware = properties.get('hardware', device.get('hardwareProperties', {}))
    connection = properties.get('connection', device.get('connectionProperties', {}))
    if hardware.get('deviceType') == 'iPhone' and connection.get('state', connection.get('tunnelState')) == 'connected':
        connected.append(hardware['udid'])
if len(connected) != 1:
    sys.exit('Connect and unlock one iPhone, or pass its UDID as the first argument.')
print(connected[0])
PY
    )"
fi

xcodebuild -project ios/NearKey.xcodeproj -scheme NearKey \
    -configuration Debug -destination "id=$iphone_id" \
    -derivedDataPath ios/build -allowProvisioningUpdates \
    -allowProvisioningDeviceRegistration build
xcrun devicectl device install app --device "$iphone_id" \
    ios/build/Build/Products/Debug-iphoneos/NearKey.app
xcrun devicectl device process launch --device "$iphone_id" \
    dev.nearkey.authenticator.ios
