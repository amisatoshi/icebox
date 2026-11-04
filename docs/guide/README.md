# Icebox user guide

Icebox is an open-source desktop wallet for [Frostsnap](https://frostsnap.com) devices, for
Windows, macOS and Linux. This guide walks through every screen, from installing it to sending
your first payment.

> **Icebox is early, unaudited, independent software.** It is not made or endorsed by Frostsnap.
> Start on **Signet** (free test coins), and keep mainnet amounts small until you trust it.

This guide matches **Icebox 0.3**. If your version is different, check the guide in that
release's tag on GitHub.

## Contents

1. [Install Icebox](01-install.md): Windows, macOS, Linux, checking downloads, and running unsigned builds
2. [Try demo mode](02-demo-mode.md): every screen, no devices needed
3. [Devices](03-devices.md): plugging in, firmware, nonces, erasing
4. [Create a wallet](04-create-wallet.md): names, threshold, the check code, backups
5. [Receive bitcoin](05-receive.md): fresh addresses, checking on a device, the address list
6. [Send bitcoin](06-send.md): fees, signing one device at a time, broadcasting
7. [Restore a wallet](07-restore.md): from devices, one at a time if they're in different places, including wallets made in the official app
8. [Backups](08-backups.md): writing them down, showing them again, checking them
9. [Wallet details and export](09-details-and-export.md): descriptor, Sparrow, BTCPay Server, removing a wallet
10. [Settings and shortcuts](10-settings.md): Electrum servers, your own node, data folder, keyboard
11. [Updating](11-updating.md): new Icebox versions, device firmware, uninstalling
12. [Troubleshooting](12-troubleshooting.md): common messages and what to do
13. [FAQ](faq.md)

## Quick start

1. [Install Icebox](01-install.md), then close the official Frostsnap app if it's open (both want
   the USB port).
2. No devices yet? Choose **Help → Try demo mode** and click around.
3. Plug in your Frostsnap devices. Click **+ New wallet**, choose **Signet**, name each device,
   pick how many must sign (2 of 3 is a good start) and click **Create keys**.
4. Check every device shows the same code, then **back up each device** on its own screen.
5. **Receive**: get an address, click **Check on a device**, and compare.
6. **Send**: enter the address, amount and fee, then approve on each device and **Broadcast**.

## Five rules that keep your coins safe

1. **Trust the device screen, not the computer screen.** Malware can change what your computer
   shows. It can't change what a Frostsnap shows.
2. **Check every receive address on a device** before you give it to anyone.
3. **Check the amount and address on each device** before you approve a payment.
4. **Write down every device's backup words**, and keep each set with or near its device. Never
   type them into a computer, a phone or a website. Icebox never asks for them.
5. **Keep enough devices.** With 2 of 3, you can lose one device and still spend. Lose two and
   the coins are gone, unless you have their backups.

## Words used in this guide

| Word | Meaning |
|------|---------|
| **Device** | One Frostsnap. Each holds one *share* of a wallet's key. |
| **Share** | One device's part of the key. No single share can spend. |
| **Threshold** | How many devices must sign to spend, e.g. "2 to sign". |
| **Signet** | A Bitcoin test network. Its coins are free and worthless, so mistakes cost nothing. |
| **Mainnet** | The real Bitcoin network, with real money. |
| **Nonce** | A single-use number a device needs for each signature. Icebox tops them up for you. |
| **Descriptor** | A public description of the wallet that lets other software *watch* it. It can't spend. |
| **Electrum server** | The server Icebox asks about the blockchain (balances, history, broadcasting). |

## Help and feedback

- Found a bug, or something in this guide is wrong? [Open an issue](https://github.com/amisatoshi/icebox/issues).
- Questions and ideas: [Discussions](https://github.com/amisatoshi/icebox/discussions).
- Security problems: please follow [SECURITY.md](../../SECURITY.md) and report privately.

Screenshots in this guide come from demo mode. The devices are called Alpha, Bravo and
Charlie, and the wallet is "Cold storage". When you name your own devices, neutral names like
these are a good idea: avoid names that say who holds a device or where it's kept.
