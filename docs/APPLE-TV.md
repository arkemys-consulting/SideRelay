# SideRelay on Apple TV

## Install or refresh a separate tvOS app

SideRelay can manage Apple TV apps with the macOS app or with [Docker on OrbStack and the Mac helper](DOCKER.md#install-and-refresh-apple-tv-apps-through-orbstack). The steps below are for the macOS app.

Pair the Apple TV with your Mac in Xcode under **Window → Devices and Simulators**. On the Apple TV, open **Settings → Remotes and Devices → Remote App and Devices** when pairing. Add the paired Apple TV from **Devices** in SideRelay, then drop a tvOS IPA into **Apps** and select the Apple TV and signing account.

Keep the Mac and Apple TV reachable on the same local network for installs and refreshes. Leave **Auto-Refresh** enabled to renew signatures before expiry. [Apple’s wireless pairing guide](https://help.apple.com/xcode/mac/current/en.lproj/devbc48d1bad.html)

## Add the Store and TVContainer companion

This optional setup builds a companion for your own Apple TV. It needs full Xcode, XcodeGen, Git, Python 3, and Tailscale on the Mac and Apple TV under the same Tailscale user. To control the Apple TV from iPhone, also set up the SideRelay iPhone companion on the same tailnet.

Run the commands from a checkout of SideRelay. Set the data path for the app you’re running and list paired Apple TVs to find the SideRelay device ID.

```bash
export SIDERELAY_DATA_DIR="$HOME/Library/Application Support/SideRelay/donnees"
# For SideRelay built from source, use "$PWD/donnees" instead.
sqlite3 -readonly "$SIDERELAY_DATA_DIR/signature.db" \
  "SELECT id, name FROM devices WHERE discovery = 'coredevice-tvos';"
```

Use the ID returned by SideRelay, the Apple TV’s hostname shown in Tailscale, and your Mac’s full Tailscale DNS name.

```bash
tv_id='SIDERELAY_DEVICE_ID'
tv_peer='APPLE_TV_TAILSCALE_HOSTNAME'
mac_endpoint='https://YOUR-MAC.YOUR-TAILNET.ts.net:19445'
tv_work="$(mktemp -d)"

python3 -B -m Interface.CompagnonTV "$SIDERELAY_DATA_DIR" "$tv_id" "$tv_peer"
git init "$tv_work/TVContainer"
git -C "$tv_work/TVContainer" fetch --depth 1 https://github.com/hubzzzgr/TVContainer.git ffa3d5aeef32cdc9c8ee1de3d898307c5166eac5
git -C "$tv_work/TVContainer" checkout --detach FETCH_HEAD
bash Compagnon/construire-tvos.sh "$tv_work/TVContainer" "$tv_work/SideRelayTV.ipa" "$mac_endpoint" "$tv_id"
```

Quit and reopen SideRelay on the Mac so the companion service picks up the Apple TV. Drop the built IPA into **Apps**, install it on the same Apple TV, then set up the signing identity over the paired device channel.

```bash
python3 -B signature-ios livecontainer-setup "$tv_id"
```

On Apple TV, open SideRelay and choose **Store** or **Signatures**. Compatible TVContainer apps can run inside the companion. On the iPhone, **Apps → Apple TV** opens the linked device’s app list and lets you send a tvOS IPA from Files. The Mac signs and installs the uploaded app over its local connection to the Apple TV.
