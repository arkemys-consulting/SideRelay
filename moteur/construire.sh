#!/bin/bash
set -euo pipefail

engine_dir=$(cd "$(dirname "$0")" && pwd -P)
build_dir=$(mktemp -d "${SIGNATURE_IOS_TMP:-${TMPDIR:-/tmp}}/siderelay-engine.XXXXXX")
trap 'python3 -B -c "import shutil, sys; shutil.rmtree(sys.argv[1])" "$build_dir"' EXIT

checkout() {
    local repository=$1 commit=$2 destination=$3
    git init -q "$destination"
    git -C "$destination" fetch -q --depth 1 "$repository" "$commit"
    git -C "$destination" checkout -q --detach FETCH_HEAD
}

checkout https://github.com/jkcoxson/jas.git cf709e4a5fb298a20cb595e0d5f1f263e4c82bef "$build_dir/jas"
checkout https://github.com/nab138/isideload.git 065e852b2092f1386c88195ea3a6506f6b917742 "$build_dir/isideload"

for patch in jas-renouvellement jas-routes-stables jas-certificats jas-renouvellement-wifi \
    jas-usb-atelier jas-catalogue jas-lots jas-admin-tools jas-depannage-profils jas-audit jas-tvos jas-library-removal jas-app-id-cleanup jas-ipa-inbox jas-tvos-app-id-reuse jas-tvos-top-shelf jas-docker-credentials jas-device-versions jas-two-factor jas-engine-access; do
    git -C "$build_dir/jas" apply --index "$engine_dir/$patch.patch"
done

for patch in isideload-certificat-existant isideload-cycle-certificat isideload-tvos isideload-tvos-app-id-reuse isideload-tvos-top-shelf isideload-two-factor isideload-zip; do
    git -C "$build_dir/isideload" apply --index "$engine_dir/$patch.patch"
done

if [[ "${SIDERELAY_BUILD_PORTAL:-0}" == 1 ]]; then
    (cd "$build_dir/jas" && LEPTOS_OUTPUT_NAME=jas SQLX_OFFLINE=true cargo leptos build --release)
    git -C "$build_dir/jas" diff --exit-code -- Cargo.lock
    install -d "$engine_dir/target/site"
    cp -R "$build_dir/jas/target/site/." "$engine_dir/target/site/"
    install -m 644 "$build_dir/jas/README.md" "$engine_dir/target/JAS-README.md"
else
    if [[ ! -d "$engine_dir/target/site" ]]; then
        gh run download 40165852055 --repo jkcoxson/jas --name jas-macOS-ARM64 --dir "$build_dir/upstream"
        mkdir -p "$engine_dir/target"
        cp -R "$build_dir/upstream/target/site" "$engine_dir/target/"
    fi
    # Leptos uses the build-time output name to choose the WebAssembly filename.
    (cd "$build_dir/jas" && LEPTOS_OUTPUT_NAME=jas SQLX_OFFLINE=true cargo build --release --locked --features ssr --no-default-features --bin jas)
fi
if [[ -d "$engine_dir/target/site" ]]; then
    for asset in jas.wasm jas.js jas.css; do
        test -s "$engine_dir/target/site/pkg/$asset"
    done
fi

target_dir=${CARGO_TARGET_DIR:-$build_dir/jas/target}
if [[ "$target_dir" != /* ]]; then
    target_dir="$build_dir/jas/$target_dir"
fi
install -m 755 "$target_dir/release/jas" "$engine_dir/jas"
