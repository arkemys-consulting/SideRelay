#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
racine="$(pwd -P)"
dossier="$(mktemp -d "${SIGNATURE_IOS_TMP:-${TMPDIR:-/tmp}}/signature-ios-app.XXXXXX")"
nettoyer() {
    python3 -B -c 'import shutil, sys; shutil.rmtree(sys.argv[1])' "$dossier"
}
trap nettoyer EXIT
app="$dossier/SideRelay.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp Interface/Info.plist "$app/Contents/Info.plist"
cp Interface/Comptes.js Interface/Guide.js Interface/IPA.js Interface/Routes.js Interface/Outils.js Interface/Bibliotheque.js Interface/Store.js Interface/LotsIPA.js Interface/Jumelage.js Interface/ArchiveIPA.py Interface/ComposantsIPA.py Interface/ProvisionnementIPA.py "$app/Contents/Resources/"
mkdir "$dossier/SideRelay.iconset" "$dossier/symboles"
xcrun swiftc -swift-version 6 -target arm64-apple-macos15.0 -parse-as-library -O \
    -module-cache-path "$dossier/modules" Interface/Logo.swift Interface/Icone.swift -o "$dossier/icone"
"$dossier/icone" "$dossier/SideRelay.iconset" "$dossier/symboles"
iconutil -c icns "$dossier/SideRelay.iconset" -o "$app/Contents/Resources/SideRelay.icns"
python3 -B - "$dossier" "$app/Contents/Resources/App.css" <<'PYTHON'
from base64 import b64encode
from pathlib import Path
import sys

dossier, sortie = map(Path, sys.argv[1:])
style = Path("Interface/App.css").read_text()
images = {f.stem: f for f in (dossier / "symboles").glob("*.png")}
images["SETUP_MARK"] = dossier / "SideRelay.iconset/icon_128x128.png"
for nom, fichier in images.items():
    style = style.replace("__" + nom + "__", b64encode(fichier.read_bytes()).decode("ascii"))
sortie.write_text(style)
PYTHON
xcrun swiftc -swift-version 6 -target arm64-apple-macos15.0 -parse-as-library -O \
    -module-cache-path "$dossier/modules" Interface/SignatureIOS.swift Interface/Runtime.swift Interface/Jumelage.swift Interface/Decouverte.swift Interface/Trousseau.swift Interface/Certificat.swift Interface/Logo.swift Interface/AtelierIPA.swift Interface/PortableBackup.swift \
    -o "$app/Contents/MacOS/SignatureIOS"
if [[ -n "${SIDERELAY_PAIR_BINARY:-}" ]]; then
    install -m 755 "$SIDERELAY_PAIR_BINARY" "$app/Contents/MacOS/siderelay-pair"
else
    cargo build --release --locked --manifest-path Interface/Jumelage/Cargo.toml --target-dir "$dossier/rust"
    install -m 755 "$dossier/rust/release/siderelay-pair" "$app/Contents/MacOS/siderelay-pair"
fi
xcrun swiftc -swift-version 6 -target arm64-apple-macos15.0 -parse-as-library -O \
    -module-cache-path "$dossier/modules" Interface/IdentiteImportee.swift -o "$app/Contents/MacOS/siderelay-identity"
xcrun clang -target arm64-apple-macos15.0 -fobjc-arc -O2 -framework AppKit \
    Interface/ApercuIconeTV.m -o "$app/Contents/MacOS/siderelay-tv-icon"
identite="${SIDERELAY_DEVELOPER_ID:--}"
signer() {
    if [[ "$identite" == "-" ]]; then
        codesign --force --sign - "$1"
    else
        codesign --force --options runtime --timestamp --sign "$identite" "$1"
    fi
}
if [[ "${SIDERELAY_BUNDLE_RUNTIME:-0}" == "1" ]]; then
    python="${SIDERELAY_PYTHON_ROOT:?Set SIDERELAY_PYTHON_ROOT to a relocatable macOS arm64 CPython installation}"
    [[ -x "$python/bin/python3" && -d "$python/lib" ]] || { echo "Invalid CPython installation" >&2; exit 1; }
    contenu="$app/Contents/Resources"
    runtime="$contenu/Runtime"
    mkdir -p "$runtime/Interface" "$runtime/Compagnon" "$runtime/moteur/target" "$contenu/Python/bin" "$contenu/Notices"
    cp signature-ios LICENSE "$runtime/"
    cp Interface/*.py Interface/Logo.swift Interface/StoreSources.json Interface/Store2026.json Interface/StoreTV.json "$runtime/Interface/"
    cp Compagnon/{construire.sh,construire-tvos.sh,LiveContainer.patch,SideRelayView.swift,SideRelayTV.swift,SideRelayTVStore.swift,SideRelayTVImport.swift,Icone.swift} "$runtime/Compagnon/"
    ditto moteur/target/site "$runtime/moteur/target/site"
    install -m 755 moteur/jas "$app/Contents/MacOS/siderelay-engine"
    ditto "$python/lib" "$contenu/Python/lib"
    install -m 755 "$python/bin/python3" "$contenu/Python/bin/python3"
    /usr/libexec/PlistBuddy -c 'Add :SideRelayBundledRuntime bool true' "$app/Contents/Info.plist"
    find "$contenu/Python" -name __pycache__ -type d -prune -exec rm -rf {} +
    find "$contenu/Python/lib" -name site-packages -type d -prune -exec rm -rf {} +
    find "$contenu/Python/lib" -name LICENSE.txt -path '*/python3.*/LICENSE.txt' -exec cp {} "$contenu/Notices/CPython.txt" \;
    test -s "$contenu/Notices/CPython.txt"
    if [[ -d "$python/licenses" ]]; then ditto "$python/licenses" "$contenu/Notices/Python"; fi
    cp LICENSE "$contenu/Notices/SideRelay-0BSD.txt"
    cp docs/licenses/LiveContainer-AGPL-3.0.txt "$contenu/Notices/"
    cp docs/licenses/isideload-MIT.txt "$contenu/Notices/"
    cp docs/MAC-DISTRIBUTION.md docs/APPLE-TV.md "$contenu/Notices/"
    while IFS= read -r -d '' binaire; do
        signer "$binaire"
    done < <(find "$contenu/Python" -type f \( -name "*.so" -o -name "*.dylib" \) -print0)
    xcrun lipo -verify_arch arm64 "$contenu/Python/bin/python3"
    signer "$contenu/Python/bin/python3"
    signer "$app/Contents/MacOS/siderelay-engine"
    env -i PATH=/usr/bin:/bin "$contenu/Python/bin/python3" -I -B -c "import ssl, sqlite3, plistlib, hashlib, zlib"
fi
signer "$app/Contents/MacOS/siderelay-identity"
signer "$app/Contents/MacOS/siderelay-pair"
signer "$app/Contents/MacOS/siderelay-tv-icon"
plutil -lint "$app/Contents/Info.plist"
signer "$app"
codesign --verify --deep --strict "$app"
sortie="${SIDERELAY_OUTPUT_APP:-$racine/SideRelay.app}"
if [[ -n "${SIDERELAY_OUTPUT_APP:-}" && -e "$sortie" ]]; then
    echo "Output already exists: $sortie" >&2
    exit 1
fi
ditto "$app" "$sortie"
codesign --verify --deep --strict "$sortie"
