# SideRelay on Docker

Run SideRelay on a Linux Docker host with the browser interface shared with the macOS app. Install IPAs, keep signatures current, and manage your library from one place. The image builds the signing engine and portal from source.

## Start the server

On a Linux host with Docker Engine and Compose installed, download `compose.yaml` and the matching image archive from the [Docker release](https://github.com/arkemys-consulting/SideRelay/releases/tag/docker-v1.28.8). Run these commands in the download folder, using the `arm64` filename on ARM64.

```sh
docker load -i SideRelay-Docker-1.28.8-linux-amd64.tar.gz
docker compose up -d --no-build
docker compose ps
```

Open `http://127.0.0.1:18785`. Set `SIDERELAY_PORT` when starting Compose to use a different host port.

From a source checkout, you can build the image instead:

```sh
docker compose up -d --build
```

The first launch generates a portal access key. Read it locally on the Docker host and enter it on the **Sign In to SideRelay** screen:

```sh
docker compose exec -T siderelay cat /var/lib/siderelay-secrets/portal-password
```

Keep this access key private. Use **Sign Out** in the sidebar on a shared browser. Browser sessions expire after 12 hours or when the container restarts.

Compose publishes the portal on loopback. For a remote Docker host, forward the port over SSH and open the same local URL:

```sh
ssh -N -L 18785:127.0.0.1:18785 user@docker-host
```

### Update SideRelay

When a new Docker release is available, SideRelay offers to open it. **Update Available** at the bottom of the sidebar reopens the prompt after you dismiss it. Download the archive for your host and compare its SHA‑256 checksum with `SHA256SUMS` on the release page. Run `docker load -i` with the new archive, then run `docker compose up -d --no-build` from your existing Compose project with the same overrides. This replaces the container and reuses its data and secrets volumes.

## Pair, install, and renew

1. Open **Devices** to discover nearby devices. On Linux, use [idevice_pair](https://github.com/jkcoxson/idevice_pair) to create and save a **Remote Pairing** record. Choose **Import Pairing File…** and select the device or enter its reachable IP address. On OrbStack with the pairing helper, you can also choose **Pair over Wi-Fi…** or **Pair via USB…**.
2. Connect an Apple Account under **Apple Accounts**. Complete Apple's verification prompt if it appears. You can connect multiple accounts and manage their App IDs and signing certificates.
3. In **Apps**, choose or drop an IPA. You can also use **Get** in the Store or select **Install** next to an app from the IPA Inbox. After installation, keep the container running to renew signatures automatically.

Bonjour scanning is enabled by default. On Linux, use host networking if the bridge cannot receive Bonjour traffic from the LAN. In host-network mode, remove the Compose port mapping and set `SIDERELAY_WEB_BIND=127.0.0.1`. Set `SIDERELAY_MDNS=0` in the container to disable its multicast discovery.

For Tailscale, ensure the container can reach the device's Tailscale IP and Remote Pairing port. **Settings → iPhone Connection** determines which available address SideRelay suggests when you add a device.

When you choose an IPA, SideRelay reads the paired iPhone or iPad's OS version over its existing device connection and filters out known incompatible targets. If an offline device's version cannot be read, it remains available for selection.

### Discover devices in OrbStack

In OrbStack, SideRelay can use the Mac's Bonjour and Tailscale discovery. **Devices** scans when it opens, and **Scan Again** refreshes the results. If the Mac helper is unavailable, SideRelay can still scan any Bonjour traffic visible to the container.

From the repository on the Mac, build and run the loopback discovery helper. The helper reads the same Bonjour services and Tailscale device list as the Mac app.

```sh
discovery_dir="$(mktemp -d)"
xcrun swiftc -O -parse-as-library Interface/Decouverte.swift Interface/Jumelage.swift Interface/DecouverteOrbStack.swift -o "$discovery_dir/bonjour"
printf 'SIDERELAY_DISCOVERY_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$discovery_dir/discovery.env"
chmod 600 "$discovery_dir/discovery.env"
python3 -B Interface/DecouverteOrbStack.py --bonjour "$discovery_dir/bonjour" --credentials "$discovery_dir/discovery.env"
```

Keep the helper running. To enable direct USB and Wi-Fi pairing in OrbStack, add `--pair /path/to/SideRelay.app/Contents/MacOS/siderelay-pair` to the helper's command. Use `--portal-port` if the Docker portal uses a different host port. If you change the helper's own `--port`, set the same `SIDERELAY_DISCOVERY_PORT` in the container. In a second terminal, set `SIDERELAY_DISCOVERY_CONFIG` to the path of that `discovery.env` file and start Compose with both files.

When upgrading from a build without portal authentication, rebuild and restart the Mac helper with the same discovery credentials to keep direct pairing working.

```sh
docker compose -f compose.yaml -f compose.orbstack.yaml up -d
```

### Verify and sign IPAs through OrbStack

Start the Mac helper with `--identity-helper /path/to/SideRelay.app/Contents/MacOS/siderelay-identity --signature-work-dir /path/to/private-scratch`. Set `SIDERELAY_HOST_SIGNING=1` when starting the OrbStack Compose override. **IPA Details** then checks the IPA's installed code and profiles with the Mac tools. In **Library**, use the build menu → **Sign with Imported Identity…** to supply a .p12 and provisioning profiles and download a signed copy. The portal only sends the selected files to the configured loopback Mac helper. The helper works in a private temporary directory and deletes the temporary keychain when finished.

### Install and refresh Apple TV apps through OrbStack

1. Keep Xcode installed on the Mac. On the Apple TV, open **Settings → Remotes and Devices → Remote App and Devices** with both devices on the same network. Pair in Xcode if the Apple TV is still awaiting trust.
2. Restart the OrbStack discovery helper with `--apple-tv`. Start Compose with the OrbStack override and `SIDERELAY_HOST_TVOS=1`.
3. Open **Devices**, scan for the Apple TV, and select **Add Apple TV**. For an unpaired Apple TV that CoreDevice discovers, use **Pair Apple TV…** and complete the Apple pairing prompt. Then use **Get** in the Apple TV Store or install a tvOS IPA in **Apps**. Updates and Auto-Refresh use the same Apple Account and stored IPA.

The Docker engine signs the app and manages its job. The authenticated Mac helper uses CoreDevice to deliver the signed app to the Apple TV. Keep the helper running and ensure the Mac can reach the Apple TV so scheduled renewals can complete. A standalone Linux host without the OrbStack helper can download tvOS IPAs from the Store.

To install a guest in TVContainer, restart `Interface/DecouverteOrbStack.py` from this release with `--apple-tv`. Install SideRelay for Apple TV build 11 or later with its signing identity configured, then choose **Destination → Install in TVContainer** from Library or the Apple TV Store. The portal confirms when the companion imports the IPA.

Building the companions and using the macOS menu bar, Dock, or Keychain require the Mac app.

### Serve an existing iPhone companion

On a Linux host with Tailscale, set `SIDERELAY_COMPANION_OWNER` to your Tailscale login and start SideRelay with the companion override:

```sh
docker compose -f compose.yaml -f compose.companion.yaml up -d --build
```

The portal and the companion endpoint listen on host loopback ports 18785 and 19446, respectively. Route the companion's HTTPS address to its endpoint with [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve):

```sh
tailscale serve --bg --https=19445 http://127.0.0.1:19446
```

Use the address configured in the iPhone companion and the existing SideRelay data volume with its matching device registration. The endpoint serves expiry status, refresh requests and Home Screen launchers. Building or updating the companion binary continues to use Xcode. Keep the companion endpoint on loopback so Tailscale Serve is the only network entry point.

Set `SIDERELAY_COMPANION_ADDRESS` to the companion's `https://…ts.net:19445` address to enable **Import into LiveContainer**. Use port `19447` in both Tailscale Serve and that address to run alongside the Mac service. For signature status and refresh on 19447, use a companion build that supports that port and is configured with the Docker instance's address and device ID. Scan the private QR code on the selected Tailscale device to import the IPA into its existing LiveContainer. The link expires in five minutes and serves the selected IPA only to that device.

If the Docker engine can already manage an Apple TV through the Mac helper, set `SIDERELAY_COMPANION_TV_ADDRESSES` to a JSON object mapping each SideRelay Apple TV device ID to its own Tailscale IP address. This enables the paired TV's companion and its controls in the iPhone companion. The device ID and Tailscale address must match the installed companion and the paired Apple TV.

## Manage IPAs

- **Apps → Library** groups builds and identifies installed apps and available updates. Use **Import IPA…** or **More → Import Xcode Build…** to add an existing iPhone or iPad build. Browser folder uploads support regular files.
- **Apps → More → IPA Workshop…** edits app names, Bundle IDs, minimum OS versions, file sharing, device restrictions, and extensions. For iPhone and iPad IPAs you can also replace a PNG or JPEG icon and embed iOS components. Save the result to the library or download the prepared IPA.
- **IPA Details** reads embedded provisioning profiles and checks their App IDs, dates, and registered devices. Enable the Mac helper to verify the code and to sign with a manually imported identity.
- **Batch History** lets you download signed outputs as a ZIP. **Activity** shows install, update, and refresh jobs.
- **Store → More → Manage Sources…** adds compatible HTTPS catalogues.
- SideRelay monitors the `IPA-Inbox` directory in the data volume. New apps appear in their own section in **Apps → Installed**, and new builds can show **Update** on apps already installed. Use **Settings → App Updates → Choose Folder…** to select another accessible folder under `/var/lib/siderelay`.

To use an existing host folder as the inbox, create it first, give the container user (UID 10001) read and directory traversal access, and add this mount alongside the data volume in a Compose override:

```yaml
services:
  siderelay:
    volumes:
      - /path/to/your/IPA-Inbox:/var/lib/siderelay/IPA-Inbox:ro
```

## Data and updates

Use **Settings → Back Up or Restore…** to move IPA builds, Store sources, and auto-refresh preferences with a password-protected `.siderelaybackup` file compatible with the macOS app. Pair devices and reconnect accounts after restoring on a new host.

Docker uses the Apple password and verification code in memory while signing in. It stores the Apple Account address, session, Xcode authorization, and signing data encrypted with AES-256-GCM for unattended refresh. Backups exported from Settings omit Apple sessions and signing keys.

The `siderelay_data` volume holds the database and uploaded IPAs. The separate `siderelay_secrets` volume holds the service encryption key and the portal access key. Upgrading an existing installation moves its current key into the new secrets volume and encrypts its saved account records. Older copies of the data volume are unaffected by the migration.

Preserve both volumes when upgrading. Load the new image and run `docker compose up -d --no-build`, or update your source checkout and run `docker compose up -d --build`. For full-service backups, stop the service and save the data and secrets in separate protected locations. Anyone who administers the Docker host can access both volumes. Keep the portal on loopback and use the SSH tunnel above for remote access.

The engine follows the [JAS license terms](https://github.com/jkcoxson/jas/blob/cf709e4a5fb298a20cb595e0d5f1f263e4c82bef/README.md#license).

## Shared views and platform integrations

| View | Shared workflow |
| --- | --- |
| Setup and Settings | Four-step assistant, Finish Later and Resume, preferred connection, IPA Inbox and encrypted backups. |
| Devices and Overview | Device list, reachability, signature status, Refresh All, and pairing-file import. OrbStack adds discovery and pairing with the Mac helper, including Apple TV with CoreDevice enabled. |
| Apps and Store | Library and versions, IPA Inbox updates, Xcode folder import and drop, IPA Workshop, iPhone and iPad installation, and both Store catalogues. |
| Apple Accounts and Activity | Apple sign-in and verification, App IDs, certificate management, job progress and installation logs. |

The Mac builds companion binaries through Xcode and supplies native window, menu bar, Dock and Keychain integration. In Docker, enable **Settings → Notifications** to receive signature expiry alerts while the portal stays open in a supported desktop browser. The experimental cellular MDM tool is separate from the Docker image.
