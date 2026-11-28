# Android trial build (developers)

Status: **beta**, released alongside the desktop app from 0.5.0 (see
[android-release.md](android-release.md) for how releases are signed). Icebox on an Android
phone, talking to Frostsnap devices over the phone's USB-C port.

## How it works

Android apps can't open serial ports, so on Android Icebox uses the **USB host API** through a small
Tauri plugin (`crates/tauri-plugin-icebox-usb`, Kotlin in `android/`). It lists Frostsnap devices
(USB `303a:1001`), asks the user's permission for each, and hands Rust a file descriptor. Rust then
drives the device with `frostsnap_coordinator::cdc_acm_usb`, as the official Frostsnap Android app
does (`src-tauri/src/android_usb.rs`). Everything else is the desktop code.

Desktop-only parts (menu bar, single-instance, window size) are behind `#[cfg(desktop)]`. The app
is now a library (`src-tauri/src/lib.rs`, `icebox_lib::run`) with a tiny `main.rs` for desktop, as
Tauri's mobile support needs.

## One-time setup (Windows)

1. **Android Studio**: install from developer.android.com/studio. Open it, then
   *More Actions → SDK Manager*:
   - *SDK Platforms*: the latest Android (API 36).
   - *SDK Tools*: tick **Android SDK Build-Tools**, **NDK (Side by side)**, **Android SDK
     Command-line Tools** and **Android SDK Platform-Tools**. Apply.
2. **Environment variables** (Windows *Edit environment variables for your account* → New):
   - `JAVA_HOME` = `C:\Program Files\Android\Android Studio\jbr`
   - `ANDROID_HOME` = `C:\Users\<you>\AppData\Local\Android\Sdk`
   - `NDK_HOME` = `%ANDROID_HOME%\ndk\<the version folder inside ndk>`
   - Add `%ANDROID_HOME%\platform-tools` to `Path` (for `adb`).
   Close and reopen Git Bash, then check: `echo $NDK_HOME` and `adb version`.
3. **Rust target** (run inside the repo so it lands on the pinned toolchain):
   `rustup target add aarch64-linux-android`
4. **Tauri CLI**: `cargo tauri --version` should say 2.x (`cargo install tauri-cli --version "^2"`
   if not).
5. **Generate the Android project** (once, in the repo): `cargo tauri android init`.
   This creates `src-tauri/gen/android`.

## The phone

- *Settings → About phone →* tap **Build number** seven times, enter your PIN.
- *Settings → System → Developer options →* turn on **Wireless debugging**, tap it, then
  **Pair device with pairing code**. On the PC: `adb pair <ip:port> <code>`, then
  `adb connect <ip:port>` (the port on the Wireless debugging screen). `adb devices` should list it.
- Wireless debugging keeps the USB-C port free for the Frostsnap device.
- **GrapheneOS**: *Settings → Security → Exploit protection → USB-C port* blocks new USB devices
  while the phone is locked (by default). Keep it unlocked while testing, or start with stock Android.

## Run it

```
cargo tauri android dev
```

Pick the phone when asked. The first build takes a while. Icebox opens on the phone.

Plug a Frostsnap device into the phone's USB-C port (the device's own plug fits; otherwise use a
USB-C OTG adapter). Android asks whether Icebox may use it: tap **OK**. Within a few seconds it
should appear on the Devices page with its name.

To build an APK to install by hand: `cargo tauri android build --apk --target aarch64` (debug-signed
builds need `--debug`).

## When something goes wrong

- In Icebox: *Settings → View logs* (the log file works on Android too).
- On the PC: `adb logcat | grep -i -E "icebox|tauri|rust"`.
- Note what you did, what the phone showed, and send both.
