# Changelog

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
