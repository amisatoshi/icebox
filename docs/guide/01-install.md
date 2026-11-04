# 1. Install Icebox

[← Contents](README.md) · Next: [Try demo mode →](02-demo-mode.md)

## Download

Go to the [Releases page](https://github.com/amisatoshi/icebox/releases) and download the file
for your computer:

| Computer | File | |
|----------|------|---|
| Windows 10/11 | `Icebox_<version>_x64_en-US.msi` | installer with Start-menu entry and uninstaller |
| macOS (Apple Silicon or Intel) | `Icebox_<version>_universal.dmg` | open it and drag Icebox to Applications |
| Linux: Debian, Ubuntu, Mint | `Icebox_<version>_amd64.deb` | also sets up USB access for the devices |
| Linux: Fedora, openSUSE | `Icebox-<version>-1.x86_64.rpm` | also sets up USB access for the devices |
| Linux: any other | `Icebox_<version>_amd64.AppImage` | runs anywhere, but set up USB access yourself (below) |

## Check the download (recommended)

Each release has a `SHA256SUMS` file. Comparing your file against it proves the download wasn't
damaged or swapped.

**Windows** (PowerShell, in your Downloads folder):

```powershell
Get-FileHash .\Icebox_0.3.0_x64_en-US.msi -Algorithm SHA256
```

**macOS / Linux** (Terminal, in the folder with both files):

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing     # macOS
sha256sum -c SHA256SUMS --ignore-missing         # Linux
```

The value must match the line for your file in `SHA256SUMS` exactly. Releases also carry GitHub
build provenance. If you have the [GitHub CLI](https://cli.github.com), this proves the file was
built by this repository's release workflow:

```bash
gh attestation verify Icebox_0.3.0_x64_en-US.msi --repo amisatoshi/icebox
```

## Running unsigned builds

Icebox's installers aren't **code-signed** yet. Code signing is how Windows and macOS recognise
who published an app, and it needs paid or approved certificates; it's on the
[roadmap](../../ROADMAP.md). Until then, your computer warns you the first time you open Icebox.

The warning means "Windows or macOS doesn't know who made this", not "this is harmful". The way
to be sure your copy is genuine is to [check the download](#check-the-download-recommended)
before you open it. Then it's safe to click past the warning.

### Windows

1. **The browser may block the download.** In Edge: **… → Keep → Show more → Keep anyway**. In
   Chrome: **Keep** (or **Download suspicious file**).
2. **"Windows protected your PC"** (SmartScreen) appears when you open the installer. Click
   **More info**, then **Run anyway**.
3. **"Do you want to allow this app… Unknown publisher"** appears. Click **Yes**.

If nothing happens when you open the file, right-click it, choose **Properties**, tick
**Unblock** at the bottom of the General tab, and click **OK**.

You only see these once per version. Some antivirus programs are also wary of new, unsigned
apps; if yours quarantines Icebox, check the download first, then restore it from quarantine.

### macOS

1. Open the `.dmg` and drag **Icebox** into **Applications**.
2. Open Icebox. macOS says it **can't be opened** ("Apple could not verify…"). Click **Done**,
   not Move to Bin.
3. Open **System Settings → Privacy & Security**, scroll down to the message about Icebox, and
   click **Open Anyway**. Enter your password.
4. Open Icebox again and click **Open**. From then on it opens normally.

On macOS 15 (Sequoia) and later, the old shortcut (Control-click → Open) no longer works; use
the steps above. If the **Open Anyway** button isn't there, open Icebox once more and go straight
back to Privacy & Security; it only shows for about an hour after a blocked attempt.

**"Icebox is damaged and can't be opened. You should move it to the Bin."** From version 0.3.0, Icebox
carries an ad-hoc signature that should prevent this. If you do see it (for example with 0.2.0),
the app isn't damaged: macOS is refusing an app with no signature at all. Open **Terminal** and
run:

```bash
xattr -dr com.apple.quarantine /Applications/Icebox.app
```

then open Icebox again. This removes the "downloaded from the internet" flag from Icebox only.

### Linux

Linux doesn't block unsigned apps, so there's no warning, but nothing checks the download for
you either, which makes [checking the download](#check-the-download-recommended) the main
protection.

- **`.deb` / `.rpm`:** install with your software centre, or
  `sudo apt install ./Icebox_0.3.0_amd64.deb` (Debian/Ubuntu) or
  `sudo dnf install ./Icebox-0.3.0-1.x86_64.rpm` (Fedora).
- **AppImage:** make it executable (right-click → **Properties → Allow executing file as
  program**, or `chmod +x Icebox_0.3.0_amd64.AppImage`), then run it.
- **AppImage on Ubuntu 22.04 or later:** AppImages need FUSE 2, which Ubuntu no longer installs.
  If the AppImage does nothing when opened, install it:

  ```bash
  sudo apt install libfuse2      # Ubuntu 22.04
  sudo apt install libfuse2t64   # Ubuntu 24.04 and later
  ```

## Linux: USB access for the devices

The `.deb` and `.rpm` packages set this up for you. With the AppImage, install the rule from the
repository's [`linux/70-frostsnap.rules`](../../linux/70-frostsnap.rules) once:

```bash
sudo wget -O /etc/udev/rules.d/70-frostsnap.rules https://raw.githubusercontent.com/amisatoshi/icebox/main/linux/70-frostsnap.rules
sudo udevadm control --reload && sudo udevadm trigger
```

Then unplug and replug the devices. Without it, Icebox opens but never sees any devices.

To check it worked, plug in a device and run `ls -l /dev/ttyACM*`: the line should end in `+`
(e.g. `crw-rw----+`), meaning your user has access.

**Upgrading from Icebox 0.2?** Its rule was named `99-frostsnap.rules`, which Linux applies too
late, so devices only appeared after a `sudo chmod`. The `.deb` and `.rpm` packages replace it
automatically. If you installed it by hand for the AppImage, rename it:
`sudo mv /etc/udev/rules.d/99-frostsnap.rules /etc/udev/rules.d/70-frostsnap.rules`, then run the
reload command above.

macOS and Windows need no drivers.

## Before you start

- **Close the official Frostsnap app.** Only one program can talk to the devices at a time.
- **Only one copy of Icebox runs at once.** Opening it again brings the existing window forward.
- **Building it yourself** instead? See [Building](../../README.md#building) in the README.

[← Contents](README.md) · Next: [Try demo mode →](02-demo-mode.md)
