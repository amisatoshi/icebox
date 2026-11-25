//! Icebox core: a third-party coordinator for Frostsnap devices, built on the official
//! `frostsnap_core` and `frostsnap_coordinator` crates. It has no UI dependency; the Tauri app
//! (and any other front end) drives it through [`Service`] and listens for [`Event`]s.

mod device_list;
pub mod events;
mod restore;
mod service;
mod watch_only;

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

/// The GitHub page for an Icebox release, or an error unless `tag` looks like a release tag
/// (`v1.2.3`, optionally with a suffix such as `-rc.1`). Icebox builds the URL itself, so the
/// page can never hand an arbitrary link to the system.
pub fn release_url(tag: &str) -> Result<String, String> {
    let tag = tag.trim();
    let version = tag
        .strip_prefix('v')
        .ok_or("that isn't an Icebox release")?;
    let (core, suffix) = match version.split_once('-') {
        Some((core, suffix)) => (core, Some(suffix)),
        None => (version, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let numeric = |p: &&str| !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit());
    let suffix_ok = suffix.is_none_or(|s| {
        !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
    });
    if parts.len() != 3 || !parts.iter().all(numeric) || !suffix_ok {
        return Err("that isn't an Icebox release".into());
    }
    Ok(format!(
        "https://github.com/amisatoshi/icebox/releases/tag/{tag}"
    ))
}

/// One of Icebox's fixed help pages: `guide` (the user guide) or `bug` (the bug report form).
/// Like [`release_url`], the page passes a name and never a URL.
pub fn help_url(page: &str) -> Result<String, String> {
    let path = match page.trim() {
        "guide" => "blob/main/docs/guide/README.md",
        "bug" => "issues/new?template=bug_report.yml",
        _ => return Err("unknown help page".into()),
    };
    Ok(format!("https://github.com/amisatoshi/icebox/{path}"))
}

/// The last `max_lines` lines of a log, with the user's home folder shown as `~` (it usually
/// contains their account name, which a log sent for troubleshooting doesn't need).
pub fn tidy_log(text: &str, home: Option<&str>, max_lines: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let tail = lines[lines.len().saturating_sub(max_lines)..].join("\n");
    match home {
        Some(home) if home.len() > 1 => {
            // Paths can appear as written or with escaped backslashes ("C:\\Users\\..."), as
            // Debug formatting writes them.
            let escaped = home.replace('\\', "\\\\");
            let tail = if escaped != home {
                tail.replace(&escaped, "~")
            } else {
                tail
            };
            tail.replace(home, "~")
        }
        _ => tail,
    }
}

/// Largest camera frame accepted for QR decoding (pixels), to bound the work per frame.
const MAX_QR_FRAME: usize = 1920 * 1080;

/// Reads a QR code from one camera frame, sent from the UI as base64 greyscale pixels (one byte
/// per pixel, row by row, 0 = black). Returns the text of the first QR code found, `None` if
/// there isn't a readable one in this frame, or an error for a malformed frame. Decoding happens
/// here, in Rust, so the UI needs no third-party JavaScript, and frames never leave the computer.
pub fn decode_qr_frame(
    width: usize,
    height: usize,
    pixels_b64: &str,
) -> Result<Option<String>, String> {
    use base64::Engine;
    if width == 0 || height == 0 || width.saturating_mul(height) > MAX_QR_FRAME {
        return Err("camera frame has an unsupported size".into());
    }
    let pixels = base64::engine::general_purpose::STANDARD
        .decode(pixels_b64)
        .map_err(|_| "camera frame isn't valid base64".to_string())?;
    if pixels.len() != width * height {
        return Err("camera frame is the wrong length".into());
    }
    Ok(decode_qr(width, height, &pixels))
}

fn decode_qr(width: usize, height: usize, pixels: &[u8]) -> Option<String> {
    let mut img =
        rqrr::PreparedImage::prepare_from_greyscale(width, height, |x, y| pixels[y * width + x]);
    img.detect_grids()
        .into_iter()
        .find_map(|grid| grid.decode().ok().map(|(_meta, text)| text))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Draws `text` as a QR code into a greyscale buffer, like a camera frame of a screen.
    fn qr_frame(text: &str) -> (usize, usize, Vec<u8>) {
        let code = qrcode::QrCode::new(text.as_bytes()).unwrap();
        let modules = code.width();
        let colors = code.to_colors();
        let (scale, quiet) = (6, 4);
        let size = (modules + 2 * quiet) * scale;
        let mut pixels = vec![255u8; size * size];
        for y in 0..modules {
            for x in 0..modules {
                if colors[y * modules + x] == qrcode::Color::Dark {
                    for dy in 0..scale {
                        for dx in 0..scale {
                            let (px, py) = ((x + quiet) * scale + dx, (y + quiet) * scale + dy);
                            pixels[py * size + px] = 0;
                        }
                    }
                }
            }
        }
        (size, size, pixels)
    }

    #[test]
    fn qr_codes_are_read_back_from_frames() {
        for text in [
            "BITCOIN:TB1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KXPJZSX",
            "icebox-watch1:signet:0325b0d1cda060241998916f45d02e227db436bdd708a55cf1dc67f3f534e332186fd6543fbfc5dd07094e93543fa05120f12d3a80876aa011a4897b7a0770d1fb:1a2b3c4d:Cold storage",
        ] {
            let (w, h, pixels) = qr_frame(text);
            let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &pixels);
            assert_eq!(decode_qr_frame(w, h, &b64).unwrap().as_deref(), Some(text));
        }
    }

    #[test]
    fn release_links_only_for_release_tags() {
        assert_eq!(
            release_url("v0.4.0").unwrap(),
            "https://github.com/amisatoshi/icebox/releases/tag/v0.4.0"
        );
        assert!(release_url("v1.2.3-rc.1").is_ok());
        for bad in [
            "0.4.0",
            "v0.4",
            "v0.4.0/../../evil",
            "v0.4.0?x=1",
            "v0.4.0-",
            "vx.y.z",
            "",
        ] {
            assert!(release_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn help_links_are_fixed() {
        assert_eq!(
            help_url("guide").unwrap(),
            "https://github.com/amisatoshi/icebox/blob/main/docs/guide/README.md"
        );
        assert!(help_url("bug").unwrap().contains("/issues/new"));
        for bad in ["", "https://evil.example", "../guide", "Guide"] {
            assert!(help_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn logs_keep_the_end_and_hide_the_home_folder() {
        let log = "one\ntwo /home/sam/.local/share/icebox\nthree\n";
        assert_eq!(
            tidy_log(log, Some("/home/sam"), 2),
            "two ~/.local/share/icebox\nthree"
        );
        assert_eq!(
            tidy_log(log, None, 10),
            "one\ntwo /home/sam/.local/share/icebox\nthree"
        );
        let win = r#"path="C:\\Users\\sam\\AppData" and C:\Users\sam\AppData"#;
        assert_eq!(
            tidy_log(win, Some(r"C:\Users\sam"), 5),
            r#"path="~\\AppData" and ~\AppData"#
        );
        assert_eq!(tidy_log("", Some("/home/sam"), 5), "");
    }

    #[test]
    fn frames_without_a_code_or_malformed_are_handled() {
        let blank = vec![255u8; 200 * 100];
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &blank);
        assert_eq!(decode_qr_frame(200, 100, &b64), Ok(None));
        assert!(decode_qr_frame(200, 99, &b64).is_err());
        assert!(decode_qr_frame(0, 0, "").is_err());
        assert!(decode_qr_frame(10, 10, "not base64!").is_err());
    }

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
