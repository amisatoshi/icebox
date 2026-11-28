//! Prices: what the user has chosen, kept in Icebox's own settings table.
//!
//! Prices are off until the user switches them on, because fetching one tells a price server
//! that someone at this IP address runs a Bitcoin wallet. The fetching itself is done by the
//! window (it only needs the public price), so nothing about the wallet is ever in the request.
//! Here are the choices and the rules for them.

use serde::{Deserialize, Serialize};

/// Currencies mempool.space prices directly.
pub const MEMPOOL_CURRENCIES: [&str; 7] = ["GBP", "USD", "EUR", "AUD", "CAD", "CHF", "JPY"];

/// Currencies worked out from the euro price and the European Central Bank's daily rate.
pub const ECB_CURRENCIES: [&str; 1] = ["MYR"];

/// Currencies pegged to the US dollar at a fixed rate, worked out from the dollar price with no
/// extra request. Kuwait's dinar isn't here: it follows a basket, not a peg.
pub const USD_PEGS: [(&str, f64); 5] = [
    ("AED", 3.6725),
    ("SAR", 3.75),
    ("QAR", 3.64),
    ("BHD", 0.376),
    ("OMR", 0.3845),
];

/// The user's price choices.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PriceSettings {
    /// Fetch prices at all. Off by default.
    pub enabled: bool,
    /// A three-letter code from the lists above, or "MANUAL".
    pub currency: String,
    /// For "MANUAL": the code to show (any three letters, e.g. "KWD"), and the user's own price
    /// of one bitcoin in it. Nothing is fetched for a manual price.
    pub manual_code: Option<String>,
    pub manual_price: Option<f64>,
}

impl Default for PriceSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            currency: "GBP".into(),
            manual_code: None,
            manual_price: None,
        }
    }
}

pub fn is_known_currency(code: &str) -> bool {
    MEMPOOL_CURRENCIES.contains(&code)
        || ECB_CURRENCIES.contains(&code)
        || USD_PEGS.iter().any(|(c, _)| *c == code)
}

impl PriceSettings {
    /// Checks and tidies settings from the window. Codes are upper-cased; a manual price must be
    /// a positive number with a three-letter code. A manual code and price are kept when another
    /// currency is chosen, so switching back doesn't lose them.
    pub fn cleaned(mut self) -> Result<Self, String> {
        self.currency = self.currency.trim().to_ascii_uppercase();
        self.manual_code = self
            .manual_code
            .map(|c| c.trim().to_ascii_uppercase())
            .filter(|c| !c.is_empty());
        if let Some(code) = &self.manual_code {
            if code.len() != 3 || !code.bytes().all(|b| b.is_ascii_uppercase()) {
                return Err("a currency code is three letters, like KWD".into());
            }
        }
        if let Some(price) = self.manual_price {
            if !(price.is_finite() && price > 0.0 && price < 1e15) {
                return Err("enter the price of one bitcoin as a positive number".into());
            }
        }
        if self.currency == "MANUAL" {
            if self.manual_code.is_none() || self.manual_price.is_none() {
                return Err(
                    "for your own price, enter a currency code and the price of one bitcoin".into(),
                );
            }
        } else if !is_known_currency(&self.currency) {
            return Err(format!(
                "{} isn't a currency Icebox can price",
                self.currency
            ));
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(currency: &str, code: Option<&str>, price: Option<f64>) -> PriceSettings {
        PriceSettings {
            enabled: true,
            currency: currency.into(),
            manual_code: code.map(Into::into),
            manual_price: price,
        }
    }

    #[test]
    fn off_by_default() {
        assert!(!PriceSettings::default().enabled);
        assert_eq!(
            PriceSettings::default().cleaned(),
            Ok(PriceSettings::default())
        );
    }

    #[test]
    fn known_currencies() {
        for c in ["gbp", " USD ", "MYR", "aed", "OMR"] {
            assert!(s(c, None, None).cleaned().is_ok(), "{c}");
        }
        assert!(s("KWD", None, None).cleaned().is_err());
        assert!(s("BTC", None, None).cleaned().is_err());
    }

    #[test]
    fn manual() {
        let ok = s("manual", Some(" kwd "), Some(28_500.5))
            .cleaned()
            .unwrap();
        assert_eq!(ok.currency, "MANUAL");
        assert_eq!(ok.manual_code.as_deref(), Some("KWD"));
        assert!(s("MANUAL", Some("KWD"), None).cleaned().is_err());
        assert!(s("MANUAL", None, Some(1.0)).cleaned().is_err());
        assert!(s("MANUAL", Some("KW"), Some(1.0)).cleaned().is_err());
        assert!(s("MANUAL", Some("K1D"), Some(1.0)).cleaned().is_err());
        assert!(s("MANUAL", Some("KWD"), Some(0.0)).cleaned().is_err());
        assert!(s("MANUAL", Some("KWD"), Some(f64::NAN)).cleaned().is_err());
        // a manual price is kept while another currency is in use
        let kept = s("GBP", Some("KWD"), Some(30_000.0)).cleaned().unwrap();
        assert_eq!(kept.manual_price, Some(30_000.0));
    }

    #[test]
    fn json_round_trip() {
        let v = s("MANUAL", Some("KWD"), Some(30_000.0));
        let text = serde_json::to_string(&v).unwrap();
        assert_eq!(serde_json::from_str::<PriceSettings>(&text).unwrap(), v);
    }
}
