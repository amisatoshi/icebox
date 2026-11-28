# Changelog

All notable changes to Icebox are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break things).

## [Unreleased]

## [0.5.0] - unreleased

### Added
- **Android (beta).** Icebox runs on Android phones (Android 7+, arm64), talking to Frostsnap
  devices over USB-C through Android's USB host API (a small Kotlin plugin,
  `crates/tauri-plugin-icebox-usb`, hands Rust a file descriptor for `cdc_acm_usb`, as the official
  Android app does). Same version and release as the desktop app; the APK is built and attested by
  the release workflow, unsigned, and signed offline by the maintainer
  (`docs/dev/android-release.md`, `dev/sign-android.sh`). Phone layout: top bar, drawer sidebar,
  two-line history. `versionCode` is `major×10000 + minor×100 + patch` (500), checked by
  `dev/check-versions.py` in CI.
- **Labels** on payments, addresses and coins, edited in place (History, Receive, Coins), plus a
  **Note** on the Send page that becomes the payment's label when signing starts (removed again if
  the payment is cancelled). Stored in Icebox's own `icebox_labels` table; removed with the
  wallet.
- **BIP-329 import and export** of labels (Details → Labels and exports). Every record type is
  kept, including other wallets' `spendable` marks, so a file passes through Icebox unchanged;
  `origin` is written from the wallet's descriptor.
- **Export history as CSV**: UTC date, txid, amount and fee in BTC (exact, no floating point),
  status and label, with spreadsheet-formula guarding on text cells. With prices on, a value
  column at each day's price, from the full price history in one request (never per-payment
  lookups). Files go to Downloads (or the data folder) and are never overwritten.
- **Coins tab**: every coin with its address, amount, confirmations and labels (its own, or the
  payment's or address's), and **Combine chosen coins** into one, signed like a payment
  (`plan_consolidate`). Paying from chosen coins needs `plan_send_from_coins` in
  `frostsnap_coordinator`, proposed upstream.
- **Prices (opt-in)**, Settings → Prices, off by default: GBP, USD, EUR, AUD, CAD, CHF and JPY from
  mempool.space; MYR from the euro price and the ECB's rate (frankfurter.dev); AED, SAR, QAR, BHD
  and OMR from the dollar price and their fixed pegs; or a price typed in for any currency. Shown
  under the balance, on Coins and on Send, for mainnet wallets only. Clicking the balance swaps
  the big figure between BTC and the currency (remembered). Fetched by the window; CSP
  `connect-src` adds `https://mempool.space` and `https://api.frankfurter.dev`.
- **Used with BTCPay Server: watch further ahead** (Details). Reveals receive addresses up to
  100/250/500/1000 past the highest one in use, so the chain client subscribes to them and
  payments after long runs of unpaid invoices aren't missed (the subscription window is otherwise
  50). Icebox's own Receive addresses then start after them. Switching it off doesn't undo
  addresses already marked as handed out; the settings text says so.
- CI builds the Android APK on every pull request.

### Changed
- On phones, the restored-wallet notice is one short line, and each backup row shows its status
  next to the device name with the buttons underneath.
- The address list shows the newest 10 and every used or labelled address when there are more than
  60 (as there are when watching ahead for BTCPay), with **Show all**.
- **Restore all defaults** also switches prices off.

### Fixed
- The Mainnet badge stretched into a tall oval on phones (it shared a class name with the page
  container).

## [0.4.1] - 2026-11-25

### Added
- **Hide amounts.** An eye button next to the balance, View → **Hide or show balances**
  (Ctrl/⌘+B) and a Settings tick box show the balance, incoming amounts and history as `•••••`.
  Stored with Frostsnap's own `hide_balance` setting, so it's remembered. Amounts on the Send page
  stay visible.
- **Logs.** Icebox now writes `logs/icebox.log` in the data folder (as well as the terminal), kept
  to about 5 MB with the previous file as `icebox.log.1`. Help → **Logs** (or Settings → View logs)
  shows the end of it with **Copy** and **Show log file**; the home folder is replaced with `~`.
  Logging now starts once the data folder is known, at the start of `setup`.
- **Restore defaults** for each network's Electrum servers (the official app's defaults, read from
  `frostsnap_coordinator`), and **Restore all defaults**, which also shows amounts again.
- **Erase several devices at once**, in a Danger zone at the bottom of the Devices page (the
  official app keeps its "Erase multiple devices" behind Developer mode). Tick the devices, type
  `ERASE`, then confirm on each device's screen; the page shows which have erased.
- Help menu: **User guide**, **Keyboard shortcuts** (Ctrl/⌘+/), **Check for updates**, **Logs** and
  **Report a bug**. Wallet menu: **Add watch-only wallet**. Help pages open from a fixed list in
  Rust (`help_url`); the page only passes a name.
- Menu icons on Windows and Linux ([Lucide](https://lucide.dev), ISC licence; notice in
  `src-tauri/icons/menu/LICENSE-lucide.txt`). Left off on macOS, where menu bar icons look out of
  place.

### Changed
- "New wallet" is now **New multi-sig wallet**, matching the official app's wording.
- Restore progress reads "2 found · 3 needed to restore" instead of "2 of 3 needed", which looked
  like a 2-of-3 wallet. The text explains that "needed" is the threshold, not the total.
- Settings notes that the default servers are the same as the official app's.

## [0.4.0] - 2026-11-08

### Added
- **Watch-only wallets.** Details → **Show watch-only code** gives a code and QR code
  (`icebox-watch1:…`) that another Icebox adds with **Add watch-only wallet** (paste, scan or open
  a file), to see the wallet's balance, history and receive addresses with no devices. It can't
  spend. Codes carry the wallet's master app key (Frostsnap's wallet engine needs it; a
  descriptor doesn't contain it), the network and the name, with a checksum against typos.
  Saved in Icebox's own `icebox_watch_only` table; the official app ignores it.
- **Webcam QR scanning** on the Send page (addresses and `bitcoin:` links, including the amount)
  and when adding a watch-only wallet. Frames are decoded in Rust with `rqrr`, so there's still
  no third-party JavaScript; the camera is only on while the scan window is open and nothing is
  stored. Windows and macOS (macOS asks permission; `NSCameraUsageDescription` added). Not yet on
  Linux.
- **Check for updates** on the About page: one request to GitHub's public API, only when clicked,
  with a button to open the new release's page (the URL is built and checked in Rust).
  `connect-src` now allows `https://api.github.com` for this.

### Changed
- History explains when an incoming payment was replaced by its sender, and marks payments that
  have waited over two weeks as "may never confirm".
- The Send page shows the minimum amount for the address entered (dust limit), and refuses less
  before building the payment.
- The new-wallet wizard warns when the name is already used by another wallet.

## [0.3.1] - 2026-11-08

### Fixed
- **A restored wallet missed devices that weren't plugged in at the time.** Restoring a 3-of-5
  wallet with three devices left the other two out of Backups, address checks and signing,
  with no way to add them. The Restore page now spots devices holding shares of a wallet that's
  already in Icebox and offers **Add … to *wallet***, using the official `recover_share` (each
  share is checked against the wallet's public key first). The wallet page points out plugged-in
  devices that aren't listed in any wallet.
- **Devices kept showing a tick after a backup was shown or checked.** Icebox now sends the device
  back to its home screen a moment after the backup is confirmed or checked.

### Changed
- Wallets show how many devices Icebox knows as well as how many must sign: "3 of 5 to sign"
  (previously just "3 to sign").
- **Check backup** is described as what it is on current firmware: the device asks for each word
  with three choices and you pick the one on your paper (it doesn't display the words).
- The receive-address list shows each full address on hover.

## [0.3.0] - 2026-11-05

### Added
- **Restore one device at a time** (Restore page): after plugging in a wallet's first device,
  choose **Save and continue later**. The restore is saved in the database using the official
  `frostsnap_core` restoration code, the same way the official app saves it, so the other devices
  can be added later, at other places, even after closing Icebox. Each device is recorded as soon
  as it answers. Unfinished restores are listed in the sidebar and on the Restore page, with
  **Finish restoring** and **Cancel restore**. Only public information is saved: which wallet each
  device holds a share of, and the share's number and public image.
- **User guide** in `docs/guide/`: installing (checking downloads, running unsigned builds on
  Windows, macOS and Linux), demo mode, devices, creating a wallet, receiving, sending, restoring,
  backups, descriptor and BTCPay Server export, settings and shortcuts, updating, troubleshooting
  and an FAQ, with screenshots from demo mode. Linked from the README.

### Changed
- macOS builds are ad-hoc signed (`signingIdentity: "-"`), so macOS shows its normal
  "unidentified developer" prompt instead of saying the app is damaged. The app still isn't
  notarised.
- Demo mode's "older wallet" devices (now Delta and Echo, so they no longer share names with the
  devices you create) are plugged in one at a time, to show restoring across places.

### Fixed
- **Linux: devices weren't usable without `sudo chmod`.** The USB rule was named
  `99-frostsnap.rules`, which runs after systemd applies `uaccess` (`73-seat-late.rules`), so it
  never gave the logged-in user access. It's now `70-frostsnap.rules` (the `.deb` and `.rpm`
  packages replace the old file).
- Demo mode's About page said version 0.1.0.

## [0.2.0] - 2026-11-03

### Security
- eMudhra CA compromise (RUSTSEC-2026-0382): `rustls-webpki` 0.103.16 and `webpki-roots` 1.0.11,
  the same fix as Frostsnap v0.4.1. Electrum `ssl://` connections no longer trust certificate chains
  through the compromised intermediates.

### Added
- Daily check for new Frostsnap releases (`.github/workflows/upstream-watch.yml`), which opens an
  issue so you're emailed; review notes in `upstream/README.md`.
- **BTCPay Server export** (Details tab): the wallet's extended public key in BTCPay's Taproot
  format, `xpub…-[taproot]`, with setup steps and safety notes.
- **macOS builds**: a universal `.dmg` (Apple Silicon and Intel) from the release workflow, a
  macOS compile check in CI, and macOS build instructions.
- **Check a backup** (Backups tab): type the words you wrote down on the device itself, and it
  confirms they match its share. The words never reach the computer. A match marks the device as
  backed up. Uses the official coordinator's check-backup protocol.
- **All receive addresses** (Receive tab): every address handed out, newest first, marked
  "used" once it has received coins, "handed out", or "fresh". Opening a used address warns
  against reusing it.
- **Descriptor QR code** on the Details tab, for scanning into a watch-only wallet.
- Restore from devices: scan every plugged-in device, group shares by wallet, restore in one step.
- Demo mode with simulated devices and test coins (Help → Try demo mode).
- Menu bar with keyboard shortcuts; About page.
- Firmware version per device, with a warning (and explicit opt-in) for older or unrecognised firmware.
- Erase device, confirmed on the device's own screen.
- Single running copy; remembers window size and position.
- Devices show as soon as they announce themselves ("connecting…"), and device events are logged.
- Receive QR codes are `bitcoin:` links, so phone cameras offer to open a wallet app.
- Demo-mode addresses and QR codes are clearly labelled as placeholders and can't be scanned.
- Remove a wallet from Icebox (Details tab, confirmed by typing its name). Only Icebox forgets it;
  the devices keep their shares, so it can be restored later. Cancels its payments in progress.
- Transactions in History link to mempool.space (opens your browser; Icebox builds the link itself).

### Fixed
- "Get another" returned the same address until it received coins. Addresses are now marked as
  handed out when copied, checked on a device, or replaced, as the official app does, so each
  "Get another" is fresh.
- Restored wallets showed every device as "backed up". Backup status is kept by the app that made
  the wallet, not on the devices, so it's now "unknown on this computer", with a notice and a
  "Show backup on device" button for each device. Backed-up devices can show their words again.
- The restore card said "5 of 3 needed" when more devices than needed were plugged in.
- Keyboard shortcuts (Ctrl+N, R, S, D, comma, Q) now work on Windows, where the window swallowed
  the menu's shortcuts. Ctrl+R no longer reloads the page.
- Devices stopped showing a receive address only after clicking Done. Leaving the Receive tab or
  getting another address now clears their screens too.
- The wallet header says "syncing…" instead of "block 0" before the first sync.
- Payments too small to relay ("dust", e.g. under 330 sats to a taproot address) are refused
  before signing, instead of failing at broadcast after every device has signed. Broadcast errors
  from the network are explained in plain words.
- Cancel didn't remove a payment that was already fully signed but not broadcast. It now does,
  and releases its coins and change address.

### Changed
- New wallets use blank devices only, as in the official app, enforced in the core service as
  well as the screen. A device that already holds a wallet shows "Unplug it to continue, or erase
  it". (An experimental option to add test wallets to such devices was tried and removed: the
  device firmware expects one wallet per device and crashed at the end of keygen.)
- Wallets are labelled "2 to sign" rather than "2-of-3".
- Windows builds produce the `.msi` installer only.

## [0.1.0] - 2026-10-13

### Added
- First version: device detection, wallet creation (keygen), backups on device, balance and
  history over Electrum, receive with on-device address check, send with per-device signing and
  broadcast, watch-only descriptor, Electrum server settings.

[Unreleased]: https://github.com/amisatoshi/icebox/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/amisatoshi/icebox/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/amisatoshi/icebox/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/amisatoshi/icebox/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/amisatoshi/icebox/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/amisatoshi/icebox/releases/tag/v0.2.0
[0.1.0]: https://github.com/amisatoshi/icebox/releases/tag/v0.1.0
