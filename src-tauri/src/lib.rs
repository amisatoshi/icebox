//! The Tauri shell. It does three things only: starts the [`Service`], forwards its events to
//! the window, and exposes each wallet action as a command. All wallet logic lives in
//! `icebox-core`.

use icebox_core::events::*;
use icebox_core::{Event, Service};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
#[cfg(desktop)]
use tauri::menu::{IconMenuItemBuilder, MenuBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, State};

#[cfg(target_os = "android")]
mod android_usb;

/// The service, or the reason it failed to start (shown in the window).
struct AppState(OnceLock<Result<Service, String>>);

type CmdResult<T> = Result<T, String>;

fn service<'a>(state: &'a State<'_, AppState>) -> CmdResult<&'a Service> {
    match state.0.get() {
        Some(Ok(service)) => Ok(service),
        Some(Err(e)) => Err(format!("Icebox failed to start: {e}")),
        None => Err("Icebox is still starting".into()),
    }
}

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

// ---------- status ----------

#[tauri::command(async)]
fn startup_status(state: State<'_, AppState>) -> CmdResult<String> {
    service(&state).map(|_| "ok".to_string())
}

#[tauri::command(async)]
fn data_dir(app: tauri::AppHandle) -> CmdResult<String> {
    resolve_data_dir(&app).map(|p| p.display().to_string())
}

#[tauri::command(async)]
fn app_info(app: tauri::AppHandle) -> CmdResult<AppInfo> {
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        frostsnap_rev: icebox_core::FROSTSNAP_REV.to_string(),
        expected_firmware: icebox_core::expected_firmware(),
        data_dir: resolve_data_dir(&app)?.display().to_string(),
    })
}

/// Opens an Icebox release page (from the About page's update check) in the browser. The page
/// passes only a tag; the URL is built and checked here.
#[tauri::command(async)]
fn open_release(app: tauri::AppHandle, tag: String) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let url = icebox_core::release_url(&tag)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("couldn't open the browser: {e}"))
}

/// Reads a QR code from one camera frame (base64 greyscale pixels). Decoding is done here, in
/// Rust; the frame isn't stored or sent anywhere.
#[tauri::command(async)]
fn decode_qr(width: usize, height: usize, data: String) -> CmdResult<Option<String>> {
    icebox_core::decode_qr_frame(width, height, &data)
}

/// Opens a transaction on mempool.space in the user's browser. The page can't open arbitrary
/// URLs: Icebox builds the link itself from the network and a checked txid.
#[tauri::command(async)]
fn open_tx(app: tauri::AppHandle, network: String, txid: String) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let url = icebox_core::explorer_tx_url(&network, &txid)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("couldn't open the browser: {e}"))
}

/// Opens one of Icebox's fixed help pages (user guide, bug report form) in the browser. The page
/// passes a name, never a URL.
#[tauri::command(async)]
fn open_help(app: tauri::AppHandle, page: String) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let url = icebox_core::help_url(&page)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("couldn't open the browser: {e}"))
}

// ---------- logs ----------

/// The log file: `logs/icebox.log` in the data folder. The previous run's log is kept as
/// `icebox.log.1` once the file passes [`LOG_ROTATE_BYTES`].
fn log_file(app: &tauri::AppHandle) -> CmdResult<PathBuf> {
    Ok(resolve_data_dir(app)?.join("logs").join("icebox.log"))
}

const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;

/// The end of the log, for the Logs page. The user's home folder is replaced with `~` so the
/// text can be sent for troubleshooting without the account name in it.
#[tauri::command(async)]
fn read_logs(app: tauri::AppHandle) -> CmdResult<String> {
    let path = log_file(&app)?;
    let text = match std::fs::read(&path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("couldn't read the log: {e}")),
    };
    Ok(icebox_core::tidy_log(&text, home_dir().as_deref(), 2000))
}

/// Shows the log file in the system's file manager, so it can be attached to a message.
#[tauri::command(async)]
fn show_log_file(app: tauri::AppHandle) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let path = log_file(&app)?;
    if !path.exists() {
        return Err("there's no log file yet".into());
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("couldn't open the folder: {e}"))
}

fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|h| h.len() > 1)
}

/// Logs to the terminal and to the log file. Started in `setup`, once the data folder is known;
/// if the file can't be opened, Icebox still runs and logs to the terminal only.
fn init_logging(app: &tauri::AppHandle) {
    use tracing_subscriber::fmt::writer::MakeWriterExt;
    let filter = || {
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            // nusb is noisy; electrum at warn is plenty
            "info,nusb=error,bdk_electrum_streaming=warn".into()
        })
    };
    let file = log_file(app).ok().and_then(|path| {
        std::fs::create_dir_all(path.parent()?).ok()?;
        if std::fs::metadata(&path)
            .map(|m| m.len() > LOG_ROTATE_BYTES)
            .unwrap_or(false)
        {
            let _ = std::fs::rename(&path, path.with_extension("log.1"));
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()
    });
    match file {
        Some(file) => {
            tracing_subscriber::fmt()
                .with_env_filter(filter())
                .with_ansi(false)
                .with_writer(std::io::stdout.and(std::sync::Mutex::new(file)))
                .init();
            tracing::info!(
                version = env!("CARGO_PKG_VERSION"),
                os = std::env::consts::OS,
                "Icebox started"
            );
        }
        None => {
            tracing_subscriber::fmt().with_env_filter(filter()).init();
            tracing::warn!("couldn't open the log file; logging to the terminal only");
        }
    }
}

/// Lets the keyboard shortcut Ctrl+Q quit on Windows, where the webview swallows menu shortcuts.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

// ---------- devices ----------

#[tauri::command(async)]
fn erase_device(state: State<'_, AppState>, device_id: String) -> CmdResult<()> {
    service(&state)?.erase_device(&device_id).map_err(err)
}

#[tauri::command(async)]
fn erase_devices(state: State<'_, AppState>, device_ids: Vec<String>) -> CmdResult<()> {
    service(&state)?.erase_devices(&device_ids).map_err(err)
}

#[tauri::command(async)]
fn list_devices(state: State<'_, AppState>) -> CmdResult<Vec<DeviceView>> {
    Ok(service(&state)?.devices())
}

#[tauri::command(async)]
fn preview_device_name(
    state: State<'_, AppState>,
    device_id: String,
    name: String,
) -> CmdResult<()> {
    service(&state)?
        .preview_device_name(&device_id, &name)
        .map_err(err)
}

#[tauri::command(async)]
fn replenish_nonces(state: State<'_, AppState>, device_ids: Vec<String>) -> CmdResult<()> {
    service(&state)?.replenish_nonces(device_ids).map_err(err)
}

#[tauri::command(async)]
fn cancel_protocol(state: State<'_, AppState>) -> CmdResult<()> {
    service(&state)?.cancel_protocol();
    Ok(())
}

// ---------- keys ----------

#[tauri::command(async)]
fn list_keys(state: State<'_, AppState>) -> CmdResult<Vec<KeyView>> {
    Ok(service(&state)?.keys())
}

#[tauri::command(async)]
fn start_keygen(
    state: State<'_, AppState>,
    device_ids: Vec<String>,
    threshold: u16,
    name: String,
    network: String,
) -> CmdResult<()> {
    service(&state)?
        .start_keygen(device_ids, threshold, name, &network)
        .map_err(err)
}

#[tauri::command(async)]
fn check_backup(state: State<'_, AppState>, key_id: String, device_id: String) -> CmdResult<()> {
    service(&state)?
        .check_backup(&key_id, &device_id)
        .map_err(err)
}

#[tauri::command(async)]
fn mark_address_shared(state: State<'_, AppState>, key_id: String, index: u32) -> CmdResult<()> {
    service(&state)?
        .mark_address_shared(&key_id, index)
        .map_err(err)
}

#[tauri::command(async)]
fn addresses(state: State<'_, AppState>, key_id: String) -> CmdResult<Vec<AddressListItem>> {
    service(&state)?.addresses(&key_id).map_err(err)
}

#[tauri::command(async)]
fn address(state: State<'_, AppState>, key_id: String, index: u32) -> CmdResult<AddressView> {
    service(&state)?.address(&key_id, index).map_err(err)
}

#[tauri::command(async)]
fn delete_wallet(state: State<'_, AppState>, key_id: String) -> CmdResult<()> {
    service(&state)?.delete_wallet(&key_id).map_err(err)
}

#[tauri::command(async)]
fn finalize_keygen(state: State<'_, AppState>, keygen_id: String) -> CmdResult<String> {
    service(&state)?.finalize_keygen(&keygen_id).map_err(err)
}

#[tauri::command(async)]
fn display_backup(state: State<'_, AppState>, key_id: String, device_id: String) -> CmdResult<()> {
    service(&state)?
        .display_backup(&key_id, &device_id)
        .map_err(err)
}

#[tauri::command(async)]
fn mark_backup_complete(
    state: State<'_, AppState>,
    key_id: String,
    device_id: String,
) -> CmdResult<()> {
    service(&state)?
        .mark_backup_complete(&key_id, &device_id)
        .map_err(err)
}

#[tauri::command(async)]
fn descriptor(state: State<'_, AppState>, key_id: String) -> CmdResult<String> {
    service(&state)?.descriptor(&key_id).map_err(err)
}

#[tauri::command(async)]
fn descriptor_qr(state: State<'_, AppState>, key_id: String) -> CmdResult<String> {
    service(&state)?.descriptor_qr(&key_id).map_err(err)
}

#[tauri::command(async)]
fn btcpay_scheme(state: State<'_, AppState>, key_id: String) -> CmdResult<String> {
    service(&state)?.btcpay_scheme(&key_id).map_err(err)
}

// ---------- restore ----------

#[tauri::command(async)]
fn start_restore_scan(state: State<'_, AppState>) -> CmdResult<()> {
    service(&state)?.start_restore_scan().map_err(err)
}

#[tauri::command(async)]
fn restore_candidates(state: State<'_, AppState>) -> CmdResult<RestoreScanView> {
    Ok(service(&state)?.restore_candidates())
}

#[tauri::command(async)]
fn restore_wallet(state: State<'_, AppState>, group_id: String) -> CmdResult<String> {
    service(&state)?.restore_wallet(&group_id).map_err(err)
}

#[tauri::command(async)]
fn add_devices_to_wallet(state: State<'_, AppState>, group_id: String) -> CmdResult<usize> {
    service(&state)?
        .add_devices_to_wallet(&group_id)
        .map_err(err)
}

#[tauri::command(async)]
fn watch_only_wallets(state: State<'_, AppState>) -> CmdResult<Vec<WatchOnlyView>> {
    Ok(service(&state)?.watch_only_wallets())
}

#[tauri::command(async)]
fn watch_only_code(state: State<'_, AppState>, key_id: String) -> CmdResult<WatchCodeView> {
    service(&state)?.watch_only_code(&key_id).map_err(err)
}

#[tauri::command(async)]
fn add_watch_only(state: State<'_, AppState>, code: String) -> CmdResult<String> {
    service(&state)?.add_watch_only(&code).map_err(err)
}

#[tauri::command(async)]
fn remove_watch_only(state: State<'_, AppState>, key_id: String) -> CmdResult<()> {
    service(&state)?.remove_watch_only(&key_id).map_err(err)
}

#[tauri::command(async)]
fn clear_device_screens(state: State<'_, AppState>) -> CmdResult<()> {
    service(&state)?.clear_device_screens();
    Ok(())
}

#[tauri::command(async)]
fn save_restore(state: State<'_, AppState>, group_id: String) -> CmdResult<String> {
    service(&state)?.save_restore(&group_id).map_err(err)
}

#[tauri::command(async)]
fn finish_saved_restore(state: State<'_, AppState>, restoration_id: String) -> CmdResult<String> {
    service(&state)?
        .finish_saved_restore(&restoration_id)
        .map_err(err)
}

#[tauri::command(async)]
fn cancel_saved_restore(state: State<'_, AppState>, restoration_id: String) -> CmdResult<()> {
    service(&state)?
        .cancel_saved_restore(&restoration_id)
        .map_err(err)
}

#[tauri::command(async)]
fn saved_restores(state: State<'_, AppState>) -> CmdResult<Vec<SavedRestoreView>> {
    Ok(service(&state)?.saved_restores())
}

// ---------- prices ----------

#[tauri::command(async)]
fn price_settings(state: State<'_, AppState>) -> CmdResult<icebox_core::prices::PriceSettings> {
    Ok(service(&state)?.price_settings())
}

#[tauri::command(async)]
fn set_price_settings(
    state: State<'_, AppState>,
    settings: icebox_core::prices::PriceSettings,
) -> CmdResult<icebox_core::prices::PriceSettings> {
    service(&state)?.set_price_settings(settings).map_err(err)
}

// ---------- BTCPay watch-ahead ----------

#[tauri::command(async)]
fn btcpay_watch(state: State<'_, AppState>, key_id: String) -> CmdResult<u32> {
    service(&state)?.btcpay_watch(&key_id).map_err(err)
}

#[tauri::command(async)]
fn set_btcpay_watch(state: State<'_, AppState>, key_id: String, ahead: u32) -> CmdResult<()> {
    service(&state)?
        .set_btcpay_watch(&key_id, ahead)
        .map_err(err)
}

// ---------- coins ----------

#[tauri::command(async)]
fn coins(state: State<'_, AppState>, key_id: String) -> CmdResult<Vec<CoinView>> {
    service(&state)?.coins(&key_id).map_err(err)
}

#[tauri::command(async)]
fn prepare_consolidate(
    state: State<'_, AppState>,
    key_id: String,
    outpoints: Vec<String>,
    feerate: f32,
) -> CmdResult<SendPreview> {
    service(&state)?
        .prepare_consolidate(&key_id, outpoints, feerate)
        .map_err(err)
}

// ---------- labels and exports ----------

#[tauri::command(async)]
fn labels(state: State<'_, AppState>, key_id: String) -> CmdResult<Vec<LabelView>> {
    service(&state)?.labels(&key_id).map_err(err)
}

#[tauri::command(async)]
fn set_label(
    state: State<'_, AppState>,
    key_id: String,
    kind: String,
    reference: String,
    label: String,
) -> CmdResult<()> {
    service(&state)?
        .set_label(&key_id, &kind, &reference, &label)
        .map_err(err)
}

#[tauri::command(async)]
fn export_labels(state: State<'_, AppState>, key_id: String) -> CmdResult<String> {
    service(&state)?.export_labels(&key_id).map_err(err)
}

#[tauri::command(async)]
fn import_labels(
    state: State<'_, AppState>,
    key_id: String,
    text: String,
) -> CmdResult<LabelImportView> {
    service(&state)?.import_labels(&key_id, &text).map_err(err)
}

#[tauri::command(async)]
fn history_csv(
    state: State<'_, AppState>,
    key_id: String,
    currency: Option<String>,
    daily_prices: Option<std::collections::HashMap<String, f64>>,
) -> CmdResult<String> {
    service(&state)?
        .history_csv(
            &key_id,
            currency.as_deref(),
            &daily_prices.unwrap_or_default(),
        )
        .map_err(err)
}

/// Saves an export (labels, history) to the Downloads folder and returns where it went. The
/// name is tidied to plain characters and never overwrites: a second export the same day gets
/// " (2)". If Downloads can't be written (some phones), it goes in Icebox's own folder instead.
#[tauri::command(async)]
fn save_export(app: tauri::AppHandle, file_name: String, contents: String) -> CmdResult<String> {
    let name = icebox_core::export_file_name(&file_name);
    let mut dirs = Vec::new();
    if let Ok(dir) = app.path().download_dir() {
        dirs.push(dir);
    }
    dirs.push(resolve_data_dir(&app)?.join("exports"));
    let mut last_error = String::new();
    for dir in dirs {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            last_error = e.to_string();
            continue;
        }
        let path = icebox_core::unused_path(&dir, &name);
        // create_new: never replace a file, even one that appeared since unused_path looked.
        let written = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .and_then(|mut f| std::io::Write::write_all(&mut f, contents.as_bytes()));
        match written {
            Ok(()) => {
                tracing::info!(file = %path.display(), "saved export");
                return Ok(path.to_string_lossy().into_owned());
            }
            Err(e) => last_error = e.to_string(),
        }
    }
    Err(format!("couldn't save the file: {last_error}"))
}

/// Shows a file Icebox saved in the system's file manager.
#[tauri::command(async)]
fn show_file(app: tauri::AppHandle, path: String) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let path = PathBuf::from(path);
    // Only files Icebox itself saves: in Downloads or its own folder.
    let allowed = [
        app.path().download_dir().ok(),
        resolve_data_dir(&app).ok().map(|d| d.join("exports")),
    ];
    let parent = path.parent().map(|p| p.to_path_buf());
    if parent.is_none() || !allowed.iter().flatten().any(|d| Some(d) == parent.as_ref()) {
        return Err("that isn't a file Icebox saved".into());
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("couldn't open the folder: {e}"))
}

// ---------- wallet ----------

#[tauri::command(async)]
fn wallet(state: State<'_, AppState>, key_id: String) -> CmdResult<WalletView> {
    service(&state)?.wallet(&key_id).map_err(err)
}

#[tauri::command(async)]
fn next_address(state: State<'_, AppState>, key_id: String) -> CmdResult<AddressView> {
    service(&state)?.next_address(&key_id).map_err(err)
}

#[tauri::command(async)]
fn verify_address(state: State<'_, AppState>, key_id: String, index: u32) -> CmdResult<()> {
    service(&state)?.verify_address(&key_id, index).map_err(err)
}

#[tauri::command(async)]
fn fee_estimates(state: State<'_, AppState>, network: String) -> CmdResult<Vec<FeeEstimate>> {
    service(&state)?.fee_estimates(&network).map_err(err)
}

#[tauri::command(async)]
fn prepare_send(
    state: State<'_, AppState>,
    key_id: String,
    address: String,
    amount: Option<u64>,
    feerate: f32,
) -> CmdResult<SendPreview> {
    service(&state)?
        .prepare_send(&key_id, &address, amount, feerate)
        .map_err(err)
}

#[tauri::command(async)]
fn start_send(
    state: State<'_, AppState>,
    key_id: String,
    signer_ids: Vec<String>,
) -> CmdResult<String> {
    service(&state)?
        .start_send(&key_id, signer_ids)
        .map_err(err)
}

#[tauri::command(async)]
fn request_device_sign(
    state: State<'_, AppState>,
    session_id: String,
    device_id: String,
) -> CmdResult<()> {
    service(&state)?
        .request_device_sign(&session_id, &device_id)
        .map_err(err)
}

#[tauri::command(async)]
fn resume_signing(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    service(&state)?.resume_signing(&session_id).map_err(err)
}

#[tauri::command(async)]
fn cancel_sign_session(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    service(&state)?
        .cancel_sign_session(&session_id)
        .map_err(err)
}

#[tauri::command(async)]
fn sessions(state: State<'_, AppState>, key_id: String) -> CmdResult<Vec<SessionView>> {
    service(&state)?.sessions(&key_id).map_err(err)
}

#[tauri::command(async)]
fn broadcast(state: State<'_, AppState>, session_id: String) -> CmdResult<String> {
    service(&state)?.broadcast(&session_id).map_err(err)
}

// ---------- electrum ----------

#[tauri::command(async)]
fn electrum_servers(state: State<'_, AppState>, network: String) -> CmdResult<ElectrumView> {
    service(&state)?.electrum_servers(&network).map_err(err)
}

#[tauri::command(async)]
fn set_electrum_servers(
    state: State<'_, AppState>,
    network: String,
    primary: String,
    backup: String,
) -> CmdResult<()> {
    service(&state)?
        .set_electrum_servers(&network, &primary, &backup)
        .map_err(err)
}

#[tauri::command(async)]
fn restore_default_electrum(state: State<'_, AppState>, network: String) -> CmdResult<()> {
    service(&state)?
        .restore_default_electrum(&network)
        .map_err(err)
}

// ---------- display ----------

#[tauri::command(async)]
fn hide_balance(state: State<'_, AppState>) -> CmdResult<bool> {
    Ok(service(&state)?.hide_balance())
}

#[tauri::command(async)]
fn set_hide_balance(state: State<'_, AppState>, hide: bool) -> CmdResult<()> {
    service(&state)?.set_hide_balance(hide).map_err(err)
}

#[tauri::command(async)]
fn reconnect(state: State<'_, AppState>, network: String) -> CmdResult<()> {
    service(&state)?.reconnect(&network).map_err(err)
}

/// A 32×32 RGBA menu icon from `icons/menu` (Lucide icons, ISC licence; see LICENSE-lucide.txt
/// there). Windows and Linux draw them at 16×16.
#[cfg(desktop)]
macro_rules! menu_icon {
    ($name:literal) => {
        tauri::image::Image::new(
            include_bytes!(concat!("../icons/menu/", $name, ".rgba")),
            32,
            32,
        )
    };
}

/// The native menu bar. Quit is handled here; every other item is forwarded to the window as a
/// `menu` event carrying the item id, and the UI decides what to show.
#[cfg(desktop)]
fn build_menu(app: &tauri::App) -> tauri::Result<()> {
    let item = |id: &str, text: &str, accel: Option<&str>, icon: tauri::image::Image<'static>| {
        let mut b = IconMenuItemBuilder::with_id(id, text);
        // Icons in a macOS menu bar look out of place there, so they're left off on macOS.
        if !cfg!(target_os = "macos") {
            b = b.icon(icon);
        }
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };
    let file = SubmenuBuilder::new(app, "File")
        .item(&item(
            "settings",
            "Settings",
            Some("CmdOrCtrl+,"),
            menu_icon!("settings"),
        )?)
        .separator()
        .item(&item(
            "quit",
            "Quit Icebox",
            Some("CmdOrCtrl+Q"),
            menu_icon!("power"),
        )?)
        .build()?;
    let wallet = SubmenuBuilder::new(app, "Wallet")
        .item(&item(
            "new_wallet",
            "New multi-sig wallet…",
            Some("CmdOrCtrl+N"),
            menu_icon!("plus"),
        )?)
        .item(&item(
            "restore",
            "Restore from devices…",
            None,
            menu_icon!("rotate-ccw-clock"),
        )?)
        .item(&item(
            "watch_add",
            "Add watch-only wallet…",
            None,
            menu_icon!("eye"),
        )?)
        .separator()
        .item(&item(
            "receive",
            "Receive",
            Some("CmdOrCtrl+R"),
            menu_icon!("arrow-down-left"),
        )?)
        .item(&item(
            "send",
            "Send",
            Some("CmdOrCtrl+S"),
            menu_icon!("arrow-up-right"),
        )?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item(
            "devices",
            "Devices",
            Some("CmdOrCtrl+D"),
            menu_icon!("usb"),
        )?)
        .item(&item(
            "hide_balances",
            "Hide or show balances",
            Some("CmdOrCtrl+B"),
            menu_icon!("eye-off"),
        )?)
        .build()?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&item("guide", "User guide", None, menu_icon!("book-open"))?)
        .item(&item(
            "shortcuts",
            "Keyboard shortcuts",
            Some("CmdOrCtrl+/"),
            menu_icon!("keyboard"),
        )?)
        .item(&item(
            "demo",
            "Try demo mode",
            None,
            menu_icon!("flask-conical"),
        )?)
        .separator()
        .item(&item(
            "updates",
            "Check for updates",
            None,
            menu_icon!("cloud-download"),
        )?)
        .item(&item("logs", "Logs", None, menu_icon!("scroll-text"))?)
        .item(&item(
            "report_bug",
            "Report a bug",
            None,
            menu_icon!("bug"),
        )?)
        .separator()
        .item(&item("about", "About Icebox", None, menu_icon!("info"))?)
        .build()?;
    let menu = MenuBuilder::new(app)
        .item(&file)
        .item(&wallet)
        .item(&view)
        .item(&help)
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref().to_string();
        if id == "quit" {
            app.exit(0);
        } else if let Err(e) = app.emit("menu", id) {
            tracing::warn!("could not deliver menu event: {e}");
        }
    });
    Ok(())
}

/// `ICEBOX_DATA_DIR` overrides the default per-user application data folder.
fn resolve_data_dir(app: &tauri::AppHandle) -> CmdResult<PathBuf> {
    if let Some(dir) = std::env::var_os("ICEBOX_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    app.path()
        .app_data_dir()
        .map_err(|e| format!("can't find a data directory: {e}"))
}

/// How Icebox reaches the devices: serial ports on desktop, Android's USB host API on Android.
#[cfg(not(target_os = "android"))]
fn device_serial(_app: &tauri::AppHandle) -> Box<dyn icebox_core::Serial> {
    Box::new(icebox_core::DesktopSerial)
}

#[cfg(target_os = "android")]
fn device_serial(app: &tauri::AppHandle) -> Box<dyn icebox_core::Serial> {
    let usb = app
        .state::<tauri_plugin_icebox_usb::UsbHost<tauri::Wry>>()
        .inner()
        .clone();
    Box::new(android_usb::AndroidSerial::new(usb))
}

/// Starts Icebox. Desktop builds call this from `main.rs`; Android calls it as the app's entry
/// point.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        // Must be the first plugin: a second launch focuses the running window instead of
        // starting another copy that would fight it for the USB ports.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // Remembers window size and position between launches.
        .plugin(tauri_plugin_window_state::Builder::default().build());
    builder
        // Android: lists Frostsnap devices on the USB port and opens them. Does nothing elsewhere.
        .plugin(tauri_plugin_icebox_usb::init())
        // Used only from Rust (open_tx, open_help, show_log_file); the page has no opener
        // permission.
        .plugin(tauri_plugin_opener::init())
        .manage(AppState(OnceLock::new()))
        .setup(|app| {
            init_logging(app.handle());
            #[cfg(desktop)]
            build_menu(app)?;
            let handle = app.handle().clone();
            let result = resolve_data_dir(&handle).and_then(|dir| {
                let emitter = handle.clone();
                let events: icebox_core::EventFn = Arc::new(move |event: Event| {
                    if let Err(e) = emitter.emit("icebox", &event) {
                        tracing::warn!("could not deliver event to window: {e}");
                    }
                });
                Service::start_with(&dir, events, device_serial(&handle)).map_err(err)
            });
            if let Err(e) = &result {
                tracing::error!("startup failed: {e}");
            }
            let _ = app.state::<AppState>().0.set(result);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_status,
            app_info,
            open_tx,
            quit_app,
            erase_device,
            erase_devices,
            open_help,
            read_logs,
            show_log_file,
            hide_balance,
            set_hide_balance,
            restore_default_electrum,
            start_restore_scan,
            restore_candidates,
            restore_wallet,
            add_devices_to_wallet,
            clear_device_screens,
            decode_qr,
            open_release,
            watch_only_wallets,
            watch_only_code,
            add_watch_only,
            remove_watch_only,
            save_restore,
            finish_saved_restore,
            cancel_saved_restore,
            saved_restores,
            data_dir,
            list_devices,
            preview_device_name,
            replenish_nonces,
            cancel_protocol,
            list_keys,
            start_keygen,
            finalize_keygen,
            delete_wallet,
            check_backup,
            mark_address_shared,
            addresses,
            address,
            descriptor_qr,
            btcpay_scheme,
            display_backup,
            mark_backup_complete,
            descriptor,
            wallet,
            next_address,
            verify_address,
            fee_estimates,
            prepare_send,
            start_send,
            request_device_sign,
            resume_signing,
            cancel_sign_session,
            sessions,
            broadcast,
            electrum_servers,
            set_electrum_servers,
            reconnect,
            price_settings,
            set_price_settings,
            btcpay_watch,
            set_btcpay_watch,
            coins,
            prepare_consolidate,
            labels,
            set_label,
            export_labels,
            import_labels,
            history_csv,
            save_export,
            show_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Icebox");
}
