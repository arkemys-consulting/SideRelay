# Changelog

## 1.28.8 · 2026-11-17

### Store

- Keep browsing and installing from saved catalogues when a publisher can’t refresh. **Manage Sources** names the affected source, explains the error, and shows how many apps are still available from it.
- SideRelay pauses GitHub source checks when GitHub reaches its request limit and shows when checks can resume. Automatic GitHub catalogue checks now run every four hours. Other sources refresh on their usual schedule.

### Docker

- Store navigation restores the selected tab, category, app page, and scroll position. Vertical gestures over screenshots scroll the page, and horizontal gestures browse the gallery. Screenshot previews use smaller images and show the original when enlarged.

## 1.28.7 · 2026-11-17

### macOS

- Swipe with two fingers to go back or forward within the current section. Page changes use a brief slide and fade, with motion disabled when **Reduce Motion** is on.
- Scroll down over a screenshot gallery to continue reading the app page. A sideways gesture scrolls the gallery.
- Page changes and Store image loads verify the local signing service in the background to keep the window responsive. Previews are smaller, and long lists load in batches and restore your position when you go back.
- Account rows in **Apple Accounts** keep a steady background on hover.

### Store

- A redesigned Store brings **Featured**, **Recently Updated**, categories, and search to both iPhone and iPad and Apple TV. Click a screenshot to enlarge it.
- Expanded the 2026 catalogue with apps such as UTM Remote, GeoLibre, and Saber for iPhone and iPad, plus Spelunkr and Luna for Apple TV.

### Docker

- The Store remembers its tabs, categories, app pages, and scroll position when you go back or forward. Trackpad navigation stays within the current section and uses the same brief transition as the Mac app.
- Vertical scrolling over the gallery continues down the app page. Swipe sideways to browse screenshots. The portal loads smaller previews and fetches the original when you enlarge one.

## 1.28.6 · 2026-11-17

### macOS

- Fixed the “SideRelay service key is missing” signing error in the macOS package. The bundled engine reads the existing private key file. Bundled builds now compile the engine from the current source patches. [#3](https://github.com/arkemys-consulting/SideRelay/issues/3)
- If SideRelay asks you to reconnect after updating, sign in to the same Apple Account to refresh the saved session.

## 1.28.5 · 2026-11-17

### macOS

- Fixed a Library error when an installed build had no update available. Library now shows **Installed** or **Updated** for the current build.

### Docker

- Fixed a Library error when an installed build had no update available. Library now shows **Installed** or **Updated** for the current build.

## 1.28.4 · 2026-11-17

### SideRelay for macOS

- SideRelay checks GitHub for new macOS releases. A native alert offers **Yes** or **No**. Choose **Yes** to download, verify, and open the DMG. **Update Available** at the bottom of the sidebar reopens the alert anytime.

### Apple TV

- **Update** can reuse the current App ID when Top Shelf is the only extension that needs a new one and the account is out of App IDs. If the installed app already runs without Top Shelf, SideRelay prepares the new build the same way and keeps the original IPA in Library. Tested with Quire on Apple TV.

### Docker

- The browser portal checks GitHub for Docker releases and shows **Update Available** at the bottom of the sidebar. The **Yes** action opens the matching release with downloads and installation instructions.
- In Library or the Apple TV Store, choose **Install in TVContainer** to send a compatible IPA to a paired Apple TV through the updated OrbStack helper. The portal waits for the companion to confirm the import.
- Apple TV updates can reuse the installed App ID when the existing app runs without Top Shelf and a new Top Shelf extension would exceed the App ID quota.

## 1.28.3 · 2026-11-17

### TVContainer on macOS

- Install compatible tvOS IPAs in TVContainer directly from SideRelay on your Mac. Open an IPA from **Library** or the **Store**, select **Destination → Install in TVContainer**, and choose your Apple TV.
- SideRelay transfers the IPA over the paired Xcode connection and confirms the import in the Mac window. TVContainer uses its existing signing identity and App ID for the guest. The import was tested with Orbrisa on an Apple TV.
- This requires SideRelay for Apple TV **build 11 or later** and a configured signing identity. Follow the [Apple TV companion setup](docs/APPLE-TV.md#add-the-store-and-tvcontainer-companion).

### Download

- The DMG supports Apple silicon Macs running macOS 15 or later. It is ad hoc signed and distributed without notarization.

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
