# Icebox roadmap

What's planned, roughly in order. Nothing here is a promise of dates; priorities move with what
testers and users ask for. Ideas and votes are welcome in Discussions.

## In testing

- **Restore from devices**: rebuild a wallet (including ones made in the official app) by
  plugging in its devices
- **Demo mode**: try everything with simulated devices
- Menu bar, About page, firmware check, erase device
- Transaction links to mempool.space from the history page

## Next

- **Watch-only wallets**: add a wallet from its descriptor (paste, file or QR code) to see
  balance and history on a computer that never holds a device. For a treasurer, a family member,
  or your own second computer. Includes exporting a wallet from one Icebox to another as a QR code.
- **Check a backup**: enter the words you wrote down on the device, which confirms they match its
  share, without the words ever reaching the computer (the official coordinator crate already has
  this protocol)
- **Address list**: every receive address with a "used" mark, to discourage address reuse
- **Descriptor as a QR code** on the Details tab, for importing into a watch-only wallet
- **Scan QR codes with the webcam**: pay-to addresses and `bitcoin:` links on the Send page, and
  watch-only descriptors. Decoded in Rust, so no third-party JavaScript; the camera is only on
  while the scan window is open.
- **Coin control and labels**: choose and freeze coins; label addresses and transactions;
  import/export labels in the BIP-329 format other wallets use
- **Block-explorer links**: open any transaction on mempool.space (in testing); next, a setting to
  use your own mempool instance instead
- **CSV export**: transactions with dates, amounts, fees and labels, plus an optional fiat value
  in **GBP, USD or EUR** at the time of each transaction, for accounting

## Planned

- **Zakat helper**: balance on a chosen date against a nisab you set, with 2.5% worked out
  (you choose the rules; Icebox does the maths)
- **Inheritance kit**: printable letter of instruction (never containing backup words) and
  reminders to check each device's backup
- **Fee bumping**: "speed up" stuck payments (RBF / CPFP)
- **Treasury mode** for organisations: device owners and locations, approval history, audit report
- **Privacy**: Electrum over Tor, trust a self-signed certificate on your own node, optional
  fiat prices from a source you choose
- **PSBT import/export**
- **Restore from written-down backup words**
- **Firmware upgrades from Icebox**, using the official coordinator's upgrade protocol and the
  official signed firmware (devices only accept firmware signed by Frostsnap)
- **Code-signed Windows installer**

## Exploring

- **Shared Nostr identity**: a Nostr account whose key is split across devices (e.g. 2 of 3
  people must approve a post), with Icebox acting as a NIP-46 remote signer. The Frostsnap
  protocol supports Nostr keys, but devices need an approval screen for Nostr events first;
  this depends on Frostsnap firmware.
- **Arabic and right-to-left support**, then other languages
- **macOS version**
- **Command-line tool** built on `icebox-core`
- **Android** version
