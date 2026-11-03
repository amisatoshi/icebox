"use strict";
/*
 * Icebox UI. Plain JavaScript, no dependencies, no build step.
 *
 * Talks to the Rust side only through Tauri's IPC bridge: `invoke` calls an explicit command,
 * `listen("icebox")` receives events. Every piece of text from outside (device names, addresses,
 * wallet names) is inserted with textContent, never as HTML.
 */

const tauri = window.__TAURI__;
// Every command goes through `backend`, which demo mode swaps for the simulated one.
let backend = (cmd, args) => tauri.core.invoke(cmd, args || {});
const invoke = (cmd, args) => backend(cmd, args || {});

// ---------------------------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------------------------

const state = {
  ready: false,
  demo: false,          // simulated devices and coins (Help → Try demo mode)
  appInfo: null,        // version, Frostsnap commit, expected firmware
  erase: null,          // { id, step: "confirm" | "waiting" } while erasing a device
  restore: null,        // restore page: { scan, busy }
  restoreScanning: false,
  startupError: null,
  devices: [],
  keys: [],
  chain: {},            // network -> { state, url }
  view: { name: "devices" },
  nonces: null,         // last nonce replenish progress
  keygen: null,         // last keygen progress
  verify: null,         // last verify-address progress
  backup: null,         // last display-backup progress
  checkBackup: null,    // { keyId, device_id, done, valid } while checking a backup on a device
  signing: {},          // session id -> last signing progress
  wizard: null,
  wallet: null,         // per-wallet page state
  settings: null,
};

// ---------------------------------------------------------------------------------------------
// tiny DOM helpers
// ---------------------------------------------------------------------------------------------

/** h("div", { class: "x", onclick: fn, text: "..." }, child, child) */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    // Through CSSOM rather than the style attribute, which the app's content security policy blocks.
    else if (k === "style") el.style.cssText = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $ = (id) => document.getElementById(id);

let toastTimer = null;
function toast(message, bad) {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), bad ? 6000 : 3000);
}

/** Runs a command, showing any error as a toast. Returns undefined on failure, and null (never
 *  undefined) for a command that succeeds without a value. */
async function call(cmd, args) {
  try {
    const result = await invoke(cmd, args);
    return result === undefined ? null : result;
  } catch (e) {
    toast(String(e), true);
    return undefined;
  }
}

function fmtSats(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-GB") + " sats";
}
function fmtBtc(n) {
  if (n === null || n === undefined) return "—";
  const sign = n < 0 ? "−" : "";
  return sign + (Math.abs(n) / 1e8).toFixed(8);
}
function shortId(id) {
  return id ? id.slice(0, 8) + "…" : "";
}
function fmtTime(ts) {
  if (!ts) return "unconfirmed";
  return new Date(ts * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}
function networkLabel(n) {
  return { bitcoin: "Mainnet", signet: "Signet", testnet: "Testnet", regtest: "Regtest" }[n] || n || "—";
}

/** "2 to sign": how many devices must approve. Shown instead of "2-of-3" because a wallet
 *  restored from some of its devices doesn't know how many devices exist in total. */
function signLabel(k) {
  return `${k.threshold} to sign`;
}

function deviceName(id) {
  const d = state.devices.find((d) => d.id === id);
  if (d && d.name) return d.name;
  for (const k of state.keys) {
    const kd = k.devices.find((kd) => kd.id === id);
    if (kd && kd.name) return kd.name;
  }
  return "Device " + shortId(id);
}
const isConnected = (id) => state.devices.some((d) => d.id === id);

/** An address split into groups of four characters, for reading against a device screen. */
function addressChunks(address) {
  const box = h("div", { class: "address-box" });
  for (let i = 0; i < address.length; i += 4) {
    box.append(h("span", { class: "chunk", text: address.slice(i, i + 4) }), " ");
  }
  return box;
}

// ---------------------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------------------

// Ends an on-device address check: the devices stop showing the address.
function stopVerify() {
  if (state.verify) call("cancel_protocol");
  state.verify = null;
}

function render() {
  // Leaving the restore page stops the scan, so devices aren't asked about shares forever.
  if (state.restoreScanning && state.view.name !== "restore") {
    state.restoreScanning = false;
    call("cancel_protocol");
  }
  // Leaving the Receive tab clears an address check, so devices go back to their home screen.
  if (state.verify && !(state.view.name === "wallet" && state.wallet && state.wallet.tab === "receive")) stopVerify();
  // Leaving the Backups tab ends a backup check, so the device goes back to its home screen.
  if (state.checkBackup && !state.checkBackup.done && !(state.view.name === "wallet" && state.wallet && state.wallet.tab === "backups")) {
    state.checkBackup = null;
    call("cancel_protocol");
  }
  // Re-rendering replaces the DOM, so remember which input had focus and put it back.
  const active = document.activeElement;
  const focusId = active && active.id;
  const selStart = active && active.selectionStart;
  renderSidebar();
  const main = $("main");
  main.replaceChildren(renderMain());
  if (focusId) {
    const el = $(focusId);
    if (el) {
      el.focus();
      try { if (selStart !== null && selStart !== undefined) el.setSelectionRange(selStart, selStart); } catch (_) {}
    }
  }
}

function renderSidebar() {
  $("device-count").textContent = state.devices.length;
  $("device-hint").hidden = state.devices.length > 0;
  $("device-chain").replaceChildren(
    ...state.devices.map((d) =>
      h("li", {},
        h("span", { class: "dot" + (d.ready ? (d.name ? "" : " blank") : " connecting") }),
        h("div", { class: "meta" },
          h("span", { class: "name", text: d.name || "New device" }),
          h("span", { class: "sub", text: !d.ready ? "connecting…" : d.name ? `${d.nonces} nonces` : "not set up yet" }),
        ),
      ),
    ),
  );
  const current = state.view.name === "wallet" ? state.view.keyId : null;
  $("wallet-list").replaceChildren(
    ...state.keys.map((k) =>
      h("li", {},
        h("button", {
          class: k.key_id === current ? "active" : "",
          onclick: () => openWallet(k.key_id),
        },
          h("span", { class: "wname", text: k.name }),
          h("span", { class: "wsub", text: `${signLabel(k)} · ${networkLabel(k.network)}` }),
        ),
      ),
    ),
  );
}

function renderMain() {
  if (state.startupError) {
    return h("div", { class: "page" },
      h("h1", { text: "Icebox couldn't start" }),
      h("div", { class: "notice bad", text: state.startupError }),
    );
  }
  const page = renderView();
  if (state.demo) page.prepend(demoBanner());
  return page;
}

function renderView() {
  switch (state.view.name) {
    case "wizard": return renderWizard();
    case "wallet": return renderWallet();
    case "settings": return renderSettings();
    case "about": return renderAbout();
    case "restore": return renderRestore();
    default: return renderDevices();
  }
}

// ---------------------------------------------------------------------------------------------
// demo mode
// ---------------------------------------------------------------------------------------------

function demoBanner() {
  return h("div", { class: "notice warn demo-banner" },
    h("strong", { text: "Demo mode. " }),
    "Simulated devices and test coins. Nothing here touches real devices, your wallets or the network. ",
    h("button", { class: "link", onclick: exitDemo }, "Exit demo"),
  );
}

async function enterDemo() {
  if (state.demo) return;
  state.demo = true;
  const demo = window.createIceboxDemo((event) => onEvent(event));
  backend = (cmd, args) => demo.invoke(cmd, args);
  Object.assign(state, {
    devices: [], keys: [], chain: {}, nonces: null, keygen: null, verify: null, backup: null,
    signing: {}, wizard: null, wallet: null, settings: null, erase: null, startupError: null,
    restore: null, restoreScanning: false,
  });
  const [devices, keys] = await Promise.all([call("list_devices"), call("list_keys")]);
  state.devices = devices || [];
  state.keys = keys || [];
  state.view = { name: "devices" };
  render();
  toast("Demo mode: three pretend devices are plugged in. Try New wallet.");
}

function exitDemo() {
  // A fresh start is the simplest way to be sure nothing simulated lingers.
  location.reload();
}

// ---------------------------------------------------------------------------------------------
// restore from devices
// ---------------------------------------------------------------------------------------------

async function openRestore() {
  state.view = { name: "restore" };
  state.restore = { scan: null, busy: null };
  render();
  if (await call("start_restore_scan") !== undefined) {
    state.restoreScanning = true;
    await refreshRestore();
  }
}

let restoreRefreshTimer = null;
function scheduleRestoreRefresh() {
  clearTimeout(restoreRefreshTimer);
  restoreRefreshTimer = setTimeout(refreshRestore, 250);
}

async function refreshRestore() {
  if (state.view.name !== "restore" || !state.restore) return;
  const scan = await call("restore_candidates");
  if (scan && state.restore) { state.restore.scan = scan; render(); }
}

const RESTORE_STATUS = {
  ready: "Enough devices found. Ready to restore.",
  need_more: "Plug in more of this wallet's devices.",
  already_here: "Already in Icebox.",
  not_bitcoin: "Not a bitcoin wallet. Icebox can't restore this yet.",
  unknown_threshold: "These devices don't say how many are needed. Try restoring; Icebox will tell you if more are needed.",
};

function renderRestore() {
  const r = state.restore || {};
  const scan = r.scan;
  const page = h("div", { class: "page" },
    h("div", { class: "page-head" },
      h("div", {},
        h("h1", { text: "Restore from devices" }),
        h("p", { class: "sub", text: "Rebuild a wallet in Icebox from the devices that hold it, for example one you made in the official Frostsnap app." }),
      ),
    ),
    h("div", { class: "card" },
      h("p", { text: "Plug in the wallet's devices. You can chain them all at once, or plug them in one after another: Icebox remembers what each one said. You need as many devices as the wallet's threshold (e.g. 2 for a 2-of-3)." }),
      h("p", { class: "muted small", text: "Devices are only asked which wallets they hold. Nothing on them changes, and their backup words never leave them." }),
      scan
        ? h("p", { class: "muted small", text: `${scan.answered.length} device${scan.answered.length === 1 ? "" : "s"} answered${scan.waiting.length ? ` · waiting for ${scan.waiting.length}` : ""}` })
        : h("p", { class: "muted small", text: "Asking devices…" }),
      state.demo ? h("div", { class: "row" },
        h("button", { class: "btn small", onclick: async () => { await call("demo_plug_restore_devices"); scheduleRestoreRefresh(); } }, "Demo: plug in two devices holding an older wallet"),
      ) : null,
    ),
  );

  if (scan && scan.candidates.length === 0) {
    page.append(h("div", { class: "card empty" },
      h("p", { text: scan.answered.length ? "None of these devices hold a wallet share." : "No devices have answered yet." }),
      h("p", { class: "small", text: "Blank devices hold nothing. Plug in devices that were set up as part of a wallet." }),
    ));
    return page;
  }

  for (const c of (scan ? scan.candidates : [])) {
    const need = c.threshold || null;
    const pct = need ? Math.min(100, Math.round((c.found / need) * 100)) : 0;
    const card = h("div", { class: "card restore-card" + (c.status === "ready" ? " ready" : "") },
      h("div", { class: "row between" },
        h("div", { class: "row" },
          h("h2", { text: c.name }),
          c.network ? h("span", { class: "pill" + (c.network === "bitcoin" ? " main" : ""), text: networkLabel(c.network) }) : null,
        ),
        h("strong", { text: need ? (c.found >= need ? `${c.found} found · ${need} needed` : `${c.found} of ${need} needed`) : `${c.found} found` }),
      ),
      need ? h("div", { class: "meter" }, h("span", { style: `width:${pct}%` })) : null,
      h("div", { class: "list" },
        ...c.devices.map((d) => h("div", { class: "item" },
          h("span", { text: d.name || "Device " + shortId(d.id) }),
          h("div", { class: "row" },
            h("span", { class: "pill", text: `share #${d.share_number}` }),
            h("span", { class: "pill" + (d.connected ? " ok" : ""), text: d.connected ? "plugged in" : "seen earlier" }),
          ),
        )),
      ),
      h("p", { class: c.status === "ready" ? "" : "muted", text: RESTORE_STATUS[c.status] || c.status }),
    );
    const actions = h("div", { class: "row" });
    if (c.status === "already_here") {
      const key = state.keys.find((k) => c.group_id.startsWith(k.key_id));
      if (key) actions.append(h("button", { class: "btn", onclick: () => openWallet(key.key_id) }, "Open wallet"));
    } else if (c.status === "ready" || c.status === "unknown_threshold") {
      if (c.network === "bitcoin") card.append(h("div", { class: "notice warn", text: "This is a mainnet wallet holding real bitcoin. Icebox is new and unaudited: restoring only reads the devices, but be careful sending from it." }));
      actions.append(h("button", {
        class: "btn primary",
        disabled: r.busy === c.group_id,
        onclick: async () => {
          r.busy = c.group_id; render();
          const keyId = await call("restore_wallet", { groupId: c.group_id });
          r.busy = null;
          if (keyId) { toast(`${c.name} restored`); openWallet(keyId); } else render();
        },
      }, r.busy === c.group_id ? "Restoring…" : `Restore ${c.name}`));
    }
    if (actions.childNodes.length) card.append(actions);
    page.append(card);
  }
  return page;
}

// ---------------------------------------------------------------------------------------------
// about
// ---------------------------------------------------------------------------------------------

async function openAbout() {
  state.view = { name: "about" };
  if (!state.appInfo) state.appInfo = await call("app_info");
  render();
}

function renderAbout() {
  const a = state.appInfo || {};
  return h("div", { class: "page" },
    h("div", { class: "page-head" },
      h("div", { class: "row" },
        h("img", { src: "icon.png", alt: "", class: "about-icon" }),
        h("div", {},
          h("h1", { text: "Icebox" }),
          h("p", { class: "sub", text: "A self-built desktop wallet for Frostsnap devices" }),
        ),
      ),
    ),
    h("div", { class: "card" },
      h("div", { class: "list" },
        h("div", { class: "item" }, h("span", { class: "muted", text: "Version" }), h("span", { class: "mono", text: a.version || "…" })),
        h("div", { class: "item" }, h("span", { class: "muted", text: "Built on Frostsnap" }), h("span", { class: "mono small", text: a.frostsnap_rev ? a.frostsnap_rev.slice(0, 12) : "…", title: a.frostsnap_rev })),
        h("div", { class: "item" }, h("span", { class: "muted", text: "Device firmware it expects" }), h("span", { class: "mono", text: a.expected_firmware || "…" })),
        h("div", { class: "item" }, h("span", { class: "muted", text: "Data folder" }), h("span", { class: "mono small", text: a.data_dir || "…" })),
        h("div", { class: "item" }, h("span", { class: "muted", text: "Licence" }), h("span", { text: "MIT · open source" })),
      ),
    ),
    h("div", { class: "notice warn", text: "Icebox is independent, third-party software. It is not made or endorsed by Frostsnap, and it has not been audited. Use Signet (test coins) until you trust it, and keep mainnet amounts small." }),
    h("p", { class: "muted small", text: "Icebox uses the open-source frostsnap_core and frostsnap_coordinator crates (MIT) for all key generation, signing and device communication. Private keys never leave the devices." }),
  );
}

// ---------------------------------------------------------------------------------------------
// firmware
// ---------------------------------------------------------------------------------------------

function firmwareNote(d) {
  const expected = (state.appInfo && state.appInfo.expected_firmware) || "the expected version";
  if (d.firmware_status === "older") return `Older firmware (${d.firmware}). Icebox expects ${expected}. Update it with the official Frostsnap app.`;
  if (d.firmware_status === "unrecognised") return `Firmware Icebox doesn't recognise (${d.firmware}): newer than this build, or a development build. Icebox expects ${expected}.`;
  return `Firmware ${d.firmware}, as expected.`;
}

function firmwarePill(d) {
  if (!d.ready || !d.firmware) return null;
  const ok = d.firmware_status === "expected";
  return h("span", { class: "pill" + (ok ? "" : " warn"), title: firmwareNote(d), text: ok ? d.firmware : `${d.firmware} ⚠` });
}

// ---------------------------------------------------------------------------------------------
// devices page
// ---------------------------------------------------------------------------------------------

function renderDevices() {
  const page = h("div", { class: "page" },
    h("div", { class: "page-head" },
      h("div", {},
        h("h1", { text: "Devices" }),
        h("p", { class: "sub", text: "Devices plugged in to this computer, in chain order." }),
      ),
    ),
  );

  if (state.devices.length === 0) {
    page.append(h("div", { class: "card empty" },
      h("p", { text: "No devices connected." }),
      h("p", { class: "small", text: "Plug a Frostsnap into a USB port. You can daisy-chain more devices off the first one." }),
      state.demo ? null : h("button", { class: "btn", onclick: enterDemo }, "No devices to hand? Try demo mode"),
    ));
    return page;
  }

  if (state.erase) page.append(renderErase());

  const fwIssues = state.devices.filter((d) => d.ready && d.firmware_status && d.firmware_status !== "expected");
  if (fwIssues.length) {
    page.append(h("div", { class: "notice warn" }, ...fwIssues.map((d) => h("div", { text: `${d.name || "New device"}: ${firmwareNote(d)}` }))));
  }

  page.append(h("div", { class: "card" },
    h("div", { class: "list" },
      ...state.devices.map((d) =>
        h("div", { class: "item" },
          h("div", { class: "stack" },
            h("strong", { text: d.name || "New device (not set up)" }),
            h("span", { class: "muted small mono", text: d.id }),
          ),
          h("div", { class: "row" },
            firmwarePill(d),
            d.ready
              ? h("span", { class: "pill" + (d.nonces > 0 ? " ok" : " warn"), text: `${d.nonces} nonces` })
              : h("span", { class: "pill warn", text: "connecting…" }),
            d.ready && !state.erase
              ? h("button", { class: "btn danger small", onclick: () => { state.erase = { id: d.id, step: "confirm" }; render(); } }, "Erase…")
              : null,
          ),
        ),
      ),
    ),
  ));

  const named = state.devices.filter((d) => d.ready && d.name);
  page.append(h("div", { class: "card" },
    h("h2", { text: "Prepare devices for signing" }),
    h("p", { class: "muted", text: "Each signature uses up one nonce from the device. Topping them up while the devices are plugged in means you won't be stopped halfway through a payment." }),
    renderNonceProgress(),
    h("div", { class: "row" },
      h("button", {
        class: "btn",
        disabled: named.length === 0,
        onclick: () => call("replenish_nonces", { deviceIds: named.map((d) => d.id) }),
      }, "Top up nonces on plugged-in devices"),
    ),
  ));
  return page;
}

function renderErase() {
  const e = state.erase;
  const d = state.devices.find((x) => x.id === e.id);
  const name = d && d.name ? d.name : "this device";
  const holds = state.keys.filter((k) => k.devices.some((kd) => kd.id === e.id));
  const card = h("div", { class: "card erase-card" });
  if (e.step === "confirm") {
    card.append(
      h("h2", { text: `Erase ${name}?` }),
      h("p", { text: "This wipes everything on the device: its name and every wallet share it holds. It restarts as a new device." }),
      ...(holds.length ? [h("div", { class: "notice bad", text: `${name} holds a share of ${holds.map((k) => `"${k.name}"`).join(", ")}. Only continue if you have its backup written down, or the wallet's other devices can still meet the threshold without it.` })] : []),
      h("div", { class: "row" },
        h("button", { class: "btn danger", onclick: async () => {
          if (await call("erase_device", { deviceId: e.id }) !== undefined) { e.step = "waiting"; render(); }
        } }, "Erase device"),
        h("button", { class: "btn ghost", onclick: () => { state.erase = null; render(); } }, "Cancel"),
      ),
    );
  } else {
    card.append(
      h("h2", { text: `Confirm on ${name === "this device" ? "the device" : name}` }),
      h("p", { text: "The device is asking you to confirm. Nothing is erased until you confirm on the device itself." }),
      h("div", { class: "row" },
        h("button", { class: "btn ghost", onclick: () => { call("cancel_protocol"); state.erase = null; render(); } }, "Cancel"),
      ),
    );
  }
  return card;
}

function renderNonceProgress() {
  const n = state.nonces;
  if (!n) return null;
  if (n.aborted) return h("div", { class: "notice bad", text: "Topping up was cancelled. Reconnect the devices and try again." });
  if (n.finished) return h("div", { class: "notice", text: "Devices are ready." });
  return h("div", { class: "notice", text: `Preparing devices… ${n.completed_streams} of ${n.total_streams}` });
}

// ---------------------------------------------------------------------------------------------
// new wallet wizard
// ---------------------------------------------------------------------------------------------

function startWizard() {
  state.wizard = { step: "name", name: "", network: "signet", selected: [], names: {}, threshold: 2, keyId: null };
  state.keygen = null;
  state.nonces = null;
  state.view = { name: "wizard" };
  render();
}

const WIZARD_STEPS = ["name", "devices", "keygen", "backup"];

function renderWizard() {
  const w = state.wizard;
  const stepIndex = WIZARD_STEPS.indexOf(w.step === "prepare" ? "keygen" : w.step);
  const page = h("div", { class: "page" },
    h("div", { class: "page-head" },
      h("div", {},
        h("h1", { text: "New wallet" }),
        h("p", { class: "sub", text: "Your devices create the keys together. No single device, and not this computer, ever holds the whole key." }),
      ),
    ),
    h("div", { class: "steps" }, ...WIZARD_STEPS.map((_, i) => h("span", { class: i <= stepIndex ? "done" : "" }))),
  );
  if (w.step === "name") page.append(wizardName(w));
  else if (w.step === "devices") page.append(wizardDevices(w));
  else if (w.step === "prepare" || w.step === "keygen") page.append(wizardKeygen(w));
  else if (w.step === "backup") page.append(wizardBackup(w));
  return page;
}

function wizardName(w) {
  return h("div", { class: "card" },
    h("label", { class: "field" }, "Wallet name",
      h("input", {
        id: "wz-name", type: "text", value: w.name, maxlength: 20, placeholder: "e.g. Family savings",
        oninput: (e) => (w.name = e.target.value),
      }),
    ),
    h("label", { class: "field" }, "Network",
      h("select", { id: "wz-network", onchange: (e) => { w.network = e.target.value; render(); } },
        ...["signet", "testnet", "regtest", "bitcoin"].map((n) =>
          h("option", { value: n, selected: w.network === n }, n === "bitcoin" ? "Mainnet (real bitcoin)" : networkLabel(n) + " (test coins)"),
        ),
      ),
    ),
    w.network === "bitcoin"
      ? h("div", { class: "notice warn", text: "Mainnet holds real money. Icebox is new, third-party software: try it on Signet first, and keep amounts small until you trust it." })
      : null,
    h("div", { class: "row" },
      h("button", { class: "btn ghost", onclick: () => { state.view = { name: "devices" }; render(); } }, "Cancel"),
      h("button", {
        class: "btn primary",
        onclick: () => {
          if (!w.name.trim()) return toast("Give the wallet a name", true);
          w.step = "devices";
          w.selected = state.devices.filter((d) => d.ready).map((d) => d.id);
          for (const d of state.devices) if (d.name) w.names[d.id] = d.name;
          // default to a majority: 2-of-3, 3-of-5, ...
          w.threshold = Math.max(1, Math.floor(w.selected.length / 2) + 1);
          render();
          previewAllNames(w);
        },
      }, "Next"),
    ),
  );
}

let previewTimers = {};
function previewName(id, name) {
  clearTimeout(previewTimers[id]);
  previewTimers[id] = setTimeout(() => {
    if (name.trim()) call("preview_device_name", { deviceId: id, name: name.trim() });
  }, 250);
}
function previewAllNames(w) {
  for (const id of w.selected) if (w.names[id]) previewName(id, w.names[id]);
}

function wizardDevices(w) {
  // keep the selection in step with what is actually plugged in
  // As in the official app, only blank devices can join a new wallet: a device that already has a
  // name already holds a wallet, and must be unplugged (or erased) first. The device firmware is
  // built around one wallet per device. The core service enforces the same rule.
  w.selected = w.selected.filter((id) => state.devices.some((d) => d.id === id && d.ready && !d.name));
  const holdingKey = state.devices.filter((d) => d.ready && d.name);
  const n = w.selected.length;
  if (w.threshold > n) w.threshold = Math.max(1, n);

  const rows = state.devices.map((d, i) => {
    if (!d.ready) {
      return h("div", { class: "item" },
        h("span", { class: "muted", text: `#${i + 1}` }),
        h("span", { class: "muted small", text: "Still connecting… if this doesn't clear within a few seconds, unplug and replug this device." }),
        h("span", { class: "pill warn", text: "connecting" }),
      );
    }
    if (d.name) {
      return h("div", { class: "item" },
        h("span", { text: d.name }),
        h("span", { class: "muted small", text: "Already holds a wallet. Unplug it to continue, or erase it on the Devices page." }),
        h("span", { class: "pill bad", text: "unplug" }),
      );
    }
    const selected = w.selected.includes(d.id);
    return h("div", { class: "item" },
      h("label", { class: "check" },
        h("input", {
          type: "checkbox", checked: selected,
          onchange: (e) => {
            if (e.target.checked) w.selected.push(d.id);
            else w.selected = w.selected.filter((x) => x !== d.id);
            render();
          },
        }),
        `#${i + 1}`,
      ),
      h("input", {
        id: "wz-dev-" + d.id, type: "text", maxlength: 14, placeholder: "Name this device",
        value: w.names[d.id] || "", disabled: !selected,
        oninput: (e) => { w.names[d.id] = e.target.value; previewName(d.id, e.target.value); render(); },
      }),
      h("span", { class: "pill warn", text: "new" }),
    );
  });

  const unnamed = w.selected.filter((id) => !(w.names[id] || "").trim());
  const fwIssues = w.selected.map((id) => state.devices.find((d) => d.id === id)).filter((d) => d && d.firmware_status && d.firmware_status !== "expected");
  const fwBlocked = fwIssues.length > 0 && !w.fwOverride;
  return h("div", { class: "card" },
    h("h2", { text: "Choose devices" }),
    h("p", { class: "muted", text: "Plug in every device that will hold a share. The name you type appears on the device's screen as you type it." }),
    state.devices.length === 0
      ? h("div", { class: "notice warn", text: "No devices plugged in." })
      : h("div", { class: "list" }, ...rows),
    h("label", { class: "field" }, "Signatures needed to spend",
      h("select", { id: "wz-threshold", onchange: (e) => { w.threshold = Number(e.target.value); render(); } },
        ...Array.from({ length: Math.max(n, 1) }, (_, i) => i + 1).map((t) =>
          h("option", { value: t, selected: t === w.threshold }, `${t} of ${n}`),
        ),
      ),
    ),
    n === 1 ? h("div", { class: "notice warn", text: "With one device, losing it means losing the wallet. Two or three devices is the point of Frostsnap." }) : null,
    w.threshold === n && n > 1 ? h("div", { class: "notice warn", text: `Every device is needed to spend. If one is lost, so are the funds. ${n - 1} of ${n} or fewer leaves room for a lost device.` }) : null,
    fwIssues.length ? h("div", { class: "notice warn" },
      ...fwIssues.map((d) => h("div", { text: `${w.names[d.id] || d.name || "A device"}: ${firmwareNote(d)}` })),
      h("label", { class: "check fw-override" },
        h("input", { type: "checkbox", checked: !!w.fwOverride, onchange: (ev) => { w.fwOverride = ev.target.checked; render(); } }),
        "I understand the risk. Create the wallet anyway (Signet only, please)."),
    ) : null,
    h("div", { class: "row" },
      h("button", { class: "btn ghost", onclick: () => { w.step = "name"; render(); } }, "Back"),
      h("button", {
        class: "btn primary",
        disabled: n === 0 || unnamed.length > 0 || fwBlocked || holdingKey.length > 0,
        onclick: () => beginKeygen(w),
      }, "Create keys"),
      holdingKey.length ? h("span", { class: "muted small", text: `Unplug ${holdingKey.map((d) => d.name).join(", ")} first: ${holdingKey.length === 1 ? "it already holds" : "they already hold"} a wallet.` })
        : unnamed.length ? h("span", { class: "muted small", text: "Name every selected device first." })
        : fwBlocked ? h("span", { class: "muted small", text: "Resolve the firmware warning first." }) : null,
    ),
  );
}

async function beginKeygen(w) {
  // send the final names to the devices, then top up nonces, then start the ceremony
  for (const id of w.selected) {
    await call("preview_device_name", { deviceId: id, name: w.names[id].trim() });
  }
  w.step = "prepare";
  state.nonces = null;
  state.keygen = null;
  render();
  await call("replenish_nonces", { deviceIds: w.selected });
}

function onNoncesForWizard() {
  const w = state.wizard;
  if (!w || w.step !== "prepare" || !state.nonces) return;
  if (state.nonces.aborted) return;
  if (state.nonces.finished) {
    w.step = "keygen";
    call("start_keygen", {
      deviceIds: w.selected, threshold: w.threshold, name: w.name.trim(), network: w.network,
    }).then((r) => { if (r === undefined) { w.step = "devices"; render(); } });
  }
}

function wizardKeygen(w) {
  const k = state.keygen;
  const card = h("div", { class: "card" });
  if (w.step === "prepare") {
    card.append(h("h2", { text: "Preparing devices" }), renderNonceProgress() || h("p", { class: "muted", text: "Starting…" }));
    if (state.nonces && state.nonces.aborted) {
      card.append(h("button", { class: "btn", onclick: () => { w.step = "devices"; render(); } }, "Back"));
    }
    return card;
  }
  card.append(h("h2", { text: "Creating keys" }));
  if (!k) {
    card.append(h("p", { class: "muted", text: "Starting key generation…" }));
    return card;
  }
  if (k.aborted) {
    card.append(
      h("div", { class: "notice bad", text: "Key generation stopped: " + k.aborted }),
      h("button", { class: "btn", onclick: () => { w.step = "devices"; state.keygen = null; render(); } }, "Start again"),
    );
    return card;
  }
  card.append(h("div", { class: "list" },
    ...k.devices.map((id) => {
      const acked = k.session_acks.includes(id);
      const shared = k.got_shares.includes(id);
      return h("div", { class: "item" },
        h("strong", { text: w.names[id] || deviceName(id) }),
        h("span", {
          class: "pill" + (acked ? " ok" : ""),
          text: acked ? "confirmed on device" : shared ? "waiting for you to confirm on device" : "working…",
        }),
      );
    }),
  ));
  if (k.check_code) {
    card.append(
      h("p", { text: "Every device should now show this code:" }),
      h("div", { class: "code-big", text: k.check_code.toUpperCase() }),
      h("p", { class: "muted", text: "Check each screen. If any device shows a different code, cancel — something is interfering." }),
    );
  }
  card.append(h("div", { class: "row" },
    h("button", { class: "btn ghost", onclick: () => { call("cancel_protocol"); w.step = "devices"; state.keygen = null; render(); } }, "Cancel"),
    h("button", {
      class: "btn primary",
      disabled: !k.all_acks,
      onclick: async () => {
        const keyId = await call("finalize_keygen", { keygenId: k.keygen_id });
        if (keyId) { w.keyId = keyId; w.step = "backup"; state.backup = null; render(); }
      },
    }, k.all_acks ? `All devices show ${k.check_code.toUpperCase()}` : "Waiting for every device…"),
  ));
  return card;
}

function wizardBackup(w) {
  const key = state.keys.find((k) => k.key_id === w.keyId);
  const card = h("div", { class: "card" },
    h("h2", { text: "Write down each device's backup" }),
    h("p", { class: "muted", text: "Each device shows its own backup words on its screen. They never come to this computer. Write each one down and store it with, or near, its device." }),
  );
  if (!key) {
    card.append(h("p", { class: "muted", text: "Saving…" }));
    return card;
  }
  card.append(renderBackupList(key));
  card.append(h("div", { class: "row" },
    h("button", { class: "btn primary", onclick: () => openWallet(key.key_id) },
      key.devices.every((d) => d.backup_done === true) ? "Open wallet" : "I'll finish backups later"),
  ));
  return card;
}

function renderBackupList(key) {
  const b = state.backup;
  return h("div", { class: "list" },
    ...key.devices.map((d) => {
      const showing = b && b.device_id === d.id && !b.closed;
      // backup_done: true (confirmed here), false (not yet), null (restored: unknown here)
      const show = (label, cls) => h("button", {
        class: cls,
        onclick: () => { state.backup = { device_id: d.id, confirmed: false, closed: false }; call("display_backup", { keyId: key.key_id, deviceId: d.id }); render(); },
      }, label);
      const status = d.backup_done === true ? h("span", { class: "pill ok", text: "backed up" })
        : d.backup_done === false ? h("span", { class: "pill warn", text: "not backed up" })
        : h("span", { class: "pill", text: "unknown on this computer" });
      const c = state.checkBackup;
      const checking = c && c.device_id === d.id && c.keyId === key.key_id && !c.done && isConnected(d.id);
      const check = h("button", {
        class: "btn small ghost",
        title: "Type the words you wrote down on the device. It tells you if they match. The words never reach this computer.",
        onclick: () => { state.checkBackup = { keyId: key.key_id, device_id: d.id, done: false }; call("check_backup", { keyId: key.key_id, deviceId: d.id }).then((r) => { if (r === undefined) { state.checkBackup = null; render(); } }); render(); },
      }, "Check backup");
      let action;
      if (showing) action = h("span", { class: "pill warn", text: "showing on device — confirm there when written down" });
      else if (checking) action = h("div", { class: "row" },
        h("span", { class: "pill warn", text: "enter your words on the device" }),
        h("button", { class: "btn small ghost", onclick: () => { call("cancel_protocol"); state.checkBackup = null; render(); } }, "Cancel"));
      else if (!isConnected(d.id)) action = d.backup_done === true ? status : h("div", { class: "row" }, status, h("span", { class: "pill", text: "plug in to show" }));
      else if (d.backup_done === true) action = h("div", { class: "row" }, status, check, show("Show again", "btn small ghost"));
      else action = h("div", { class: "row" }, status, show("Show backup on device", "btn small"), check);
      return h("div", { class: "item" },
        h("div", { class: "stack" },
          h("strong", { text: d.name || deviceName(d.id) }),
          h("span", { class: "muted small", text: `share #${d.share_index}` }),
        ),
        action,
      );
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// wallet page
// ---------------------------------------------------------------------------------------------

async function openWallet(keyId, tab) {
  if (!state.wallet || state.wallet.keyId !== keyId) {
    state.wallet = { keyId, tab: tab || "history", data: null, sessions: [], address: null, send: freshSend(), descriptor: null, fees: null };
  } else if (tab) {
    state.wallet.tab = tab;
  }
  state.view = { name: "wallet", keyId };
  render();
  await refreshWallet();
}

function freshSend() {
  return { address: "", amount: "", max: false, feerate: "", preview: null, signers: [], sessionId: null, busy: false };
}

async function refreshWallet() {
  const w = state.wallet;
  if (!w) return;
  const [data, sessions] = await Promise.all([
    call("wallet", { keyId: w.keyId }),
    call("sessions", { keyId: w.keyId }),
  ]);
  if (state.wallet !== w) return;
  if (data) w.data = data;
  if (sessions) w.sessions = sessions;
  render();
}

function renderWallet() {
  const w = state.wallet;
  const key = state.keys.find((k) => k.key_id === w.keyId);
  if (!key) return h("div", { class: "page" }, h("p", { class: "muted", text: "Loading…" }));
  const data = w.data;
  const chain = state.chain[key.network];

  const page = h("div", { class: "page" },
    h("div", { class: "page-head" },
      h("div", {},
        h("div", { class: "row" },
          h("h1", { text: key.name }),
          h("span", { class: "pill" + (key.network === "bitcoin" ? " main" : ""), text: networkLabel(key.network) }),
          h("span", { class: "pill", text: signLabel(key), title: `${key.devices.length} device${key.devices.length === 1 ? "" : "s"} known to Icebox` }),
        ),
        h("p", { class: "sub" },
          chain ? `Electrum: ${chain.state}` : "Electrum: not connected yet",
          data ? (data.height ? ` · block ${data.height.toLocaleString("en-GB")}` : " · syncing…") : "",
        ),
      ),
      h("div", { class: "stack" },
        h("div", { class: "balance" }, data ? fmtBtc(data.balance) : "—", h("span", { class: "unit", text: "BTC" })),
        data && data.pending_incoming
          ? h("span", { class: "muted small", text: `+ ${fmtSats(data.pending_incoming)} incoming, unconfirmed` })
          : null,
      ),
    ),
  );

  if (key.devices.some((d) => d.backup_done === false)) {
    page.append(h("div", { class: "notice warn" },
      "Some devices haven't been backed up yet. ",
      h("button", { class: "link", onclick: () => { w.tab = "backups"; render(); } }, "Back them up now"),
    ));
  } else if (key.devices.some((d) => d.backup_done == null)) {
    page.append(h("div", { class: "notice" },
      "This wallet was restored, so Icebox doesn't know whether its backups were written down (that's recorded by the app that made it, not on the devices). If you're not sure, ",
      h("button", { class: "link", onclick: () => { w.tab = "backups"; render(); } }, "show each device's backup and write it down"),
      ".",
    ));
  }

  const tabs = [["history", "History"], ["receive", "Receive"], ["send", "Send"], ["backups", "Backups"], ["details", "Details"]];
  page.append(h("div", { class: "tabs" },
    ...tabs.map(([id, label]) => h("button", {
      class: w.tab === id ? "active" : "",
      onclick: () => { w.tab = id; render(); if (id === "details") loadDescriptor(); },
    }, label)),
  ));

  if (w.tab === "receive") page.append(renderReceive(key, w));
  else if (w.tab === "send") page.append(renderSend(key, w));
  else if (w.tab === "backups") page.append(h("div", { class: "card" }, renderBackupList(key)));
  else if (w.tab === "details") page.append(renderDetails(key, w));
  else page.append(renderHistory(w));
  return page;
}

function renderHistory(w) {
  const txs = (w.data && w.data.txs) || [];
  if (!txs.length) {
    return h("div", { class: "card empty" },
      h("p", { text: "No transactions yet." }),
      h("button", { class: "btn", onclick: () => { w.tab = "receive"; render(); } }, "Receive bitcoin"),
    );
  }
  return h("div", { class: "card" },
    h("table", {},
      h("thead", {}, h("tr", {}, h("th", { text: "When" }), h("th", { text: "Transaction" }), h("th", { text: "Amount" }), h("th", { text: "Status" }))),
      h("tbody", {},
        ...txs.map((tx) => h("tr", {},
          h("td", { text: fmtTime(tx.timestamp) }),
          h("td", {}, txLink(w.data.network, tx.txid)),
          h("td", { class: "num " + (tx.net_value > 0 ? "pos" : "neg"), text: tx.net_value === null ? "—" : (tx.net_value > 0 ? "+" : "") + fmtSats(tx.net_value) }),
          h("td", {}, h("span", {
            class: "pill" + (tx.confirmations >= 1 ? " ok" : " warn"),
            text: tx.confirmations >= 1 ? `${tx.confirmations} conf` : "pending",
          })),
        )),
      ),
    ),
  );
}

// A transaction id that opens mempool.space in the browser. Icebox builds the URL itself (see
// open_tx), so the page never hands an arbitrary link to the system.
function txLink(network, txid) {
  const label = shortId(txid) + txid.slice(-6);
  if (network === "regtest") return h("span", { class: "mono", text: label });
  return h("button", {
    class: "link mono",
    title: "View on mempool.space (opens your browser)",
    onclick: () => {
      if (state.demo) return toast("Demo transactions aren't on the real network");
      call("open_tx", { network, txid });
    },
  }, label + " ↗");
}

// Records that an address was handed out, so "Get another" gives a fresh one (as in the official
// app). Called on Copy, Check on a device, and Get another.
function markShared(key, w, a) {
  if (!a) return;
  call("mark_address_shared", { keyId: key.key_id, index: a.index }).then(() => loadAddresses(w, key, true));
}

async function loadAddresses(w, key, force) {
  if (!w.addressesOpen || (w.addresses && !force)) return;
  const list = await call("addresses", { keyId: key.key_id });
  if (list) { w.addresses = list; render(); }
}

async function showAddress(key, w, index) {
  const a = await call("address", { keyId: key.key_id, index });
  if (a) { w.address = a; stopVerify(); render(); }
}

async function nextAddress(key, w) {
  if (w.address) markShared(key, w, w.address); // the current one counts as handed out
  const addr = await call("next_address", { keyId: key.key_id });
  if (addr) { w.address = addr; stopVerify(); render(); }
}

function renderReceive(key, w) {
  const wrap = h("div", { class: "stack" });
  const card = h("div", { class: "card" });
  wrap.append(card, renderAddressList(key, w));
  const a = w.address;
  if (!a) {
    card.append(
      h("p", { class: "muted", text: "Get a fresh address, then check it on a device before giving it to anyone." }),
      h("div", { class: "row" }, h("button", {
        class: "btn primary",
        onclick: async () => { const addr = await call("next_address", { keyId: key.key_id }); if (addr) { w.address = addr; stopVerify(); render(); } },
      }, "Get a receive address")),
    );
    return wrap;
  }
  const v = state.verify;
  if (state.demo) {
    card.append(h("div", { class: "notice warn", text: "Demo mode: this address and QR code are placeholders. They can't receive anything, so never send coins to them." }));
  }
  if (a.used) {
    card.append(h("div", { class: "notice warn" },
      "This address has already received coins. Reusing it links your payments together for anyone watching the blockchain. ",
      h("button", { class: "link", onclick: () => nextAddress(key, w) }, "Use a fresh address"),
    ));
  }
  card.append(
    h("div", { class: "row between" },
      h("h2", { text: `Address #${a.index}` }),
      h("button", { class: "link", onclick: () => nextAddress(key, w) }, "Get another"),
    ),
    h("div", { class: "grid2" },
      h("div", { class: "stack" },
        addressChunks(a.address),
        h("div", { class: "row" },
          h("button", { class: "btn", onclick: () => navigator.clipboard.writeText(a.address).then(() => { toast("Copied"); markShared(key, w, a); }) }, "Copy"),
          h("button", {
            class: "btn primary",
            onclick: () => { state.verify = { target_devices: [], connected_devices: [], started: true }; call("verify_address", { keyId: key.key_id, index: a.index }); markShared(key, w, a); render(); },
          }, "Check on a device"),
        ),
        v ? h("div", { class: "notice" },
          v.connected_devices && v.connected_devices.length
            ? `Now showing on ${v.connected_devices.map(deviceName).join(", ")}. Compare it group by group with the address here. Only share it if they match exactly.`
            : "Plug in any device from this wallet to see the address on its screen.",
          h("div", { class: "row" }, h("button", { class: "btn small", onclick: () => { stopVerify(); render(); } }, "Done – clear device screens")),
        ) : h("div", { class: "notice warn", text: "Not yet checked on a device. Malware on a computer can swap addresses; the device screen can't be faked." }),
      ),
      h("img", { class: "qr", src: a.qr_svg, alt: "QR code of the address" }),
    ),
  );
  return wrap;
}

// Every address handed out so far, newest first, marked "used" once it has received coins.
function renderAddressList(key, w) {
  const card = h("div", { class: "card" });
  const head = h("div", { class: "row between" },
    h("h3", { text: "All receive addresses" }),
    h("button", {
      class: "link",
      onclick: () => { w.addressesOpen = !w.addressesOpen; render(); loadAddresses(w, key, true); },
    }, w.addressesOpen ? "Hide" : "Show"),
  );
  card.append(head);
  if (!w.addressesOpen) return card;
  if (!w.addresses) { card.append(h("p", { class: "muted", text: "Loading…" })); return card; }
  card.append(h("div", { class: "list" },
    ...w.addresses.map((x) => h("button", {
      class: "item addr-row" + (w.address && w.address.index === x.index ? " current" : ""),
      onclick: () => showAddress(key, w, x.index),
    },
      h("span", { class: "muted mono", text: `#${x.index}` }),
      h("span", { class: "mono small addr-short" + (x.used ? " struck" : ""), text: x.address.slice(0, 14) + "…" + x.address.slice(-8) }),
      x.used ? h("span", { class: "pill bad", text: "used" })
        : x.shared ? h("span", { class: "pill", text: "handed out" })
        : h("span", { class: "pill ok", text: "fresh" }),
    )),
  ));
  return card;
}

function renderSend(key, w) {
  const s = w.send;
  const wrap = h("div", { class: "stack" });

  // pending payments first: they matter more than a new one
  const pending = (w.sessions || []).filter((p) => p.session_id !== s.sessionId);
  if (pending.length) {
    wrap.append(h("div", { class: "card" },
      h("h2", { text: "Payments in progress" }),
      h("div", { class: "list" }, ...pending.map((p) => renderPendingSession(key, w, p))),
    ));
  }

  if (s.sessionId) {
    wrap.append(renderSigning(key, w));
    return wrap;
  }

  const card = h("div", { class: "card" }, h("h2", { text: "New payment" }));
  if (!s.preview) {
    card.append(
      h("label", { class: "field" }, "Pay to",
        h("input", { id: "send-address", type: "text", value: s.address, placeholder: key.network === "bitcoin" ? "bc1…" : "tb1…", spellcheck: "false", oninput: (e) => (s.address = e.target.value) }),
      ),
      h("div", { class: "grid2" },
        h("label", { class: "field" }, "Amount (sats)",
          h("input", { id: "send-amount", type: "number", min: "1", step: "1", value: s.amount, disabled: s.max, oninput: (e) => (s.amount = e.target.value) }),
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: s.max, onchange: (e) => { s.max = e.target.checked; render(); } }), "Send everything"),
        ),
        h("label", { class: "field" }, "Fee rate (sat/vB)",
          h("input", { id: "send-fee", type: "number", min: "1", step: "0.1", value: s.feerate, oninput: (e) => (s.feerate = e.target.value) }),
          renderFeeChoices(key, w),
        ),
      ),
      h("div", { class: "row" },
        h("button", {
          class: "btn primary",
          disabled: s.busy,
          onclick: async () => {
            const amount = s.max ? null : Math.floor(Number(s.amount));
            if (!s.max && !(amount > 0)) return toast("Enter an amount in sats", true);
            const feerate = Number(s.feerate);
            if (!(feerate >= 1)) return toast("Enter a fee rate of at least 1 sat/vB", true);
            s.busy = true; render();
            const preview = await call("prepare_send", { keyId: key.key_id, address: s.address, amount, feerate });
            s.busy = false;
            if (preview) {
              s.preview = preview;
              const connected = key.devices.filter((d) => isConnected(d.id)).map((d) => d.id);
              const rest = key.devices.map((d) => d.id).filter((id) => !connected.includes(id));
              s.signers = connected.concat(rest).slice(0, key.threshold);
            }
            render();
          },
        }, s.busy ? "Working…" : "Review payment"),
      ),
    );
    wrap.append(card);
    return wrap;
  }

  const p = s.preview;
  card.append(
    h("div", { class: "list" },
      h("div", { class: "item" }, h("span", { class: "muted", text: "To" }), h("span", { class: "mono", text: p.recipient })),
      h("div", { class: "item" }, h("span", { class: "muted", text: "Amount" }), h("strong", { class: "mono", text: fmtSats(p.amount) })),
      h("div", { class: "item" }, h("span", { class: "muted", text: "Network fee" }), h("span", { class: "mono", text: `${fmtSats(p.fee)} (${p.feerate} sat/vB)` })),
      p.change ? h("div", { class: "item" }, h("span", { class: "muted", text: "Change back to this wallet" }), h("span", { class: "mono", text: fmtSats(p.change) })) : null,
    ),
    h("h3", { text: `Sign with ${key.threshold} device${key.threshold > 1 ? "s" : ""}` }),
    h("div", { class: "list" },
      ...key.devices.map((d) => h("div", { class: "item" },
        h("label", { class: "check" },
          h("input", {
            type: "checkbox", checked: s.signers.includes(d.id),
            onchange: (e) => {
              if (e.target.checked) s.signers.push(d.id); else s.signers = s.signers.filter((x) => x !== d.id);
              render();
            },
          }),
          d.name || deviceName(d.id),
        ),
        h("span", { class: "pill" + (isConnected(d.id) ? " ok" : ""), text: isConnected(d.id) ? "plugged in" : "not plugged in" }),
      )),
    ),
    h("div", { class: "row" },
      h("button", { class: "btn ghost", onclick: () => { s.preview = null; render(); } }, "Edit"),
      h("button", {
        class: "btn primary",
        disabled: s.signers.length !== key.threshold || s.busy,
        onclick: async () => {
          s.busy = true; render();
          const sessionId = await call("start_send", { keyId: key.key_id, signerIds: s.signers });
          s.busy = false;
          if (sessionId) { s.sessionId = sessionId; s.preview = null; await refreshWallet(); }
          render();
        },
      }, `Start signing (${s.signers.length}/${key.threshold})`),
    ),
  );
  wrap.append(card);
  return wrap;
}

function renderFeeChoices(key, w) {
  if (!w.fees) {
    return h("button", {
      class: "link small",
      onclick: async () => {
        w.fees = "loading"; render();
        const fees = await call("fee_estimates", { network: key.network });
        w.fees = fees || null;
        if (fees && fees.length && !w.send.feerate) w.send.feerate = String(fees.find((f) => f.target_blocks === 3)?.sat_per_vb ?? fees[0].sat_per_vb);
        render();
      },
    }, "Suggest fee rates");
  }
  if (w.fees === "loading") return h("span", { class: "muted small", text: "Asking the server…" });
  const names = { 1: "next block", 3: "~30 min", 6: "~1 hour", 25: "~4 hours" };
  return h("div", { class: "row" },
    ...w.fees.map((f) => h("button", {
      class: "btn small ghost",
      onclick: () => { w.send.feerate = String(f.sat_per_vb); render(); },
    }, `${f.sat_per_vb} · ${names[f.target_blocks] || f.target_blocks + " blocks"}`)),
  );
}

function renderPendingSession(key, w, p) {
  const recipients = p.recipients.map((r) => `${fmtSats(r.amount)} → ${r.address ? shortId(r.address) + r.address.slice(-6) : "unknown script"}`).join(", ");
  return h("div", { class: "item" },
    h("div", { class: "stack" },
      h("strong", { text: recipients || "Payment to yourself" }),
      h("span", { class: "muted small", text: `fee ${fmtSats(p.fee)} · ${p.got_shares.length}/${p.signers.length} signatures` }),
    ),
    h("div", { class: "row" },
      p.signed
        ? h("button", { class: "btn primary small", onclick: () => doBroadcast(w, p.session_id) }, "Broadcast")
        : h("button", {
          class: "btn small",
          onclick: async () => {
            if (await call("resume_signing", { sessionId: p.session_id }) !== undefined) { w.send.sessionId = p.session_id; render(); }
          },
        }, "Continue signing"),
      // two-step cancel instead of window.confirm, which not every webview implements
      w.confirmCancel === p.session_id
        ? h("button", {
          class: "btn danger small",
          onclick: async () => {
            w.confirmCancel = null;
            await call("cancel_sign_session", { sessionId: p.session_id });
            if (w.send.sessionId === p.session_id) w.send = freshSend();
            refreshWallet();
          },
        }, "Yes, cancel payment")
        : h("button", {
          class: "btn danger small",
          onclick: () => { w.confirmCancel = p.session_id; render(); },
        }, "Cancel"),
    ),
  );
}

function renderSigning(key, w) {
  const s = w.send;
  const sig = state.signing[s.sessionId];
  const session = (w.sessions || []).find((p) => p.session_id === s.sessionId);
  const card = h("div", { class: "card" }, h("h2", { text: "Signing" }));
  if (session) {
    card.append(h("div", { class: "notice" },
      "Each device will show this payment. Check the address and amount on its screen before approving: ",
      h("strong", { text: session.recipients.map((r) => `${fmtSats(r.amount)} to ${r.address || "?"}`).join("; ") }),
      ` (fee ${fmtSats(session.fee)}).`,
    ));
  }
  if (sig && sig.aborted) {
    card.append(h("div", { class: "notice bad", text: "Signing stopped: " + sig.aborted }));
  }
  const signers = sig ? sig.needed_from : session ? session.signers : [];
  card.append(h("div", { class: "list" },
    ...signers.map((id) => {
      const done = sig ? sig.got_shares.includes(id) : session && session.got_shares.includes(id);
      const canAsk = sig && sig.connected_but_need_request.includes(id);
      let action;
      if (done) action = h("span", { class: "pill ok", text: "signed" });
      else if (canAsk) action = h("button", { class: "btn small primary", onclick: () => call("request_device_sign", { sessionId: s.sessionId, deviceId: id }) }, "Ask to sign");
      else if (isConnected(id)) action = h("span", { class: "pill warn", text: "approve on the device" });
      else action = h("span", { class: "pill", text: "plug in this device" });
      return h("div", { class: "item" }, h("strong", { text: deviceName(id) }), action);
    }),
  ));
  const finished = (sig && sig.finished) || (session && session.signed);
  card.append(h("div", { class: "row" },
    h("button", { class: "btn ghost", onclick: () => { call("cancel_protocol"); w.send = freshSend(); refreshWallet(); } }, finished ? "Close" : "Pause"),
    finished ? h("button", { class: "btn primary", onclick: () => doBroadcast(w, s.sessionId) }, "Broadcast payment") : null,
  ));
  return card;
}

// Node rejections are terse; say what they mean and what to do.
function explainBroadcastError(e) {
  const m = String(e);
  if (/dust/i.test(m)) return "The network refused this payment: an amount in it is too small (\"dust\", under about 330 sats). Cancel it under Payments in progress and send a larger amount.";
  if (/insufficient fee|min relay fee|mempool min fee/i.test(m)) return "The network refused this payment: the fee rate is too low right now. Cancel it and send again with a higher fee rate.";
  if (/missing inputs|bad-txns-inputs-missingorspent|already spent/i.test(m)) return "The network refused this payment: some of its coins were already spent. Cancel it and send again.";
  return "Broadcast failed: " + m.replace(/^broadcast failed:\s*/i, "");
}

async function doBroadcast(w, sessionId) {
  let txid;
  try {
    txid = await invoke("broadcast", { sessionId });
  } catch (e) {
    toast(explainBroadcastError(e), true);
    return;
  }
  if (txid) {
    toast("Sent. Transaction " + shortId(txid));
    w.send = freshSend();
    w.tab = "history";
    await refreshWallet();
  }
}

async function loadDescriptor() {
  const w = state.wallet;
  if (!w || w.descriptor) return;
  const [d, qr, btcpay] = await Promise.all([
    call("descriptor", { keyId: w.keyId }),
    call("descriptor_qr", { keyId: w.keyId }),
    call("btcpay_scheme", { keyId: w.keyId }),
  ]);
  if (d) { w.descriptor = d; w.descriptorQr = qr || null; w.btcpay = btcpay || null; render(); }
}

function renderDetails(key, w) {
  return h("div", { class: "card" },
    h("div", { class: "list" },
      h("div", { class: "item" }, h("span", { class: "muted", text: "Network" }), h("span", { text: networkLabel(key.network) })),
      h("div", { class: "item" }, h("span", { class: "muted", text: "Spending rule" }), h("span", { text: `any ${key.threshold} devices (${key.devices.length} known to Icebox)` })),
      h("div", { class: "item" }, h("span", { class: "muted", text: "Key id" }), h("span", { class: "mono small", text: key.key_id })),
    ),
    h("h3", { text: "Watch-only descriptor" }),
    h("p", { class: "muted small", text: "Lets another wallet (Sparrow, Bitcoin Core) watch your balance. It can't spend, but it reveals all your addresses, so keep it private." }),
    w.descriptor ? h("div", { class: "grid2" },
      h("div", { class: "stack" },
        h("div", { class: "address-box small", text: w.descriptor }),
        h("div", { class: "row" }, h("button", { class: "btn", onclick: () => navigator.clipboard.writeText(w.descriptor).then(() => toast("Copied")) }, "Copy descriptor")),
      ),
      w.descriptorQr ? h("img", { class: "qr", src: w.descriptorQr, alt: "QR code of the watch-only descriptor" }) : null,
    ) : h("p", { class: "muted", text: "Loading…" }),
    renderBtcpay(key, w),
    renderRemoveWallet(key, w),
  );
}

// The wallet's extended public key in BTCPay Server's format, so a shop can take payments
// straight into it. BTCPay can only watch: spending still needs the devices, here in Icebox.
function renderBtcpay(key, w) {
  if (!w.btcpay) return null;
  return h("div", { class: "stack" },
    h("h3", { text: "Accept payments with BTCPay Server" }),
    h("p", { class: "muted small", text: "In BTCPay: your store → Wallets → Bitcoin → Connect an existing wallet → Enter extended public key, and paste this. BTCPay then gives each invoice its own address from this wallet. It can see payments but never spend them." }),
    h("div", { class: "address-box small", text: w.btcpay }),
    h("div", { class: "row" }, h("button", { class: "btn", onclick: () => navigator.clipboard.writeText(w.btcpay).then(() => toast("Copied")) }, "Copy for BTCPay")),
    h("div", { class: "notice" },
      h("strong", { text: "Before taking real payments: " }),
      "check that the first address BTCPay shows matches this wallet's address #0 on the Receive tab. ",
      "Use a wallet just for the shop: BTCPay and Icebox both hand out addresses from it, so using it for other payments too can give two payers the same address. ",
      key.network === "bitcoin" ? "Anyone who has this key can see every payment to the wallet, so only paste it into a BTCPay server you run or trust." : "",
    ),
  );
}

// Removing a wallet only forgets it here, like the official app's "Delete wallet". The devices keep
// their shares, so it can be restored later; making a device blank again is Erase, on Devices.
function renderRemoveWallet(key, w) {
  const box = h("div", { class: "danger-zone" }, h("h3", { text: "Remove wallet from Icebox" }));
  if (!w.removing) {
    box.append(
      h("p", { class: "muted small", text: "Forgets this wallet on this computer. Nothing on the devices changes: they keep their shares, and you can bring the wallet back with Restore from devices. To make a device blank again, erase it on the Devices page." }),
      h("button", { class: "btn danger", onclick: () => { w.removing = { typed: "" }; render(); } }, "Remove wallet…"),
    );
    return box;
  }
  const matches = w.removing.typed.trim() === key.name;
  box.append(
    h("div", { class: "notice warn", text: key.network === "bitcoin"
      ? "This is a mainnet wallet. Before removing it, make sure you can restore it: every device's backup is written down, or enough of its devices are safe to restore from."
      : "Payments in progress for this wallet will be cancelled." }),
    h("label", { class: "field" }, `Type the wallet name (${key.name}) to confirm`,
      h("input", { id: "remove-wallet-name", type: "text", value: w.removing.typed, spellcheck: "false", oninput: (e) => { w.removing.typed = e.target.value; render(); } }),
    ),
    h("div", { class: "row" },
      h("button", { class: "btn ghost", onclick: () => { w.removing = null; render(); } }, "Keep it"),
      h("button", {
        class: "btn danger", disabled: !matches,
        onclick: async () => {
          const r = await call("delete_wallet", { keyId: key.key_id });
          if (r === undefined) return;
          toast(`Removed "${key.name}" from Icebox`);
          state.wallet = null;
          state.view = { name: "devices" };
          render();
        },
      }, "Remove from Icebox"),
    ),
  );
  return box;
}

// ---------------------------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------------------------

const NETWORKS = ["bitcoin", "signet", "testnet", "regtest"];

async function openSettings() {
  state.view = { name: "settings" };
  state.settings = { servers: {}, dataDir: null };
  render();
  const [dataDir, ...servers] = await Promise.all([
    call("data_dir"),
    ...NETWORKS.map((network) => call("electrum_servers", { network })),
  ]);
  state.settings.dataDir = dataDir;
  for (const s of servers) if (s) state.settings.servers[s.network] = s;
  render();
}

function renderSettings() {
  const st = state.settings || { servers: {} };
  const page = h("div", { class: "page" },
    h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Settings" }))),
  );
  const card = h("div", { class: "card" },
    h("h2", { text: "Electrum servers" }),
    h("p", { class: "muted", text: "Where Icebox reads the blockchain. For the most privacy, point mainnet at your own node, e.g. tcp://umbrel.local:50001 or ssl://your-node:50002." }),
  );
  for (const network of NETWORKS) {
    const s = st.servers[network];
    if (!s) continue;
    const chain = state.chain[network];
    card.append(h("div", { class: "stack" },
      h("div", { class: "row between" },
        h("strong", { text: networkLabel(network) }),
        h("span", { class: "pill" + (chain && chain.state === "connected" ? " ok" : ""), text: chain ? chain.state : "idle" }),
      ),
      h("div", { class: "grid2" },
        h("label", { class: "field" }, "Primary",
          h("input", { id: `es-${network}-p`, type: "text", value: s.primary, spellcheck: "false", oninput: (e) => (s.primary = e.target.value) })),
        h("label", { class: "field" }, "Backup",
          h("input", { id: `es-${network}-b`, type: "text", value: s.backup, spellcheck: "false", oninput: (e) => (s.backup = e.target.value) })),
      ),
      h("div", { class: "row" },
        h("button", {
          class: "btn small",
          onclick: async () => {
            if (await call("set_electrum_servers", { network, primary: s.primary, backup: s.backup }) !== undefined) toast(`${networkLabel(network)} servers saved`);
          },
        }, "Save"),
        h("button", { class: "btn small ghost", onclick: () => call("reconnect", { network }) }, "Reconnect"),
      ),
    ));
  }
  page.append(card);
  page.append(h("div", { class: "card" },
    h("h2", { text: "Data" }),
    h("p", { class: "muted", text: "Wallet data lives in this folder. It contains no private keys (those stay on the devices), but it does reveal your addresses and history. Set ICEBOX_DATA_DIR to use a different folder." }),
    h("div", { class: "address-box small", text: st.dataDir || "…" }),
  ));
  return page;
}

// ---------------------------------------------------------------------------------------------
// events from Rust
// ---------------------------------------------------------------------------------------------

function onEvent(e) {
  switch (e.kind) {
    case "devices":
      state.devices = e.devices;
      break;
    case "keys":
      state.keys = e.keys;
      break;
    case "nonces":
      state.nonces = e;
      onNoncesForWizard();
      break;
    case "keygen":
      state.keygen = e;
      break;
    case "signing":
      state.signing[e.session_id] = e;
      if (e.finished && state.wallet) refreshWallet();
      break;
    case "verify_address":
      if (state.verify) state.verify = e;
      break;
    case "display_backup": {
      state.backup = e;
      if (e.confirmed) {
        const keyId = (state.wizard && state.wizard.step === "backup" && state.wizard.keyId) || (state.wallet && state.wallet.keyId);
        if (keyId) call("mark_backup_complete", { keyId, deviceId: e.device_id }).then(() => toast("Backup recorded"));
      }
      break;
    }
    case "check_backup": {
      const c = state.checkBackup;
      if (!c || c.device_id !== e.device_id) return;
      c.done = true;
      c.valid = e.valid;
      if (e.valid) {
        // a backup that checks out is certainly written down
        call("mark_backup_complete", { keyId: c.keyId, deviceId: e.device_id });
        toast(`${deviceName(e.device_id)}: backup words match`);
      } else {
        toast(`${deviceName(e.device_id)}: those words don't match this device's backup`, true);
      }
      break;
    }
    case "wallet_changed":
      if (state.wallet && state.wallet.keyId === e.key_id) refreshWallet();
      return;
    case "chain":
      state.chain[e.network] = e;
      break;
    case "restore_scan_changed":
      scheduleRestoreRefresh();
      return;
    case "erase":
      if (e.confirmed) {
        toast(`${deviceName(e.device_id)} erased. It will restart as a new device.`);
        state.erase = null;
      } else if (state.erase && state.erase.id === e.device_id) {
        state.erase.step = "waiting";
      }
      break;
  }
  render();
}

// ---------------------------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------------------------

function onMenu(id) {
  const needWallet = (tab) => {
    if (state.wallet) return openWallet(state.wallet.keyId, tab);
    if (state.keys.length) return openWallet(state.keys[0].key_id, tab);
    toast("Create a wallet first");
  };
  switch (id) {
    case "settings": return openSettings();
    case "new_wallet": return startWizard();
    case "restore": return openRestore();
    case "devices": state.view = { name: "devices" }; return render();
    case "receive": return needWallet("receive");
    case "send": return needWallet("send");
    case "demo": return enterDemo();
    case "about": return openAbout();
  }
}

// Keyboard shortcuts. On Windows the webview has keyboard focus and swallows the menu's own
// shortcuts, so the page handles them too. lastMenu stops a double action on systems where both
// the menu and the page see the key.
const SHORTCUTS = { n: "new_wallet", r: "receive", s: "send", d: "devices", ",": "settings", q: "quit" };
let lastMenu = { id: null, at: 0 };

function runMenu(id) {
  const now = Date.now();
  if (lastMenu.id === id && now - lastMenu.at < 400) return;
  lastMenu = { id, at: now };
  onMenu(id);
}

document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const id = SHORTCUTS[e.key.toLowerCase()];
  if (!id) return;
  e.preventDefault(); // also stops Ctrl+R reloading the page, Ctrl+S saving it, and so on
  if (id === "quit") {
    if (tauri) tauri.core.invoke("quit_app");
    return;
  }
  runMenu(id);
});

async function main() {
  $("new-wallet-btn").addEventListener("click", startWizard);
  const restoreBtn = $("restore-btn");
  if (restoreBtn) restoreBtn.addEventListener("click", openRestore);
  $("devices-btn").addEventListener("click", () => { state.view = { name: "devices" }; render(); });
  $("settings-btn").addEventListener("click", openSettings);

  if (!tauri) {
    state.startupError = "This page only works inside the Icebox app.";
    render();
    return;
  }
  // Real device events are ignored while the demo is running.
  await tauri.event.listen("icebox", (msg) => { if (!state.demo) onEvent(msg.payload); });
  await tauri.event.listen("menu", (msg) => runMenu(msg.payload));

  try {
    await invoke("startup_status");
  } catch (e) {
    state.startupError = String(e);
    render();
    return;
  }
  const [devices, keys] = await Promise.all([call("list_devices"), call("list_keys")]);
  state.devices = devices || [];
  state.keys = keys || [];
  state.appInfo = await call("app_info");
  state.ready = true;
  if (state.keys.length) openWallet(state.keys[0].key_id);
  else render();
}

main();
