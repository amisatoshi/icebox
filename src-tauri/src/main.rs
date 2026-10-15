// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Tauri shell. It does three things only: starts the [`Service`], forwards its events to
//! the window, and exposes each wallet action as a command. All wallet logic lives in
//! `icebox-core`.

use icebox_core::events::*;
use icebox_core::{Event, Service};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, State};

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
fn reconnect(state: State<'_, AppState>, network: String) -> CmdResult<()> {
    service(&state)?.reconnect(&network).map_err(err)
}

/// The native menu bar. Quit is handled here; every other item is forwarded to the window as a
/// `menu` event carrying the item id, and the UI decides what to show.
fn build_menu(app: &tauri::App) -> tauri::Result<()> {
    let item = |id: &str, text: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::with_id(id, text);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("settings", "Settings", Some("CmdOrCtrl+,"))?)
        .separator()
        .item(&item("quit", "Quit Icebox", Some("CmdOrCtrl+Q"))?)
        .build()?;
    let wallet = SubmenuBuilder::new(app, "Wallet")
        .item(&item("new_wallet", "New wallet…", Some("CmdOrCtrl+N"))?)
        .item(&item("restore", "Restore from devices…", None)?)
        .separator()
        .item(&item("receive", "Receive", Some("CmdOrCtrl+R"))?)
        .item(&item("send", "Send", Some("CmdOrCtrl+S"))?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("devices", "Devices", Some("CmdOrCtrl+D"))?)
        .build()?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&item("demo", "Try demo mode", None)?)
        .separator()
        .item(&item("about", "About Icebox", None)?)
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

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                // nusb is noisy; electrum at warn is plenty
                "info,nusb=error,bdk_electrum_streaming=warn".into()
            }),
        )
        .init();

    tauri::Builder::default()
        // Must be the first plugin: a second launch focuses the running window instead of
        // starting another copy that would fight it for the USB ports.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // Remembers window size and position between launches.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // Used only from Rust (open_tx); the page has no opener permission.
        .plugin(tauri_plugin_opener::init())
        .manage(AppState(OnceLock::new()))
        .setup(|app| {
            build_menu(app)?;
            let handle = app.handle().clone();
            let result = resolve_data_dir(&handle).and_then(|dir| {
                let emitter = handle.clone();
                let events: icebox_core::EventFn = Arc::new(move |event: Event| {
                    if let Err(e) = emitter.emit("icebox", &event) {
                        tracing::warn!("could not deliver event to window: {e}");
                    }
                });
                Service::start(&dir, events).map_err(err)
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
            start_restore_scan,
            restore_candidates,
            restore_wallet,
            data_dir,
            list_devices,
            preview_device_name,
            replenish_nonces,
            cancel_protocol,
            list_keys,
            start_keygen,
            finalize_keygen,
            delete_wallet,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Icebox");
}
