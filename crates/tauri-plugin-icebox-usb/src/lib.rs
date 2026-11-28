//! Android USB host access for Icebox.
//!
//! Android apps can't open `/dev/tty*` serial ports, so the desktop serial code doesn't work there.
//! Instead, Android's USB host API hands an app a file descriptor for a USB device once the user
//! has allowed it. This plugin (Kotlin side in `android/`) lists the Frostsnap devices plugged in,
//! asks the user's permission for each new one, and opens a device to give Rust its file
//! descriptor. Rust then speaks USB CDC-ACM over it with `frostsnap_coordinator`'s own driver,
//! the same way the official Frostsnap Android app does.
//!
//! On every other platform the plugin does nothing.

use serde::Deserialize;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

/// A USB device the phone can see.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbDeviceInfo {
    /// Android's name for the device, e.g. `/dev/bus/usb/001/002`. Stable while it's plugged in.
    pub id: String,
    pub vid: u16,
    pub pid: u16,
    /// Whether the user has allowed Icebox to use it.
    pub permitted: bool,
}

#[cfg(target_os = "android")]
mod android {
    use super::UsbDeviceInfo;
    use serde::{Deserialize, Serialize};
    use tauri::{plugin::PluginHandle, Runtime};

    #[derive(Deserialize)]
    struct ListResponse {
        devices: Vec<UsbDeviceInfo>,
    }

    #[derive(Serialize)]
    struct OpenArgs<'a> {
        id: &'a str,
    }

    #[derive(Deserialize)]
    struct OpenResponse {
        fd: i32,
    }

    /// Handle to the Kotlin plugin. Cheap to clone, and usable from any thread except Android's
    /// main thread (calls wait for the Kotlin side to answer).
    pub struct UsbHost<R: Runtime>(pub(crate) PluginHandle<R>);

    impl<R: Runtime> Clone for UsbHost<R> {
        fn clone(&self) -> Self {
            Self(self.0.clone())
        }
    }

    impl<R: Runtime> UsbHost<R> {
        /// Frostsnap devices plugged in. Asks the user's permission for any that don't have it
        /// yet; those show up with `permitted: false` until the user taps Allow.
        pub fn list(&self) -> Result<Vec<UsbDeviceInfo>, String> {
            self.0
                .run_mobile_plugin::<ListResponse>("listDevices", ())
                .map(|r| r.devices)
                .map_err(|e| e.to_string())
        }

        /// Opens a device and returns a file descriptor that the caller now owns.
        pub fn open(&self, id: &str) -> Result<i32, String> {
            let r: OpenResponse = self
                .0
                .run_mobile_plugin("openDevice", OpenArgs { id })
                .map_err(|e| e.to_string())?;
            if r.fd < 0 {
                return Err(format!("Android couldn't open USB device {id}"));
            }
            Ok(r.fd)
        }
    }
}

#[cfg(target_os = "android")]
pub use android::UsbHost;

/// Adds the plugin. On Android, the [`UsbHost`] handle is then available with
/// `app.state::<UsbHost<R>>()`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("icebox-usb")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin(
                    "uk.co.blockchainology.icebox.usb",
                    "IceboxUsbPlugin",
                )?;
                _app.manage(UsbHost(handle));
            }
            Ok(())
        })
        .build()
}
