//! Everything the UI hears about arrives as one of these events. They are plain data, serialised
//! to JSON, so the front end never holds a Rust object and cannot call anything that is not an
//! explicit command.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    /// The full list of devices currently plugged in, in chain order.
    Devices { devices: Vec<DeviceView> },
    /// The full list of wallets (keys) this coordinator knows about.
    Keys { keys: Vec<KeyView> },
    /// Progress of giving devices fresh signing nonces.
    Nonces(NonceView),
    /// Progress of a key generation ceremony.
    Keygen(KeygenView),
    /// Progress of a signing session.
    Signing(SigningView),
    /// Progress of showing an address on the devices.
    VerifyAddress(VerifyAddressView),
    /// Progress of showing a backup on one device.
    DisplayBackup(DisplayBackupView),
    /// Result of checking a device's written-down backup on the device.
    CheckBackup(CheckBackupView),
    /// Progress of erasing a device.
    Erase(EraseView),
    /// A device answered the restore scan (or one was plugged in or out). The UI fetches the
    /// grouped results with the `restore_candidates` command.
    RestoreScanChanged,
    /// The wallet for this key saw new chain data; the UI should refresh it.
    WalletChanged { key_id: String },
    /// Connection status of the Electrum server for a network.
    Chain(ChainView),
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceView {
    pub id: String,
    /// False while the device is still connecting (it announced itself but hasn't yet asked
    /// for a name or been registered). Only ready devices can be used.
    pub ready: bool,
    pub name: Option<String>,
    pub needs_name: bool,
    pub nonces: u32,
    pub firmware_digest: String,
    /// e.g. "v0.4.0", or "dev-1a2b3c" if unrecognised.
    pub firmware: String,
    /// "expected", "older" or "unrecognised" compared with [`AppInfo::expected_firmware`].
    pub firmware_status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeyView {
    pub key_id: String,
    pub name: String,
    /// "bitcoin", "signet", "testnet", "regtest", or None for non-bitcoin keys.
    pub network: Option<String>,
    pub threshold: u16,
    pub access_structure_id: String,
    pub devices: Vec<KeyDeviceView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeyDeviceView {
    pub id: String,
    pub name: Option<String>,
    pub share_index: u32,
    /// Whether the user confirmed they wrote this device's backup down: `None` when this
    /// computer doesn't know (a restored wallet; backup status isn't stored on the devices).
    pub backup_done: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NonceView {
    pub devices: Vec<String>,
    pub completed_streams: u32,
    pub total_streams: u32,
    pub finished: bool,
    pub aborted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeygenView {
    pub keygen_id: String,
    pub threshold: usize,
    pub devices: Vec<String>,
    pub got_shares: Vec<String>,
    pub session_acks: Vec<String>,
    pub all_acks: bool,
    /// First four bytes of the session hash, as hex. Every device shows the same code; the user
    /// must check they match before finalising.
    pub check_code: Option<String>,
    pub finished: Option<String>,
    pub aborted: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SigningView {
    pub session_id: String,
    pub got_shares: Vec<String>,
    pub needed_from: Vec<String>,
    /// Connected devices that are part of the session but have not been asked to sign yet.
    pub connected_but_need_request: Vec<String>,
    pub finished: bool,
    pub aborted: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VerifyAddressView {
    pub target_devices: Vec<String>,
    pub connected_devices: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DisplayBackupView {
    pub device_id: String,
    pub confirmed: bool,
    pub closed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AddressListItem {
    pub index: u32,
    pub address: String,
    /// Has received coins. Reusing it links payments together.
    pub used: bool,
    /// Was handed out (copied, shown or checked on a device).
    pub shared: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckBackupView {
    pub device_id: String,
    /// The device confirmed the words entered on it match its share. (Current firmware only
    /// reports success; a mismatch is shown, and retried, on the device itself.)
    pub valid: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EraseView {
    pub device_id: String,
    /// The user confirmed on the device and erasing has begun. The device restarts blank.
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreScanView {
    /// Devices that have said what they hold.
    pub answered: Vec<String>,
    /// Devices asked that haven't answered yet.
    pub waiting: Vec<String>,
    pub candidates: Vec<RestoreCandidateView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreCandidateView {
    pub group_id: String,
    pub name: String,
    pub network: Option<String>,
    /// Shares needed to restore, if the devices said.
    pub threshold: Option<u16>,
    /// Different shares found so far.
    pub found: usize,
    /// "ready", "need_more", "already_here", "not_bitcoin" or "unknown_threshold".
    pub status: String,
    pub devices: Vec<RestoreDeviceView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreDeviceView {
    pub id: String,
    pub name: Option<String>,
    pub share_number: u32,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub version: String,
    /// The Frostsnap commit this build uses.
    pub frostsnap_rev: String,
    /// The device firmware release this build is made for, e.g. "v0.4.0".
    pub expected_firmware: String,
    pub data_dir: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChainView {
    pub network: String,
    pub state: String,
    pub url: String,
}

// ---------- values returned directly from commands ----------

#[derive(Debug, Clone, Serialize)]
pub struct WalletView {
    pub key_id: String,
    pub network: String,
    pub height: u32,
    /// Confirmed balance plus our own unconfirmed change, in sats.
    pub balance: i64,
    /// Unconfirmed incoming funds from others, in sats.
    pub pending_incoming: i64,
    pub txs: Vec<TxView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TxView {
    pub txid: String,
    /// Change to our balance in sats (negative for sends).
    pub net_value: Option<i64>,
    pub fee: Option<u64>,
    pub confirmations: u32,
    pub timestamp: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AddressView {
    pub index: u32,
    pub address: String,
    pub used: bool,
    /// QR code of the address as an SVG data URI.
    pub qr_svg: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SendPreview {
    pub recipient: String,
    pub amount: u64,
    pub fee: u64,
    pub change: Option<u64>,
    pub input_count: usize,
    pub feerate: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionView {
    pub session_id: String,
    pub key_id: String,
    pub txid: String,
    pub fee: Option<u64>,
    pub feerate: Option<f64>,
    pub recipients: Vec<RecipientView>,
    pub signers: Vec<String>,
    pub got_shares: Vec<String>,
    /// True once enough devices have signed and the transaction can be broadcast.
    pub signed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecipientView {
    pub address: Option<String>,
    pub amount: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct FeeEstimate {
    pub target_blocks: usize,
    pub sat_per_vb: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ElectrumView {
    pub network: String,
    pub primary: String,
    pub backup: String,
}
