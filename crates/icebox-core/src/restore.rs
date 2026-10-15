//! Restoring a wallet from the devices that hold its shares.
//!
//! The official app asks one device at a time. Icebox asks every plugged-in device at once which
//! wallet shares it holds (a device can hold shares of several wallets), groups the answers by
//! wallet, and restores a whole wallet in one step once enough of its devices have answered. The
//! restoring itself is the official `frostsnap_core` restoration code.

use frostsnap_coordinator::frostsnap_comms::{CoordinatorSendBody, CoordinatorSendMessage};
use frostsnap_coordinator::{Completion, DeviceMode, Sink, UiProtocol};
use frostsnap_core::coordinator::restoration::{RecoverShare, ToUserRestoration};
use frostsnap_core::coordinator::CoordinatorToUserMessage;
use frostsnap_core::message::{CoordinatorRestoration, CoordinatorToDeviceMessage, HeldShare2};
use frostsnap_core::DeviceId;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

/// What each scanned device said it holds. `None` means asked but not answered yet.
pub type ScanResults = Arc<Mutex<BTreeMap<DeviceId, Option<Vec<HeldShare2>>>>>;

/// Asks every connected, set-up device for the shares it holds, including devices plugged in
/// while the scan is open. Stays open until cancelled.
pub struct ScanHeldShares {
    results: ScanResults,
    to_ask: BTreeSet<DeviceId>,
    changed: Box<dyn Sink<()>>,
    cancelled: bool,
}

impl ScanHeldShares {
    pub fn new(results: ScanResults, changed: impl Sink<()>) -> Self {
        results.lock().unwrap().clear();
        Self {
            results,
            to_ask: Default::default(),
            changed: Box::new(changed),
            cancelled: false,
        }
    }
}

impl UiProtocol for ScanHeldShares {
    fn cancel(&mut self) {
        self.cancelled = true;
    }

    fn is_complete(&self) -> Option<Completion> {
        self.cancelled.then_some(Completion::Abort {
            send_cancel_to_all_devices: false,
        })
    }

    fn connected(&mut self, id: DeviceId, mode: DeviceMode) {
        // A blank device holds nothing; don't bother asking it.
        let answer = if mode == DeviceMode::Blank {
            Some(vec![])
        } else {
            self.to_ask.insert(id);
            None
        };
        self.results.lock().unwrap().insert(id, answer);
        self.changed.send(());
    }

    fn disconnected(&mut self, id: DeviceId) {
        self.to_ask.remove(&id);
        // Keep what an unplugged device told us: the user may swap devices in and out of one
        // port, and its share still counts towards the restore.
        let mut results = self.results.lock().unwrap();
        if matches!(results.get(&id), Some(None)) {
            results.remove(&id);
        }
        drop(results);
        self.changed.send(());
    }

    fn poll(&mut self) -> Vec<CoordinatorSendMessage> {
        std::mem::take(&mut self.to_ask)
            .into_iter()
            .map(|id| {
                CoordinatorSendMessage::to(
                    id,
                    CoordinatorSendBody::Core(CoordinatorToDeviceMessage::Restoration(
                        CoordinatorRestoration::RequestHeldShares,
                    )),
                )
            })
            .collect()
    }

    fn process_to_user_message(&mut self, message: CoordinatorToUserMessage) -> bool {
        if let CoordinatorToUserMessage::Restoration(ToUserRestoration::GotHeldShares {
            held_by,
            shares,
        }) = message
        {
            self.results.lock().unwrap().insert(held_by, Some(shares));
            self.changed.send(());
            true
        } else {
            false
        }
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn as_mut_any(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

/// Shares that (as far as the devices say) belong to the same wallet.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub group_id: String,
    pub key_name: Option<String>,
    pub threshold: Option<u16>,
    pub network: Option<frostsnap_coordinator::bdk_chain::bitcoin::Network>,
    pub access_structure_ref: Option<frostsnap_core::AccessStructureRef>,
    pub shares: Vec<RecoverShare>,
}

impl Candidate {
    /// Distinct share numbers found. Two devices holding the same share only count once.
    pub fn distinct_shares(&self) -> usize {
        self.shares
            .iter()
            .map(|s| share_number(&s.held_share))
            .collect::<BTreeSet<_>>()
            .len()
    }
}

/// The share's number (1, 2, 3, ...), as written on the device's backup card.
pub fn share_number(held_share: &HeldShare2) -> u32 {
    u32::try_from(held_share.share_image.index).unwrap_or(u32::MAX)
}

/// Groups everything the scan found by wallet. Shares that carry their wallet's identity are
/// grouped by it; older ones that don't are grouped by name and threshold, and the restoration
/// itself rejects any share that turns out not to fit.
pub fn group(results: &BTreeMap<DeviceId, Option<Vec<HeldShare2>>>) -> Vec<Candidate> {
    let mut groups: BTreeMap<String, Candidate> = BTreeMap::new();
    for (&held_by, shares) in results {
        for held_share in shares.iter().flatten() {
            let group_id = match held_share.access_structure_ref {
                Some(r) => format!("{}:{}", r.key_id, r.access_structure_id),
                None => format!(
                    "unidentified:{}:{}",
                    held_share.key_name.clone().unwrap_or_default(),
                    held_share
                        .threshold
                        .map(|t| t.to_string())
                        .unwrap_or_default()
                ),
            };
            let entry = groups.entry(group_id.clone()).or_insert_with(|| Candidate {
                group_id,
                key_name: held_share.key_name.clone(),
                threshold: held_share.threshold,
                network: held_share.purpose.and_then(|p| p.bitcoin_network()),
                access_structure_ref: held_share.access_structure_ref,
                shares: vec![],
            });
            entry.shares.push(RecoverShare {
                held_by,
                held_share: held_share.clone(),
            });
        }
    }
    groups.into_values().collect()
}
