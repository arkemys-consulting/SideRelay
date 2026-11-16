# Changelog

## 1.28.2 · 2026-11-16

### macOS

- **First launch** now starts with iPhone pairing. SideRelay highlights the available connection and shows **Continue** once the iPhone is paired. Pairing-file import and refresh testing are available on demand.
- **Window layout** keeps page titles and controls visible below the toolbar after setup. The toolbar uses the native macOS sidebar toggle.

### Docker

- The [Docker release](https://github.com/arkemys-consulting/SideRelay/releases/tag/docker-v1.28.2) adds a browser portal for Linux on amd64 and arm64. Install and renew apps on iPhone and iPad, manage Store sources, and import new IPA builds from the Inbox. Apple TV installs and renewals use Docker on OrbStack with the Mac helper.

### Download

- The standalone DMG supports Apple silicon Macs running macOS 15 or later. The app is ad hoc signed and distributed without notarization.

## 1.28.1 · 2026-11-16

### macOS

- **Overview** keeps device cards compact. Auto-Refresh status sits next to the app count. Open it to see the last renewal, next expiry, and **Check Connection**.
- **Check Connection** returns to its default label after a successful check. If the device is unreachable, SideRelay shows how to reconnect it.

### Store

- The iPhone and iPad Store adds 12 apps to the bundled catalogue and seven publisher sources with IPA releases from 2026, including Fretline and Caffeinate. The new sources are included when building the iPhone companion.
- The Apple TV catalogue grows from 46 to 52 apps, including TypeType, Private IPTV, and tvOS Browser.

### Download

- The standalone DMG supports Apple silicon Macs running macOS 15 or later. The app is ad hoc signed and distributed without notarization.

## 1.28.0 · 2026-11-16

### Auto-Refresh

- **Overview** shows the last successful renewal and next known expiry for each device. Use **Check Connection** to see what needs attention.
- Enable **Signature Expiry Alerts** in the iPhone companion to get a notification before a known signature expires on your iPhone or linked Apple TV. This requires an updated companion.

### Store

- **Get** checks the target device and signing account and suggests a way forward when installation is blocked, such as switching accounts, reusing an eligible App ID, or using LiveContainer when available.
- The Store adds 17 apps to the bundled iOS catalogue and five iOS publisher sources. Seven new tvOS apps bring the Apple TV catalogue to 46 apps. The Mac Store’s Featured carousel uses native scroll momentum.

### macOS

- **Settings → Backup → Back Up or Restore…** creates a password-protected backup of your IPA library, Store sources, and Auto-Refresh preferences. Apple Account credentials and device pairing files stay on the original Mac.
- The privacy mode used during user testing was removed for the public release.

### Download

- The standalone DMG supports Apple silicon Macs running macOS 15 or later. The app is ad hoc signed and distributed without notarization.

## 1.26.0 · 2026-11-15

### Store

- The Mac Store now has dedicated **iPhone & iPad** and **Apple TV** tabs. Search stays within the selected platform, and app details show the correct tvOS requirements.
- The Apple TV catalogue grows from 9 to 26 apps, including Moonfin, Streamyfin, AIOStreams, CloudNow, and Nightfall Sleep. The bundled catalogue is available as soon as the Store opens and refreshes from the publishers’ release feeds.

### macOS

- The sidebar groups **Apps** and **Store** under **Library**, and device, account, activity, and settings views under **Management**.
- Device details have a Back button in the native toolbar, and Activity has a toolbar refresh button. The Overview and Devices lists distinguish Apple TV from other devices.
- Installed apps use aligned rows with signature expiry in a consistent column. Settings groups general preferences, iPhone connection, and IPA updates. Apple Accounts shows connected accounts before the sign-in form.

### Distribution

- Fixed a duplicate dependency override that prevented the signing engine from building from source.
- The standalone Apple silicon DMG supports macOS 15 and later. It is ad hoc signed and does not include Apple notarization.

## 1.25.0 · 2026-11-15

### Apple TV and iPhone

- The SideRelay companion for Apple TV combines TVContainer, signing status, and a built-in Store with nine tvOS sources. The Mac Store has an **Apple TV** category.
- **Apps → Apple TV** on iPhone lets you select a linked Apple TV, check expiry, refresh apps, and send a tvOS IPA from Files. The iPhone shows upload bytes and the Mac’s installation progress.
- Apple TV signing can reuse an eligible active App ID for a new installation. Compatible Top Shelf extensions can use an App Group when Apple includes it in the app and extension profiles.
- Mac lists show icons extracted from the compiled image catalogues inside tvOS IPAs.

### macOS

- Click **Update** on an installed app to install the newer IPA in place. The row shows progress and the result.
- **IPA Inbox** has a dedicated list for dropped builds of apps awaiting their first installation. The Library identifies the platform next to the build number and groups older builds under the app.
- The updated interface uses a collapsible sidebar, compact app rows and a persistent navigation header. Apple Account sign-in supports the SMS verification prompt.

### Distribution

- The Apple silicon DMG includes the app, signing engine, local portal, pairing helper, and Python runtime. The GitHub build is ad hoc signed and not notarized.

## 1.24.0 · 2026-11-15

### Apple TV

- Sign, install, and automatically refresh tvOS IPAs over the local network. Pair the Apple TV in Xcode, then add it from **Devices** in SideRelay. Apple Personal Team limits apply to free accounts.

### App updates and Library

- Drop finished IPAs into the folder selected under **Settings → App Updates**. SideRelay imports them into the Library and offers **Update** on installed apps when it finds a compatible newer version or build.
- The Library labels the matching build **Installed** and groups older builds within the same app card. Remove an unused IPA from its actions menu.
- Installation and update review show progress and completion in the primary button. The action footer stays visible in shorter windows.

### Apple Accounts

- **Manage App IDs** shows the quota Apple reports, registered IDs, expiry dates, and known usage. Review unused IDs for removal or enable automatic cleanup on eligible Personal Teams. Apple may continue to count removed IDs until they expire.
- Signing certificates now use a compact list with certificate details and revocation in the row actions.

### macOS interface

- Click a device card in **Overview** or a row in **Devices** to open its details. **Import Pairing File** opens in a dialog.
- Installed apps show the version, device, signature expiry, and a single primary action. Provisioning profiles and other app actions are available from the row menu.
