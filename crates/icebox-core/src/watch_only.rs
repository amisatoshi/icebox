//! Watch-only codes: how one Icebox shares a wallet with another so it can watch the balance,
//! history and receive addresses without any devices.
//!
//! Frostsnap's wallet engine identifies a wallet by its master app key (the descriptor shown on
//! the Details page holds a key derived from it, and there's no going back), so the code carries
//! that key, plus the network and the wallet's name:
//!
//! ```text
//! icebox-watch1:<network>:<master app key, hex>:<checksum>:<name>
//! ```
//!
//! The checksum (the first four bytes of a SHA-256 of the rest) catches typos and truncated
//! pastes. The name comes last so it may contain colons. Nothing in a code can spend: it reveals
//! the wallet's addresses and payments, the same as a descriptor.

use frostsnap_coordinator::bdk_chain::bitcoin::hashes::{sha256, Hash};
use frostsnap_coordinator::bdk_chain::bitcoin::Network;
use frostsnap_core::MasterAppkey;
use std::str::FromStr;

const PREFIX: &str = "icebox-watch1";

/// Longest wallet name accepted from a code (a little more than wallets can be given, so codes
/// from future versions with longer names still work).
const MAX_NAME: usize = 40;

#[derive(Debug, Clone, PartialEq)]
pub struct WatchCode {
    pub name: String,
    pub network: Network,
    pub master_appkey: MasterAppkey,
}

fn checksum(network: &str, appkey_hex: &str, name: &str) -> String {
    let digest = sha256::Hash::hash(format!("{network}:{appkey_hex}:{name}").as_bytes());
    digest.to_byte_array()[..4]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl WatchCode {
    pub fn encode(&self) -> String {
        let network = self.network.to_string();
        let appkey = self.master_appkey.to_string();
        let sum = checksum(&network, &appkey, &self.name);
        format!("{PREFIX}:{network}:{appkey}:{sum}:{}", self.name)
    }

    /// Reads a code pasted, opened from a file or scanned. Surrounding whitespace is ignored.
    pub fn decode(code: &str) -> Result<Self, String> {
        let code = code.trim();
        let mut parts = code.splitn(5, ':');
        let prefix = parts.next().unwrap_or_default();
        if !prefix.eq_ignore_ascii_case(PREFIX) {
            return Err(
                "that isn't an Icebox watch-only code (it should start icebox-watch1:)".into(),
            );
        }
        let (Some(network), Some(appkey), Some(sum), Some(name)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err("that watch-only code is incomplete; copy the whole code".into());
        };
        let name = name.trim();
        if checksum(network, appkey, name) != sum.to_ascii_lowercase() {
            return Err(
                "that watch-only code doesn't check out; it may be mistyped or cut short".into(),
            );
        }
        let network = Network::from_str(network)
            .map_err(|_| format!("unknown network \"{network}\" in that code"))?;
        let master_appkey = MasterAppkey::from_str(appkey)
            .map_err(|_| "that watch-only code's key isn't valid".to_string())?;
        if name.is_empty() || name.chars().count() > MAX_NAME {
            return Err("that watch-only code's wallet name isn't valid".into());
        }
        Ok(Self {
            name: name.to_string(),
            network,
            master_appkey,
        })
    }
}

#[cfg(test)]
mod test {
    use super::*;

    // a real master app key, from frostsnap_coordinator's own descriptor test
    const APPKEY: &str = "0325b0d1cda060241998916f45d02e227db436bdd708a55cf1dc67f3f534e332186fd6543fbfc5dd07094e93543fa05120f12d3a80876aa011a4897b7a0770d1fb";

    fn sample(name: &str) -> WatchCode {
        WatchCode {
            name: name.into(),
            network: Network::Signet,
            master_appkey: MasterAppkey::from_str(APPKEY).unwrap(),
        }
    }

    #[test]
    fn codes_round_trip() {
        for name in ["Cold storage", "Shop: till 2", "Ünïcode ✓"] {
            let code = sample(name).encode();
            assert!(code.starts_with("icebox-watch1:signet:"));
            assert_eq!(WatchCode::decode(&code).unwrap(), sample(name));
            // pasted with stray whitespace
            assert_eq!(
                WatchCode::decode(&format!("  {code}\n")).unwrap(),
                sample(name)
            );
        }
    }

    #[test]
    fn damaged_codes_are_refused() {
        let code = sample("Cold storage").encode();
        // a typo in the key
        let typo = code.replacen("0325b0", "0325b1", 1);
        assert!(WatchCode::decode(&typo).is_err());
        // a renamed wallet without a new checksum
        assert!(WatchCode::decode(&code.replace("Cold storage", "Hot storage")).is_err());
        // cut short
        assert!(WatchCode::decode(&code[..40]).is_err());
        // something else entirely
        assert!(WatchCode::decode("tr([12345678/0/0]xpub.../<0;1>/*)").is_err());
        assert!(WatchCode::decode("").is_err());
    }
}
