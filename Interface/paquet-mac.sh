#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
racine="$(pwd -P)"
if [[ -n "${SIDERELAY_DEVELOPER_ID:-}" || -n "${SIDERELAY_NOTARY_PROFILE:-}" ]]; then
    [[ "${SIDERELAY_DEVELOPER_ID:-}" == "Developer ID Application: "* && -n "${SIDERELAY_NOTARY_PROFILE:-}" ]] ||
        { echo "A Developer ID Application identity and a notarytool keychain profile are both required." >&2; exit 1; }
    /usr/bin/security find-identity -v -p codesigning | /usr/bin/grep -F -- "\"$SIDERELAY_DEVELOPER_ID\"" >/dev/null ||
        { echo "The Developer ID Application identity is not available in the signing keychain." >&2; exit 1; }
    suffixe=""
else
    unset SIDERELAY_DEVELOPER_ID SIDERELAY_NOTARY_PROFILE
    suffixe=".local"
fi
version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' Interface/Info.plist)"
sortie="${1:-$racine/dist}"
mkdir -p "$sortie"
sortie="$(cd "$sortie" && pwd -P)"
archive="$sortie/SideRelay-$version-macOS-arm64$suffixe.zip"
[[ ! -e "$archive" ]] || { echo "Archive already exists: $archive" >&2; exit 1; }
dossier="$(mktemp -d "${SIGNATURE_IOS_TMP:-${TMPDIR:-/tmp}}/siderelay-release.XXXXXX")"
trap 'rm -rf "$dossier"' EXIT
app="$dossier/SideRelay.app"
SIDERELAY_BUNDLE_RUNTIME=1 SIDERELAY_OUTPUT_APP="$app" bash Interface/construire.sh
/usr/bin/ditto -c -k --keepParent "$app" "$dossier/SideRelay.zip"
if [[ -z "$suffixe" ]]; then
    xcrun notarytool submit "$dossier/SideRelay.zip" --keychain-profile "$SIDERELAY_NOTARY_PROFILE" --wait --output-format json > "$dossier/notary.json"
    python3 -B -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r.get("status"), r.get("id")); sys.exit(r.get("status") != "Accepted")' "$dossier/notary.json"
    xcrun stapler staple "$app"
    xcrun stapler validate "$app"
    codesign --verify --deep --strict "$app"
    /usr/sbin/spctl --assess --type execute "$app"
    rm "$dossier/SideRelay.zip"
    /usr/bin/ditto -c -k --keepParent "$app" "$dossier/SideRelay.zip"
fi
mv "$dossier/SideRelay.zip" "$archive"
printf 'Mac package: %s\n' "$archive"
