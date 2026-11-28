//! Reaching Frostsnap devices on Android.
//!
//! The device loop asks for the ports it can see and opens new ones, through the
//! [`icebox_core::Serial`] trait. On Android the ports come from the Icebox USB plugin (Android's
//! USB host API, which also asks the user's permission), and an opened device is driven over its
//! file descriptor with Frostsnap's own CDC-ACM code. Mirrors the official app's `FfiSerial`.

use icebox_core::{CdcAcmSerial, PortDesc, PortOpenError, Serial, SerialPort};
use std::os::fd::{FromRawFd, OwnedFd};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri_plugin_icebox_usb::UsbHost;

/// The device loop asks for ports many times a second; a call into Android is slower than
/// listing serial ports, so the answer is reused briefly.
const LIST_EVERY: Duration = Duration::from_millis(400);

pub struct AndroidSerial {
    usb: UsbHost<tauri::Wry>,
    cache: Mutex<Option<(Instant, Vec<PortDesc>)>>,
}

impl AndroidSerial {
    pub fn new(usb: UsbHost<tauri::Wry>) -> Self {
        Self {
            usb,
            cache: Mutex::new(None),
        }
    }
}

impl Serial for AndroidSerial {
    fn available_ports(&self) -> Vec<PortDesc> {
        let mut cache = self.cache.lock().unwrap();
        if let Some((at, ports)) = &*cache {
            if at.elapsed() < LIST_EVERY {
                return ports.clone();
            }
        }
        let ports: Vec<PortDesc> = match self.usb.list() {
            // Devices the user hasn't allowed yet are left out until they tap Allow.
            Ok(devices) => devices
                .into_iter()
                .filter(|d| d.permitted)
                .map(|d| PortDesc {
                    id: d.id,
                    vid: d.vid,
                    pid: d.pid,
                })
                .collect(),
            Err(e) => {
                tracing::warn!("couldn't list USB devices: {e}");
                Vec::new()
            }
        };
        *cache = Some((Instant::now(), ports.clone()));
        ports
    }

    fn open_device_port(&self, id: &str, baud_rate: u32) -> Result<SerialPort, PortOpenError> {
        let fd = self
            .usb
            .open(id)
            .map_err(|e| PortOpenError::Other(e.into()))?;
        // SAFETY: the plugin hands over a duplicated, detached descriptor that nothing else owns.
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let port = CdcAcmSerial::new_auto(fd, id.to_string(), baud_rate)
            .map_err(|e| PortOpenError::Other(e.into()))?;
        tracing::info!(port = id, "opened USB device");
        Ok(Box::new(port))
    }
}
