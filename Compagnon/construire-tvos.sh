#!/bin/bash
set -euo pipefail

scripts="$(cd "$(dirname "$0")" && pwd -P)"
source="$(cd "${1:?TVContainer 1.0 checkout required}" && pwd -P)"
output="${2:?Absolute IPA output path required}"
address="${3:?SideRelay Tailscale HTTPS address required}"
device="${4:?SideRelay Apple TV device ID required}"
build="${SIDERELAY_TVOS_BUILD:-11}"
commit=ffa3d5aeef32cdc9c8ee1de3d898307c5166eac5
[[ "$output" == /* && ! -e "$output" && "$(git -C "$source" rev-parse HEAD)" == "$commit" ]]
command -v xcodegen >/dev/null
cd "$source"

cp "$scripts/SideRelayTV.swift" "$scripts/SideRelayTVStore.swift" "$scripts/SideRelayTVImport.swift" TVContainer/UI/
python3 -B - "$build" <<'PYTHON'
from pathlib import Path
import sys

def edit(path, replacements):
    path = Path(path)
    content = path.read_text()
    for old, new in replacements:
        if content.count(old) != 1:
            raise SystemExit(f"Unexpected TVContainer source in {path}")
        content = content.replace(old, new)
    path.write_text(content)

build = int(sys.argv[1])
if build <= 7:
    raise SystemExit("The companion build must be newer than TVContainer 1.0.")
edit("project.yml", [
    ("CFBundleVersion: '7'", f"CFBundleVersion: '{build}'"),
    ("PRODUCT_BUNDLE_IDENTIFIER: com.kdt.tvcontainer\n", "PRODUCT_BUNDLE_IDENTIFIER: com.hubzzzgr.tvcontainer\n"),
])
edit("TVContainer/UI/TVHomeView.swift", [
    ("@State private var selectedTab = 0", '@SceneStorage("SideRelayTVTab") private var selectedTab = 3'),
    ("            TVInstallView(url:", '''            SideRelayTVView().tabItem { Label("Signatures", systemImage: "checkmark.shield") }.tag(3)
            SideRelayTVStoreView().tabItem { Label("Store", systemImage: "bag") }.tag(4)
            TVInstallView(url:'''),
    ('Text("TVContainer").font(.largeTitle.bold())\n                            Text("LiveContainer port for Apple TV").foregroundStyle(.secondary)', 'Text("TVContainer").font(.largeTitle.bold())'),
    ("        .onOpenURL { url in", '''        .task { importSideRelayIdentity() }
        .onOpenURL { url in
            if url.scheme == "tvcontainer", url.host == "siderelay-import" {
                importSideRelayIdentity()
                library.importPairedIPA(url)
                return
            }
            if url.scheme == "tvcontainer", url.host == "siderelay-store" {
                selectedTab = 4
                return
            }
            if url.scheme == "tvcontainer", url.host == "siderelay-setup" {
                importSideRelayIdentity()
                return
            }'''),
    ("\n}\n\nstruct TVAppsView", '''

    private func importSideRelayIdentity() {
        if SideRelayTVSetup.importSigningIdentity() { library.reload() }
    }
}

struct TVAppsView'''),
])
PYTHON

mkdir -p build/ModuleCache
xcrun swiftc -module-cache-path "$source/build/ModuleCache" "$scripts/../Interface/Logo.swift" "$scripts/Icone.swift" -o build/siderelay-icon
build/siderelay-icon TVContainer/Artwork/TVContainerIcon.jpg 1280 768
bash scripts/generate_project.sh
xcodebuild archive -project TVContainer.xcodeproj -scheme TVContainer -destination 'generic/platform=tvOS' \
    -derivedDataPath "$source/build/DerivedData" -archivePath "$source/build/TVContainer.xcarchive" \
    -configuration Release CODE_SIGNING_ALLOWED=NO
app="$source/build/TVContainer.xcarchive/Products/Applications/TVContainer.app"
python3 -B tests/validate_bundle.py "$app"

mkdir -p build/package/Payload
ditto "$app" build/package/Payload/TVContainer.app
cp LICENSE build/package/Payload/TVContainer.app/TVContainer-LICENSE.txt
cp "$scripts/../LICENSE" build/package/Payload/TVContainer.app/SideRelay-LICENSE.txt
python3 -B - "$scripts" "$address" "$device" "$commit" <<'PYTHON'
import hashlib
from pathlib import Path
import plistlib
import sys
from urllib.parse import urlsplit
from uuid import UUID

scripts, address, device, commit = sys.argv[1:]
url = urlsplit(address)
if (url.scheme != "https" or url.port not in {19445, 19447} or not (url.hostname or "").endswith(".ts.net")
        or url.username or url.password or url.path or url.query or url.fragment):
    raise SystemExit("Invalid SideRelay HTTPS address.")
path = Path("build/package/Payload/TVContainer.app/Info.plist")
info = plistlib.loads(path.read_bytes())
if info["CFBundleIdentifier"] != "com.hubzzzgr.tvcontainer" or info["CFBundleSupportedPlatforms"] != ["AppleTVOS"]:
    raise SystemExit("The archive is not the SideRelay Apple TV companion.")
revision = hashlib.sha256()
for name in ("construire-tvos.sh", "SideRelayTV.swift", "SideRelayTVStore.swift", "SideRelayTVImport.swift", "Icone.swift", "../Interface/Logo.swift"):
    revision.update((Path(scripts) / name).read_bytes())
info["CFBundleDisplayName"] = "SideRelay"
info["SideRelayConnection"] = {"address": address, "deviceID": str(UUID(device)),
                               "revision": f"{commit}-{revision.hexdigest()[:16]}", "certificateSetup": "paired-v1",
                               "pairedImport": 1}
path.write_bytes(plistlib.dumps(info, fmt=plistlib.FMT_BINARY))
PYTHON
(cd build/package && /usr/bin/zip -qry "$output" Payload)
printf '%s\n' "$output"
