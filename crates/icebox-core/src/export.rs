//! The payment history as a CSV file, for a spreadsheet or an accountant.
//!
//! One row per payment, newest first, amounts in BTC with eight decimals so a spreadsheet adds
//! them up exactly. A value column in the user's currency is added only when prices are switched
//! on and a rate is known for that day; otherwise the column is left out entirely rather than
//! filled with blanks that look like zero.

/// One payment as it goes into the file.
#[derive(Debug, Clone, PartialEq)]
pub struct CsvRow {
    pub txid: String,
    /// Seconds since 1970 (UTC): when it confirmed, or when it was first seen if it hasn't yet.
    pub timestamp: Option<u64>,
    /// Change to the wallet's balance in sats; negative for payments out. None when the wallet
    /// can't tell (a payment it only partly knows the inputs of).
    pub net_sats: Option<i64>,
    pub fee_sats: Option<u64>,
    pub confirmations: u32,
    pub label: String,
    /// What `net_sats` was worth in the chosen currency on that day, if known.
    pub fiat_value: Option<f64>,
}

/// Formats sats as BTC with eight decimals, without going through floating point.
pub fn btc(sats: i64) -> String {
    let sign = if sats < 0 { "-" } else { "" };
    let abs = sats.unsigned_abs();
    format!("{sign}{}.{:08}", abs / 100_000_000, abs % 100_000_000)
}

/// A Unix time as an ISO 8601 UTC date and time, e.g. `2026-11-27T14:05:09Z`.
pub fn iso_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// The calendar date of a Unix time, `YYYY-MM-DD`, UTC.
pub fn iso_date(secs: u64) -> String {
    iso_utc(secs)[..10].to_string()
}

/// Days since 1970-01-01 to (year, month, day) in the proleptic Gregorian calendar
/// (Howard Hinnant's `civil_from_days`).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// One CSV field, quoted when it needs to be. Text that a spreadsheet would run as a formula
/// (starting `=`, `+`, `-`, `@`, or a tab or carriage return) gets a leading `'`, so a label like
/// `=HYPERLINK(...)` that came in from someone else's file shows as text instead of running.
fn field(text: &str) -> String {
    let guarded = match text.chars().next() {
        Some('=' | '+' | '-' | '@' | '\t' | '\r') => format!("'{text}"),
        _ => text.to_string(),
    };
    if guarded.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", guarded.replace('"', "\"\""))
    } else {
        guarded
    }
}

/// The file. `currency` names the value column (e.g. "GBP"); pass None to leave the column out.
pub fn history_csv(rows: &[CsvRow], currency: Option<&str>) -> String {
    let mut out = String::from("Date (UTC),Transaction ID,Amount (BTC),Fee (BTC),Status,Label");
    if let Some(code) = currency {
        out.push_str(&format!(",Value ({})", field(code)));
    }
    out.push_str("\r\n");
    for r in rows {
        let cells = [
            r.timestamp.map(iso_utc).unwrap_or_default(),
            r.txid.clone(),
            r.net_sats.map(btc).unwrap_or_default(),
            r.fee_sats
                .filter(|_| r.net_sats.is_some_and(|v| v < 0))
                .map(|f| btc(f as i64))
                .unwrap_or_default(),
            match r.confirmations {
                0 => "Pending".to_string(),
                1 => "1 confirmation".to_string(),
                n => format!("{n} confirmations"),
            },
            field(&r.label),
        ];
        out.push_str(&cells.join(","));
        if currency.is_some() {
            out.push(',');
            if let Some(v) = r.fiat_value {
                out.push_str(&format!("{v:.2}"));
            }
        }
        out.push_str("\r\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn btc_formatting() {
        assert_eq!(btc(0), "0.00000000");
        assert_eq!(btc(1), "0.00000001");
        assert_eq!(btc(-150_000_000), "-1.50000000");
        assert_eq!(btc(2_100_000_000_000_000), "21000000.00000000");
        assert_eq!(btc(i64::MIN), "-92233720368.54775808");
    }

    #[test]
    fn dates() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso_utc(1_795_788_309), "2026-11-27T14:05:09Z");
        assert_eq!(iso_date(1_795_788_309), "2026-11-27");
    }

    #[test]
    fn fields_are_quoted_and_guarded() {
        assert_eq!(field("plain"), "plain");
        assert_eq!(field("a, b"), "\"a, b\"");
        assert_eq!(field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(field("=1+1"), "'=1+1");
        assert_eq!(field("-sell"), "'-sell");
        assert_eq!(field("@x,y"), "\"'@x,y\"");
    }

    #[test]
    fn whole_file() {
        let rows = vec![
            CsvRow {
                txid: "aa".into(),
                timestamp: Some(1_795_788_309),
                net_sats: Some(-25_000),
                fee_sats: Some(420),
                confirmations: 3,
                label: "Supplier, May".into(),
                fiat_value: Some(-18.456),
            },
            CsvRow {
                txid: "bb".into(),
                timestamp: None,
                net_sats: Some(10_000),
                fee_sats: Some(300),
                confirmations: 0,
                label: String::new(),
                fiat_value: None,
            },
        ];
        assert_eq!(
            history_csv(&rows, Some("GBP")),
            "Date (UTC),Transaction ID,Amount (BTC),Fee (BTC),Status,Label,Value (GBP)\r\n\
             2026-11-27T14:05:09Z,aa,-0.00025000,0.00000420,3 confirmations,\"Supplier, May\",-18.46\r\n\
             ,bb,0.00010000,,Pending,,\r\n"
        );
        assert!(!history_csv(&rows, None).contains("Value"));
    }
}
