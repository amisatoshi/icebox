# 12. Troubleshooting

[← Updating](11-updating.md) · [Contents](README.md) · Next: [FAQ →](faq.md)

## Devices

**No devices appear when I plug one in.**
- Close the **official Frostsnap app**. Only one program can use the devices at a time.
- Try another USB cable. Some cables only carry power, not data.
- **Linux:** install the USB rule (see [Install → Linux](01-install.md#linux-usb-access-for-the-devices)),
  then unplug and replug.
- **Linux: devices only appear after `sudo chmod`, and stop again when replugged.** The rule file
  is named so that it runs too late (the old `99-frostsnap.rules` from Icebox 0.2). Rename it to
  `70-frostsnap.rules`; see [Install → Linux](01-install.md#linux-usb-access-for-the-devices).
- **Linux: check what's happening.** `sudo dmesg | tail` should show `idVendor=303a,
  idProduct=1001` and `ttyACM0` when you plug a device in. If it doesn't, try another cable: some
  only carry power. If it does but Icebox doesn't see it, it's the USB rule.
- Unplug and replug the device, or restart Icebox.

**A device stays on "connecting…".**
Unplug it and plug it back in. In a daisy chain, check the cables between devices.

**A device shows a ⚠ firmware warning.**
See [Devices → Firmware](03-devices.md#firmware). Update it with the official Frostsnap app, or
check for a newer Icebox release.

**"Already holds a wallet. Unplug it to continue, or erase it on the Devices page."**
Each device holds one wallet. To make a new wallet, use blank devices, or
[erase](03-devices.md#erasing-a-device) one you no longer need. Erasing a device that holds a
wallet share can lose coins, so read the warning first.

**Signing stops halfway or a device won't sign.**
The device may have run out of nonces. Go to **Devices → Top up nonces on plugged-in devices**,
then **Continue signing** under **Send → Payments in progress**.

## Creating a wallet

**"Key generation stopped: …"**
A device was unplugged or cancelled during setup. Click **Start again**. Nothing has been saved,
and the devices are still blank.

**A device shows a different check code.**
Click **Cancel**. Something may be interfering with the connection, or with the computer. Try
again, ideally on a different computer.

## Receiving

**The address on the device doesn't match the one on screen.**
**Don't use that address.** Your computer may be compromised. Don't send or receive with it until
you've investigated; use a different, trusted computer.

**"Plug in any device from this wallet to see the address on its screen."**
None of the wallet's devices is plugged in. Plug one in; the address appears on it.

**An incoming payment's amount changed or it disappeared.**
The sender probably replaced it (e.g. to raise the fee). Wait for it to confirm. See
[Receive](05-receive.md#when-the-coins-arrive).

## Sending

**"can't build that payment: …" mentioning insufficient funds**
The amount plus the fee is more than the wallet can spend. Lower the amount, use a lower fee
rate, or tick **Send everything**.

**The payment is refused when broadcasting.**
See [Send → If broadcasting fails](06-send.md#if-broadcasting-fails).

**A payment is stuck unconfirmed for a long time.**
Its fee rate was too low for current demand. Icebox can't speed payments up yet (it's on the
[roadmap](../../ROADMAP.md)). It will usually confirm when the network quietens, or you can use
the official Frostsnap app to bump the fee.

## Connection

**"Electrum: disconnected" or the balance doesn't update.**
- Check your internet connection.
- In [Settings](10-settings.md), click **Reconnect** for that network.
- If you changed servers, check the address starts with `ssl://` or `tcp://` and has a port.
- A server with a self-signed certificate won't work yet. Use `tcp://` on your own network.

**The balance says "syncing…".**
Icebox is still fetching the blockchain. Give it a minute, especially the first time.

## Installing

**Windows says "Windows protected your PC".** Click **More info → Run anyway**. See
[Install](01-install.md#running-unsigned-builds).

**macOS says Icebox "can't be opened".** Use **System Settings → Privacy & Security → Open
Anyway**. See [Install → macOS](01-install.md#macos).

**macOS says Icebox "is damaged and can't be opened".** It isn't damaged. Run
`xattr -dr com.apple.quarantine /Applications/Icebox.app` in Terminal. See
[Install → macOS](01-install.md#macos).

**Linux: the AppImage does nothing when opened.** Make it executable, and on Ubuntu 22.04 or
later install FUSE 2 (`libfuse2`, or `libfuse2t64` on 24.04 and later). See
[Install → Linux](01-install.md#linux).

**"Icebox couldn't start" with a message about the database or data folder.**
Another copy may still be closing, or the data folder isn't writable. Quit Icebox, wait a few
seconds and open it again. If it keeps happening, [open an issue](https://github.com/amisatoshi/icebox/issues)
with the message.

## Still stuck?

[Open an issue](https://github.com/amisatoshi/icebox/issues) with your system (Windows, macOS,
Linux), the details from **Help → About Icebox**, and what you were doing. **Never include backup
words, and don't paste your descriptor or addresses** if the wallet holds real coins.

[← Updating](11-updating.md) · [Contents](README.md) · Next: [FAQ →](faq.md)
