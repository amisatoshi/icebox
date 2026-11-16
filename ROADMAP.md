# Icebox roadmap

What's planned, roughly in order. Nothing here is a promise of dates; priorities move with what
testers and users ask for. Ideas and votes are welcome in Discussions.

## In testing

- **Restore from devices**: rebuild a wallet (including ones made in the official app) by
  plugging in its devices
- **Demo mode**: try everything with simulated devices
- Menu bar, About page, firmware check, erase device
- Transaction links to mempool.space from the history page
- Check a backup on the device; all receive addresses with "used" marks; descriptor QR code
- BTCPay Server export (`xpub…-[taproot]`); macOS builds
- **Restore one device at a time**: saved restores you can continue later, at other places
- **Watch-only wallets** from an Icebox watch-only code (QR or text); **webcam QR scanning**
  (Windows and macOS); opt-in **Check for updates**

## Next

- **Prices**: an opt-in "Fetch prices" setting (mempool.space for GBP, USD, EUR, AUD and more;
  MYR via the European Central Bank's daily rates), or prices typed in by hand for any currency
- **Coin control and labels**: choose and freeze coins; label addresses and transactions;
  import/export labels in the BIP-329 format other wallets use
- **Block-explorer links**: open any transaction on mempool.space (in testing); next, a setting to
  use your own mempool instance instead
- **CSV export**: transactions with dates, amounts, fees and labels, plus an optional fiat value
  in your chosen currency at the time of each transaction, for accounting

## Planned

- **Zakat helper**: balance on a chosen date against a nisab you set, with 2.5% worked out
  (you choose the rules; Icebox does the maths)
- **Inheritance kit**: printable letter of instruction (never containing backup words) and
  reminders to check each device's backup
- **Fee bumping**: "speed up" stuck payments (RBF / CPFP)
- **Watch any descriptor**: watch-only wallets from other apps' descriptors (e.g. Sparrow), if
  there's demand (needs a second wallet engine alongside Frostsnap's)
- **Webcam scanning on Linux**
- **Treasury mode** for organisations: device owners and locations, approval history, audit report
- **Privacy**: Electrum over Tor, trust a self-signed certificate on your own node, optional
  fiat prices from a source you choose
- **PSBT import/export**
- **Restore from written-down backup words**
- **Firmware upgrades from Icebox**, using the official coordinator's upgrade protocol and the
  official signed firmware (devices only accept firmware signed by Frostsnap)
- **Code-signed Windows installer and signed, notarised macOS app**

## Exploring

- **Shared Nostr identity**: a Nostr account whose key is split across devices (e.g. 2 of 3
  people must approve a post), with Icebox acting as a NIP-46 remote signer. The Frostsnap
  protocol supports Nostr keys, but devices need an approval screen for Nostr events first;
  this depends on Frostsnap firmware.
- **Arabic and right-to-left support**, then other languages
- **Command-line tool** built on `icebox-core`
- **Android** version
