# FAQ

[← Troubleshooting](12-troubleshooting.md) · [Contents](README.md)

**What is Icebox, and how is it different from the official Frostsnap app?**
Icebox is an independent, open-source **coordinator**: the program on your computer that talks
to Frostsnap devices, runs key generation and signing, and tracks your wallet. It uses
Frostsnap's own open-source Rust code for all of that, with a different desktop interface and
some extras (demo mode, BTCPay export, an address list). It isn't made or endorsed by Frostsnap.

**Is it safe?**
Your private keys never leave the devices, and every payment must be approved on each device's
own screen. But Icebox is **new and unaudited**. Use Signet first, keep mainnet amounts small,
and read the [security model](../../README.md#security-model-briefly).

**Can Icebox steal my coins?**
Not on its own: spending needs your devices, and each one shows you exactly what it's signing.
That's why checking addresses and amounts on the device screens matters so much.

**Do I need to trust the computer?**
Less than with most wallets. A compromised computer can lie on screen, but it can't make a device
sign something different from what the device shows you. It *can* see your balance and addresses.

**Can I use my wallet in both Icebox and the official app?**
Yes. Wallets made in either can be [restored](07-restore.md) in the other. Just don't run both
at the same time.

**Can one device hold more than one wallet?**
No. As in the official app, each device holds one wallet. Erase a device to reuse it.

**What happens if I lose a device?**
With a 2-of-3 wallet, the other two can still spend. Move the coins to a new wallet (with a new
device) soon, so you're back to being able to lose one. If you lose more devices than that, you'll
need their [backup words](08-backups.md) and the official app to restore them.

**What if someone steals one device?**
One device can't spend from a 2-of-3 wallet. Move your coins to a new wallet promptly anyway.

**Does Icebox ever see my backup words?**
No. They're shown and checked only on the devices. Icebox never asks for them, and nor should
anyone else.

**What are nonces?**
Single-use numbers each device needs for every signature. Icebox tops them up for you. See
[Devices](03-devices.md#nonces-preparing-devices-for-signing).

**Does Icebox send my data anywhere?**
Only to the Electrum server it uses to read the blockchain and broadcast payments. That server
can see which addresses you ask about, so for privacy use [your own node](10-settings.md#use-your-own-node-recommended-for-mainnet).
There are no accounts, analytics or update checks.

**Can I watch my wallet on another computer or phone?**
Yes, with the [watch-only descriptor](09-details-and-export.md#watch-only-descriptor-sparrow-bitcoin-core-and-others)
in Sparrow or Bitcoin Core. Watch-only wallets inside Icebox are coming next.

**Can I use it for a business?**
Yes: [BTCPay Server export](09-details-and-export.md#accept-payments-with-btcpay-server) lets a
shop take payments straight into a multi-device wallet. Treasury features are on the
[roadmap](../../ROADMAP.md).

**How do I update Icebox?**
Install the new version over the old one; your wallets are kept. See [Updating](11-updating.md).

**How do I update device firmware?**
With the official Frostsnap app, for now. See [Updating device firmware](11-updating.md#updating-device-firmware).

**Where do I get Signet coins?**
From a Signet faucet. Search for "signet faucet", paste an Icebox Signet address (starting `tb1`),
and you'll receive free test coins.

**What's coming next?**
Watch-only wallets, webcam QR scanning, coin control and labels, CSV export with GBP/USD/EUR
values, a zakat helper and an inheritance kit. See the [roadmap](../../ROADMAP.md), and vote or
suggest in [Discussions](https://github.com/amisatoshi/icebox/discussions).

**How can I help?**
Try it on Signet and [report what's confusing](https://github.com/amisatoshi/icebox/issues),
improve this guide with a pull request, or see [CONTRIBUTING.md](../../CONTRIBUTING.md).

[← Troubleshooting](12-troubleshooting.md) · [Contents](README.md)
