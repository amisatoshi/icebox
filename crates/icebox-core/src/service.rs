//! The coordinator service: owns the database, talks to Frostsnap devices over USB, runs the
//! FROST coordinator from `frostsnap_core`, and keeps one Bitcoin wallet per network in sync over
//! Electrum.
//!
//! The structure deliberately mirrors the official app's `FfiCoordinator`
//! (frostsnapp/rust/src/coordinator.rs) so that behaviour stays the same and the code can track
//! upstream changes. The database layout is also the same as the official desktop app's, so a
//! data directory can be moved between the two.
//!
//! Lock order, everywhere: coordinator -> db -> ui_stack -> device_names / device_list.
//! `backup_state` and `settings` are only ever taken before `db` and never together with
//! `coordinator`.

use crate::device_list::DeviceList;
use crate::events::*;
use crate::restore::{self, ScanHeldShares, ScanResults};
use anyhow::{anyhow, Context as _, Result};
use frostsnap_coordinator::backup_run::BackupState;
use frostsnap_coordinator::bdk_chain::bitcoin::{self, Address, Network};
use frostsnap_coordinator::bitcoin::chain_sync::{
    ChainClient, ChainStatus, ChainStatusState, ElectrumConfig, SUPPORTED_NETWORKS,
};
use frostsnap_coordinator::bitcoin::send::SendPlan;
use frostsnap_coordinator::bitcoin::tofu::trusted_certs::TrustedCertificates;
use frostsnap_coordinator::bitcoin::wallet::CoordSuperWallet;
use frostsnap_coordinator::check_backup::{CheckBackupProtocol, CheckBackupState};
use frostsnap_coordinator::display_backup::{DisplayBackupProtocol, DisplayBackupState};
use frostsnap_coordinator::erase_device::{EraseDevice, EraseDeviceState};
use frostsnap_coordinator::frostsnap_comms::{
    CoordinatorSendBody, CoordinatorSendMessage, Destination, DeviceName,
};
use frostsnap_coordinator::frostsnap_persist::DeviceNames;
use frostsnap_coordinator::keygen::{KeyGen, KeyGenState};
use frostsnap_coordinator::nonce_replenish::{NonceReplenishProtocol, NonceReplenishState};
use frostsnap_coordinator::persist::Persisted;
use frostsnap_coordinator::settings::Settings as CoordSettings;
use frostsnap_coordinator::signing::{SigningDispatcher, SigningState};
use frostsnap_coordinator::verify_address::{VerifyAddressProtocol, VerifyAddressProtocolState};
use frostsnap_coordinator::{
    AppMessageBody, DesktopSerial, DeviceChange, Sink, UiProtocol, UiStack, UsbSender,
    UsbSerialManager,
};
use frostsnap_core::bitcoin_transaction::TransactionTemplate;
use frostsnap_core::coordinator::{BeginKeygen, CoordFrostKey, CoordinatorSend, FrostCoordinator};
use frostsnap_core::device::KeyPurpose;
use frostsnap_core::tweak::{BitcoinAccount, NormalIndex};
use frostsnap_core::{
    AccessStructureRef, DeviceId, KeyId, KeygenId, SignSessionId, SymmetricKey, WireSignTask,
};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing::{event, Level};

/// How many nonce streams to keep topped up on each device (same as the official app).
const N_NONCE_STREAMS: usize = 4;

/// The key that encrypts each wallet's root public key inside the database.
///
/// This protects privacy only (it hides which addresses belong to you), not funds: spending
/// always needs a threshold of devices. The official desktop app uses this same all-zero key,
/// which is what keeps the database format interchangeable with it.
const DESKTOP_ENCRYPTION_KEY: SymmetricKey = SymmetricKey([0u8; 32]);

/// A callback that receives every event for the UI.
pub type EventFn = Arc<dyn Fn(Event) + Send + Sync + 'static>;

/// Adapts a closure into the coordinator crate's `Sink` trait.
struct FnSink<F>(F);

impl<M, F> Sink<M> for FnSink<F>
where
    F: Fn(M) + Send + 'static,
{
    fn send(&self, state: M) {
        (self.0)(state)
    }
}

struct PendingSend {
    key_id: KeyId,
    plan: SendPlan,
}

/// The running coordinator. Cheap to clone.
#[derive(Clone)]
pub struct Service(Arc<Inner>);

struct Inner {
    events: EventFn,
    db: Arc<Mutex<rusqlite::Connection>>,
    coordinator: Arc<Mutex<Persisted<FrostCoordinator>>>,
    device_names: Arc<Mutex<Persisted<DeviceNames>>>,
    backup_state: Mutex<Persisted<BackupState>>,
    settings: Mutex<Persisted<CoordSettings>>,
    ui_stack: Arc<Mutex<UiStack>>,
    device_list: Arc<Mutex<DeviceList>>,
    usb_sender: UsbSender,
    chains: HashMap<Network, ChainClient>,
    wallets: HashMap<Network, Arc<Mutex<CoordSuperWallet>>>,
    /// Names the user typed for devices during wallet creation, committed at finalize.
    pending_names: Mutex<HashMap<DeviceId, String>>,
    pending_send: Mutex<Option<PendingSend>>,
    /// What devices said they hold, from the restore scan.
    scan_results: ScanResults,
}

// ---------- id helpers: every id crosses to the UI as a hex string ----------

fn parse<T: FromStr>(what: &str, s: &str) -> Result<T> {
    T::from_str(s.trim()).map_err(|_| anyhow!("invalid {what}: {s}"))
}

fn parse_device(s: &str) -> Result<DeviceId> {
    parse("device id", s)
}

fn parse_key(s: &str) -> Result<KeyId> {
    parse("key id", s)
}

fn parse_session(s: &str) -> Result<SignSessionId> {
    parse("signing session id", s)
}

fn ids<'a>(it: impl IntoIterator<Item = &'a DeviceId>) -> Vec<String> {
    it.into_iter().map(|id| id.to_string()).collect()
}

pub fn parse_network(s: &str) -> Result<Network> {
    let network = Network::from_str(s.trim()).map_err(|_| anyhow!("unknown network {s}"))?;
    if !SUPPORTED_NETWORKS.contains(&network) {
        return Err(anyhow!("network {network} is not supported"));
    }
    Ok(network)
}

impl Service {
    /// Opens (or creates) the databases in `app_dir`, connects to USB, and starts the background
    /// threads. `events` is called from background threads for every UI event.
    pub fn start(app_dir: &Path, events: EventFn) -> Result<Self> {
        std::fs::create_dir_all(app_dir)
            .with_context(|| format!("creating data directory {}", app_dir.display()))?;
        let db_file = app_dir.join("frostsnap.sqlite");
        event!(Level::INFO, path = %db_file.display(), "opening database");
        let db = rusqlite::Connection::open(&db_file)
            .with_context(|| format!("opening database {}", db_file.display()))?;
        let db = Arc::new(Mutex::new(db));

        let (coordinator, device_names, backup_state, settings) = {
            let mut db_ = db.lock().unwrap();
            (
                Persisted::<FrostCoordinator>::new(&mut *db_, ())?,
                Persisted::<DeviceNames>::new(&mut *db_, ())?,
                Persisted::<BackupState>::new(&mut *db_, ())?,
                Persisted::<CoordSettings>::new(&mut *db_, ())?,
            )
        };

        let usb_manager = UsbSerialManager::new(Box::new(DesktopSerial));
        let usb_sender = usb_manager.usb_sender();

        // One chain client and one wallet per network, exactly as the official app does. The
        // chain clients connect lazily, so networks you never use never open a socket.
        let mut chains = HashMap::new();
        let mut wallets = HashMap::new();
        for network in SUPPORTED_NETWORKS {
            let config = ElectrumConfig {
                enabled: settings.get_electrum_enabled(network),
                primary: settings.get_electrum_server(network),
                backup: settings.get_backup_electrum_server(network),
            };
            let genesis_hash =
                bitcoin::constants::genesis_block(bitcoin::params::Params::new(network))
                    .block_hash();
            let trusted_certificates = {
                let mut db_ = db.lock().unwrap();
                Persisted::<TrustedCertificates>::new(&mut *db_, network)?
            };
            let (chain, conn_handler) =
                ChainClient::new(genesis_hash, config, trusted_certificates, db.clone());

            let wallet_db_file = wallet_db_file(app_dir, network);
            let wallet_db = rusqlite::Connection::open(&wallet_db_file)
                .with_context(|| format!("opening {}", wallet_db_file.display()))?;
            let wallet = CoordSuperWallet::load_or_init(
                Arc::new(Mutex::new(wallet_db)),
                network,
                chain.clone(),
            )
            .with_context(|| format!("loading {network} wallet"))?;
            let wallet = Arc::new(Mutex::new(wallet));

            let status_events = events.clone();
            chain.set_status_sink(Box::new(FnSink(move |status: ChainStatus| {
                status_events(Event::Chain(chain_view(network, &status)));
            })));

            std::thread::Builder::new()
                .name(format!("electrum-{network}"))
                .spawn({
                    let wallet = wallet.clone();
                    let events = events.clone();
                    move || {
                        conn_handler.run(wallet, move |master_appkey, _txs| {
                            events(Event::WalletChanged {
                                key_id: master_appkey.key_id().to_string(),
                            });
                        })
                    }
                })?;

            chains.insert(network, chain);
            wallets.insert(network, wallet);
        }

        let service = Service(Arc::new(Inner {
            events,
            db,
            coordinator: Arc::new(Mutex::new(coordinator)),
            device_names: Arc::new(Mutex::new(device_names)),
            backup_state: Mutex::new(backup_state),
            settings: Mutex::new(settings),
            ui_stack: Default::default(),
            device_list: Default::default(),
            usb_sender,
            chains,
            wallets,
            pending_names: Default::default(),
            pending_send: Default::default(),
            scan_results: Default::default(),
        }));

        service.spawn_device_loop(usb_manager)?;
        service.emit_keys();
        service.emit_devices();
        Ok(service)
    }

    fn emit(&self, event: Event) {
        (self.0.events)(event)
    }

    // =====================================================================================
    // The device loop: a straight port of the official app's coordinator thread.
    // =====================================================================================

    fn spawn_device_loop(&self, mut usb_manager: UsbSerialManager) -> Result<()> {
        let this = self.clone();
        std::thread::Builder::new()
            .name("frostsnap-usb".into())
            .spawn(move || loop {
                // give command threads a chance to take the locks
                std::thread::sleep(Duration::from_millis(100));
                this.device_loop_iteration(&mut usb_manager);
            })?;
        Ok(())
    }

    fn device_loop_iteration(&self, usb_manager: &mut UsbSerialManager) {
        let inner = &self.0;
        // Never hold a lock across poll_ports.
        let device_changes = usb_manager.poll_ports();
        let mut devices_changed = false;
        let mut keys_changed = false;
        let mut coordinator_outbox = VecDeque::default();

        {
            let mut coordinator = inner.coordinator.lock().unwrap();
            let mut db = inner.db.lock().unwrap();
            let mut ui_stack = inner.ui_stack.lock().unwrap();
            let mut messages_from_devices = vec![];

            for change in device_changes {
                // Log every change except the high-volume protocol messages, so a device that
                // stalls part-way through connecting shows up in the terminal output.
                match &change {
                    DeviceChange::AppMessage(_) => {}
                    other => event!(Level::INFO, change = ?other, "device change"),
                }
                devices_changed |= inner.device_list.lock().unwrap().consume(&change);
                match change {
                    DeviceChange::Registered { id, .. } => {
                        let mode = inner
                            .device_list
                            .lock()
                            .unwrap()
                            .get(id)
                            .map(|d| d.mode())
                            .unwrap_or(frostsnap_coordinator::DeviceMode::Ready);
                        ui_stack.connected(id, mode);
                    }
                    DeviceChange::NeedsName { id } => {
                        ui_stack.connected(id, frostsnap_coordinator::DeviceMode::Blank);
                    }
                    DeviceChange::Disconnected { id } => {
                        ui_stack.disconnected(id);
                    }
                    DeviceChange::NameChange { id, name } => {
                        let mut device_names = inner.device_names.lock().unwrap();
                        let result = device_names.staged_mutate(&mut *db, |names| {
                            names.insert(id, name.clone());
                            Ok(())
                        });
                        match result {
                            Ok(()) => {
                                usb_manager.accept_device_name(id, name);
                                keys_changed = true;
                            }
                            Err(e) => event!(
                                Level::ERROR,
                                error = %e,
                                "failed to persist device name change"
                            ),
                        }
                    }
                    DeviceChange::AppMessage(message) => messages_from_devices.push(message),
                    DeviceChange::Connected { .. } | DeviceChange::GenuineDevice { .. } => {}
                }
            }

            for app_message in messages_from_devices {
                match app_message.body {
                    AppMessageBody::Core(core_message) => {
                        let result = coordinator.staged_mutate(&mut *db, |coordinator| {
                            match coordinator.recv_device_message(app_message.from, *core_message) {
                                Ok(messages) => coordinator_outbox.extend(messages),
                                Err(e) => event!(
                                    Level::ERROR,
                                    from = %app_message.from,
                                    "failed to process device message: {e}"
                                ),
                            }
                            Ok(())
                        });
                        if let Err(e) = result {
                            event!(Level::ERROR, error = %e, "failed to persist device message");
                        }
                        // nonce counts and signing state may have moved
                        devices_changed = true;
                    }
                    AppMessageBody::Misc(comms_misc) => {
                        ui_stack.process_comms_message(app_message.from, comms_misc);
                    }
                }
            }

            while let Some(message) = coordinator_outbox.pop_front() {
                match message {
                    CoordinatorSend::ToDevice {
                        message,
                        destinations,
                    } => inner.usb_sender.send(CoordinatorSendMessage {
                        target_destinations: Destination::from(destinations),
                        message_body: CoordinatorSendBody::Core(message),
                    }),
                    CoordinatorSend::ToUser(msg) => ui_stack.process_to_user_message(msg),
                }
            }

            for message in ui_stack.poll() {
                inner.usb_sender.send(message);
            }

            if ui_stack.clean_finished() {
                // a protocol aborted; tell every device to stop what it was doing
                inner.usb_sender.send_cancel_all();
            }
        }

        if devices_changed {
            self.emit_devices();
        }
        if keys_changed {
            self.emit_keys();
        }
    }

    /// Starts a UI protocol, telling it which devices are already plugged in.
    fn start_protocol<P: UiProtocol + Send + 'static>(&self, mut protocol: P) {
        let connected = self.0.device_list.lock().unwrap().ready_devices();
        for device in connected {
            protocol.connected(device.id, device.mode());
        }
        self.0.ui_stack.lock().unwrap().push(protocol);
    }

    /// Cancels whatever the devices are currently doing (keygen, signing request, address
    /// display, backup display, ...).
    pub fn cancel_protocol(&self) {
        let inner = &self.0;
        let mut coordinator = inner.coordinator.lock().unwrap();
        let mut ui_stack = inner.ui_stack.lock().unwrap();
        // As in the official app: a cancelled keygen must also be dropped from the core, or a
        // late device reply makes the core continue a ceremony the devices already abandoned.
        let keygen_id = ui_stack.get_mut::<KeyGen>().map(|k| k.keygen_id());
        if ui_stack.cancel_all() {
            if let Some(keygen_id) = keygen_id {
                coordinator.MUTATE_NO_PERSIST().cancel_keygen(keygen_id);
            }
            drop(ui_stack);
            drop(coordinator);
            inner.usb_sender.send_cancel_all();
        }
    }

    // =====================================================================================
    // Devices
    // =====================================================================================

    pub fn devices(&self) -> Vec<DeviceView> {
        let coordinator = self.0.coordinator.lock().unwrap();
        let devices = self.0.device_list.lock().unwrap().devices();
        devices
            .into_iter()
            .map(|d| DeviceView {
                id: d.id.to_string(),
                ready: d.ready,
                firmware: d.firmware_name.clone(),
                firmware_status: d.firmware_status().as_str().to_string(),
                needs_name: d.name.is_none(),
                name: d.name,
                nonces: coordinator
                    .nonces_available(d.id)
                    .values()
                    .copied()
                    .max()
                    .unwrap_or(0),
                firmware_digest: d.firmware_digest,
            })
            .collect()
    }

    fn emit_devices(&self) {
        let devices = self.devices();
        self.emit(Event::Devices { devices });
    }

    /// Shows `name` on the device's screen while the user types it.
    pub fn preview_device_name(&self, device_id: &str, name: &str) -> Result<()> {
        let id = parse_device(device_id)?;
        let name = name.trim();
        let device_name: DeviceName = name
            .try_into()
            .map_err(|_| anyhow!("device names must be short plain text"))?;
        self.0.usb_sender.update_name_preview(id, device_name);
        self.0
            .pending_names
            .lock()
            .unwrap()
            .insert(id, name.to_string());
        Ok(())
    }

    /// Asks a device to wipe itself. The user must confirm on the device's own screen; the
    /// device then restarts blank. Emits `Erase` events.
    pub fn erase_device(&self, device_id: &str) -> Result<()> {
        let id = parse_device(device_id)?;
        let ready = self
            .0
            .device_list
            .lock()
            .unwrap()
            .get(id)
            .map(|d| d.ready)
            .unwrap_or(false);
        if !ready {
            return Err(anyhow!("that device isn't plugged in"));
        }
        let events = self.0.events.clone();
        let device_str = id.to_string();
        let protocol = EraseDevice::new(
            id,
            FnSink(move |state: EraseDeviceState| {
                events(Event::Erase(EraseView {
                    device_id: device_str.clone(),
                    confirmed: state == EraseDeviceState::Confirmed,
                }))
            }),
        );
        self.start_protocol(protocol);
        Ok(())
    }

    /// Gives devices fresh nonces so they can sign later. Emits `Nonces` events; if no device
    /// needs any, a single finished event is emitted straight away.
    pub fn replenish_nonces(&self, device_ids: Vec<String>) -> Result<()> {
        let devices: BTreeSet<DeviceId> = device_ids
            .iter()
            .map(|s| parse_device(s))
            .collect::<Result<_>>()?;
        let request = self
            .0
            .coordinator
            .lock()
            .unwrap()
            .MUTATE_NO_PERSIST()
            .maybe_request_nonce_replenishment(&devices, N_NONCE_STREAMS, &mut rand::thread_rng());

        if !request.some_nonces_requested() {
            self.emit(Event::Nonces(NonceView {
                devices: ids(&devices),
                completed_streams: 0,
                total_streams: 0,
                finished: true,
                aborted: false,
            }));
            return Ok(());
        }

        let events = self.0.events.clone();
        let protocol = NonceReplenishProtocol::new(
            devices,
            request,
            FnSink(move |state: NonceReplenishState| {
                events(Event::Nonces(NonceView {
                    devices: ids(&state.devices),
                    completed_streams: state.completed_streams,
                    total_streams: state.total_streams,
                    finished: state.is_finished(),
                    aborted: state.abort,
                }))
            }),
        );
        protocol.emit_state();
        self.start_protocol(protocol);
        Ok(())
    }

    // =====================================================================================
    // Keys: creation, listing, backups
    // =====================================================================================

    /// Starts the key generation ceremony. Every listed device must be plugged in.
    ///
    /// Only blank devices can join, as in the official app: the device firmware is built around
    /// one wallet per device (it expects a new name during every keygen and shows only its first
    /// wallet on the home screen).
    pub fn start_keygen(
        &self,
        device_ids: Vec<String>,
        threshold: u16,
        name: String,
        network: &str,
    ) -> Result<()> {
        let network = parse_network(network)?;
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(anyhow!("give the wallet a name"));
        }
        let requested: HashSet<DeviceId> = device_ids
            .iter()
            .map(|s| parse_device(s))
            .collect::<Result<_>>()?;
        if threshold == 0 || usize::from(threshold) > requested.len() {
            return Err(anyhow!(
                "threshold must be between 1 and the number of devices ({})",
                requested.len()
            ));
        }

        {
            let device_list = self.0.device_list.lock().unwrap();
            for id in &requested {
                let device = device_list
                    .get(*id)
                    .ok_or_else(|| anyhow!("a chosen device is no longer plugged in"))?;
                if let Some(name) = &device.name {
                    return Err(anyhow!(
                        "{name} already holds a wallet. New wallets need blank devices: unplug \
                         it, or erase it first."
                    ));
                }
            }
        }

        let (devices, currently_connected) = {
            let device_list = self.0.device_list.lock().unwrap();
            (
                device_list.sort_as_connected(&requested),
                device_list.ready_ids(),
            )
        };
        let begin_keygen = BeginKeygen::new(
            devices,
            threshold,
            name,
            KeyPurpose::Bitcoin(network),
            &mut rand::thread_rng(),
        );

        let events = self.0.events.clone();
        let sink = FnSink(move |state: KeyGenState| events(Event::Keygen(keygen_view(&state))));
        let protocol = KeyGen::new(
            sink,
            self.0.coordinator.lock().unwrap().MUTATE_NO_PERSIST(),
            currently_connected.into_iter().collect(),
            begin_keygen,
            &mut rand::thread_rng(),
        );
        protocol.emit_state();
        self.start_protocol(protocol);
        Ok(())
    }

    /// Call once every device has acknowledged and the user has checked that all devices show
    /// the same check code. Saves the key and tells the devices to keep their shares.
    pub fn finalize_keygen(&self, keygen_id: &str) -> Result<String> {
        let keygen_id: KeygenId = parse("keygen id", keygen_id)?;
        let inner = &self.0;
        let pending_names = std::mem::take(&mut *inner.pending_names.lock().unwrap());

        let access_structure_ref = {
            let mut coordinator = inner.coordinator.lock().unwrap();
            let mut db = inner.db.lock().unwrap();
            let mut ui_stack = inner.ui_stack.lock().unwrap();
            let keygen = ui_stack
                .get_mut::<KeyGen>()
                .ok_or(anyhow!("no key generation is in progress"))?;
            let participants: BTreeSet<DeviceId> = keygen.devices().iter().copied().collect();

            let finalized = coordinator.staged_mutate(&mut *db, |coordinator| {
                Ok(coordinator.finalize_keygen(
                    keygen_id,
                    DESKTOP_ENCRYPTION_KEY,
                    &mut rand::thread_rng(),
                )?)
            })?;
            let access_structure_ref = finalized.access_structure_ref;
            inner.usb_sender.send_from_core(finalized);

            // Store the names the user typed now, rather than waiting for each device to
            // report its name back.
            let mut device_names = inner.device_names.lock().unwrap();
            for (id, name) in pending_names {
                if !participants.contains(&id) || name.is_empty() {
                    continue;
                }
                if let Err(e) = device_names.staged_mutate(&mut *db, |names| {
                    names.insert(id, name.clone());
                    Ok(())
                }) {
                    event!(Level::ERROR, error = %e, "failed to persist device name");
                }
            }
            drop(device_names);

            keygen.keygen_finalized(access_structure_ref);
            access_structure_ref
        };

        // Track which devices' backups the user has written down.
        let share_indices: Vec<u32> = {
            let coordinator = inner.coordinator.lock().unwrap();
            let access_structure = coordinator
                .get_access_structure(access_structure_ref)
                .ok_or(anyhow!("access structure missing after keygen"))?;
            access_structure
                .iter_shares()
                .map(|(_, share_index)| {
                    u32::try_from(share_index).expect("share index should fit in u32")
                })
                .collect()
        };
        {
            let mut backup_state = inner.backup_state.lock().unwrap();
            let mut db = inner.db.lock().unwrap();
            backup_state.mutate2(&mut *db, |state, mutations| {
                state.start_run(access_structure_ref, share_indices, mutations);
                Ok(())
            })?;
        }

        self.emit_keys();
        Ok(access_structure_ref.key_id.to_string())
    }

    fn frost_key(&self, key_id: KeyId) -> Result<CoordFrostKey> {
        self.0
            .coordinator
            .lock()
            .unwrap()
            .get_frost_key(key_id)
            .cloned()
            .ok_or(anyhow!("unknown wallet {key_id}"))
    }

    pub fn keys(&self) -> Vec<KeyView> {
        let keys: Vec<CoordFrostKey> = self
            .0
            .coordinator
            .lock()
            .unwrap()
            .iter_keys()
            .cloned()
            .collect();
        let backup_runs: HashMap<KeyId, std::collections::BTreeMap<u32, bool>> = {
            let backup_state = self.0.backup_state.lock().unwrap();
            keys.iter()
                .map(|k| (k.key_id, backup_state.get_backup_run(k.key_id)))
                .collect()
        };
        let device_names = self.0.device_names.lock().unwrap();

        keys.into_iter()
            .map(|key| {
                let access_structure = key.master_access_structure();
                let backups = backup_runs.get(&key.key_id);
                let devices = access_structure
                    .device_to_share_indicies()
                    .into_iter()
                    .map(|(id, share_index)| {
                        let share_index = u32::try_from(share_index).unwrap_or(u32::MAX);
                        KeyDeviceView {
                            id: id.to_string(),
                            name: device_names.get(id),
                            share_index,
                            // Backup status lives only in the app that made the wallet (the
                            // devices don't record it), so for a restored wallet it's unknown
                            // until the user shows and confirms a backup here.
                            backup_done: backups.and_then(|b| b.get(&share_index).copied()),
                        }
                    })
                    .collect();
                KeyView {
                    key_id: key.key_id.to_string(),
                    name: key.key_name.clone(),
                    network: key.purpose.bitcoin_network().map(|n| n.to_string()),
                    threshold: access_structure.threshold(),
                    access_structure_id: access_structure.access_structure_id().to_string(),
                    devices,
                }
            })
            .collect()
    }

    fn emit_keys(&self) {
        let keys = self.keys();
        self.emit(Event::Keys { keys });
    }

    /// Asks a device to show its backup (share) on its own screen. The backup never leaves the
    /// device. Emits `DisplayBackup` events; when `confirmed` arrives, call
    /// [`Self::mark_backup_complete`].
    pub fn display_backup(&self, key_id: &str, device_id: &str) -> Result<()> {
        let key = self.frost_key(parse_key(key_id)?)?;
        let device_id = parse_device(device_id)?;
        let access_structure_ref = key.master_access_structure().access_structure_ref();
        let events = self.0.events.clone();
        let device_str = device_id.to_string();
        let protocol = DisplayBackupProtocol::new(
            self.0.coordinator.lock().unwrap().MUTATE_NO_PERSIST(),
            device_id,
            access_structure_ref,
            DESKTOP_ENCRYPTION_KEY,
            FnSink(move |state: DisplayBackupState| {
                events(Event::DisplayBackup(DisplayBackupView {
                    device_id: device_str.clone(),
                    confirmed: state.confirmed,
                    closed: state.close_dialog,
                }))
            }),
        )?;
        self.start_protocol(protocol);
        Ok(())
    }

    /// Asks a device to check the user's written-down backup: the user enters the words on the
    /// device itself, which compares them with its share. The words never reach the computer.
    /// Emits `CheckBackup` when the device answers; the UI then calls
    /// [`Self::mark_backup_complete`] if it matched.
    pub fn check_backup(&self, key_id: &str, device_id: &str) -> Result<()> {
        let key = self.frost_key(parse_key(key_id)?)?;
        let device_id = parse_device(device_id)?;
        let access_structure = key.master_access_structure();
        let share_index = access_structure
            .device_to_share_indicies()
            .get(&device_id)
            .copied()
            .ok_or(anyhow!("that device holds no share of this wallet"))?;
        let firmware = self
            .0
            .device_list
            .lock()
            .unwrap()
            .get(device_id)
            .filter(|d| d.ready)
            .and_then(|d| d.firmware)
            .ok_or(anyhow!("plug the device in first"))?;
        let events = self.0.events.clone();
        let device_str = device_id.to_string();
        let protocol = CheckBackupProtocol::new(
            self.0.coordinator.lock().unwrap().MUTATE_NO_PERSIST(),
            device_id,
            access_structure.access_structure_ref(),
            share_index,
            DESKTOP_ENCRYPTION_KEY,
            firmware,
            FnSink(move |state: CheckBackupState| {
                events(Event::CheckBackup(CheckBackupView {
                    device_id: device_str.clone(),
                    valid: state.backup_manually_entered_valid.unwrap_or(true),
                }))
            }),
        )?;
        self.start_protocol(protocol);
        Ok(())
    }

    pub fn mark_backup_complete(&self, key_id: &str, device_id: &str) -> Result<()> {
        let key = self.frost_key(parse_key(key_id)?)?;
        let device_id = parse_device(device_id)?;
        let access_structure = key.master_access_structure();
        let share_index = access_structure
            .device_to_share_indicies()
            .get(&device_id)
            .copied()
            .ok_or(anyhow!("that device holds no share of this wallet"))?;
        let share_index = u32::try_from(share_index).expect("share index should fit in u32");
        {
            let mut backup_state = self.0.backup_state.lock().unwrap();
            let mut db = self.0.db.lock().unwrap();
            backup_state.mutate2(&mut *db, |state, mutations| {
                state.mark_backup_complete(
                    access_structure.access_structure_ref(),
                    share_index,
                    mutations,
                );
                Ok(())
            })?;
        }
        self.emit_keys();
        Ok(())
    }

    /// Removes a wallet from Icebox only, as the official app's "Delete wallet" does. Nothing on
    /// the devices changes: their shares stay, and the wallet can be restored from them later.
    /// Payments in progress for it are cancelled first.
    pub fn delete_wallet(&self, key_id: &str) -> Result<()> {
        let key_id = parse_key(key_id)?;
        self.frost_key(key_id)?;
        self.cancel_protocol();
        {
            let mut coordinator = self.0.coordinator.lock().unwrap();
            let mut db = self.0.db.lock().unwrap();
            let active: Vec<_> = coordinator
                .active_signing_sessions()
                .filter(|s| s.key_id == key_id)
                .map(|s| s.session_id())
                .collect();
            let finished: Vec<_> = coordinator
                .finished_signing_sessions()
                .iter()
                .filter(|(_, s)| s.key_id == key_id)
                .map(|(id, _)| *id)
                .collect();
            coordinator.staged_mutate(&mut *db, |coordinator| {
                for id in active {
                    coordinator.cancel_sign_session(id);
                }
                for id in finished {
                    coordinator.forget_finished_sign_session(id);
                }
                coordinator.delete_key(key_id);
                Ok(())
            })?;
        }
        {
            // backup_state is never held together with coordinator (see the lock order above)
            let mut backup_state = self.0.backup_state.lock().unwrap();
            let mut db = self.0.db.lock().unwrap();
            backup_state.mutate2(&mut *db, |state, mutations| {
                state.clear_backup_run(key_id, mutations);
                Ok(())
            })?;
        }
        {
            let mut pending = self.0.pending_send.lock().unwrap();
            if pending.as_ref().is_some_and(|p| p.key_id == key_id) {
                *pending = None;
            }
        }
        tracing::info!(%key_id, "removed wallet from Icebox");
        self.emit_keys();
        Ok(())
    }

    /// The wallet's output descriptor, for setting up a watch-only wallet elsewhere.
    pub fn descriptor(&self, key_id: &str) -> Result<String> {
        let key = self.frost_key(parse_key(key_id)?)?;
        let network = key_network(&key)?;
        Ok(
            frostsnap_coordinator::bitcoin::multi_x_descriptor_for_account(
                key.complete_key.master_appkey,
                BitcoinAccount::default(),
                network.into(),
            )
            .to_string(),
        )
    }

    /// The descriptor as a QR code, for scanning into a watch-only wallet (Sparrow, the
    /// official app, another Icebox). Low error correction keeps the code small enough to scan
    /// easily from a screen.
    pub fn descriptor_qr(&self, key_id: &str) -> Result<String> {
        qr_svg(&self.descriptor(key_id)?, qrcode::EcLevel::L)
    }

    // =====================================================================================
    // Restoring a wallet from its devices
    // =====================================================================================

    /// Starts asking every plugged-in device which wallet shares it holds. Stays open (and asks
    /// newly plugged-in devices too) until `cancel_protocol`. Emits `RestoreScanChanged`.
    pub fn start_restore_scan(&self) -> Result<()> {
        let events = self.0.events.clone();
        // The sink runs inside the device loop, which holds the coordinator lock, so it only
        // signals; the UI then calls `restore_candidates` from its own thread.
        let protocol = ScanHeldShares::new(
            self.0.scan_results.clone(),
            FnSink(move |()| events(Event::RestoreScanChanged)),
        );
        self.start_protocol(protocol);
        Ok(())
    }

    fn candidates(&self) -> Vec<restore::Candidate> {
        restore::group(&self.0.scan_results.lock().unwrap())
    }

    /// The wallets found so far by the restore scan, grouped, with whether each can be restored.
    pub fn restore_candidates(&self) -> RestoreScanView {
        let results = self.0.scan_results.lock().unwrap().clone();
        let candidates = restore::group(&results);
        let connected = self.0.device_list.lock().unwrap().ready_ids();
        let coordinator = self.0.coordinator.lock().unwrap();
        let device_names = self.0.device_names.lock().unwrap();
        let live_names: HashMap<DeviceId, String> = self
            .0
            .device_list
            .lock()
            .unwrap()
            .devices()
            .into_iter()
            .filter_map(|d| Some((d.id, d.name?)))
            .collect();

        let views = candidates
            .iter()
            .map(|c| {
                let found = c.distinct_shares();
                let already_here = c
                    .access_structure_ref
                    .map(|r| coordinator.get_access_structure(r).is_some())
                    .unwrap_or(false);
                let status = if already_here {
                    "already_here"
                } else if c.network.is_none() {
                    "not_bitcoin"
                } else {
                    match c.threshold {
                        Some(t) if found >= usize::from(t) => "ready",
                        Some(_) => "need_more",
                        None => "unknown_threshold",
                    }
                };
                RestoreCandidateView {
                    group_id: c.group_id.clone(),
                    name: c
                        .key_name
                        .clone()
                        .unwrap_or_else(|| "Unnamed wallet".into()),
                    network: c.network.map(|n| n.to_string()),
                    threshold: c.threshold,
                    found,
                    status: status.to_string(),
                    devices: c
                        .shares
                        .iter()
                        .map(|s| RestoreDeviceView {
                            id: s.held_by.to_string(),
                            name: live_names
                                .get(&s.held_by)
                                .cloned()
                                .or_else(|| device_names.get(s.held_by)),
                            share_number: restore::share_number(&s.held_share),
                            connected: connected.contains(&s.held_by),
                        })
                        .collect(),
                }
            })
            .collect();

        RestoreScanView {
            answered: results
                .iter()
                .filter(|(_, a)| a.is_some())
                .map(|(id, _)| id.to_string())
                .collect(),
            waiting: results
                .iter()
                .filter(|(_, a)| a.is_none())
                .map(|(id, _)| id.to_string())
                .collect(),
            candidates: views,
        }
    }

    /// Rebuilds a wallet from the shares the scan found for it, using the official restoration
    /// code. Shares that turn out not to fit are skipped. Returns the new wallet's key id.
    pub fn restore_wallet(&self, group_id: &str) -> Result<String> {
        let candidate = self
            .candidates()
            .into_iter()
            .find(|c| c.group_id == group_id)
            .ok_or(anyhow!(
                "those devices are no longer in the scan results; scan again"
            ))?;
        if let Some(r) = candidate.access_structure_ref {
            if self
                .0
                .coordinator
                .lock()
                .unwrap()
                .get_access_structure(r)
                .is_some()
            {
                return Err(anyhow!("this wallet is already in Icebox"));
            }
        }
        let (first, rest) = candidate
            .shares
            .split_first()
            .ok_or(anyhow!("no shares found for that wallet"))?;

        let inner = &self.0;
        let mut coordinator = inner.coordinator.lock().unwrap();
        let mut db = inner.db.lock().unwrap();
        let restoration_id = frostsnap_core::RestorationId::new(&mut rand::thread_rng());

        // Each step is its own persisted mutation. The core functions check before they change
        // anything, so an error inside one leaves nothing half-done to be saved later.
        coordinator
            .staged_mutate(&mut *db, |c| {
                Ok(c.start_restoring_key_from_recover_share(first, restoration_id))
            })?
            .map_err(|e| anyhow!("can't start restoring from that device: {e:?}"))?;

        let mut skipped = 0;
        for share in rest {
            let added = coordinator.staged_mutate(&mut *db, |c| {
                Ok(c.add_recovery_share_to_restoration(
                    restoration_id,
                    share,
                    DESKTOP_ENCRYPTION_KEY,
                ))
            })?;
            if let Err(e) = added {
                skipped += 1;
                event!(Level::WARN, device = %share.held_by, "share didn't fit the restoration: {e:?}");
            }
        }

        let state = coordinator
            .get_restoration_state(restoration_id)
            .ok_or(anyhow!("restoration vanished"))?;
        if !state.is_restorable() {
            coordinator.staged_mutate(&mut *db, |c| {
                c.cancel_restoration(restoration_id);
                Ok(())
            })?;
            let count = state.status().share_count();
            return Err(anyhow!(
                "not enough matching shares yet ({} of {} needed{}). Plug in more of this wallet's devices.",
                count.got.unwrap_or(0),
                count
                    .needed
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| "?".into()),
                if skipped > 0 {
                    format!(", {skipped} didn't match")
                } else {
                    String::new()
                }
            ));
        }
        let needs_consolidation: Vec<DeviceId> = state.needs_to_consolidate().collect();

        let access_structure_ref = coordinator
            .staged_mutate(&mut *db, |c| {
                Ok(c.finish_restoring(
                    restoration_id,
                    DESKTOP_ENCRYPTION_KEY,
                    &mut rand::thread_rng(),
                ))
            })?
            .map_err(|e| anyhow!("couldn't finish restoring: {e:?}"))?;

        // A device restored earlier from written-down backup words keeps that share in a
        // temporary form until the coordinator tells it the wallet is whole again. Do that now
        // for any such device that's plugged in.
        let connected = inner.device_list.lock().unwrap().ready_ids();
        for device_id in needs_consolidation {
            if !connected.contains(&device_id) {
                continue;
            }
            match coordinator.consolidate_pending_physical_backups(
                device_id,
                access_structure_ref,
                DESKTOP_ENCRYPTION_KEY,
            ) {
                Ok(Some(message)) => inner.usb_sender.send_from_core([message]),
                Ok(None) => {}
                Err(e) => event!(Level::ERROR, device = %device_id, "couldn't consolidate: {e:?}"),
            }
        }
        drop(db);
        drop(coordinator);

        event!(Level::INFO, key = %access_structure_ref.key_id, "wallet restored from devices");
        self.emit_keys();
        Ok(access_structure_ref.key_id.to_string())
    }

    // =====================================================================================
    // Wallet: balance, history, receiving
    // =====================================================================================

    fn wallet_for(&self, key: &CoordFrostKey) -> Result<(Network, Arc<Mutex<CoordSuperWallet>>)> {
        let network = key_network(key)?;
        let wallet = self
            .0
            .wallets
            .get(&network)
            .cloned()
            .ok_or(anyhow!("network {network} is not loaded"))?;
        Ok((network, wallet))
    }

    fn chain(&self, network: Network) -> Result<&ChainClient> {
        self.0
            .chains
            .get(&network)
            .ok_or(anyhow!("network {network} is not loaded"))
    }

    pub fn wallet(&self, key_id: &str) -> Result<WalletView> {
        let key = self.frost_key(parse_key(key_id)?)?;
        let master_appkey = key.complete_key.master_appkey;
        let (network, wallet) = self.wallet_for(&key)?;
        let mut wallet = wallet.lock().unwrap();
        let height = wallet.chain_tip().height();
        let txs = wallet.list_transactions(master_appkey);
        drop(wallet);

        let mut balance = 0i64;
        let mut pending_incoming = 0i64;
        let mut views = Vec::with_capacity(txs.len());
        for tx in &txs {
            let owned_in: Option<u64> = tx
                .inner
                .input
                .iter()
                .map(|txin| tx.prevouts.get(&txin.previous_output))
                .collect::<Option<Vec<_>>>()
                .map(|prevouts| {
                    prevouts
                        .into_iter()
                        .filter(|p| tx.is_mine.contains_key(&p.script_pubkey))
                        .map(|p| p.value.to_sat())
                        .sum()
                });
            let owned_out: u64 = tx
                .inner
                .output
                .iter()
                .filter(|o| tx.is_mine.contains_key(&o.script_pubkey))
                .map(|o| o.value.to_sat())
                .sum();
            let spent = owned_in.unwrap_or(0) as i64;
            let created = owned_out as i64;
            // Same accounting as the official app: unconfirmed funds from others are kept
            // separate until they confirm.
            if spent == 0 && tx.confirmation_time.is_none() {
                pending_incoming += created;
            } else {
                balance += created - spent;
            }

            let fee = tx
                .inner
                .input
                .iter()
                .map(|txin| {
                    tx.prevouts
                        .get(&txin.previous_output)
                        .map(|o| o.value.to_sat())
                })
                .sum::<Option<u64>>()
                .map(|inputs| {
                    inputs.saturating_sub(tx.inner.output.iter().map(|o| o.value.to_sat()).sum())
                });
            views.push(TxView {
                txid: tx.txid.to_string(),
                net_value: owned_in.map(|spent| created - spent as i64),
                fee,
                confirmations: tx.confirmations,
                timestamp: tx
                    .confirmation_time
                    .as_ref()
                    .map(|t| t.time)
                    .or(tx.last_seen),
            });
        }
        if balance < 0 {
            pending_incoming += balance;
            balance = 0;
        }

        Ok(WalletView {
            key_id: key.key_id.to_string(),
            network: network.to_string(),
            height,
            balance,
            pending_incoming,
            txs: views,
        })
    }

    /// Reveals the next unused receive address.
    pub fn next_address(&self, key_id: &str) -> Result<AddressView> {
        let key = self.frost_key(parse_key(key_id)?)?;
        let (_, wallet) = self.wallet_for(&key)?;
        let info = wallet
            .lock()
            .unwrap()
            .next_address(key.complete_key.master_appkey);
        address_view(info.index, &info.address, info.used)
    }

    /// Records that receive address `index` was handed out (copied, shown, or checked on a
    /// device), as the official app does, so the next `next_address` is a fresh one.
    pub fn mark_address_shared(&self, key_id: &str, index: u32) -> Result<()> {
        let key = self.frost_key(parse_key(key_id)?)?;
        let (_, wallet) = self.wallet_for(&key)?;
        wallet
            .lock()
            .unwrap()
            .mark_address_shared(key.complete_key.master_appkey, index)?;
        Ok(())
    }

    /// Every receive address handed out so far plus the next one, newest first, with whether
    /// each has received coins (to discourage reuse).
    pub fn addresses(&self, key_id: &str) -> Result<Vec<AddressListItem>> {
        let key = self.frost_key(parse_key(key_id)?)?;
        let (_, wallet) = self.wallet_for(&key)?;
        let list = wallet
            .lock()
            .unwrap()
            .list_addresses(key.complete_key.master_appkey);
        Ok(list
            .into_iter()
            .map(|a| AddressListItem {
                index: a.index,
                address: a.address.to_string(),
                used: a.used,
                shared: a.revealed,
            })
            .collect())
    }

    /// One receive address, with its QR code, to show again.
    pub fn address(&self, key_id: &str, index: u32) -> Result<AddressView> {
        let key = self.frost_key(parse_key(key_id)?)?;
        let (_, wallet) = self.wallet_for(&key)?;
        let info = wallet
            .lock()
            .unwrap()
            .address(key.complete_key.master_appkey, index)
            .ok_or_else(|| anyhow!("address index {index} is out of range"))?;
        address_view(info.index, &info.address, info.used)
    }

    /// Shows receive address `index` on the devices so the user can check it there. Never hand
    /// out an address that has not been checked on a device.
    pub fn verify_address(&self, key_id: &str, index: u32) -> Result<()> {
        let key_id = parse_key(key_id)?;
        let index = NormalIndex::new(index)
            .ok_or_else(|| anyhow!("address index {index} is out of range"))?;
        let messages = self
            .0
            .coordinator
            .lock()
            .unwrap()
            .verify_address(key_id, index)?;
        let events = self.0.events.clone();
        let protocol = VerifyAddressProtocol::new(
            messages,
            FnSink(move |state: VerifyAddressProtocolState| {
                events(Event::VerifyAddress(VerifyAddressView {
                    target_devices: ids(&state.target_devices),
                    connected_devices: ids(&state.connected_devices),
                }))
            }),
        );
        protocol.emit_state();
        self.start_protocol(protocol);
        Ok(())
    }

    // =====================================================================================
    // Sending
    // =====================================================================================

    pub fn fee_estimates(&self, network: &str) -> Result<Vec<FeeEstimate>> {
        let network = parse_network(network)?;
        let estimates = self.chain(network)?.estimate_fee([1usize, 3, 6, 25])?;
        Ok(estimates
            .into_iter()
            .map(|(target_blocks, rate)| FeeEstimate {
                target_blocks,
                sat_per_vb: rate.to_sat_per_vb_ceil(),
            })
            .collect())
    }

    /// Selects coins for a payment and returns what it would cost. Nothing is reserved until
    /// [`Self::start_send`]. `amount` of `None` sends everything.
    pub fn prepare_send(
        &self,
        key_id: &str,
        address: &str,
        amount: Option<u64>,
        feerate: f32,
    ) -> Result<SendPreview> {
        let key_id = parse_key(key_id)?;
        let key = self.frost_key(key_id)?;
        let (network, wallet) = self.wallet_for(&key)?;
        if !(feerate.is_finite() && feerate >= 1.0) {
            return Err(anyhow!("fee rate must be at least 1 sat/vB"));
        }
        let address = parse_address(address, network)?;
        if amount == Some(0) {
            return Err(anyhow!("amount must be more than zero"));
        }

        let plan = wallet
            .lock()
            .unwrap()
            .plan_send(
                key.complete_key.master_appkey,
                [(address.clone(), amount)],
                feerate,
            )
            .map_err(|e| anyhow!("can't build that payment: {e}"))?;

        // Nodes refuse to relay a payment whose output is "dust" (under ~330 sats for taproot),
        // so catch it here rather than after every device has signed.
        check_not_dust(&address, plan.recipient_value(0).unwrap_or(0))?;

        let preview = SendPreview {
            recipient: address.to_string(),
            amount: plan.recipient_value(0).unwrap_or(0),
            fee: plan.fee(),
            change: plan.change_value(),
            input_count: plan.input_count(),
            feerate,
        };
        *self.0.pending_send.lock().unwrap() = Some(PendingSend { key_id, plan });
        Ok(preview)
    }

    /// Commits the prepared payment and opens a signing session with `signer_ids` (exactly the
    /// wallet's threshold of devices). Returns the session id; progress arrives as `Signing`
    /// events.
    pub fn start_send(&self, key_id: &str, signer_ids: Vec<String>) -> Result<String> {
        let key_id = parse_key(key_id)?;
        let key = self.frost_key(key_id)?;
        let master_appkey = key.complete_key.master_appkey;
        let (_, wallet) = self.wallet_for(&key)?;
        let access_structure = key.master_access_structure();
        let signers: BTreeSet<DeviceId> = signer_ids
            .iter()
            .map(|s| parse_device(s))
            .collect::<Result<_>>()?;
        if signers.len() != usize::from(access_structure.threshold()) {
            return Err(anyhow!(
                "choose exactly {} devices to sign",
                access_structure.threshold()
            ));
        }
        for signer in &signers {
            if !access_structure.contains_device(*signer) {
                return Err(anyhow!("device {signer} is not part of this wallet"));
            }
        }
        {
            let coordinator = self.0.coordinator.lock().unwrap();
            for signer in &signers {
                let nonces = coordinator
                    .nonces_available(*signer)
                    .values()
                    .copied()
                    .max()
                    .unwrap_or(0);
                if nonces == 0 {
                    return Err(anyhow!(
                        "a chosen device has no signing nonces left: plug it in and use \
                         \"Prepare devices\" first"
                    ));
                }
            }
        }

        let pending = self
            .0
            .pending_send
            .lock()
            .unwrap()
            .take()
            .ok_or(anyhow!("prepare the payment first"))?;
        if pending.key_id != key_id {
            return Err(anyhow!("the prepared payment is for a different wallet"));
        }

        let reserved = self
            .0
            .coordinator
            .lock()
            .unwrap()
            .reserved_change_indices(master_appkey, BitcoinAccount::default());
        let template = wallet
            .lock()
            .unwrap()
            .commit_send(&pending.plan, reserved)?;
        if !template.as_seen_by(master_appkey).has_any_inputs_to_sign() {
            return Err(anyhow!("the payment spends none of this wallet's coins"));
        }

        self.start_signing(
            access_structure.access_structure_ref(),
            signers,
            WireSignTask::BitcoinTransaction(template),
        )
    }

    fn start_signing(
        &self,
        access_structure_ref: AccessStructureRef,
        signers: BTreeSet<DeviceId>,
        task: WireSignTask,
    ) -> Result<String> {
        let session_id = {
            let mut coordinator = self.0.coordinator.lock().unwrap();
            let mut db = self.0.db.lock().unwrap();
            coordinator.staged_mutate(&mut *db, |coordinator| {
                Ok(coordinator.start_sign(
                    access_structure_ref,
                    task,
                    &signers,
                    &mut rand::thread_rng(),
                )?)
            })?
        };
        let mut protocol = SigningDispatcher::new(
            signers,
            access_structure_ref.key_id,
            session_id,
            self.signing_sink(),
        );
        protocol.emit_state();
        self.start_protocol(protocol);
        Ok(session_id.to_string())
    }

    fn signing_sink(&self) -> impl Sink<SigningState> {
        let events = self.0.events.clone();
        FnSink(move |state: SigningState| {
            events(Event::Signing(SigningView {
                session_id: state.session_id.to_string(),
                got_shares: ids(&state.got_shares),
                needed_from: ids(&state.needed_from),
                connected_but_need_request: ids(&state.connected_but_need_request),
                finished: state.finished_signatures.is_some(),
                aborted: state.aborted.clone(),
            }))
        })
    }

    /// Re-opens a signing session after the app was restarted.
    pub fn resume_signing(&self, session_id: &str) -> Result<()> {
        let session_id = parse_session(session_id)?;
        let session = self
            .0
            .coordinator
            .lock()
            .unwrap()
            .active_signing_sessions_by_ssid()
            .get(&session_id)
            .cloned()
            .ok_or(anyhow!("that signing session no longer exists"))?;
        let mut protocol =
            SigningDispatcher::restore_signing_session(&session, self.signing_sink());
        protocol.emit_state();
        self.start_protocol(protocol);
        Ok(())
    }

    /// Sends the signing request to one plugged-in device. The device then shows the
    /// transaction and the user approves it there.
    pub fn request_device_sign(&self, session_id: &str, device_id: &str) -> Result<()> {
        let session_id = parse_session(session_id)?;
        let device_id = parse_device(device_id)?;
        let inner = &self.0;
        if inner
            .ui_stack
            .lock()
            .unwrap()
            .get_mut::<SigningDispatcher>()
            .is_none()
        {
            return Err(anyhow!("no signing session is open"));
        }
        let sign_request = {
            let mut coordinator = inner.coordinator.lock().unwrap();
            let mut db = inner.db.lock().unwrap();
            coordinator.staged_mutate(&mut *db, |coordinator| {
                Ok(coordinator.request_device_sign(session_id, device_id, DESKTOP_ENCRYPTION_KEY))
            })?
        };
        let mut ui_stack = inner.ui_stack.lock().unwrap();
        let signing = ui_stack
            .get_mut::<SigningDispatcher>()
            .ok_or(anyhow!("the signing session closed"))?;
        signing.send_sign_request(sign_request);
        Ok(())
    }

    pub fn cancel_sign_session(&self, session_id: &str) -> Result<()> {
        let session_id = parse_session(session_id)?;
        {
            let mut coordinator = self.0.coordinator.lock().unwrap();
            let mut db = self.0.db.lock().unwrap();
            // A fully signed payment has moved from the active sessions to the finished ones,
            // which `cancel_sign_session` doesn't touch; those are forgotten instead (as the
            // official app does). Either way its coins and change address are released.
            let finished = coordinator
                .finished_signing_sessions()
                .contains_key(&session_id);
            coordinator.staged_mutate(&mut *db, |coordinator| {
                if finished {
                    coordinator.forget_finished_sign_session(session_id);
                } else {
                    coordinator.cancel_sign_session(session_id);
                }
                Ok(())
            })?;
            tracing::info!(%session_id, finished, "cancelled sign session");
        }
        self.cancel_protocol();
        Ok(())
    }

    /// Payments for this wallet that are being signed, or signed but not yet broadcast.
    pub fn sessions(&self, key_id: &str) -> Result<Vec<SessionView>> {
        let key_id = parse_key(key_id)?;
        let key = self.frost_key(key_id)?;
        let master_appkey = key.complete_key.master_appkey;
        let (network, wallet) = self.wallet_for(&key)?;
        let known_txids: HashSet<bitcoin::Txid> = wallet
            .lock()
            .unwrap()
            .list_transactions(master_appkey)
            .into_iter()
            .map(|tx| tx.txid)
            .collect();

        let coordinator = self.0.coordinator.lock().unwrap();
        let mut sessions = vec![];
        for session in coordinator.active_signing_sessions() {
            if session.key_id != key_id {
                continue;
            }
            if let WireSignTask::BitcoinTransaction(template) =
                &session.init.group_request.sign_task
            {
                sessions.push(session_view(
                    network,
                    master_appkey,
                    session.session_id(),
                    key_id,
                    template,
                    session.init.nonces.keys().copied().collect(),
                    session.received_from().collect(),
                    false,
                ));
            }
        }
        for (&session_id, session) in coordinator.finished_signing_sessions() {
            if session.key_id != key_id || session.signatures.is_empty() {
                continue;
            }
            if let WireSignTask::BitcoinTransaction(template) =
                &session.init.group_request.sign_task
            {
                if known_txids.contains(&template.txid()) {
                    continue; // already broadcast and seen by the wallet
                }
                let signers: Vec<DeviceId> = session.init.nonces.keys().copied().collect();
                sessions.push(session_view(
                    network,
                    master_appkey,
                    session_id,
                    key_id,
                    template,
                    signers.clone(),
                    signers,
                    true,
                ));
            }
        }
        Ok(sessions)
    }

    /// Broadcasts a fully signed payment.
    pub fn broadcast(&self, session_id: &str) -> Result<String> {
        let session_id = parse_session(session_id)?;
        let (template, signatures, key_id) = {
            let coordinator = self.0.coordinator.lock().unwrap();
            let session = coordinator
                .finished_signing_sessions()
                .get(&session_id)
                .ok_or(anyhow!("that payment has not finished signing"))?;
            match &session.init.group_request.sign_task {
                WireSignTask::BitcoinTransaction(template) => {
                    (template.clone(), session.signatures.clone(), session.key_id)
                }
                _ => return Err(anyhow!("that session did not sign a bitcoin transaction")),
            }
        };
        let key = self.frost_key(key_id)?;
        let (network, wallet) = self.wallet_for(&key)?;
        let tx = template
            .as_seen_by(key.complete_key.master_appkey)
            .to_signed_rust_bitcoin_tx(&signatures)
            .map_err(|e| anyhow!("signatures don't match the transaction: {e:?}"))?;

        let txid = self
            .chain(network)?
            .broadcast(tx.clone())
            .context("broadcast failed")?;
        wallet.lock().unwrap().broadcast_success(tx);

        {
            let mut coordinator = self.0.coordinator.lock().unwrap();
            let mut db = self.0.db.lock().unwrap();
            coordinator.staged_mutate(&mut *db, |coordinator| {
                coordinator.forget_finished_sign_session(session_id);
                Ok(())
            })?;
        }
        self.emit(Event::WalletChanged {
            key_id: key_id.to_string(),
        });
        Ok(txid.to_string())
    }

    // =====================================================================================
    // Electrum settings
    // =====================================================================================

    pub fn electrum_servers(&self, network: &str) -> Result<ElectrumView> {
        let network = parse_network(network)?;
        let settings = self.0.settings.lock().unwrap();
        Ok(ElectrumView {
            network: network.to_string(),
            primary: settings.get_electrum_server(network),
            backup: settings.get_backup_electrum_server(network),
        })
    }

    /// Sets the Electrum servers for a network. Use `ssl://host:port` or, for a node on your
    /// own machine or LAN, `tcp://host:port`.
    pub fn set_electrum_servers(&self, network: &str, primary: &str, backup: &str) -> Result<()> {
        let network = parse_network(network)?;
        let primary = primary.trim().to_string();
        let backup = backup.trim().to_string();
        for url in [&primary, &backup] {
            if !(url.starts_with("ssl://") || url.starts_with("tcp://")) {
                return Err(anyhow!(
                    "server addresses look like ssl://host:port or tcp://host:port"
                ));
            }
        }
        {
            let mut settings = self.0.settings.lock().unwrap();
            let mut db = self.0.db.lock().unwrap();
            settings.mutate2(&mut *db, |settings, update| {
                settings.set_electrum_server(network, primary.clone(), update);
                settings.set_backup_electrum_server(network, backup.clone(), update);
                Ok(())
            })?;
        }
        self.chain(network)?.set_urls(primary, backup);
        Ok(())
    }

    pub fn reconnect(&self, network: &str) -> Result<()> {
        self.chain(parse_network(network)?)?.reconnect();
        Ok(())
    }
}

// ---------- free helpers ----------

fn wallet_db_file(app_dir: &Path, network: Network) -> PathBuf {
    // same file name as the official app
    app_dir.join(format!("wallet-{network}.sql"))
}

fn key_network(key: &CoordFrostKey) -> Result<Network> {
    key.purpose
        .bitcoin_network()
        .ok_or(anyhow!("this key is not a bitcoin wallet"))
}

fn parse_address(address: &str, network: Network) -> Result<Address> {
    let address = address.trim();
    // accept "bitcoin:<address>?..." URIs by keeping just the address part
    let address = address
        .strip_prefix("bitcoin:")
        .or_else(|| address.strip_prefix("BITCOIN:"))
        .map(|rest| rest.split('?').next().unwrap_or(rest))
        .unwrap_or(address);
    Address::from_str(address)
        .map_err(|_| anyhow!("that is not a valid bitcoin address"))?
        .require_network(network)
        .map_err(|_| anyhow!("that address is not for {network}"))
}

/// Errors if paying `value` sats to `address` would make a dust output, which Bitcoin nodes won't
/// relay (the threshold depends on the address type: 330 sats for taproot, 294 for P2WPKH).
fn check_not_dust(address: &Address, value: u64) -> Result<()> {
    let min = address.script_pubkey().minimal_non_dust().to_sat();
    if value < min {
        return Err(anyhow!(
            "{value} sats is too small to send to this address: Bitcoin nodes won't relay \
             payments under {min} sats to it (they count as \"dust\"). Send at least {min} sats."
        ));
    }
    Ok(())
}

/// A QR code of `text` as an SVG data URI (the page's CSP allows `data:` images).
fn qr_svg(text: &str, ec_level: qrcode::EcLevel) -> Result<String> {
    let code = qrcode::QrCode::with_error_correction_level(text.as_bytes(), ec_level)
        .map_err(|e| anyhow!("can't make QR code: {e}"))?;
    let svg = code
        .render::<qrcode::render::svg::Color<'_>>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .build();
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, svg)
    ))
}

fn address_view(index: u32, address: &Address, used: bool) -> Result<AddressView> {
    let text = address.to_string();
    // A BIP21 "bitcoin:" link, so phone cameras offer to open a wallet app instead of showing
    // bare text. All upper case lets the QR use its compact alphanumeric mode; wallets accept it.
    let qr_svg = qr_svg(
        &format!("BITCOIN:{}", text.to_uppercase()),
        qrcode::EcLevel::M,
    )?;
    Ok(AddressView {
        index,
        address: text,
        used,
        qr_svg,
    })
}

fn keygen_view(state: &KeyGenState) -> KeygenView {
    KeygenView {
        keygen_id: state.keygen_id.to_string(),
        threshold: state.threshold,
        devices: ids(&state.devices),
        got_shares: ids(&state.got_shares),
        session_acks: ids(&state.session_acks),
        all_acks: state.all_acks,
        check_code: state
            .session_hash
            .map(|hash| frostsnap_core::hex::encode(&hash.0[..4])),
        finished: state.finished.map(|r| r.key_id.to_string()),
        aborted: state.aborted.clone(),
    }
}

fn chain_view(network: Network, status: &ChainStatus) -> ChainView {
    let state = match status.state {
        ChainStatusState::Idle => "idle",
        ChainStatusState::Connecting => "connecting",
        ChainStatusState::Connected => "connected",
        ChainStatusState::Disconnected => "disconnected",
    };
    ChainView {
        network: network.to_string(),
        state: state.to_string(),
        url: if status.on_backup {
            status.backup_url.clone()
        } else {
            status.primary_url.clone()
        },
    }
}

#[allow(clippy::too_many_arguments)]
fn session_view(
    network: Network,
    master_appkey: frostsnap_core::MasterAppkey,
    session_id: SignSessionId,
    key_id: KeyId,
    template: &TransactionTemplate,
    signers: Vec<DeviceId>,
    got_shares: Vec<DeviceId>,
    signed: bool,
) -> SessionView {
    let scoped = template.as_seen_by(master_appkey);
    SessionView {
        session_id: session_id.to_string(),
        key_id: key_id.to_string(),
        txid: template.txid().to_string(),
        fee: scoped.fee(),
        feerate: scoped.feerate(),
        recipients: scoped
            .foreign_recipients()
            .map(|(script, amount)| RecipientView {
                address: Address::from_script(script, network)
                    .ok()
                    .map(|a| a.to_string()),
                amount,
            })
            .collect(),
        signers: ids(&signers),
        got_shares: ids(&got_shares),
        signed,
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn descriptor_sized_text_makes_a_qr_code() {
        let descriptor = format!("tr([39532015/0/0]tpub{}/<0;1>/*)#7jyky7mh", "x".repeat(107));
        let svg = qr_svg(&descriptor, qrcode::EcLevel::L).unwrap();
        assert!(svg.starts_with("data:image/svg+xml;base64,"));
    }

    #[test]
    fn dust_payments_are_refused() {
        // the BIP-86 test vector's first taproot address
        let tr = parse_address(
            "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr",
            Network::Bitcoin,
        )
        .unwrap();
        assert!(check_not_dust(&tr, 329).is_err());
        assert!(check_not_dust(&tr, 330).is_ok());
        let wpkh = parse_address(
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
            Network::Bitcoin,
        )
        .unwrap();
        assert!(check_not_dust(&wpkh, 293).is_err());
        assert!(check_not_dust(&wpkh, 294).is_ok());
    }

    #[test]
    fn networks_parse_and_unsupported_ones_are_refused() {
        assert_eq!(parse_network("signet").unwrap(), Network::Signet);
        assert_eq!(parse_network(" bitcoin ").unwrap(), Network::Bitcoin);
        assert!(parse_network("testnet4").is_err());
        assert!(parse_network("dogecoin").is_err());
    }

    #[test]
    fn addresses_must_match_the_wallet_network() {
        let signet = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
        assert!(parse_address(signet, Network::Signet).is_ok());
        assert!(parse_address(signet, Network::Bitcoin).is_err());
        assert!(parse_address("not an address", Network::Signet).is_err());
    }

    #[test]
    fn bitcoin_uris_are_reduced_to_their_address() {
        let uri = "bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.001&label=x";
        let address = parse_address(uri, Network::Signet).unwrap();
        assert_eq!(
            address.to_string(),
            "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"
        );
    }

    #[test]
    fn receive_addresses_get_a_qr_code() {
        let address = parse_address(
            "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
            Network::Signet,
        )
        .unwrap();
        let view = address_view(0, &address, false).unwrap();
        assert!(view.qr_svg.starts_with("data:image/svg+xml;base64,"));
    }
}
