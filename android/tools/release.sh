#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
: "${JAVA_HOME:=$(/usr/libexec/java_home -v 17)}"
: "${ANDROID_HOME:?Set ANDROID_HOME to your Android SDK}"
: "${NEARKEY_SIGNING_DIR:=$HOME/.local/share/nearkey/signing}"
export JAVA_HOME
tools="$ANDROID_HOME/build-tools/37.0.0"
test -f "$NEARKEY_SIGNING_DIR/release.jks"
test -f "$NEARKEY_SIGNING_DIR/store-password"
cd "$project_dir/android"
./gradlew --console=plain --no-daemon :app:assembleRelease
mkdir -p "$project_dir/public/downloads"
"$tools/zipalign" -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk app/build/outputs/apk/release/nearkey-aligned.apk
"$tools/apksigner" sign --v4-signing-enabled false --ks "$NEARKEY_SIGNING_DIR/release.jks" --ks-key-alias nearkey --ks-pass "file:$NEARKEY_SIGNING_DIR/store-password" --out "$project_dir/public/downloads/nearkey.apk" app/build/outputs/apk/release/nearkey-aligned.apk
"$tools/apksigner" verify --verbose "$project_dir/public/downloads/nearkey.apk"
