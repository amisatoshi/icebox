//! Labels: short notes the user writes against a payment, an address or a coin, and the
//! [BIP-329] file format other wallets use to move them around.
//!
//! A BIP-329 file is JSON Lines: one record per line, each
//! `{"type": "tx", "ref": "<txid>", "label": "Invoice 1042"}`. Types are `tx`, `addr`, `pubkey`,
//! `input`, `output` and `xpub`. Icebox writes `tx`, `addr` and `output` labels itself, but keeps
//! every type it reads so a file passed through Icebox comes out with nothing missing.
//!
//! Nothing here touches the database or the wallet; it is the format and the rules, so it can be
//! tested on its own.
//!
//! [BIP-329]: https://github.com/bitcoin/bips/blob/master/bip-0329.mediawiki

use serde_json::Value;
use std::fmt;

/// Longest label kept, in characters. BIP-329 sets no limit but says importers may truncate;
/// 255 is what the BIP suggests other wallets are likely to accept.
pub const MAX_LABEL: usize = 255;

/// Biggest import accepted. A label file for even a busy shop is a few megabytes; anything far
/// bigger is the wrong file.
pub const MAX_IMPORT_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LabelKind {
    Tx,
    Addr,
    Pubkey,
    Input,
    Output,
    Xpub,
}

impl LabelKind {
    pub const ALL: [LabelKind; 6] = [
        LabelKind::Tx,
        LabelKind::Addr,
        LabelKind::Pubkey,
        LabelKind::Input,
        LabelKind::Output,
        LabelKind::Xpub,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            LabelKind::Tx => "tx",
            LabelKind::Addr => "addr",
            LabelKind::Pubkey => "pubkey",
            LabelKind::Input => "input",
            LabelKind::Output => "output",
            LabelKind::Xpub => "xpub",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

impl fmt::Display for LabelKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One label. `spendable` only means anything on an `output` record, and is kept so a file
/// passed through Icebox keeps another wallet's frozen coins frozen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Label {
    pub kind: LabelKind,
    pub reference: String,
    pub label: String,
    pub spendable: Option<bool>,
}

/// Tidies a label the user typed or a file supplied: control characters (newlines, tabs, escape
/// codes) become spaces, runs of spaces collapse, the ends are trimmed, and it is cut to
/// [`MAX_LABEL`] characters.
pub fn clean_label(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(MAX_LABEL * 4));
    let mut last_space = true;
    let mut count = 0;
    for c in raw.chars() {
        let c = if c.is_control() || c.is_whitespace() {
            ' '
        } else {
            c
        };
        if c == ' ' {
            if last_space {
                continue;
            }
            last_space = true;
        } else {
            last_space = false;
        }
        out.push(c);
        count += 1;
        if count == MAX_LABEL {
            break;
        }
    }
    out.trim_end().to_string()
}

fn is_txid(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Checks a reference fits its type and puts it in the one spelling Icebox stores, so the same
/// coin never ends up with two labels: txids lower-case, outpoints `txid:vout` with a plain
/// decimal vout. Addresses, keys and xpubs are kept as written (bech32 is lower-case already,
/// and base58 is case-sensitive), only trimmed.
pub fn normalise_ref(kind: LabelKind, reference: &str) -> Option<String> {
    let r = reference.trim();
    if r.is_empty() || r.len() > 200 || r.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    match kind {
        LabelKind::Tx => is_txid(r).then(|| r.to_ascii_lowercase()),
        LabelKind::Input | LabelKind::Output => {
            let (txid, vout) = r.split_once(':')?;
            if !is_txid(txid) || vout.is_empty() || !vout.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let vout: u32 = vout.parse().ok()?;
            Some(format!("{}:{vout}", txid.to_ascii_lowercase()))
        }
        LabelKind::Addr | LabelKind::Pubkey | LabelKind::Xpub => Some(r.to_string()),
    }
}

/// What reading a label file found.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Parsed {
    pub labels: Vec<Label>,
    /// Lines that weren't a label record (bad JSON, an unknown type, a reference that doesn't
    /// fit its type). Blank lines aren't counted.
    pub skipped: usize,
}

/// Reads a BIP-329 file. Lines that don't make sense are skipped and counted rather than failing
/// the whole import, as the BIP asks. A record with an empty label and no `spendable` says
/// nothing and is skipped too.
///
/// When the same reference appears twice the later line wins, as if each were applied in turn.
pub fn parse_bip329(text: &str) -> Parsed {
    let mut parsed = Parsed::default();
    let mut seen: std::collections::HashMap<(LabelKind, String), usize> = Default::default();
    // A file saved on Windows may start with a byte-order mark.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some(label) = parse_line(line) else {
            parsed.skipped += 1;
            continue;
        };
        let key = (label.kind, label.reference.clone());
        match seen.get(&key) {
            Some(&at) => parsed.labels[at] = label,
            None => {
                seen.insert(key, parsed.labels.len());
                parsed.labels.push(label);
            }
        }
    }
    parsed
}

fn parse_line(line: &str) -> Option<Label> {
    let Value::Object(record) = serde_json::from_str::<Value>(line).ok()? else {
        return None;
    };
    let kind = LabelKind::parse(record.get("type")?.as_str()?)?;
    let reference = normalise_ref(kind, record.get("ref")?.as_str()?)?;
    let label = match record.get("label") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => clean_label(s),
        Some(_) => return None,
    };
    let spendable = match (kind, record.get("spendable")) {
        (LabelKind::Output, Some(Value::Bool(b))) => Some(*b),
        _ => None,
    };
    if label.is_empty() && spendable.is_none() {
        return None;
    }
    Some(Label {
        kind,
        reference,
        label,
        spendable,
    })
}

/// Writes labels as a BIP-329 file, one record per line, in the order given. `origin` is the
/// wallet's key origin (BIP-329's abbreviated descriptor, e.g. `tr([73c5da0a/86'/0'/0'])`) and is
/// added to `tx`, `addr`, `input` and `output` records when known.
pub fn to_bip329(labels: &[Label], origin: Option<&str>) -> String {
    let mut out = String::new();
    for l in labels {
        // Fields in the BIP's own order; every value goes through serde_json so quoting is
        // always right.
        let mut line = format!(
            "{{\"type\":{},\"ref\":{}",
            json_str(l.kind.as_str()),
            json_str(&l.reference)
        );
        if !l.label.is_empty() {
            line.push_str(&format!(",\"label\":{}", json_str(&l.label)));
        }
        let has_origin = matches!(
            l.kind,
            LabelKind::Tx | LabelKind::Addr | LabelKind::Input | LabelKind::Output
        );
        if let (true, Some(origin)) = (has_origin, origin) {
            line.push_str(&format!(",\"origin\":{}", json_str(origin)));
        }
        if let (LabelKind::Output, Some(spendable)) = (l.kind, l.spendable) {
            line.push_str(&format!(",\"spendable\":{spendable}"));
        }
        line.push('}');
        out.push_str(&line);
        out.push('\n');
    }
    out
}

fn json_str(s: &str) -> String {
    Value::String(s.to_string()).to_string()
}

/// The BIP-329 origin for a descriptor: everything up to and including the key origin's closing
/// `]`, then the brackets closed. `tr([73c5da0a/86h/0h/0h]xpub.../0/*)#abcd` becomes
/// `tr([73c5da0a/86h/0h/0h])`. None when the descriptor has no key origin.
pub fn origin_of(descriptor: &str) -> Option<String> {
    let descriptor = descriptor.split('#').next()?.trim();
    let close = descriptor.find(']')?;
    let head = &descriptor[..=close];
    if !head.contains('[') {
        return None;
    }
    let opens = head.matches('(').count();
    Some(format!("{head}{}", ")".repeat(opens)))
}

/// A label for `reference`, tidied and normalised; None when the reference doesn't fit `kind`.
pub fn record(kind: LabelKind, reference: &str, label: &str) -> Option<Label> {
    Some(Label {
        kind,
        reference: normalise_ref(kind, reference)?,
        label: clean_label(label),
        spendable: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TXID: &str = "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd";

    #[test]
    fn reads_the_bip_examples() {
        let file = r#"{ "type": "tx", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd", "label": "Transaction", "origin": "wpkh([d34db33f/84'/0'/0'])" }
{ "type": "addr", "ref": "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c", "label": "Address" }
{ "type": "pubkey", "ref": "0283409659355b6d1cc3c32decd5d561abaac86c37a353b52895a5e6c196d6f448", "label": "Public Key" }
{ "type": "input", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd:0", "label": "Input" }
{ "type": "output", "ref": "f91d0a8a78462bc59398f2c5d7a84fcff491c26ba54c4833478b202796c8aafd:1", "label": "Output" , "spendable" : "false" }
{ "type": "xpub", "ref": "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8", "label": "Extended Public Key" }
{ "type": "tx", "ref": "f546156d9044844e02b181026a1a407abfca62e7ea1159f87bbeaa77b4286c74", "label": "Account #1 Transaction", "origin": "wpkh([d34db33f/84'/0'/1'])" }
"#;
        let parsed = parse_bip329(file);
        assert_eq!(parsed.skipped, 0);
        assert_eq!(parsed.labels.len(), 7);
        assert_eq!(parsed.labels[0].kind, LabelKind::Tx);
        assert_eq!(parsed.labels[0].label, "Transaction");
        // "spendable": "false" is a string, not a bool, so it is ignored rather than guessed.
        assert_eq!(parsed.labels[4].spendable, None);
        assert_eq!(parsed.labels[5].kind, LabelKind::Xpub);
    }

    #[test]
    fn skips_bad_lines_and_counts_them() {
        let file = format!(
            "not json\n\n{{\"type\":\"tx\",\"ref\":\"abc\",\"label\":\"short txid\"}}\n\
             {{\"type\":\"wallet\",\"ref\":\"x\",\"label\":\"unknown type\"}}\n\
             {{\"type\":\"tx\",\"ref\":\"{TXID}\",\"label\":\"\"}}\n\
             [1,2]\n\
             {{\"type\":\"tx\",\"ref\":\"{TXID}\",\"label\":\"good\"}}\n"
        );
        let parsed = parse_bip329(&file);
        assert_eq!(parsed.labels.len(), 1);
        assert_eq!(parsed.skipped, 5);
    }

    #[test]
    fn later_line_wins_and_refs_are_normalised() {
        let upper = TXID.to_ascii_uppercase();
        let file = format!(
            "{{\"type\":\"output\",\"ref\":\"{upper}:01\",\"label\":\"first\"}}\n\
             {{\"type\":\"output\",\"ref\":\"{TXID}:1\",\"label\":\"second\",\"spendable\":false}}\n"
        );
        let parsed = parse_bip329(&file);
        assert_eq!(parsed.labels.len(), 1);
        assert_eq!(parsed.labels[0].reference, format!("{TXID}:1"));
        assert_eq!(parsed.labels[0].label, "second");
        assert_eq!(parsed.labels[0].spendable, Some(false));
    }

    #[test]
    fn spendable_alone_is_kept_on_outputs_only() {
        let file = format!(
            "{{\"type\":\"output\",\"ref\":\"{TXID}:0\",\"spendable\":false}}\n\
             {{\"type\":\"tx\",\"ref\":\"{TXID}\",\"spendable\":false}}\n"
        );
        let parsed = parse_bip329(&file);
        assert_eq!(parsed.labels.len(), 1);
        assert_eq!(parsed.labels[0].label, "");
        assert_eq!(parsed.skipped, 1);
    }

    #[test]
    fn byte_order_mark_and_crlf() {
        let file = format!("\u{feff}{{\"type\":\"tx\",\"ref\":\"{TXID}\",\"label\":\"a\"}}\r\n");
        assert_eq!(parse_bip329(&file).labels.len(), 1);
    }

    #[test]
    fn cleans_labels() {
        assert_eq!(
            clean_label("  Invoice\n1042\t\u{1b}[31m  "),
            "Invoice 1042 [31m"
        );
        let long = "é".repeat(300);
        assert_eq!(clean_label(&long).chars().count(), MAX_LABEL);
        assert_eq!(clean_label("   "), "");
    }

    #[test]
    fn round_trips() {
        let labels = vec![
            record(LabelKind::Tx, TXID, "Rent \"May\"").unwrap(),
            record(
                LabelKind::Addr,
                "bc1q34aq5drpuwy3wgl9lhup9892qp6svr8ldzyy7c",
                "Shop",
            )
            .unwrap(),
            Label {
                kind: LabelKind::Output,
                reference: format!("{TXID}:0"),
                label: String::new(),
                spendable: Some(false),
            },
            record(LabelKind::Xpub, "xpub661MyMwAqRbc", "Other wallet").unwrap(),
        ];
        let text = to_bip329(&labels, Some("tr([73c5da0a/86'/0'/0'])"));
        let first = text.lines().next().unwrap();
        assert_eq!(
            first,
            format!(
                "{{\"type\":\"tx\",\"ref\":\"{TXID}\",\"label\":\"Rent \\\"May\\\"\",\"origin\":\"tr([73c5da0a/86'/0'/0'])\"}}"
            )
        );
        // xpub records don't carry an origin.
        assert!(!text.lines().nth(3).unwrap().contains("origin"));
        let back = parse_bip329(&text);
        assert_eq!(back.skipped, 0);
        assert_eq!(back.labels, labels);
    }

    #[test]
    fn origin_from_descriptor() {
        assert_eq!(
            origin_of("tr([73c5da0a/86h/0h/0h]xpub6C.../0/*)#abcd1234").as_deref(),
            Some("tr([73c5da0a/86h/0h/0h])")
        );
        assert_eq!(origin_of("tr(xpub6C.../0/*)"), None);
    }

    #[test]
    fn kinds_round_trip() {
        for k in LabelKind::ALL {
            assert_eq!(LabelKind::parse(k.as_str()), Some(k));
        }
        assert_eq!(LabelKind::parse("TX"), None);
    }
}
