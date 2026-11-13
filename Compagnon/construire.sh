#!/bin/bash
set -euo pipefail
script_directory=$(cd "$(dirname "$0")" && pwd -P)
commit=$1
workspace=$2
[[ "$commit" =~ ^[a-f0-9]{40}$ ]]
source="$workspace/upstream"
git init -q "$source"
git -C "$source" remote add origin https://github.com/LiveContainer/LiveContainer.git
git -C "$source" fetch --quiet --depth 1 origin "$commit"
git -C "$source" checkout --quiet --detach FETCH_HEAD
git -C "$source" submodule update --init --recursive --depth 1 --jobs 3
git -C "$source" apply --check "$script_directory/LiveContainer.patch"
git -C "$source" apply "$script_directory/LiveContainer.patch"
cp "$script_directory/SideRelayView.swift" "$source/LiveContainerSwiftUI/Views/SideRelayView.swift"
# Generate both icon names used by the upstream app from the shared Mac artwork.
xcrun --sdk macosx swiftc "$script_directory/../Interface/Logo.swift" "$script_directory/Icone.swift" \
    -o "$workspace/icone-siderelay"
"$workspace/icone-siderelay" "$workspace/SideRelayIcon.png" 1024
"$workspace/icone-siderelay" "$source/Resources/AppIconGrey60x60@2x.png" 120
"$workspace/icone-siderelay" "$source/Resources/AppIconGrey76x76@2x~ipad.png" 152
python3 -B - "$source/Resources" "$workspace/SideRelayIcon.png" <<'PY'
from pathlib import Path
import json
import shutil
import sys

resources = Path(sys.argv[1])
icon = Path(sys.argv[2])
for name in ('AppIcon', 'AppIconGrey'):
    iconset = resources / 'Assets.xcassets' / f'{name}.appiconset'
    for old_icon in iconset.glob('*.png'):
        old_icon.unlink()
    shutil.copyfile(icon, iconset / icon.name)
    # iOS derives appearance variants from the universal SideRelay artwork.
    (iconset / 'Contents.json').write_text(json.dumps({
        'images': [{'filename': icon.name, 'idiom': 'universal', 'platform': 'ios', 'size': '1024x1024'}],
        'info': {'author': 'xcode', 'version': 1},
    }))
for directory in resources.rglob('*.lproj'):
    if directory.name not in ('en.lproj', 'Base.lproj'):
        shutil.rmtree(directory)
for catalogue in resources.rglob('*.xcstrings'):
    document = json.loads(catalogue.read_text())
    for entry in document['strings'].values():
        if 'localizations' in entry:
            entry['localizations'] = {k: v for k, v in entry['localizations'].items() if k == 'en'}
    catalogue.write_text(json.dumps(document, ensure_ascii=False))
PY
xcodebuild archive -project "$source/LiveContainer.xcodeproj" -scheme LiveContainer \
    -configuration Release -destination 'generic/platform=iOS' -archivePath "$workspace/SideRelay.xcarchive" \
    -derivedDataPath "$workspace/derived" -clonedSourcePackagesDirPath "$workspace/packages"
app="$workspace/SideRelay.xcarchive/Products/Applications/LiveContainer.app"
[[ -d "$app/Frameworks/LiveContainerSwiftUI.framework" ]]
/usr/bin/plutil -replace CFBundleDevelopmentRegion -string en "$app/Info.plist"
/usr/bin/plutil -replace CFBundleLocalizations -json '["en"]' "$app/Info.plist"
cp "$script_directory/../Interface/StoreSources.json" "$script_directory/../Interface/Store2026.json" "$app/"
# Match the standalone product layout of the official release.
if [[ -d "$app/Frameworks/SideStoreSupport.framework" ]]; then
    mv "$app/Frameworks/SideStoreSupport.framework" "$workspace/SideStoreSupport.framework"
fi
cp "$source/LICENSE" "$app/LiveContainer-LICENSE.txt"
