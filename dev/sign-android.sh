#!/usr/bin/env bash
# Signs the unsigned Android APK from the release workflow with the Icebox release key, on your
# own computer, so the key never goes near GitHub. See docs/dev/android-release.md.
#
#   dev/sign-android.sh <Icebox_X.Y.Z_android-beta_unsigned.apk> <keystore.jks> [key alias]
#
# Writes Icebox_X.Y.Z_android-beta.apk next to the unsigned one and prints its SHA-256 and the
# signing certificate's fingerprint (which must match the one published in the README).
# apksigner asks for the keystore password itself; it's never on the command line or in history.
set -euo pipefail

unsigned="${1:?usage: dev/sign-android.sh <unsigned.apk> <keystore.jks> [alias]}"
keystore="${2:?usage: dev/sign-android.sh <unsigned.apk> <keystore.jks> [alias]}"
alias="${3:-icebox}"

[ -f "$unsigned" ] || { echo "no such file: $unsigned" >&2; exit 1; }
[ -f "$keystore" ] || { echo "no such keystore: $keystore" >&2; exit 1; }
case "$unsigned" in
  *_unsigned.apk) ;;
  *) echo "expected the workflow's ..._unsigned.apk" >&2; exit 1 ;;
esac

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -n "$sdk" ] || { echo "set ANDROID_HOME to your Android SDK folder" >&2; exit 1; }
latest="$(ls "$sdk/build-tools" | sort -V | tail -n1)"
tools="$sdk/build-tools/$latest"
zipalign="$tools/zipalign"; [ -e "$zipalign" ] || zipalign="$tools/zipalign.exe"
apksigner="$tools/apksigner"; [ -e "$apksigner" ] || apksigner="$tools/apksigner.bat"
echo "Using Android build-tools $latest"

dir="$(dirname "$unsigned")"
# If the workflow's checksum file is beside the APK, make sure this is the file it built.
if [ -f "$dir/SHA256SUMS-unsigned" ]; then
  (cd "$dir" && sha256sum -c --ignore-missing SHA256SUMS-unsigned)
else
  echo "Note: SHA256SUMS-unsigned isn't next to the APK, so its checksum wasn't checked."
fi

out="${unsigned%_unsigned.apk}.apk"
aligned="$(mktemp "${TMPDIR:-/tmp}/icebox-aligned.XXXXXX.apk")"
trap 'rm -f "$aligned"' EXIT

# Gradle's release APK is normally aligned already; align it if not. -P 16 also aligns native
# libraries for phones with 16 KB memory pages (needs build-tools 35 or newer).
if "$zipalign" -c -P 16 4 "$unsigned" >/dev/null 2>&1; then
  cp "$unsigned" "$aligned"
else
  "$zipalign" -f -P 16 4 "$unsigned" "$aligned" 2>/dev/null || "$zipalign" -f 4 "$unsigned" "$aligned"
fi

"$apksigner" sign --ks "$keystore" --ks-key-alias "$alias" --out "$out" "$aligned"
rm -f "$out.idsig"

echo
echo "Signed: $out"
"$apksigner" verify --print-certs "$out" | grep -E "Signer #1 certificate (DN|SHA-256)"
echo
sha256sum "$out"
echo
echo "Check the certificate SHA-256 above matches the one in the README before uploading."
