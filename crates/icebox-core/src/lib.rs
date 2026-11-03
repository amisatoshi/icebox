//! Icebox core: a third-party coordinator for Frostsnap devices, built on the official
//! `frostsnap_core` and `frostsnap_coordinator` crates. It has no UI dependency; the Tauri app
//! (and any other front end) drives it through [`Service`] and listens for [`Event`]s.

mod device_list;
pub mod events;
mod restore;
mod service;

pub use events::Event;
pub use service::{parse_network, EventFn, Service};

/// The Frostsnap commit the `frostsnap_core` / `frostsnap_coordinator` crates are pinned to.
/// Keep in step with `rev` in the workspace Cargo.toml.
pub const FROSTSNAP_REV: &str = "233f93b6d4ad16552596fad4f80e7a44b9fe4c60";

/// The device firmware release this build is made for, e.g. "v0.4.0".
pub fn expected_firmware() -> String {
    format!("v{}", device_list::expected_firmware())
}

/// The mempool.space page for a transaction, or an error for an unknown network or a txid that
/// isn't 64 hex characters. Regtest has no public explorer.
pub fn explorer_tx_url(network: &str, txid: &str) -> Result<String, String> {
    let txid = txid.trim();
    if txid.len() != 64 || !txid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("that isn't a transaction id".into());
    }
    let prefix = match network.trim() {
        "bitcoin" => "",
        "signet" => "/signet",
        "testnet" => "/testnet",
        "testnet4" => "/testnet4",
        "regtest" => return Err("regtest transactions aren't on a public explorer".into()),
        other => return Err(format!("unknown network {other}")),
    };
    Ok(format!(
        "https://mempool.space{prefix}/tx/{}",
        txid.to_ascii_lowercase()
    ))
}

/// The wallet as a BTCPay Server (NBXplorer) derivation scheme: `xpub…-[taproot]`.
///
/// BTCPay derives receive addresses at `key/0/i` and change at `key/1/i`, exactly what the
/// wallet's descriptor `tr([origin]key/<0;1>/*)` describes, so both see the same addresses.
/// Anything else (a different script type or path) is refused rather than half-converted.
pub fn btcpay_derivation_scheme(descriptor: &str) -> Result<String, String> {
    let body = descriptor.trim();
    let body = body.split('#').next().unwrap_or(body); // drop the checksum
    let inner = body
        .strip_prefix("tr(")
        .and_then(|b| b.strip_suffix(')'))
        .ok_or("only Taproot (tr) wallets can be exported for BTCPay")?;
    let key_and_path = match inner.find(']') {
        Some(i) if inner.starts_with('[') => &inner[i + 1..],
        _ => inner,
    };
    let key = key_and_path
        .strip_suffix("/<0;1>/*")
        .ok_or("the wallet's derivation path isn't the standard receive/change one BTCPay uses")?;
    let known_prefix = ["xpub", "tpub"].iter().any(|p| key.starts_with(p));
    if !known_prefix || key.contains('/') || !key.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("couldn't find the extended public key in the descriptor".into());
    }
    Ok(format!("{key}-[taproot]"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn btcpay_scheme_from_descriptor() {
        let key = format!("tpubD6Nz{}", "a1B2".repeat(25));
        let d = format!("tr([39532015/0/0]{key}/<0;1>/*)#7jyky7mh");
        assert_eq!(
            btcpay_derivation_scheme(&d).unwrap(),
            format!("{key}-[taproot]")
        );
        // no key origin, no checksum
        assert_eq!(
            btcpay_derivation_scheme(&format!("tr({key}/<0;1>/*)")).unwrap(),
            format!("{key}-[taproot]")
        );
        // anything else is refused
        assert!(btcpay_derivation_scheme(&format!("wpkh({key}/<0;1>/*)")).is_err());
        assert!(btcpay_derivation_scheme(&format!("tr({key}/0/*)")).is_err());
        assert!(btcpay_derivation_scheme(&format!("tr({key}/7/<0;1>/*)")).is_err());
    }

    const TXID: &str = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";

    #[test]
    fn explorer_links() {
        assert_eq!(
            explorer_tx_url("bitcoin", TXID).unwrap(),
            format!("https://mempool.space/tx/{TXID}")
        );
        assert_eq!(
            explorer_tx_url("signet", &TXID.to_uppercase()).unwrap(),
            format!("https://mempool.space/signet/tx/{TXID}")
        );
        assert!(explorer_tx_url("regtest", TXID).is_err());
        assert!(explorer_tx_url("bitcoin", "abc").is_err());
        assert!(explorer_tx_url("bitcoin", &format!("{}/../x", &TXID[..60])).is_err());
    }
}
