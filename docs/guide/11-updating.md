# 11. Updating

[← Settings](10-settings.md) · [Contents](README.md) · Next: [Troubleshooting →](12-troubleshooting.md)

There are two things to keep up to date: **Icebox** on your computer, and the **firmware** on
your Frostsnap devices.

## Finding out about new versions

Icebox doesn't check for updates by itself: it never contacts anything except your Electrum
server. To hear about new versions:

- On GitHub, open the [Icebox repository](https://github.com/amisatoshi/icebox), click
  **Watch → Custom → Releases**, then **Apply**. GitHub emails you when a version is published.
- Or check the [Releases page](https://github.com/amisatoshi/icebox/releases) from time to time.
- Your version is shown in **Help → About Icebox**.

Each release lists its changes in the release notes and in the
[changelog](../../CHANGELOG.md). Read them before updating, especially anything under
**Security** or marked as a breaking change.

## Updating Icebox

1. **Finish or cancel payments in progress** (Send tab). They're kept across updates, but it's
   simplest to start a new version with nothing half-signed.
2. **Quit Icebox** (File → Quit Icebox).
3. **Optional but sensible: back up the data folder** (shown in Settings and on the
   [Settings page](10-settings.md#data-folder) of this guide). Copy it somewhere safe. It holds no
   private keys, but it saves resyncing and keeps your list of handed-out addresses.
4. Download the new installer from [Releases](https://github.com/amisatoshi/icebox/releases)
   and [check it](01-install.md#check-the-download-recommended).
5. Install it over the old version:
   - **Windows:** run the new `.msi`. It replaces the old version.
   - **macOS:** drag the new Icebox into Applications and choose **Replace**. You may need to
     approve it again under [Privacy & Security](01-install.md#macos).
   - **Linux:** install the new `.deb`/`.rpm` the same way as before (it upgrades in place), or
     replace the old AppImage file with the new one.
6. Open Icebox and check **Help → About Icebox** shows the new version.

**Your wallets stay put.** They live in the data folder, not in the app, so updating doesn't
touch them. If something looks wrong after an update, your coins are still safe on the
devices: you can always [restore from devices](07-restore.md).

**Going back to an older version** isn't recommended: a newer version may have updated the
database in a way the older one doesn't understand. If you must, restore the data-folder copy
from step 3 as well.

## Updating device firmware

Icebox can't update device firmware yet (it's on the [roadmap](../../ROADMAP.md)). Use the
**official Frostsnap app**:

1. Quit Icebox, so the official app can use the devices.
2. Open the official Frostsnap app and follow its firmware-update prompts. Each device shows the
   update and asks you to confirm on its screen. Devices only accept firmware signed by
   Frostsnap.
3. Quit the official app and open Icebox again.

**Check compatibility first.** Each Icebox version is built for a particular Frostsnap version,
shown in **Help → About Icebox** as "Device firmware it expects". If you update the devices to
newer firmware than that, Icebox shows a ⚠ firmware warning (see
[Devices → Firmware](03-devices.md#firmware)) and may not work with them until a matching Icebox
release comes out. The Icebox release notes say when a new Frostsnap version is supported.

Updating firmware doesn't touch the wallet shares or backups on the devices.

## Uninstalling

- **Windows:** Settings → Apps → Installed apps → Icebox → Uninstall.
- **macOS:** drag Icebox from Applications to the Bin.
- **Linux:** `sudo apt remove icebox` / `sudo dnf remove icebox`, or delete the AppImage.

Uninstalling leaves the data folder in place, so reinstalling picks up where you left off.
Delete the data folder too if you want to remove every trace. That only forgets the wallets on
this computer; the devices keep their shares.

[← Settings](10-settings.md) · [Contents](README.md) · Next: [Troubleshooting →](12-troubleshooting.md)
