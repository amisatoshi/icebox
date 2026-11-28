# Icebox roadmap

What's planned, roughly in order. Nothing here is a promise of dates; priorities move with what
testers and users ask for. Ideas and votes are welcome in Discussions.

## In testing

- Everything up to 0.4.1: restore from devices (all at once or one at a time), demo mode, watch-only
  wallets, webcam QR scanning, BTCPay Server export, hide amounts, logs, erase several devices
- **0.5.0**: Android (beta); labels with BIP-329 import/export; CSV history export; the Coins tab
  and combining chosen coins; opt-in prices; watching further ahead for BTCPay Server

## Next

- **Pay from chosen coins** (full coin control), once `plan_send_from_coins` is in the Frostsnap
  library (proposed upstream); then honouring other wallets' "don't spend" marks
- **Zapstore** listing for the Android app, then F-Droid

## 0.6.0

- **Firmware updates from Icebox**, using the official coordinator's upgrade protocol and the
  official signed firmware (devices only accept firmware signed by Frostsnap)
- **Genuine device check**, Frostsnap's certificate check that a device is a real one
- **PSBT import/export**, for checking or signing payments built elsewhere
- **Trust a self-signed certificate** on your own Electrum server (trust on first use, as the
  official app does)
- **Webcam scanning on Linux**

## 0.7.0

- **Inheritance kit**: a printable letter of instruction (never containing backup words) and
  reminders to check each device's backup

## Later

- **Restore from written-down backup words**
- **Treasury mode** for organisations: device owners and locations, approval history, audit report
- **Block-explorer setting**: open transactions on your own mempool instance
- **Code-signed Windows installer and signed, notarised macOS app**
- Moving to a newer SQLite when the Frostsnap crates do

## Exploring

- **Shared Nostr identity**: a Nostr account whose key is split across devices (e.g. 2 of 3
  people must approve a post), with Icebox acting as a NIP-46 remote signer. The Frostsnap
  protocol supports Nostr keys, but devices need an approval screen for Nostr events first;
  this depends on Frostsnap firmware.
- **Arabic and right-to-left support**, then other languages
- **Command-line tool** built on `icebox-core`
