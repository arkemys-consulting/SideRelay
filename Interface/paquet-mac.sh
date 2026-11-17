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
format="${SIDERELAY_PACKAGE_FORMAT:-zip}"
case "$format" in
    dmg) archive="$sortie/SideRelay-$version-macOS-arm64.dmg" ;;
    zip) archive="$sortie/SideRelay-$version-macOS-arm64$suffixe.zip" ;;
    *) echo "Set SIDERELAY_PACKAGE_FORMAT to zip or dmg." >&2; exit 1 ;;
esac
[[ ! -e "$archive" ]] || { echo "Archive already exists: $archive" >&2; exit 1; }
dossier="$(mktemp -d "${SIGNATURE_IOS_TMP:-${TMPDIR:-/tmp}}/siderelay-release.XXXXXX")"
trap 'rm -rf "$dossier"' EXIT
app="$dossier/SideRelay.app"
SIDERELAY_BUNDLE_RUNTIME=1 SIDERELAY_OUTPUT_APP="$app" bash Interface/construire.sh
if [[ -z "$suffixe" ]]; then
    /usr/bin/ditto -c -k --keepParent "$app" "$dossier/SideRelay-notary.zip"
    xcrun notarytool submit "$dossier/SideRelay-notary.zip" --keychain-profile "$SIDERELAY_NOTARY_PROFILE" --wait --output-format json > "$dossier/notary.json"
    python3 -B -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r.get("status"), r.get("id")); sys.exit(r.get("status") != "Accepted")' "$dossier/notary.json"
    xcrun stapler staple "$app"
    xcrun stapler validate "$app"
    codesign --verify --deep --strict "$app"
    /usr/sbin/spctl --assess --type execute "$app"
fi
if [[ "$format" == dmg ]]; then
    mkdir "$dossier/image"
    mv "$app" "$dossier/image/"
    ln -s /Applications "$dossier/image/Applications"
    /usr/bin/hdiutil create -volname SideRelay -srcfolder "$dossier/image" -format UDZO "$dossier/SideRelay.dmg"
    python3 -B - "$dossier/SideRelay.dmg" "$version" "$dossier/siderelay-macos-update.json" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

image, version, manifest = sys.argv[1:]
filename = f"SideRelay-{version}-macOS-arm64.dmg"
digest = hashlib.sha256()
with open(image, "rb") as file:
    for chunk in iter(lambda: file.read(1024 * 1024), b""):
        digest.update(chunk)
release = {
    "tag_name": f"v{version}",
    "draft": False,
    "prerelease": False,
    "assets": [{
        "name": filename,
        "browser_download_url": f"https://github.com/arkemys-consulting/SideRelay/releases/download/v{version}/{filename}",
        "size": Path(image).stat().st_size,
        "digest": f"sha256:{digest.hexdigest()}",
    }],
}
Path(manifest).write_text(json.dumps([release], indent=2) + "\n", encoding="utf-8")
PY
    mv "$dossier/SideRelay.dmg" "$archive"
    mv "$dossier/siderelay-macos-update.json" "$sortie/"
else
    /usr/bin/ditto -c -k --keepParent "$app" "$dossier/SideRelay.zip"
    mv "$dossier/SideRelay.zip" "$archive"
fi
printf 'Mac package: %s\n' "$archive"
