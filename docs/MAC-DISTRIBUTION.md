# SideRelay for macOS

## Build from source

Use an Apple silicon Mac running macOS 15 or later with Xcode, Python 3, Git, and a current stable Rust toolchain. The engine build also needs OpenSSL and `pkg-config`. The following commands assume a Bash shell and an existing clone of this repository.

```bash
bash moteur/construire.sh
bash Interface/construire.sh
open SideRelay.app
```

The engine script applies the SideRelay patches to pinned versions of JAS and isideload. It needs GitHub CLI (`gh`) signed in to download the web assets from the [upstream JAS build](https://github.com/jkcoxson/jas/actions/runs/40165852055). If that artifact expires, build the upstream web assets with `cargo leptos build --release` in a checkout of the JAS revision linked below and put its `target/site` directory under `moteur/target/` before running the script. The `SideRelay.app` built from source uses the files in the checkout, so open it from that directory.

## Install the standalone app

Download the DMG from [GitHub Releases](https://github.com/arkemys-consulting/SideRelay/releases/latest). Open it, drag **SideRelay.app** to **Applications**, and open it from there. The app supports Apple silicon Macs running macOS 15 or later and includes the signing engine, local portal, Python runtime and pairing helper. The DMG contains an ad hoc signed app without Apple notarization. If macOS reports that it can’t verify the developer, see [Apple’s first-launch instructions](https://support.apple.com/en-us/102445).

Connect and unlock your iPhone. SideRelay recommends a pairing method based on the connections it finds. Use the same local network for Bonjour, or connect both devices to the same Tailscale network. Your Mac can connect to the router by Ethernet. Installing the optional iPhone companion currently requires full Xcode and Tailscale; the standard iPhone setup can install a separate app without either when both devices share a local network. A free Apple developer account cannot refresh over cellular alone.

SideRelay keeps its data in `~/Library/Application Support/SideRelay/donnees`. The packaged app starts its own local service. Quit any previous source development service before opening it. A source checkout keeps its own data; the package does not automatically copy or replace it. The package does not include the experimental MDM server.

## Build the archive

After building the engine, set `SIDERELAY_PYTHON_ROOT` to a relocatable macOS arm64 CPython distribution, such as the installation directory containing the executable returned by `uv python find --managed-python` (two levels up). An existing compatible pairing helper can be provided through `SIDERELAY_PAIR_BINARY`.

```bash
SIDERELAY_PACKAGE_FORMAT=dmg bash Interface/paquet-mac.sh
```

The DMG contains **SideRelay.app** and a shortcut to **Applications**. The script defaults to ZIP when `SIDERELAY_PACKAGE_FORMAT` is unset.

When publishing a stable macOS release, attach both the DMG and the generated `siderelay-macos-update.json` to the matching `v<version>` GitHub release. Mark it as the latest release. SideRelay uses the manifest if the GitHub API is rate-limited and verifies the DMG before opening it.

The `.local.zip` build uses an ad hoc signature and is for local testing. For a distribution ZIP, also set `SIDERELAY_DEVELOPER_ID` to the full Developer ID Application identity and `SIDERELAY_NOTARY_PROFILE` to an existing notarytool Keychain profile. The build signs the app and its executables, submits the ZIP to Apple, staples the ticket to the app, and checks it with Gatekeeper before exporting.

## Third-party components

SideRelay’s original code is licensed under 0BSD. The Mac package includes its license in `Contents/Resources/Notices/SideRelay-0BSD.txt`.

- [Python](https://www.python.org/) is distributed under the Python Software Foundation and other applicable licenses included with the runtime.
- JAS provides the local signing engine and requires written permission from its author for commercial use. [JAS license terms](https://github.com/jkcoxson/jas/blob/cf709e4a5fb298a20cb595e0d5f1f263e4c82bef/README.md#license)
- The signing engine uses isideload under the MIT license. The license is included in the Mac package. [isideload license](licenses/isideload-MIT.txt)
- [LiveContainer](https://github.com/LiveContainer/LiveContainer) powers the optional iPhone companion. [TVContainer](https://github.com/hubzzzgr/TVContainer) powers the Apple TV companion. Both are AGPL-3.0. See the [Apple TV setup guide](APPLE-TV.md).
