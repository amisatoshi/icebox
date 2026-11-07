# Changelog

All notable changes to Icebox are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break things).

## [Unreleased]

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

[Unreleased]: https://github.com/amisatoshi/icebox/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/amisatoshi/icebox/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/amisatoshi/icebox/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/amisatoshi/icebox/releases/tag/v0.2.0
[0.1.0]: https://github.com/amisatoshi/icebox/releases/tag/v0.1.0
