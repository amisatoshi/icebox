# Icebox

[![CI](https://github.com/OWNER/icebox/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/icebox/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/OWNER/icebox/badge)](https://scorecard.dev/viewer/?uri=github.com/OWNER/icebox)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

A self-built desktop wallet for [Frostsnap](https://frostsnap.com) devices, for Windows and Linux.

Icebox is a **third-party coordinator**: it does the job the official Frostsnap app does (talking
to the devices over USB, running the FROST key generation and signing protocol, keeping track of
your Bitcoin wallet), using the official open-source Frostsnap Rust crates underneath. You build it
from source yourself, so you know exactly what is running.

> **Status: early and unaudited.** Use Signet (test coins) until you have walked through creating a
> wallet, receiving and sending yourself. Keep mainnet amounts small until you trust it.

## How it fits together

```
 ┌──────────────── Icebox (one native app) ───────────────────┐
 │  ui/            plain HTML + JS, no npm packages           │
 │     │  Tauri IPC (no network port, no web server)          │
 │  src-tauri/     thin layer: one command per wallet action  │
 │     │                                                      │
 │  crates/icebox-core/   the coordinator service             │
 │     ├─ frostsnap_coordinator  USB, keygen, signing, wallet │
 │     └─ frostsnap_core         FROST protocol               │
 └─────┬───────────────────────────────────────┬──────────────┘
       │ USB serial                            │ Electrum (TLS or your own node)
  Frostsnap devices                       the Bitcoin network
```

- `crates/icebox-core` has no UI dependency. Its `Service` mirrors the official app's coordinator
  (`frostsnapp/rust/src/coordinator.rs`) closely, so behaviour matches and upstream changes are easy
  to follow.
- `src-tauri` starts the service, forwards its events to the window, and exposes each action as a
  command. That's all it does.
- `ui` is three files. No bundler, no `npm install`, no third-party JavaScript.

## Security model, briefly

- **Private keys never touch the computer.** Each device holds one share. Spending needs the
  threshold number of devices, and each device shows the payment on its own screen before it
  signs.
- **Always check on the device.** Check receive addresses on a device ("Check on a device") before
  sharing them. Check the amount and destination on each device screen before approving a signature.
  Malware on a computer can change what the screen shows; it can't change what the device shows.
- **The app is locked down.** No localhost server or open port. The page can only call Icebox's own
  commands. A strict Content Security Policy blocks any script that isn't shipped in the app. The page
  gets no Tauri plugin permissions (file system, shell, HTTP, opener); the one link it can open, a
  transaction on mempool.space, is built and checked in Rust.
- **What the database holds.** The data folder has no private keys, but it reveals your addresses,
  balances and history, so treat it as private. Each wallet's root public key is stored with the same
  all-zero encryption key the official desktop app uses (see `DESKTOP_ENCRYPTION_KEY`). That keeps the
  formats interchangeable, but it means the database file itself is what you protect, e.g. with disk
  encryption.
- **Privacy from the server.** The default Electrum servers are public ones, which can see which
  addresses you ask about. For mainnet, point Icebox at your own node in Settings.

## What it can do (v0.1)

- See devices plugged in (including daisy chains), and top up their signing nonces
- Create a new wallet: name the devices, choose the threshold (e.g. 2-of-3), check the code every
  device shows, then back up each device's share on its own screen
- See balance and history (synced over Electrum)
- Receive: fresh addresses with QR codes, checked on a device
- Send: choose fee rate (with suggestions), pick which devices sign, sign one device at a time, then
  broadcast. Payments in progress survive a restart and can be continued or cancelled.
- Export the watch-only descriptor (for Sparrow, Bitcoin Core, etc.)
- Set Electrum servers per network

**New in 0.2 (unreleased):**

- Menu bar: File (Settings, Quit), Wallet (New wallet, Receive, Send), View (Devices), Help
  (Try demo mode, About), with keyboard shortcuts
- **Demo mode** (Help → Try demo mode, or the button on an empty Devices page): pretend devices
  and test coins, so anyone can try the whole flow without hardware. Nothing touches real devices,
  wallets or the network, and leaving demo mode restarts the app clean.
- Each device's **firmware version** is shown. Devices on older or unrecognised firmware get a
  warning, and creating a wallet with them needs an explicit "I understand" tick.
- **Erase device**, confirmed on the device's own screen, with a warning if it holds a wallet share
- **Restore from devices** (sidebar, or Wallet → Restore from devices): plug in a wallet's devices,
  together or one after another, and Icebox asks each which wallet shares it holds, groups them by
  wallet ("Family savings: 2 of 2 needed") and rebuilds the wallet in one click. Use it for wallets
  made in the official app. Devices are only read; nothing on them changes. Uses the official
  `frostsnap_core` restoration code.
- Wallets are labelled "2 to sign" rather than "2-of-3": a wallet restored from some of its devices
  can't know how many devices exist in total.
- **Check a backup**: enter your written-down words on the device; it says whether they match
- All receive addresses, with "used" marks to discourage reuse; descriptor as a QR code
- About box (version, Frostsnap commit, expected firmware, data folder)
- Transactions in History open on mempool.space in your browser
- Only one copy of Icebox runs at a time, and it remembers its window size and position
- One wallet per device, as in the official app: new wallets use blank devices
- Remove a wallet from Icebox (the devices keep their shares; restore it any time)

**Not yet:** firmware upgrades, restoring from written-down backup words, PSBT import/export, Nostr keys,
accepting self-signed TLS certificates (use `tcp://` for a node on your own network, or a server with
a proper certificate). For any of those, use the official app.

## Building

You need Rust (via [rustup](https://rustup.rs)) and the Tauri CLI. The right Rust version
installs automatically from `rust-toolchain.toml`.

### Linux (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install build-essential curl wget file pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev

cargo install tauri-cli --version "^2" --locked

# let your user talk to the devices without root
sudo cp linux/99-frostsnap.rules /etc/udev/rules.d/
sudo udevadm control --reload && sudo udevadm trigger
```

Other distributions: see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

### Windows 10/11

1. Install the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
   with the **Desktop development with C++** workload.
2. Install Rust from [rustup.rs](https://rustup.rs) (default MSVC toolchain).
3. WebView2 is already part of Windows 10/11.
4. In a new terminal: `cargo install tauri-cli --version "^2" --locked`

### Run and build

From the `icebox` folder:

```bash
cargo test -p icebox-core   # quick checks of the core crate
cargo tauri dev             # run it
cargo tauri build           # installers: .msi on Windows, .deb/.rpm/.AppImage on Linux
```

The first build downloads and compiles a few hundred crates and takes a while.

## Sharing builds with your team

`cargo tauri build` only builds for the system it runs on. Build Windows installers on Windows and
Linux packages on Linux. Output goes to `target/release/bundle/`:

| System  | File | Notes |
|---------|------|-------|
| Windows | `msi/Icebox_0.1.0_x64_en-US.msi` | the one file to send; installs to Start menu with an uninstaller |
| Linux   | `deb/Icebox_0.1.0_amd64.deb` | Debian/Ubuntu; also installs the udev rule for the devices |
| Linux   | `rpm/Icebox-0.1.0-1.x86_64.rpm` | Fedora etc.; also installs the udev rule |
| Linux   | `appimage/Icebox_0.1.0_amd64.AppImage` | any distro; install `linux/99-frostsnap.rules` by hand |

The simplest way to get both is to let GitHub build them: push this folder to a GitHub repository
and push a version tag. `.github/workflows/release.yml` builds both systems from scratch, records
build provenance, and (after you approve) makes a draft release with the installers and a
`SHA256SUMS` file. See [docs/GITHUB_SETUP.md](docs/GITHUB_SETUP.md).

**Unsigned builds.** The installers aren't code-signed, so Windows SmartScreen will warn
("Windows protected your PC"). Testers click **More info → Run anyway**. Code signing removes the
warning but needs a paid certificate. Worth it for a public release, not for internal testing.

**Tell testers:** use Signet only; close the official Frostsnap app before opening Icebox; on
Linux AppImage, install the udev rule (see Building → Linux).

## Using it

1. Plug in your Frostsnap devices. They appear under **Plugged in**.
2. **New wallet**: name it, choose **Signet** to start, name each device (the name appears on the
   device as you type), choose the threshold, then **Create keys**. Confirm on each device, check
   they all show the same code, then click the button.
3. **Back up**: for each device, click **Show backup on device**, write the words down, and confirm
   on the device.
4. **Receive**: get an address, click **Check on a device**, and compare it group by group.
5. **Send**: enter address, amount and fee rate, review, choose which devices sign, then click
   **Ask to sign** for each plugged-in device and approve on its screen. Then **Broadcast**.

Don't run Icebox and the official Frostsnap app at the same time: both want the USB port.

## Data

Icebox keeps its data in your user's app-data folder (shown in Settings): `frostsnap.sqlite` plus
one `wallet-<network>.sql` per network. That's the same layout as the official app, so data should
move between the two, but **back up both folders before trying it**, and use the same Frostsnap
version in both. To use another folder, set `ICEBOX_DATA_DIR` before launching.

## Frostsnap version and device firmware

Icebox pins the Frostsnap crates to a specific commit (`233f93b`, 9 October 2026) in `Cargo.toml`.
The protocol between the app and the devices must match the firmware on your devices. If devices
don't appear, or keygen/signing fails right away, update the devices' firmware with the official
app, or move the pin to a Frostsnap commit that matches your firmware.

`Cargo.lock` started as a copy of Frostsnap's own lock file, so the shared dependencies (BDK,
rusqlite, secp256kfun and so on) resolve to the same versions upstream builds with.

To update the pin: change `rev` in the root `Cargo.toml`, run `cargo update -p frostsnap_coordinator`,
and fix anything the upstream API changed (the code that touches it is all in
`crates/icebox-core/src/service.rs`).

## Previewing the UI without devices

`dev/preview.html` loads the UI in an ordinary browser with the demo backend (`ui/demo.js`, the
same one demo mode uses) plus two extra devices showing the warning states, so the screens can be
worked on without hardware. After changing `ui/index.html`, run `python3 dev/sync-preview.py`.

## Contributing and security

- How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md) (we use DCO sign-off, not a CLA)
- Report vulnerabilities privately: [SECURITY.md](SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- Changes: [CHANGELOG.md](CHANGELOG.md)
- What's planned: [ROADMAP.md](ROADMAP.md)
- Maintainers setting up the GitHub repo: [docs/GITHUB_SETUP.md](docs/GITHUB_SETUP.md)

## Licence

[MIT](LICENSE). Contributions are accepted under the same licence (see
[CONTRIBUTING.md](CONTRIBUTING.md)).

Icebox builds on the [Frostsnap](https://github.com/frostsnap/frostsnap) crates, © the Frostsnap
contributors, MIT licence. Icebox is independent and not affiliated with or endorsed by Frostsnap.
