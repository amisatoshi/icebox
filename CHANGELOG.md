# Changelog

All notable changes to Icebox are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break things).

## [Unreleased]

### Added
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

[Unreleased]: https://github.com/OWNER/icebox/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/icebox/releases/tag/v0.1.0
