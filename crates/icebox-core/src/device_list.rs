//! Tracks which devices are plugged in, in the order they were connected.
//!
//! A device shows up as soon as it announces itself on the chain (`Connected`), but only counts
//! as *ready* once it has either asked to be named (`NeedsName`) or been registered under an
//! existing name (`Registered`). Showing devices from the first announcement means a device that
//! stalls part-way through connecting is visible, rather than silently missing.

use frostsnap_coordinator::firmware::{FirmwareVersion, VersionNumber, EARLIEST_ACCEPTABLE};
use frostsnap_coordinator::{DeviceChange, DeviceMode};
use frostsnap_core::DeviceId;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct ConnectedDevice {
    pub id: DeviceId,
    pub name: Option<String>,
    pub firmware_digest: String,
    /// The firmware release, if the digest is one this build knows.
    pub firmware_version: Option<VersionNumber>,
    /// e.g. "v0.4.0", or "dev-1a2b3c" for firmware this build doesn't recognise.
    pub firmware_name: String,
    /// Finished connecting: it asked for a name or was registered with its name.
    pub ready: bool,
}

/// How a device's firmware compares with the firmware this build of Icebox was made for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirmwareStatus {
    /// Exactly the expected release.
    Expected,
    /// A known, older release. The official app would offer an upgrade.
    Older,
    /// Not a release this build knows: newer than Icebox, or a development build.
    Unrecognised,
}

impl FirmwareStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            FirmwareStatus::Expected => "expected",
            FirmwareStatus::Older => "older",
            FirmwareStatus::Unrecognised => "unrecognised",
        }
    }
}

/// The firmware release this build of Icebox is made for.
pub fn expected_firmware() -> VersionNumber {
    EARLIEST_ACCEPTABLE
}

impl ConnectedDevice {
    pub fn firmware_status(&self) -> FirmwareStatus {
        match self.firmware_version {
            Some(v) if v == expected_firmware() => FirmwareStatus::Expected,
            Some(v) if v < expected_firmware() => FirmwareStatus::Older,
            _ => FirmwareStatus::Unrecognised,
        }
    }

    pub fn mode(&self) -> DeviceMode {
        if self.name.is_none() {
            DeviceMode::Blank
        } else {
            DeviceMode::Ready
        }
    }
}

#[derive(Debug, Default)]
pub struct DeviceList {
    order: Vec<DeviceId>,
    connected: HashMap<DeviceId, ConnectedDevice>,
}

impl DeviceList {
    /// Applies a change from the USB manager. Returns true if what the UI shows has changed.
    pub fn consume(&mut self, change: &DeviceChange) -> bool {
        match change {
            DeviceChange::Connected {
                id,
                firmware_digest,
                ..
            } => {
                let device = self
                    .connected
                    .entry(*id)
                    .or_insert_with(|| ConnectedDevice {
                        id: *id,
                        name: None,
                        firmware_digest: String::new(),
                        firmware_version: None,
                        firmware_name: String::new(),
                        ready: false,
                    });
                let firmware = FirmwareVersion::new(*firmware_digest);
                device.firmware_digest = firmware_digest.to_string();
                device.firmware_version = firmware.version;
                device.firmware_name = firmware.version_name();
                self.append(*id);
                true
            }
            DeviceChange::NeedsName { id } => {
                self.set_ready(*id);
                true
            }
            DeviceChange::Registered { id, name } => {
                if let Some(device) = self.connected.get_mut(id) {
                    device.name = Some(name.clone());
                }
                self.set_ready(*id);
                true
            }
            DeviceChange::NameChange { id, name } => {
                if let Some(device) = self.connected.get_mut(id) {
                    device.name = Some(name.clone());
                }
                true
            }
            DeviceChange::Disconnected { id } => {
                self.connected.remove(id);
                let before = self.order.len();
                self.order.retain(|d| d != id);
                before != self.order.len()
            }
            DeviceChange::AppMessage(_) | DeviceChange::GenuineDevice { .. } => false,
        }
    }

    fn set_ready(&mut self, id: DeviceId) {
        if let Some(device) = self.connected.get_mut(&id) {
            device.ready = true;
            self.append(id);
        }
    }

    fn append(&mut self, id: DeviceId) {
        if !self.order.contains(&id) {
            self.order.push(id);
        }
    }

    pub fn get(&self, id: DeviceId) -> Option<&ConnectedDevice> {
        self.connected.get(&id)
    }

    /// Every device on the chain, in connection order, ready or not.
    pub fn devices(&self) -> Vec<ConnectedDevice> {
        self.order
            .iter()
            .filter_map(|id| self.connected.get(id).cloned())
            .collect()
    }

    /// Devices that have finished connecting, in connection order.
    pub fn ready_devices(&self) -> Vec<ConnectedDevice> {
        self.devices().into_iter().filter(|d| d.ready).collect()
    }

    pub fn ready_ids(&self) -> HashSet<DeviceId> {
        self.ready_devices().into_iter().map(|d| d.id).collect()
    }

    /// Sorts `devices` into connection order (so share #1 goes to the first device in the
    /// chain), appending any that are not connected.
    pub fn sort_as_connected(&self, devices: &HashSet<DeviceId>) -> Vec<DeviceId> {
        let mut sorted: Vec<DeviceId> = self
            .order
            .iter()
            .filter(|id| devices.contains(id))
            .copied()
            .collect();
        let mut rest: Vec<DeviceId> = devices
            .iter()
            .filter(|id| !self.order.contains(id))
            .copied()
            .collect();
        rest.sort();
        sorted.extend(rest);
        sorted
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use frostsnap_coordinator::frostsnap_comms::Sha256Digest;

    fn id(n: u8) -> DeviceId {
        let mut bytes = [0u8; 33];
        bytes[0] = 2;
        bytes[32] = n;
        DeviceId(bytes)
    }

    fn connected(n: u8) -> DeviceChange {
        DeviceChange::Connected {
            id: id(n),
            firmware_digest: Sha256Digest([n; 32]),
            latest_firmware_digest: None,
        }
    }

    #[test]
    fn devices_appear_as_soon_as_they_announce() {
        let mut list = DeviceList::default();
        for n in 1..=5 {
            assert!(list.consume(&connected(n)));
        }
        assert_eq!(list.devices().len(), 5);
        assert_eq!(list.ready_devices().len(), 0);

        list.consume(&DeviceChange::NeedsName { id: id(3) });
        let ready = list.ready_devices();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].id, id(3));
        // chain order is kept
        let order: Vec<_> = list.devices().into_iter().map(|d| d.id).collect();
        assert_eq!(order, (1..=5).map(id).collect::<Vec<_>>());
    }

    #[test]
    fn registered_devices_keep_their_name_and_disconnects_remove_them() {
        let mut list = DeviceList::default();
        list.consume(&connected(1));
        list.consume(&DeviceChange::Registered {
            id: id(1),
            name: "Kitchen".into(),
        });
        let device = list.get(id(1)).unwrap();
        assert!(device.ready);
        // a made-up digest is not a known release
        assert_eq!(device.firmware_status(), FirmwareStatus::Unrecognised);
        assert!(device.firmware_name.starts_with("dev-"));
        assert_eq!(device.name.as_deref(), Some("Kitchen"));

        assert!(list.consume(&DeviceChange::Disconnected { id: id(1) }));
        assert!(list.devices().is_empty());
    }
}
