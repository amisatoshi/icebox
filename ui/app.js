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
  savedRestores: [],    // unfinished restores saved in the database (sidebar + Restore page)
  watchOnly: [],        // wallets added from a watch-only code (no devices; can't spend)
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
  hideBalance: false,   // amounts shown as dots (View → Hide or show balances, Ctrl+B)
  eraseMany: null,      // Devices → Danger zone: { open, picked: Set, typed, sent: [ids] }
  logs: null,           // Logs page: { text, loading }
  prices: { settings: null, price: null, at: null, error: null, source: null }, // see "prices" below
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
/** An amount that "Hide balances" covers: balances and payment history. Amounts the user is
 *  entering or approving on the Send page stay visible, since hiding them there would be unsafe. */
const HIDDEN = "•••••";
const money = (text) => (state.hideBalance ? HIDDEN : text);

async function toggleHideBalance() {
  const hide = !state.hideBalance;
  if (await call("set_hide_balance", { hide }) === undefined) return;
  state.hideBalance = hide;
  render();
}

/** The eye button that hides or shows amounts. */
function hideBalanceButton() {
  return h("button", {
    class: "icon-btn", title: state.hideBalance ? "Show amounts (Ctrl+B)" : "Hide amounts (Ctrl+B)",
    "aria-label": state.hideBalance ? "Show amounts" : "Hide amounts",
    onclick: toggleHideBalance,
  }, icon(state.hideBalance ? "eye-off" : "eye"));
}

// A few Lucide icons (ISC licence), drawn with DOM calls rather than HTML strings.
const ICONS = {
  eye: ["M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0", "c12,12,3"],
  "eye-off": ["M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49", "M14.084 14.158a3 3 0 0 1-4.242-4.242", "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143", "M2 2l20 20"],
};
function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  for (const part of ICONS[name] || []) {
    let el;
    if (part.startsWith("c")) {
      const [cx, cy, r] = part.slice(1).split(",");
      el = document.createElementNS(ns, "circle");
      el.setAttribute("cx", cx); el.setAttribute("cy", cy); el.setAttribute("r", r);
    } else {
      el = document.createElementNS(ns, "path");
      el.setAttribute("d", part);
    }
    svg.append(el);
  }
  return svg;
}

const later = (ms, fn) => setTimeout(fn, ms);

/** "red", "red and blue", "red, blue and green" */
function listJoin(names) {
  if (names.length <= 1) return names.join("");
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
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

/** "3 of 5 to sign": how many devices must approve, out of the devices Icebox knows about.
 *  A restored wallet only knows the devices that answered when it was restored (more can be
 *  added from Restore from devices), so the second number is "known here", not a total. */
function signLabel(k) {
  const n = k.devices.length;
  return n > k.threshold ? `${k.threshold} of ${n} to sign` : `${k.threshold} to sign · ${n} device${n === 1 ? "" : "s"}`;
}

/** A wallet by id: one with devices (from state.keys), or a watch-only one shaped the same way
 *  (no devices, watch_only: true), so the wallet page can show both. */
function walletInfo(keyId) {
  const key = state.keys.find((k) => k.key_id === keyId);
  if (key) return key;
  const w = state.watchOnly.find((k) => k.key_id === keyId);
  return w ? { ...w, watch_only: true, threshold: 0, devices: [] } : null;
}

/** Plugged-in devices that hold a wallet (they have a name) but aren't listed in any wallet here. */
function unlistedDevices() {
  const listed = new Set(state.keys.flatMap((k) => k.devices.map((d) => d.id)));
  return state.devices.filter((d) => d.ready && d.name && !listed.has(d.id));
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

// ---------------------------------------------------------------------------------------------
// phones: top bar and drawer (the sidebar slides in from the left)
// ---------------------------------------------------------------------------------------------

function setDrawer(open) {
  document.body.classList.toggle("drawer-open", open);
  const btn = $("drawer-btn");
  if (btn) btn.setAttribute("aria-expanded", String(open));
}

/** The page's name for the phone's top bar. */
function mobileTitle() {
  const v = state.view.name;
  if (v === "wallet") {
    const k = state.keys.find((k) => k.key_id === state.view.keyId) || state.watchOnly.find((k) => k.key_id === state.view.keyId);
    return k ? k.name : "Wallet";
  }
  return ({ devices: "Devices", settings: "Settings", restore: "Restore", wizard: "New multi-sig wallet",
    watch_add: "Add watch-only", logs: "Logs", shortcuts: "Shortcuts", about: "About" })[v] || "Icebox";
}

function renderMobileBar() {
  if (!$("mobilebar")) return;
  $("mobile-title").textContent = mobileTitle();
  const ready = state.devices.filter((d) => d.ready).length;
  $("mobile-device-count").textContent = ready === 1 ? "1 device" : `${ready} devices`;
  $("mobile-devices").classList.toggle("on", ready > 0);
  const more = $("more-hide");
  if (more) more.textContent = state.hideBalance ? "Show amounts" : "Hide amounts";
}

/** Android draws the app under the status and gesture bars. Older webviews report no safe-area
 *  insets for that, so measure, and fall back to typical sizes. */
function fixAndroidInsets() {
  if (!/Android/.test(navigator.userAgent || "")) return;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top,0px)";
  document.body.append(probe);
  const top = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  if (top < 1) {
    document.documentElement.style.setProperty("--inset-top", "40px");
    document.documentElement.style.setProperty("--inset-bottom", "20px");
  }
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
  renderMobileBar();
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
    // Watch-only wallets: balance and addresses, no devices.
    ...state.watchOnly.map((k) =>
      h("li", {},
        h("button", {
          class: "watching" + (k.key_id === current ? " active" : ""),
          onclick: () => openWallet(k.key_id),
          title: "Watch-only: can see this wallet but not spend from it",
        },
          h("span", { class: "wname", text: "👁 " + k.name }),
          h("span", { class: "wsub", text: `watch-only · ${networkLabel(k.network)}` }),
        ),
      ),
    ),
    // Unfinished restores: click to continue on the Restore page.
    ...state.savedRestores.map((r) =>
      h("li", {},
        h("button", { class: "restoring" + (state.view.name === "restore" ? " active" : ""), onclick: openRestore, title: "Restore in progress: click to continue" },
          h("span", { class: "wname", text: r.name }),
          h("span", { class: "wsub", text: r.restorable ? "restore ready to finish" : `restoring · ${savedCount(r)}` }),
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
    case "watch_add": return renderWatchAdd();
    case "logs": return renderLogs();
    case "shortcuts": return renderShortcuts();
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
    restore: null, restoreScanning: false, savedRestores: [], watchOnly: [], eraseMany: null, logs: null,
  });
  const [devices, keys] = await Promise.all([call("list_devices"), call("list_keys")]);
  state.devices = devices || [];
  state.keys = keys || [];
  state.view = { name: "devices" };
  render();
  toast("Demo mode: three pretend devices are plugged in. Try New multi-sig wallet.");
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
  if (scan && state.restore) { state.restore.scan = scan; state.savedRestores = scan.saved || []; render(); }
}

const RESTORE_STATUS = {
  ready: "Enough devices found. Ready to restore.",
  need_more: "Plug in more of this wallet's devices. \"Needed\" is the wallet's threshold (3 for a 3-of-5), not how many devices it has; once it's restored, its other devices can be added too.",
  already_here: "Already in Icebox.",
  not_bitcoin: "Not a bitcoin wallet. Icebox can't restore this yet.",
  unknown_threshold: "These devices don't say how many are needed. Try restoring; Icebox will tell you if more are needed.",
};

async function refreshSavedRestores() {
  const list = await call("saved_restores");
  if (list) { state.savedRestores = list; render(); }
}

/** "1 found · 2 needed to restore" for a saved restore. */
function savedCount(r) {
  if (r.found === null || r.found === undefined) return "checking which devices fit";
  return r.threshold ? `${r.found} found · ${r.threshold} needed to restore` : `${r.found} device${r.found === 1 ? "" : "s"} found`;
}

function renderSavedRestore(r) {
  const rs = state.restore || {};
  const need = r.threshold || null;
  const pct = need && r.found !== null ? Math.min(100, Math.round((r.found / need) * 100)) : 0;
  const card = h("div", { class: "card restore-card saved" + (r.restorable ? " ready" : "") },
    h("div", { class: "row between" },
      h("div", { class: "row" },
        h("h2", { text: r.name }),
        r.network ? h("span", { class: "pill" + (r.network === "bitcoin" ? " mainnet" : ""), text: networkLabel(r.network) }) : null,
        h("span", { class: "pill warn", text: "saved restore" }),
      ),
      h("strong", { text: r.restorable ? "Ready" : savedCount(r) }),
    ),
    need ? h("div", { class: "meter" }, h("span", { style: `width:${r.restorable ? 100 : pct}%` })) : null,
    h("div", { class: "list" },
      ...r.devices.map((d) => h("div", { class: "item" },
        h("span", { text: d.name || "Device " + shortId(d.id) }),
        h("div", { class: "row" },
          h("span", { class: "pill", text: `share #${d.share_number}` }),
          d.fits === "no"
            ? h("span", { class: "pill bad", text: "doesn't fit this wallet" })
            : h("span", { class: "pill" + (d.connected ? " ok" : ""), text: d.connected ? "plugged in" : "recorded" }),
        ),
      )),
    ),
    h("p", { class: r.restorable ? "" : "muted", text: r.restorable
      ? "Enough devices recorded. Ready to finish."
      : "Saved. Plug in this wallet's other devices here, now or another day: each one is recorded as soon as it answers, and progress survives closing Icebox." }),
    r.incompatible ? h("div", { class: "notice warn", text: `${r.incompatible} recorded share${r.incompatible === 1 ? " doesn't" : "s don't"} belong to this wallet and won't be used.` }) : null,
  );
  if (r.restorable && r.network === "bitcoin") card.append(h("div", { class: "notice warn", text: "This is a mainnet wallet holding real bitcoin. Icebox is new and unaudited: restoring only reads the devices, but be careful sending from it." }));
  const busy = rs.busy === r.restoration_id;
  const actions = h("div", { class: "row" });
  if (r.restorable) {
    actions.append(h("button", {
      class: "btn primary", disabled: busy,
      onclick: async () => {
        rs.busy = r.restoration_id; render();
        const keyId = await call("finish_saved_restore", { restorationId: r.restoration_id });
        rs.busy = null;
        if (keyId) { toast(`${r.name} restored`); await refreshSavedRestores(); openWallet(keyId); } else render();
      },
    }, busy ? "Restoring…" : `Finish restoring ${r.name}`));
  }
  if (rs.confirmCancel === r.restoration_id) {
    actions.append(
      h("span", { class: "muted small", text: "Forget this restore? Nothing on the devices changes." }),
      h("button", { class: "btn danger small", onclick: async () => {
        rs.confirmCancel = null;
        if (await call("cancel_saved_restore", { restorationId: r.restoration_id }) !== undefined) { toast(`Restore of ${r.name} cancelled`); }
        await refreshRestore(); await refreshSavedRestores();
      } }, "Yes, cancel restore"),
      h("button", { class: "btn ghost small", onclick: () => { rs.confirmCancel = null; render(); } }, "Keep it"),
    );
  } else {
    actions.append(h("button", { class: "btn ghost small", onclick: () => { rs.confirmCancel = r.restoration_id; render(); } }, "Cancel restore"));
  }
  card.append(actions);
  return card;
}

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
      h("p", { text: "Plug in the wallet's devices. You can chain them all at once, or plug them in one after another. You need as many devices as the wallet's threshold (e.g. 2 for a 2-of-3)." }),
      h("p", { class: "muted small", text: "Devices kept in different places? Plug in the first one and choose Save and continue later. Icebox saves the restore, and you can add the other devices on another day, even after closing Icebox." }),
      h("p", { class: "muted small", text: "Devices are only asked which wallets they hold. Nothing on them changes, and their backup words never leave them." }),
      scan
        ? h("p", { class: "muted small", text: `${scan.answered.length} device${scan.answered.length === 1 ? "" : "s"} answered${scan.waiting.length ? ` · waiting for ${scan.waiting.length}` : ""}` })
        : h("p", { class: "muted small", text: "Asking devices…" }),
      state.demo ? h("div", { class: "row" },
        h("button", { class: "btn small", onclick: async () => { await call("demo_plug_restore_devices"); scheduleRestoreRefresh(); } }, "Demo: plug in a device holding an older wallet"),
      ) : null,
    ),
  );

  const saved = scan ? scan.saved : state.savedRestores;
  if (saved.length) {
    page.append(h("h3", { text: "Restores in progress" }), ...saved.map(renderSavedRestore));
  }
  const candidates = scan ? scan.candidates.filter((c) => c.status !== "saved") : [];
  if (saved.length && candidates.length) page.append(h("h3", { text: "Found on plugged-in devices" }));

  if (scan && candidates.length === 0 && !saved.length) {
    page.append(h("div", { class: "card empty" },
      h("p", { text: scan.answered.length ? "None of these devices hold a wallet share." : "No devices have answered yet." }),
      h("p", { class: "small", text: "Blank devices hold nothing. Plug in devices that were set up as part of a wallet." }),
    ));
    return page;
  }

  for (const c of candidates) {
    const need = c.threshold || null;
    const pct = need ? Math.min(100, Math.round((c.found / need) * 100)) : 0;
    const card = h("div", { class: "card restore-card" + (c.status === "ready" ? " ready" : "") },
      h("div", { class: "row between" },
        h("div", { class: "row" },
          h("h2", { text: c.name }),
          c.network ? h("span", { class: "pill" + (c.network === "bitcoin" ? " mainnet" : ""), text: networkLabel(c.network) }) : null,
        ),
        h("strong", { text: need ? `${c.found} found · ${need} needed to restore` : `${c.found} found` }),
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
      const missing = c.not_in_wallet || [];
      if (missing.length) {
        const names = missing.map((id) => (c.devices.find((d) => d.id === id) || {}).name || "Device " + shortId(id));
        card.append(h("div", { class: "notice" },
          `${listJoin(names)} ${missing.length === 1 ? "holds a share" : "hold shares"} of this wallet that Icebox doesn't list yet. When a wallet is restored, Icebox only learns about the devices that answered at the time. Add ${missing.length === 1 ? "it" : "them"} so ${missing.length === 1 ? "it" : "they"} can sign, show ${missing.length === 1 ? "its" : "their"} address and back up here.`));
        actions.append(h("button", {
          class: "btn primary", disabled: r.busy === c.group_id,
          onclick: async () => {
            r.busy = c.group_id; render();
            const added = await call("add_devices_to_wallet", { groupId: c.group_id });
            r.busy = null;
            if (added !== undefined) toast(`${added} device${added === 1 ? "" : "s"} added to ${c.name}`);
            await refreshRestore();
          },
        }, r.busy === c.group_id ? "Adding…" : `Add ${listJoin(names)} to ${c.name}`));
      }
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
    if (c.status === "need_more" || c.status === "unknown_threshold") {
      actions.append(h("button", {
        class: "btn" + (c.status === "need_more" ? " primary" : ""),
        disabled: r.busy === c.group_id,
        title: "Saves which devices you've plugged in, so you can add the rest later, even after closing Icebox",
        onclick: async () => {
          r.busy = c.group_id; render();
          const id = await call("save_restore", { groupId: c.group_id });
          r.busy = null;
          if (id) toast(`Restore of ${c.name} saved. Plug in its other devices whenever you're ready.`);
          await refreshRestore(); await refreshSavedRestores();
        },
      }, "Save and continue later"));
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
    renderUpdateCheck(a),
    h("div", { class: "notice warn", text: "Icebox is independent, third-party software. It is not made or endorsed by Frostsnap, and it has not been audited. Use Signet (test coins) until you trust it, and keep mainnet amounts small." }),
    h("p", { class: "muted small", text: "Icebox uses the open-source frostsnap_core and frostsnap_coordinator crates (MIT) for all key generation, signing and device communication. Private keys never leave the devices." }),
  );
}

// Checking for updates only happens when the button is clicked: one request to GitHub's public
// API for Icebox's releases. Icebox never checks by itself.
const RELEASES_API = "https://api.github.com/repos/amisatoshi/icebox/releases?per_page=10";

function semverParts(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function isNewer(latest, current) {
  const a = semverParts(latest), b = semverParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

async function checkForUpdates() {
  const u = state.update = { checking: true };
  render();
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" }, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const releases = (await res.json()).filter((r) => !r.draft && semverParts(r.tag_name));
    releases.sort((x, y) => (isNewer(x.tag_name, y.tag_name) ? -1 : isNewer(y.tag_name, x.tag_name) ? 1 : 0));
    const latest = releases[0];
    Object.assign(u, { checking: false, latest: latest ? latest.tag_name : null, newer: !!latest && isNewer(latest.tag_name, (state.appInfo || {}).version) });
  } catch (e) {
    Object.assign(u, { checking: false, error: "Couldn't reach GitHub. Check your connection, or look at the Releases page yourself." });
  }
  render();
}

function renderUpdateCheck(a) {
  const u = state.update;
  const box = h("div", { class: "card stack" }, h("h3", { text: "Updates" }));
  if (!u || (!u.checking && !u.latest && !u.error)) {
    box.append(
      h("p", { class: "muted small", text: "Icebox never checks for updates by itself. Clicking the button asks GitHub (one request) for the latest Icebox release; GitHub sees your IP address, as when you visit any website." }),
      h("div", { class: "row" }, h("button", { class: "btn", onclick: checkForUpdates }, "Check for updates")),
    );
  } else if (u.checking) {
    box.append(h("p", { class: "muted", text: "Checking…" }));
  } else if (u.error) {
    box.append(h("div", { class: "notice warn", text: u.error }), h("div", { class: "row" }, h("button", { class: "btn small", onclick: checkForUpdates }, "Try again")));
  } else if (u.newer) {
    box.append(
      h("div", { class: "notice", text: `Icebox ${u.latest.replace(/^v/, "")} is available (you have ${a.version}). Read what's changed, and check the download, before installing: see Updating in the user guide.` }),
      h("div", { class: "row" }, h("button", { class: "btn primary", onclick: () => call("open_release", { tag: u.latest }) }, "Open the release page ↗")),
    );
  } else {
    box.append(h("p", { text: `You're up to date (${a.version}).` }));
  }
  return box;
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
      state.demo ? null : linuxUsbHint(),
      state.demo ? null : androidUsbHint(),
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
  page.append(renderDangerZone());
  return page;
}

// Danger zone: erase several devices at once, like the official app's "Erase multiple devices"
// (which it keeps behind Developer mode). Closed until opened, and needs ERASE typed to confirm.
// Each device still asks for confirmation on its own screen.
function renderDangerZone() {
  const z = state.eraseMany;
  const box = h("div", { class: "danger-zone" });
  const add = (...parts) => box.append(...parts.filter((x) => x !== null && x !== undefined && x !== false));
  if (!z || !z.open) {
    add(
      h("div", { class: "row between" },
        h("h3", { text: "Danger zone" }),
        h("button", { class: "btn small ghost", onclick: () => { state.eraseMany = { open: true, picked: new Set(), typed: "", sent: null }; render(); } }, "Show"),
      ),
    );
    return box;
  }
  add(h("div", { class: "row between" },
    h("h3", { text: "Danger zone: erase several devices" }),
    h("button", { class: "btn small ghost", onclick: () => { if (z.sent) call("clear_device_screens"); state.eraseMany = null; render(); } }, z.sent ? "Close" : "Hide"),
  ));

  if (z.sent) {
    // A device that has erased restarts: it drops off the list (noted in onEvent) and comes back
    // blank, with no name.
    const status = (id) => {
      const d = state.devices.find((x) => x.id === id);
      return !d || z.gone.has(id) || (z.names[id] && !d.name) ? "done" : "waiting";
    };
    const left = z.sent.filter((id) => status(id) === "waiting").length;
    add(
      h("p", { text: left ? `Confirm on each device's own screen. Nothing is erased on a device until you confirm there. ${left} still to confirm.` : "All chosen devices have erased and restarted blank." }),
      h("div", { class: "list" }, ...z.sent.map((id) => h("div", { class: "item" },
        h("span", { text: z.names[id] || "New device " + shortId(id) }),
        status(id) === "waiting" ? h("span", { class: "pill warn", text: "confirm on device" }) : h("span", { class: "pill ok", text: "erased" }),
      ))),
      left ? h("div", { class: "row" }, h("button", { class: "btn ghost", onclick: () => { call("clear_device_screens"); state.eraseMany = null; render(); } }, "Cancel the rest")) : null,
    );
    return box;
  }

  const ready = state.devices.filter((d) => d.ready);
  if (!ready.length) {
    add(h("p", { class: "muted", text: "Plug in the devices you want to erase." }));
    return box;
  }
  const holdings = (id) => state.keys.filter((k) => k.devices.some((kd) => kd.id === id));
  const picked = ready.filter((d) => z.picked.has(d.id));
  const held = [...new Set(picked.flatMap((d) => holdings(d.id).map((k) => k.name)))];
  add(
    h("p", { class: "muted small", text: "Wipes everything on the chosen devices: their names and every wallet share they hold. They restart as new devices. To forget a wallet on this computer without touching any device, use Remove wallet on the wallet's Details tab instead." }),
    h("div", { class: "list" }, ...ready.map((d) => {
      const hs = holdings(d.id);
      return h("label", { class: "item check-row" },
        h("span", { class: "row" },
          h("input", { type: "checkbox", checked: z.picked.has(d.id), onchange: (e) => { if (e.target.checked) z.picked.add(d.id); else z.picked.delete(d.id); render(); } }),
          h("span", { text: d.name || "New device (not set up)" }),
        ),
        h("span", { class: "muted small", text: hs.length ? `holds a share of ${hs.map((k) => `"${k.name}"`).join(", ")}` : (d.name ? "no wallet in Icebox" : "blank") }),
      );
    })),
    held.length ? h("div", { class: "notice bad", text: `The chosen devices hold shares of ${listJoin(held.map((n) => `"${n}"`))}. Only continue if every one of those devices has its backup written down, or each wallet's other devices can still meet its threshold.` }) : null,
    h("label", { class: "field" }, "Type ERASE to confirm",
      h("input", { id: "erase-many-confirm", type: "text", value: z.typed, spellcheck: "false", autocomplete: "off", oninput: (e) => { z.typed = e.target.value; render(); } }),
    ),
    h("div", { class: "row" },
      h("button", {
        class: "btn danger",
        disabled: !picked.length || z.typed.trim() !== "ERASE",
        onclick: async () => {
          const ids = picked.map((d) => d.id);
          if (await call("erase_devices", { deviceIds: ids }) === undefined) return;
          z.names = Object.fromEntries(picked.map((d) => [d.id, d.name || ""]));
          z.gone = new Set();
          z.sent = ids;
          render();
        },
      }, picked.length ? `Erase ${picked.length} device${picked.length === 1 ? "" : "s"}` : "Choose devices to erase"),
    ),
  );
  return box;
}

// On Linux, a device whose screen is on but that isn't listed almost always means the USB rule
// isn't installed (the AppImage can't install it). Show the one-line fix.
const LINUX_USB_RULE_CMD = "sudo wget -O /etc/udev/rules.d/70-frostsnap.rules https://raw.githubusercontent.com/amisatoshi/icebox/main/linux/70-frostsnap.rules && sudo udevadm control --reload && sudo udevadm trigger";
function androidUsbHint() {
  if (!/Android/.test(navigator.userAgent || "")) return null;
  return h("div", { class: "notice" },
    h("p", { text: "Plug a Frostsnap device into the phone's USB-C port (some phones need a USB-C OTG adapter), then tap Allow when Android asks whether Icebox may use it." }),
  );
}

function linuxUsbHint() {
  const ua = navigator.userAgent || "";
  if (!/Linux/.test(ua) || /Android/.test(ua)) return null;
  return h("div", { class: "notice linux-hint" },
    h("p", { text: "On Linux, and the device's screen is on but it isn't listed here? Linux needs a USB rule so Icebox can use the device (the .deb and .rpm packages install it; the AppImage can't). Run this once in a terminal, then unplug and replug the device:" }),
    h("div", { class: "address-box small", text: LINUX_USB_RULE_CMD }),
    h("div", { class: "row" }, h("button", { class: "btn small", onclick: () => navigator.clipboard.writeText(LINUX_USB_RULE_CMD).then(() => toast("Copied")) }, "Copy command")),
  );
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
        h("h1", { text: "New multi-sig wallet" }),
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

function nameTaken(name) {
  const n = (name || "").trim().toLowerCase();
  return !!n && state.keys.concat(state.watchOnly).some((k) => k.name.trim().toLowerCase() === n);
}

function wizardName(w) {
  return h("div", { class: "card" },
    h("label", { class: "field" }, "Wallet name",
      h("input", {
        id: "wz-name", type: "text", value: w.name, maxlength: 20, placeholder: "e.g. Cold storage",
        oninput: (e) => { const was = nameTaken(w.name); w.name = e.target.value; if (was !== nameTaken(w.name)) render(); },
      }),
    ),
    nameTaken(w.name)
      ? h("div", { class: "notice warn", text: `You already have a wallet called "${w.name.trim()}". A different name avoids mixing them up, here and on the devices' screens.` })
      : null,
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
        : h("span", { class: "pill", text: "not known here", title: "This wallet was restored, and whether its backups were written down is recorded by the app that made it, not on the devices." });
      const c = state.checkBackup;
      const checking = c && c.device_id === d.id && c.keyId === key.key_id && !c.done && isConnected(d.id);
      const check = h("button", {
        class: "btn small ghost",
        title: "Tests your written-down words without showing them: the device asks for each word, giving three choices, and you pick the one on your paper. The words never reach this computer.",
        onclick: () => { state.checkBackup = { keyId: key.key_id, device_id: d.id, done: false }; call("check_backup", { keyId: key.key_id, deviceId: d.id }).then((r) => { if (r === undefined) { state.checkBackup = null; render(); } }); render(); },
      }, "Check backup");
      let action;
      if (showing) action = h("span", { class: "pill warn", text: "showing on device — confirm there when written down" });
      else if (checking) action = h("div", { class: "row" },
        h("span", { class: "pill warn", text: "on the device: pick each word from your paper" }),
        h("button", { class: "btn small ghost", onclick: () => { call("cancel_protocol"); state.checkBackup = null; render(); } }, "Cancel"));
      else if (!isConnected(d.id)) action = d.backup_done === true ? null : h("span", { class: "muted small", text: "plug in to show its backup" });
      else if (d.backup_done === true) action = h("div", { class: "row" }, check, show("Show again", "btn small ghost"));
      else action = h("div", { class: "row" }, show("Show backup on device", "btn small"), check);
      return h("div", { class: "item backup-row" },
        h("div", { class: "stack" },
          h("div", { class: "row" }, h("strong", { text: d.name || deviceName(d.id) }), status),
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
  call("btcpay_watch", { keyId }).then((n) => { if (state.wallet && state.wallet.keyId === keyId && n !== undefined) { state.wallet.btcpayAhead = n || 0; render(); } });
  await refreshWallet();
}

function freshSend() {
  return { address: "", amount: "", max: false, feerate: "", note: "", preview: null, signers: [], sessionId: null, busy: false };
}

async function refreshWallet() {
  const w = state.wallet;
  if (!w) return;
  const watchOnly = !!(walletInfo(w.keyId) || {}).watch_only;
  const [data, sessions] = await Promise.all([
    call("wallet", { keyId: w.keyId }),
    watchOnly ? Promise.resolve([]) : call("sessions", { keyId: w.keyId }),
  ]);
  if (state.wallet !== w) return;
  if (data) { noteReplaced(w, data); w.data = data; }
  if (sessions) w.sessions = sessions;
  if (w.tab === "coins") await loadCoins(w, true);
  render();
}

function renderWallet() {
  const w = state.wallet;
  const key = walletInfo(w.keyId);
  if (!key) return h("div", { class: "page" }, h("p", { class: "muted", text: "Loading…" }));
  const data = w.data;
  const chain = state.chain[key.network];

  const page = h("div", { class: "page" },
    h("div", { class: "page-head" },
      h("div", {},
        h("div", { class: "row" },
          h("h1", { text: key.name }),
          h("span", { class: "pill" + (key.network === "bitcoin" ? " mainnet" : ""), text: networkLabel(key.network) }),
          key.watch_only
            ? h("span", { class: "pill", text: "👁 watch-only", title: "This computer can see this wallet but not spend from it" })
            : h("span", { class: "pill", text: signLabel(key), title: `${key.devices.length} device${key.devices.length === 1 ? "" : "s"} known to Icebox` }),
        ),
        h("p", { class: "sub" },
          chain ? `Electrum: ${chain.state}` : "Electrum: not connected yet",
          data ? (data.height ? ` · block ${data.height.toLocaleString("en-GB")}` : " · syncing…") : "",
        ),
      ),
      h("div", { class: "stack" },
        h("div", { class: "row balance-row" }, balanceFigure(key, data), hideBalanceButton()),
        balanceSecondLine(key, data),
        data && data.pending_incoming
          ? h("span", { class: "muted small", text: `+ ${money(fmtSats(data.pending_incoming))} incoming, unconfirmed` })
          : null,
      ),
    ),
  );

  if (key.watch_only) {
    page.append(h("div", { class: "notice", text: "Watch-only: this computer can see the balance, history and receive addresses, but can't spend. Payments are signed with the wallet's devices, on a computer where the wallet has them." }));
  }

  const unlisted = state.demo || key.watch_only ? [] : unlistedDevices();
  if (unlisted.length) {
    page.append(h("div", { class: "notice" },
      `${listJoin(unlisted.map((d) => d.name))} ${unlisted.length === 1 ? "is" : "are"} plugged in but not listed in any wallet here. If ${unlisted.length === 1 ? "it belongs" : "they belong"} to this wallet (for example one restored from some of its devices), `,
      h("button", { class: "link", onclick: openRestore }, `add ${unlisted.length === 1 ? "it" : "them"} from Restore from devices`),
      ".",
    ));
  }

  if (key.devices.some((d) => d.backup_done === false)) {
    page.append(h("div", { class: "notice warn" },
      "Some devices haven't been backed up yet. ",
      h("button", { class: "link", onclick: () => { w.tab = "backups"; render(); } }, "Back them up now"),
    ));
  } else if (key.devices.some((d) => d.backup_done == null)) {
    page.append(h("div", { class: "notice" },
      h("span", { class: "wide-only", text: "This wallet was restored, so Icebox doesn't know whether its backups were written down (that's recorded by the app that made it, not on the devices). If you're not sure, " }),
      h("span", { class: "phone-only", text: "Restored wallet: backups not known here. " }),
      h("button", { class: "link", onclick: () => { w.tab = "backups"; render(); } },
        h("span", { class: "wide-only", text: "show each device's backup and write it down" }),
        h("span", { class: "phone-only", text: "Check them" })),
      h("span", { class: "wide-only", text: "." }),
    ));
  }

  const tabs = key.watch_only
    ? [["history", "History"], ["receive", "Receive"], ["coins", "Coins"], ["details", "Details"]]
    : [["history", "History"], ["receive", "Receive"], ["send", "Send"], ["coins", "Coins"], ["backups", "Backups"], ["details", "Details"]];
  if (!tabs.some(([id]) => id === w.tab)) w.tab = "history";
  page.append(h("div", { class: "tabs" },
    ...tabs.map(([id, label]) => h("button", {
      class: w.tab === id ? "active" : "",
      onclick: () => { w.tab = id; render(); if (id === "details") loadDescriptor(); if (id === "coins") loadCoins(w, true); },
    }, label)),
  ));

  if (w.tab === "receive") page.append(renderReceive(key, w));
  else if (w.tab === "send") page.append(renderSend(key, w));
  else if (w.tab === "backups") page.append(h("div", { class: "card" }, renderBackupList(key)));
  else if (w.tab === "coins") page.append(renderCoins(key, w));
  else if (w.tab === "details") page.append(renderDetails(key, w));
  else page.append(renderHistory(w));
  return page;
}

// An unconfirmed payment that hasn't been seen for two weeks has usually been dropped by the
// network (nodes forget unconfirmed payments after about 14 days) and may never confirm.
const STALE_PENDING_SECS = 14 * 24 * 3600;

function renderHistory(w) {
  const txs = (w.data && w.data.txs) || [];
  const replaced = (w.replaced || []).map((r) => h("div", { class: "notice warn" },
    `An incoming payment of ${money(fmtSats(r.amount))} that hadn't confirmed was replaced by its sender (for example to change its fee or amount). `,
    "That's normal on Bitcoin: wait for the replacement to confirm. ",
    h("button", { class: "link", onclick: () => { w.replaced = w.replaced.filter((x) => x !== r); render(); } }, "Dismiss"),
  ));
  if (!txs.length) {
    return h("div", { class: "card empty" },
      h("p", { text: "No transactions yet." }),
      h("button", { class: "btn", onclick: () => { w.tab = "receive"; render(); } }, "Receive bitcoin"),
    );
  }
  const now = Date.now() / 1000;
  const stale = (tx) => tx.confirmations < 1 && tx.timestamp && now - tx.timestamp > STALE_PENDING_SECS;
  return h("div", { class: "stack" }, ...replaced,
    txs.some(stale) ? h("div", { class: "notice warn", text: "A payment marked \"may never confirm\" has been waiting for over two weeks. The network has probably dropped it (usually because its fee was too low), so it may never confirm. Click its transaction id to check it on mempool.space. Fee bumping, which can rescue payments like this, is planned for a later version." }) : null,
    h("div", { class: "card" },
    h("table", { class: "history" },
      h("thead", {}, h("tr", {}, h("th", { text: "When" }), h("th", { text: "Transaction" }), h("th", { text: "Amount" }), h("th", { text: "Status" }))),
      h("tbody", {},
        ...txs.map((tx) => h("tr", {},
          h("td", { text: fmtTime(tx.timestamp) }),
          h("td", { class: "tx-cell" }, txLink(w.data.network, tx.txid), labelEditor(w, "tx", tx.txid, tx.label)),
          h("td", { class: "num " + (tx.net_value > 0 ? "pos" : "neg"), text: tx.net_value === null ? "—" : money((tx.net_value > 0 ? "+" : "") + fmtSats(tx.net_value)) }),
          h("td", {}, h("span", {
            class: "pill" + (tx.confirmations >= 1 ? " ok" : stale(tx) ? " bad" : " warn"),
            text: tx.confirmations >= 1 ? `${tx.confirmations} conf` : stale(tx) ? "may never confirm" : "pending",
          })),
        )),
      ),
    ),
    ),
  );
}

/** Notices incoming payments that vanished before confirming: their sender replaced them. */
function noteReplaced(w, data) {
  const pendingIn = (txs) => txs.filter((t) => t.confirmations < 1 && t.net_value > 0);
  if (w.data && w.data.key_id === data.key_id) {
    const now = new Set(data.txs.map((t) => t.txid));
    const gone = pendingIn(w.data.txs).filter((t) => !now.has(t.txid));
    if (gone.length) w.replaced = (w.replaced || []).concat(gone.map((t) => ({ txid: t.txid, amount: t.net_value })));
  }
}

/** The smallest amount that can be sent to an address (below it, an output is "dust"). */
function minSendSats(address) {
  const a = (address || "").trim().toLowerCase().replace(/^bitcoin:/, "").split("?")[0];
  if (/^(bc|tb|bcrt)1q/.test(a)) return a.length > 50 ? 330 : 294; // P2WSH : P2WPKH
  if (/^[13mn2]/.test(a)) return 546;
  return 330; // Taproot (bc1p…), and the default
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
  if (w.btcpayAhead) {
    card.append(h("div", { class: "notice", text: `This wallet is used with BTCPay Server, which hands out its addresses from the start of the wallet. Addresses here start after the ${w.btcpayAhead} Icebox keeps watching for BTCPay, so they never clash. For shop payments, take addresses from BTCPay.` }));
  }
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
    h("div", { class: "row" }, labelEditor(w, "addr", a.address, a.label)),
    h("div", { class: "grid2" },
      h("div", { class: "stack" },
        addressChunks(a.address),
        h("div", { class: "row" },
          h("button", { class: "btn", onclick: () => navigator.clipboard.writeText(a.address).then(() => { toast("Copied"); markShared(key, w, a); }) }, "Copy"),
          key.watch_only ? null : h("button", {
            class: "btn primary",
            onclick: () => { state.verify = { target_devices: [], connected_devices: [], started: true }; call("verify_address", { keyId: key.key_id, index: a.index }); markShared(key, w, a); render(); },
          }, "Check on a device"),
        ),
        key.watch_only ? h("div", { class: "notice warn", text: "Watch-only: there are no devices here to check this address on. Before giving it out for a large payment, check it on one of the wallet's devices from the computer that has them (it's the same address there)." }) : v ? h("div", { class: "notice" },
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
  if (!w.addresses) {
    // The list is dropped when something changes it (labels imported, BTCPay watching); fetch it again.
    if (!w.addressesLoading) {
      w.addressesLoading = true;
      call("addresses", { keyId: key.key_id }).then((list) => {
        w.addressesLoading = false;
        if (list && state.wallet === w) { w.addresses = list; render(); }
      });
    }
    card.append(h("p", { class: "muted", text: "Loading…" }));
    return card;
  }
  // A wallet watching far ahead for BTCPay can have hundreds of handed-out addresses; unless asked
  // for all of them, show the newest few plus every one that's been used or labelled.
  const many = w.addresses.length > 60 && !w.allAddresses;
  const shown = many ? w.addresses.filter((x, i) => i < 10 || x.used || x.label) : w.addresses;
  card.append(h("div", { class: "list" },
    ...shown.map((x) => h("button", {
      class: "item addr-row" + (w.address && w.address.index === x.index ? " current" : ""),
      onclick: () => showAddress(key, w, x.index),
    },
      h("span", { class: "muted mono", text: `#${x.index}` }),
      h("span", { class: "mono small addr-short" + (x.used ? " struck" : ""), text: x.address.slice(0, 14) + "…" + x.address.slice(-8), title: x.address }),
      x.label ? h("span", { class: "small muted addr-label", text: x.label }) : null,
      x.used ? h("span", { class: "pill bad", text: "used" })
        : x.shared ? h("span", { class: "pill", text: "handed out" })
        : h("span", { class: "pill ok", text: "fresh" }),
    )),
  ));
  if (many) {
    card.append(h("p", { class: "muted small" },
      `Showing the newest 10 and every used or labelled address (${shown.length} of ${w.addresses.length}). `,
      h("button", { class: "link", onclick: () => { w.allAddresses = true; render(); } }, "Show all"),
    ));
  }
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

  const card = h("div", { class: "card" }, h("h2", { text: s.preview && s.preview.to_self ? "Combine coins" : "New payment" }));
  if (!s.preview) {
    card.append(
      h("label", { class: "field" }, "Pay to",
        h("div", { class: "row nowrap" },
          h("input", { id: "send-address", type: "text", value: s.address, placeholder: key.network === "bitcoin" ? "bc1…" : "tb1…", spellcheck: "false", oninput: (e) => (s.address = e.target.value) }),
          scanButton((text) => {
            const p = parsePaymentQr(text);
            s.address = p.address;
            if (p.sats !== null) { s.amount = String(p.sats); s.max = false; }
            render();
          }),
        ),
      ),
      h("div", { class: "grid2" },
        h("label", { class: "field" }, "Amount (sats)",
          h("input", { id: "send-amount", type: "number", min: "1", step: "1", value: s.amount, disabled: s.max, oninput: (e) => { s.amount = e.target.value; const el = $("send-fiat"); if (el) el.textContent = fiat(Math.floor(Number(s.amount)), key.network) || ""; } }),
          priceCurrency() && key.network === "bitcoin" ? h("span", { id: "send-fiat", class: "muted small", text: (!s.max && fiat(Math.floor(Number(s.amount)) || 0, key.network)) || "" }) : null,
          h("span", { class: "muted small", text: `Minimum ${fmtSats(minSendSats(s.address))}${s.address.trim() ? " to this address" : ""}: smaller amounts can't be sent ("dust").` }),
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: s.max, onchange: (e) => { s.max = e.target.checked; render(); } }), "Send everything"),
        ),
        h("label", { class: "field" }, "Fee rate (sat/vB)",
          h("input", { id: "send-fee", type: "number", min: "1", step: "0.1", value: s.feerate, oninput: (e) => (s.feerate = e.target.value) }),
          renderFeeChoices(key, w),
        ),
      ),
      h("label", { class: "field" }, "Note (optional)",
        h("input", { id: "send-note", type: "text", maxlength: "255", value: s.note, placeholder: "e.g. Supplier invoice 1042", oninput: (e) => (s.note = e.target.value) }),
        h("span", { class: "muted small", text: "Saved here as the payment's label, and included when you export labels or history. It isn't sent with the payment." }),
      ),
      h("div", { class: "row" },
        h("button", {
          class: "btn primary",
          disabled: s.busy,
          onclick: async () => {
            const amount = s.max ? null : Math.floor(Number(s.amount));
            if (!s.max && !(amount > 0)) return toast("Enter an amount in sats", true);
            if (!s.max && amount < minSendSats(s.address)) return toast(`That's below the minimum of ${fmtSats(minSendSats(s.address))} for this address`, true);
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
      p.to_self
        ? h("div", { class: "item" }, h("span", { class: "muted", text: "To" }), h("span", { text: `this wallet, combining ${p.input_count} coins into one` }))
        : h("div", { class: "item" }, h("span", { class: "muted", text: "To" }), h("span", { class: "mono", text: p.recipient })),
      h("div", { class: "item" }, h("span", { class: "muted", text: p.to_self ? "New coin" : "Amount" }), h("strong", { class: "mono", text: fmtSats(p.amount) + (fiat(p.amount, key.network) ? `  (${fiat(p.amount, key.network)})` : "") })),
      h("div", { class: "item" }, h("span", { class: "muted", text: "Network fee" }), h("span", { class: "mono", text: `${fmtSats(p.fee)} (${p.feerate} sat/vB)` + (fiat(p.fee, key.network) ? `  ${fiat(p.fee, key.network)}` : "") })),
      p.change ? h("div", { class: "item" }, h("span", { class: "muted", text: "Change back to this wallet" }), h("span", { class: "mono", text: fmtSats(p.change) })) : null,
      s.note.trim() ? h("div", { class: "item" }, h("span", { class: "muted", text: "Note" }), h("span", { text: s.note.trim() })) : null,
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
      h("button", { class: "btn ghost", onclick: () => { if (p.to_self) { w.send = freshSend(); w.tab = "coins"; loadCoins(w, true); } else s.preview = null; render(); } }, p.to_self ? "Back to coins" : "Edit"),
      h("button", {
        class: "btn primary",
        disabled: s.signers.length !== key.threshold || s.busy,
        onclick: async () => {
          s.busy = true; render();
          const sessionId = await call("start_send", { keyId: key.key_id, signerIds: s.signers });
          s.busy = false;
          if (sessionId) {
            s.sessionId = sessionId; s.preview = null;
            await refreshWallet();
            // The payment's txid is fixed once signing starts, so the note can be saved now and
            // is there whether it's broadcast from here or later from Payments in progress.
            const session = (w.sessions || []).find((x) => x.session_id === sessionId);
            if (s.note.trim() && session) await call("set_label", { keyId: key.key_id, kind: "tx", reference: session.txid, label: s.note });
          }
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
            // A cancelled payment never reaches the blockchain, so its note goes too.
            await call("set_label", { keyId: key.key_id, kind: "tx", reference: p.txid, label: "" });
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

// ---------------------------------------------------------------------------------------------
// Prices: off until switched on in Settings. Only the public price is fetched (mempool.space, and
// for the ringgit the European Central Bank's rate via frankfurter.dev); nothing about the wallet
// is in any request. A price the user types in fetches nothing at all.
// ---------------------------------------------------------------------------------------------

const PRICE_CURRENCIES = [
  ["GBP", "British pound"], ["USD", "US dollar"], ["EUR", "Euro"], ["AUD", "Australian dollar"],
  ["CAD", "Canadian dollar"], ["CHF", "Swiss franc"], ["JPY", "Japanese yen"], ["MYR", "Malaysian ringgit"],
  ["AED", "UAE dirham"], ["SAR", "Saudi riyal"], ["QAR", "Qatari riyal"], ["BHD", "Bahraini dinar"], ["OMR", "Omani rial"],
];
const MEMPOOL_CURRENCIES = ["GBP", "USD", "EUR", "AUD", "CAD", "CHF", "JPY"];
// Fixed pegs to the US dollar (Kuwait's dinar follows a basket, so it's left to "your own price").
const USD_PEGS = { AED: 3.6725, SAR: 3.75, QAR: 3.64, BHD: 0.376, OMR: 0.3845 };
const MEMPOOL_PRICES = "https://mempool.space/api/v1/prices";
const PRICE_REFRESH_MS = 10 * 60 * 1000;
// Demo mode never touches the network, so it shows a made-up price.
const DEMO_USD_PRICE = 80000;

/** The currency prices are shown in, or null when prices are off. */
function priceCurrency() {
  const s = state.prices.settings;
  if (!s || !s.enabled) return null;
  return s.currency === "MANUAL" ? s.manual_code : s.currency;
}

async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

const positive = (x) => (typeof x === "number" && isFinite(x) && x > 0 ? x : null);

/** Today's price of one bitcoin in `currency`, and where it came from. */
async function fetchPrice(currency) {
  if (state.demo) return { price: DEMO_USD_PRICE * (USD_PEGS[currency] || ({ GBP: 0.79, EUR: 0.93, AUD: 1.53, CAD: 1.39, CHF: 0.88, JPY: 152, MYR: 4.4 }[currency] || 1)), source: "a made-up demo price" };
  const p = await fetchJson(MEMPOOL_PRICES);
  if (MEMPOOL_CURRENCIES.includes(currency)) {
    const price = positive(p[currency]);
    if (!price) throw new Error(`mempool.space has no ${currency} price`);
    return { price, source: "mempool.space" };
  }
  if (USD_PEGS[currency]) {
    const usd = positive(p.USD);
    if (!usd) throw new Error("mempool.space has no USD price");
    return { price: usd * USD_PEGS[currency], source: `mempool.space (US dollar × the fixed ${currency} peg)` };
  }
  if (currency === "MYR") {
    const fx = await fetchJson("https://api.frankfurter.dev/v1/latest?base=EUR&symbols=MYR");
    const eur = positive(p.EUR); const rate = positive(fx && fx.rates && fx.rates.MYR);
    if (!eur || !rate) throw new Error("couldn't get the euro price or the ringgit rate");
    return { price: eur * rate, source: "mempool.space and the European Central Bank's rate" };
  }
  throw new Error(`no price source for ${currency}`);
}

let priceTimer = null;
async function refreshPrice() {
  clearTimeout(priceTimer);
  const pr = state.prices;
  const s = pr.settings;
  if (!s || !s.enabled) { Object.assign(pr, { price: null, at: null, error: null, source: null }); render(); return; }
  if (s.currency === "MANUAL") {
    Object.assign(pr, { price: s.manual_price, at: Date.now(), error: null, source: "your own price" });
    render();
    return;
  }
  const asked = s.currency;
  try {
    const { price, source } = await fetchPrice(asked);
    if (state.prices.settings !== s) return; // settings changed meanwhile
    Object.assign(pr, { price, at: Date.now(), error: null, source });
  } catch (e) {
    if (state.prices.settings !== s) return;
    pr.error = String(e.message || e);
  }
  render();
  priceTimer = setTimeout(refreshPrice, PRICE_REFRESH_MS);
}

async function loadPriceSettings() {
  const s = await call("price_settings");
  if (s) { state.prices.settings = s; refreshPrice(); }
}

async function savePriceSettings(changes) {
  const next = Object.assign({}, state.prices.settings, changes);
  if (state.demo) { state.prices.settings = next; refreshPrice(); return true; }
  const saved = await call("set_price_settings", { settings: next });
  if (saved) { state.prices.settings = saved; refreshPrice(); return true; }
  render();
  return false;
}

function fmtFiat(amount, currency) {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: amount !== 0 && Math.abs(amount) < 1 ? 4 : 2 }).format(amount);
  } catch (_) {
    return `${amount.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${currency}`;
  }
}

// The big balance figure can be in BTC (the default) or, with prices on, in the user's currency.
// Clicking it swaps the two; the choice is remembered on this computer.
function fiatFirst() {
  try { return localStorage.getItem("icebox.fiatFirst") === "1"; } catch (_) { return false; }
}
function setFiatFirst(on) {
  try { localStorage.setItem("icebox.fiatFirst", on ? "1" : "0"); } catch (_) { /* not kept; fine */ }
  render();
}

/** The balance as the big figure: BTC, or the currency value when that's chosen and known. */
function balanceFigure(key, data) {
  const value = data ? fiatValue(data.balance, key.network) : null;
  if (!data) return h("div", { class: "balance" }, "—", h("span", { class: "unit", text: "BTC" }));
  const inFiat = value !== null && fiatFirst();
  const figure = inFiat
    ? h("div", { class: "balance" }, money(fmtFiat(value, priceCurrency())))
    : h("div", { class: "balance" }, money(fmtBtc(data.balance)), h("span", { class: "unit", text: "BTC" }));
  if (value === null) return figure;
  return h("button", {
    class: "balance-swap",
    title: inFiat ? "Show the balance in BTC" : `Show the balance in ${priceCurrency()}`,
    "aria-label": inFiat ? "Show the balance in BTC" : `Show the balance in ${priceCurrency()}`,
    onclick: () => setFiatFirst(!inFiat),
  }, figure);
}

/** The line under the big figure: the other unit. */
function balanceSecondLine(key, data) {
  if (!data) return null;
  const approx = fiat(data.balance, key.network);
  if (!approx) return null;
  const text = fiatFirst() ? money(fmtBtc(data.balance)) + " BTC" : approx;
  return h("span", { class: "muted fiat", text });
}

/** An amount in sats in the chosen currency, as a number, or null when prices are off, not known
 *  yet, or the wallet isn't on mainnet. */
function fiatValue(sats, network) {
  const cur = priceCurrency();
  const price = state.prices.price;
  if (network !== "bitcoin" || !cur || !price || sats === null || sats === undefined) return null;
  return (sats / 1e8) * price;
}

/** "≈ £12.34" for an amount in sats, or null when prices are off or not known yet. Test coins
 *  (signet, testnet, regtest) are worth nothing, so they never get a price. */
function fiat(sats, network) {
  const value = fiatValue(sats, network);
  return value === null ? null : "≈ " + money(fmtFiat(value, priceCurrency()));
}

/** Each day's price (YYYY-MM-DD -> price) for the CSV, from the full history in one request,
 *  so the server never sees which days the wallet had payments on. */
async function dailyPrices(currency) {
  const base = MEMPOOL_CURRENCIES.includes(currency) ? currency : USD_PEGS[currency] ? "USD" : "EUR";
  const hist = await fetchJson(`https://mempool.space/api/v1/historical-price?currency=${base}`);
  const out = {};
  for (const e of (hist && hist.prices) || []) {
    const v = positive(e[base]);
    if (v && e.time) out[new Date(e.time * 1000).toISOString().slice(0, 10)] = v;
  }
  if (USD_PEGS[currency]) for (const d in out) out[d] *= USD_PEGS[currency];
  if (currency === "MYR") {
    const days = Object.keys(out).sort();
    if (days.length) {
      const fx = await fetchJson(`https://api.frankfurter.dev/v1/${days[0]}..?base=EUR&symbols=MYR`);
      const rates = (fx && fx.rates) || {};
      let last = null;
      for (const d of days) {
        // The ECB publishes on working days only; a weekend uses Friday's rate.
        const r = positive(rates[d] && rates[d].MYR);
        if (r) last = r;
        if (last) out[d] *= last; else delete out[d];
      }
    }
  }
  return out;
}

function renderPriceSettings() {
  const pr = state.prices;
  const s = pr.settings;
  const card = h("div", { class: "card stack" }, h("h2", { text: "Prices" }));
  if (!s) { card.append(h("p", { class: "muted", text: "Loading…" })); return card; }
  card.append(
    h("p", { class: "muted", text: "Show what amounts are worth in your currency. Off by default: fetching a price tells the price server that someone at your internet address uses a Bitcoin wallet (nothing about the wallet itself is sent). Icebox asks mempool.space every 10 minutes while it's open; for the ringgit it also asks frankfurter.dev for the European Central Bank's rate. A price you type in yourself fetches nothing." }),
    h("label", { class: "row check-row" },
      h("input", { type: "checkbox", checked: s.enabled, onchange: (e) => savePriceSettings({ enabled: e.target.checked }) }),
      h("span", { text: "Show prices" }),
    ),
  );
  if (!s.enabled) return card;
  const m = pr.manualDraft = pr.manualDraft || { code: s.manual_code || "", price: s.manual_price ? String(s.manual_price) : "" };
  card.append(h("label", { class: "field" }, "Currency",
    h("select", {
      id: "price-currency",
      onchange: (e) => {
        const currency = e.target.value;
        if (currency === "MANUAL" && !(s.manual_code && s.manual_price)) { s.currency = "MANUAL"; render(); return; }
        savePriceSettings({ currency });
      },
    },
      ...PRICE_CURRENCIES.map(([code, name]) => h("option", { value: code, selected: s.currency === code }, `${code} – ${name}`)),
      h("option", { value: "MANUAL", selected: s.currency === "MANUAL" }, "Your own price…"),
    ),
  ));
  if (s.currency === "MANUAL") {
    card.append(
      h("div", { class: "grid2" },
        h("label", { class: "field" }, "Currency code",
          h("input", { id: "price-code", type: "text", maxlength: "3", value: m.code, placeholder: "KWD", spellcheck: "false", oninput: (e) => (m.code = e.target.value) })),
        h("label", { class: "field" }, "Price of 1 bitcoin",
          h("input", { id: "price-manual", type: "number", min: "0", step: "any", value: m.price, oninput: (e) => (m.price = e.target.value) })),
      ),
      h("div", { class: "row" }, h("button", {
        class: "btn small",
        onclick: async () => {
          if (await savePriceSettings({ currency: "MANUAL", manual_code: m.code, manual_price: Number(m.price) })) toast("Price saved");
        },
      }, "Save price")),
      h("p", { class: "muted small", text: "For a currency Icebox doesn't fetch. It stays as you typed it until you change it, and the history export doesn't add values with it (it would only be today's price)." }),
    );
  }
  const cur = priceCurrency();
  if (pr.error) card.append(h("div", { class: "notice warn", text: `Couldn't get the price: ${pr.error}. Icebox will try again in 10 minutes.` }));
  else if (pr.price && cur) {
    const ago = Math.round((Date.now() - pr.at) / 60000);
    card.append(h("p", { class: "small", text: `1 BTC = ${fmtFiat(pr.price, cur)} · ${pr.source}${s.currency === "MANUAL" ? "" : ago < 1 ? ", just now" : `, ${ago} min ago`}` }));
  }
  return card;
}

// ---------------------------------------------------------------------------------------------
// Coins: the separate amounts the wallet holds. Seeing them, labelling them, and combining chosen
// ones into one. Paying from chosen coins needs a change in the Frostsnap library and will follow.
// ---------------------------------------------------------------------------------------------

async function loadCoins(w, force) {
  if (w.coins && !force) return;
  const coins = await call("coins", { keyId: w.keyId });
  if (coins && state.wallet === w) {
    w.coins = coins;
    const held = new Set(coins.map((c) => c.outpoint));
    w.coinPick = new Set([...(w.coinPick || [])].filter((o) => held.has(o)));
    render();
  }
}

function renderCoins(key, w) {
  if (!w.coins) return h("div", { class: "card" }, h("p", { class: "muted", text: "Loading…" }));
  const coins = w.coins;
  if (!coins.length) return h("div", { class: "card empty" }, h("p", { text: "No coins yet. Each payment into this wallet becomes a coin here." }));
  const pick = w.coinPick = w.coinPick || new Set();
  const total = coins.reduce((n, c) => n + c.value, 0);
  const chosen = coins.filter((c) => pick.has(c.outpoint));
  const chosenTotal = chosen.reduce((n, c) => n + c.value, 0);
  // Combining needs two or more coins; with one there's nothing to choose.
  const canSpend = !key.watch_only && coins.length >= 2;
  const frozen = coins.filter((c) => !c.spendable);

  const wrap = h("div", { class: "stack" });
  wrap.append(h("div", { class: "card stack" },
    h("p", { class: "muted small", text: `${coins.length} coin${coins.length === 1 ? "" : "s"}, ${money(fmtSats(total))}${fiat(total, key.network) ? ` (${fiat(total, key.network)})` : ""} in all. Each payment into the wallet, and each bit of change from a payment out, is a separate coin. A payment spends whole coins, and every coin it spends costs a little in fees.` }),
    !key.watch_only && coins.length === 1 ? h("p", { class: "muted small", text: "With only one coin there's nothing to combine." }) : null,
    frozen.length ? h("div", { class: "notice warn", text: `${frozen.length} coin${frozen.length === 1 ? " is" : "s are"} marked "don't spend" by a label file from another wallet. Icebox shows the mark, but can't yet keep a coin out of an ordinary payment.` }) : null,
  ));

  const table = h("table", { class: "coins" + (canSpend ? "" : " no-pick") },
    h("thead", {}, h("tr", {},
      canSpend ? h("th", { class: "pick" }, h("input", {
        type: "checkbox", "aria-label": "Choose all coins",
        checked: chosen.length === coins.length,
        onchange: (e) => { w.coinPick = new Set(e.target.checked ? coins.map((c) => c.outpoint) : []); render(); },
      })) : null,
      h("th", { text: "Coin" }), h("th", { class: "num", text: "Amount" }), h("th", { text: "Status" }),
    )),
    h("tbody", {}, ...coins.map((c) => {
      const inherited = c.tx_label || c.address_label;
      return h("tr", { class: pick.has(c.outpoint) ? "picked" : "" },
        canSpend ? h("td", { class: "pick" }, h("input", {
          type: "checkbox", "aria-label": "Choose this coin",
          checked: pick.has(c.outpoint),
          onchange: (e) => { if (e.target.checked) pick.add(c.outpoint); else pick.delete(c.outpoint); render(); },
        })) : null,
        h("td", { class: "tx-cell coin" },
          h("span", { class: "mono small", title: c.outpoint, text: c.address ? c.address.slice(0, 12) + "…" + c.address.slice(-6) : shortId(c.outpoint) }),
          labelEditor(w, "output", c.outpoint, c.label),
          !c.label && inherited ? h("span", { class: "muted small", text: "from: " + inherited }) : null,
        ),
        h("td", { class: "num amt", text: money(fmtSats(c.value)) }),
        h("td", { class: "status" },
          h("span", { class: "pill" + (c.confirmations >= 1 ? " ok" : " warn"), text: c.confirmations >= 1 ? `${c.confirmations} conf` : "pending" }),
          c.spendable ? null : h("span", { class: "pill bad", title: "Marked \"don't spend\" by another wallet's label file", text: "don't spend" }),
        ),
      );
    })),
  );
  wrap.append(h("div", { class: "card" }, table));

  if (canSpend) {
    const c = w.combine = w.combine || { feerate: "", busy: false };
    wrap.append(h("div", { class: "card stack" },
      h("h3", { text: "Combine chosen coins" }),
      h("p", { class: "muted small", text: "Moves the chosen coins back into this wallet as one coin. Doing this while fees are low means later payments spend fewer coins and cost less. Combining links those coins together for anyone watching the blockchain, so don't combine coins you'd rather keep apart (for example, ones from different customers or sources)." }),
      h("div", { class: "row" },
        h("strong", { text: chosen.length ? `${chosen.length} chosen · ${money(fmtSats(chosenTotal))}` : "No coins chosen" }),
      ),
      h("label", { class: "field" }, "Fee rate (sat/vB)",
        h("input", { id: "combine-fee", type: "number", min: "1", step: "0.1", value: c.feerate, oninput: (e) => (c.feerate = e.target.value) }),
      ),
      h("div", { class: "row" },
        h("button", {
          class: "btn primary",
          disabled: c.busy || chosen.length < 2,
          onclick: async () => {
            const feerate = Number(c.feerate);
            if (!(feerate >= 1)) return toast("Enter a fee rate of at least 1 sat/vB", true);
            c.busy = true; render();
            const preview = await call("prepare_consolidate", { keyId: key.key_id, outpoints: chosen.map((x) => x.outpoint), feerate });
            c.busy = false;
            if (preview) {
              w.send = freshSend();
              w.send.preview = preview;
              const connected = key.devices.filter((d) => isConnected(d.id)).map((d) => d.id);
              const rest = key.devices.map((d) => d.id).filter((id) => !connected.includes(id));
              w.send.signers = connected.concat(rest).slice(0, key.threshold);
              w.tab = "send";
            }
            render();
          },
        }, c.busy ? "Working…" : chosen.length < 2 ? "Choose two or more coins" : `Review combining ${chosen.length} coins`),
      ),
    ));
  }
  return wrap;
}

// ---------------------------------------------------------------------------------------------
// Labels: short notes on a payment, an address or a coin, kept on this computer and exported in
// the BIP-329 format that Sparrow, BTCPay Server and other wallets read.
// ---------------------------------------------------------------------------------------------

/** The label for one thing, with an inline editor. Only one label is edited at a time. */
function labelEditor(w, kind, ref, current) {
  const e = w.labelEdit;
  if (e && e.kind === kind && e.ref === ref) {
    const save = async () => {
      if (w.labelEdit !== e) return;
      w.labelEdit = null;
      if (e.value.trim() !== (current || "")) {
        const ok = await call("set_label", { keyId: w.keyId, kind, reference: ref, label: e.value });
        if (ok !== undefined) {
          if (kind === "addr") {
            if (w.address && w.address.address === ref) w.address.label = e.value.trim() || null;
            const key = walletInfo(w.keyId);
            if (key) loadAddresses(w, key, true);
          }
          refreshWallet();
        }
      }
      render();
    };
    return h("span", { class: "label-edit" },
      h("input", {
        id: "label-edit", type: "text", maxlength: "255", value: e.value, placeholder: "Add a note",
        "aria-label": "Label",
        oninput: (ev) => { e.value = ev.target.value; },
        onkeydown: (ev) => {
          if (ev.key === "Enter") save();
          if (ev.key === "Escape") { w.labelEdit = null; render(); }
        },
      }),
      h("button", { class: "btn small", onclick: save }, "Save"),
      h("button", { class: "btn small ghost", onclick: () => { w.labelEdit = null; render(); } }, "Cancel"),
    );
  }
  return h("button", {
    class: "link label-text" + (current ? "" : " muted"),
    title: current ? "Edit label" : "Add a label (kept only in this copy of Icebox)",
    onclick: (ev) => {
      ev.stopPropagation();
      w.labelEdit = { kind, ref, value: current || "" };
      render();
      later(0, () => { const el = $("label-edit"); if (el) el.focus(); });
    },
  }, current ? "✎ " + current : "+ label");
}

/** A short "More" fold for the longer explanation behind a setting, so the Details tab stays
 *  scannable. Its open state is the browser's own (<details>), kept across re-renders by key. */
function more(id, ...children) {
  const open = (state.openMore = state.openMore || {})[id];
  return h("details", { class: "more", open: !!open, ontoggle: (e) => { state.openMore[id] = e.target.open; } },
    h("summary", { text: "More" }),
    h("div", { class: "muted small stack" }, ...children),
  );
}

/** A file name from the wallet's name and today's date, e.g. "Shop labels 2026-11-27.jsonl". */
function exportName(key, what, ext) {
  const day = new Date().toISOString().slice(0, 10);
  return `${key.name} ${what} ${day}.${ext}`;
}

async function saveExport(w, fileName, contents) {
  if (state.demo) {
    w.exported = { demo: true, name: fileName, bytes: contents.length };
    render();
    return;
  }
  const path = await call("save_export", { fileName, contents });
  if (path) { w.exported = { path }; render(); }
}

async function exportLabels(key, w) {
  const text = await call("export_labels", { keyId: key.key_id });
  if (text === undefined) return;
  if (!text) return toast("This wallet has no labels yet", true);
  await saveExport(w, exportName(key, "labels", "jsonl"), text);
}

async function exportHistory(key, w) {
  // With prices on (and a fetched currency), add each payment's value on its day.
  const s = state.prices.settings;
  let currency = null, prices = null;
  if (s && s.enabled && s.currency !== "MANUAL" && !state.demo && key.network === "bitcoin") {
    w.exporting = true; render();
    try {
      prices = await dailyPrices(s.currency);
      if (state.prices.price) prices[new Date().toISOString().slice(0, 10)] = state.prices.price;
      currency = s.currency;
    } catch (e) {
      toast(`Couldn't get past prices (${e.message || e}), so the file has no value column.`, true);
    }
    w.exporting = false;
  }
  const csv = await call("history_csv", { keyId: key.key_id, currency, dailyPrices: prices });
  if (csv) await saveExport(w, exportName(key, "history", "csv"), csv);
  else render();
}

async function importLabels(key, w, file) {
  if (!file) return;
  let text;
  try { text = await file.text(); } catch (e) { return toast("Couldn't read that file: " + e, true); }
  const r = await call("import_labels", { keyId: key.key_id, text });
  if (r) {
    w.imported = r;
    w.addresses = null;
    if (w.address) { const a = await call("address", { keyId: key.key_id, index: w.address.index }); if (a) w.address = a; }
    await refreshWallet();
  }
}

function renderLabelsAndExports(key, w) {
  const isAndroid = /Android/.test(navigator.userAgent || "");
  const box = h("div", { class: "stack" },
    h("h3", { text: "Labels and exports" }),
    h("p", { class: "muted small", text: "Your notes on payments and addresses, kept only here. Move them to other wallets as a BIP-329 file, or save the history as a spreadsheet." }),
    h("div", { class: "row" },
      h("button", { class: "btn", onclick: () => exportLabels(key, w) }, "Export labels"),
      h("label", { class: "btn ghost file-btn" }, "Import labels…",
        h("input", {
          type: "file", accept: ".jsonl,.json,.txt,application/json,text/plain", hidden: true,
          onchange: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; importLabels(key, w, f); },
        }),
      ),
      h("button", { class: "btn", disabled: w.exporting, onclick: () => exportHistory(key, w) }, w.exporting ? "Getting past prices…" : "Export history (CSV)"),
    ),
  );
  if (w.imported) {
    const r = w.imported;
    const parts = [`${r.imported} label${r.imported === 1 ? "" : "s"} imported`];
    if (r.unchanged) parts.push(`${r.unchanged} already the same`);
    if (r.skipped) parts.push(`${r.skipped} line${r.skipped === 1 ? "" : "s"} skipped (not a label Icebox could read)`);
    box.append(h("div", { class: "notice" }, parts.join(", ") + ". ",
      h("button", { class: "link", onclick: () => { w.imported = null; render(); } }, "Dismiss")));
  }
  if (w.exported) {
    const x = w.exported;
    box.append(h("div", { class: "notice" },
      x.demo ? `Demo mode: "${x.name}" would be saved to your Downloads folder (nothing is saved in the demo). ` : `Saved to ${x.path}. `,
      !x.demo && !isAndroid ? h("button", { class: "link", onclick: () => call("show_file", { path: x.path }) }, "Show in folder") : null,
      !x.demo && !isAndroid ? " · " : null,
      h("button", { class: "link", onclick: () => { w.exported = null; render(); } }, "Dismiss"),
    ));
  }
  return box;
}

async function loadDescriptor() {
  const w = state.wallet;
  if (!w || w.descriptor) return;
  const [d, qr, btcpay, ahead] = await Promise.all([
    call("descriptor", { keyId: w.keyId }),
    call("descriptor_qr", { keyId: w.keyId }),
    call("btcpay_scheme", { keyId: w.keyId }),
    call("btcpay_watch", { keyId: w.keyId }),
  ]);
  if (d) { w.descriptor = d; w.descriptorQr = qr || null; w.btcpay = btcpay || null; w.btcpayAhead = ahead || 0; render(); }
}

function renderDetails(key, w) {
  return h("div", { class: "card" },
    h("div", { class: "list" },
      h("div", { class: "item" }, h("span", { class: "muted", text: "Network" }), h("span", { text: networkLabel(key.network) })),
      key.watch_only
        ? h("div", { class: "item" }, h("span", { class: "muted", text: "Spending" }), h("span", { text: "not from this computer (watch-only)" }))
        : h("div", { class: "item" }, h("span", { class: "muted", text: "Spending rule" }), h("span", { text: `any ${key.threshold} devices (${key.devices.length} known to Icebox)` })),
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
    renderLabelsAndExports(key, w),
    renderBtcpay(key, w),
    renderWatchCode(key, w),
    key.watch_only ? renderRemoveWatchOnly(key) : renderRemoveWallet(key, w),
  );
}

// A watch-only code lets another Icebox, with no devices, follow this wallet: balance, history
// and receive addresses. It can't spend, but like the descriptor it reveals every payment.
function renderWatchCode(key, w) {
  const box = h("div", { class: "stack" },
    h("h3", { text: "Watch this wallet on another computer" }),
    h("p", { class: "muted small", text: "See this wallet in Icebox elsewhere (Add watch-only wallet), with no devices. It can't spend, but it shows every payment." }),
  );
  if (!w.watchCode) {
    box.append(h("div", { class: "row" }, h("button", {
      class: "btn",
      onclick: async () => { const c = await call("watch_only_code", { keyId: key.key_id }); if (c) { w.watchCode = c; render(); } },
    }, "Show watch-only code")));
    return box;
  }
  box.append(h("div", { class: "grid2" },
    h("div", { class: "stack" },
      h("div", { class: "address-box small", text: w.watchCode.code }),
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: () => navigator.clipboard.writeText(w.watchCode.code).then(() => toast("Copied")) }, "Copy code"),
        h("button", { class: "btn ghost", onclick: () => { w.watchCode = null; render(); } }, "Hide"),
      ),
    ),
    h("img", { class: "qr", src: w.watchCode.qr_svg, alt: "QR code of the watch-only code" }),
  ));
  return box;
}

function renderRemoveWatchOnly(key) {
  return h("div", { class: "danger-zone" },
    h("h3", { text: "Remove watch-only wallet" }),
    h("p", { class: "muted small", text: "Stops watching this wallet on this computer. Nothing else changes: the wallet, its coins and its devices are unaffected, and you can add it again from its code." }),
    h("button", {
      class: "btn danger",
      onclick: async () => {
        if (await call("remove_watch_only", { keyId: key.key_id }) === undefined) return;
        toast(`Stopped watching "${key.name}"`);
        state.wallet = null;
        state.view = { name: "devices" };
        render();
      },
    }, "Stop watching"),
  );
}

// ---------------------------------------------------------------------------------------------
// QR scanning with the webcam
// ---------------------------------------------------------------------------------------------
// Frames are drawn to a canvas, turned to greyscale and sent to the Rust side to decode (no
// third-party JavaScript). The camera is on only while the scanner is open, and nothing is saved.

/** A "📷 Scan" button that opens the scanner and calls onResult with the text found. */
function scanButton(onResult, label) {
  // Not on Android yet: the app doesn't ask for camera permission there.
  if (/Android/.test(navigator.userAgent || "")) return null;
  return h("button", {
    class: "btn ghost", type: "button", title: "Scan a QR code with this computer's camera",
    onclick: (e) => { e.preventDefault(); openScanner(onResult); },
  }, label || "📷 Scan");
}

/** Reads a scanned payment QR: a plain address, or a bitcoin: link with an optional amount. */
function parsePaymentQr(text) {
  const t = text.trim();
  const m = /^bitcoin:([^?]+)(\?(.*))?$/i.exec(t);
  if (!m) return { address: t, sats: null };
  let sats = null;
  const params = new URLSearchParams(m[3] || "");
  const btc = params.get("amount");
  if (btc && /^\d+(\.\d{1,8})?$/.test(btc)) {
    const [whole, frac = ""] = btc.split(".");
    sats = Number(whole) * 100000000 + Number((frac + "00000000").slice(0, 8));
  }
  // Wallets often upper-case bech32 addresses in QR codes; Icebox wants lower case.
  const address = /^(bc|tb|bcrt)1/i.test(m[1]) ? m[1].toLowerCase() : m[1];
  return { address, sats };
}

let scanner = null;

async function openScanner(onResult) {
  if (scanner) return;
  if (state.demo) { toast("Demo mode doesn't use the camera. Paste the text instead.", true); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("The camera isn't available in Icebox on this system yet. Paste the text instead.", true);
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) {
    toast(e && e.name === "NotAllowedError"
      ? "Icebox wasn't allowed to use the camera. Allow it in your system's privacy settings, or paste the text instead."
      : "Couldn't start the camera. Is one connected and free? You can paste the text instead.", true);
    return;
  }
  const video = h("video", { class: "scanner-video", autoplay: true, muted: true, playsinline: true });
  video.muted = true;
  video.srcObject = stream;
  const status = h("p", { class: "muted small", text: "Hold the QR code up to the camera…" });
  const overlay = h("div", { class: "scanner-overlay", role: "dialog", "aria-label": "Scan a QR code" },
    h("div", { class: "card stack scanner-card" },
      h("h2", { text: "Scan a QR code" }),
      video,
      status,
      h("div", { class: "row" }, h("button", { class: "btn ghost", onclick: () => closeScanner() }, "Cancel")),
    ),
  );
  document.body.append(overlay);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  scanner = { stream, overlay, timer: null, busy: false };

  const tick = async () => {
    if (!scanner || scanner.busy || video.readyState < 2) return;
    // Scale down so each frame is small to send and quick to decode.
    const scale = Math.min(1, 800 / (video.videoWidth || 800));
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const hgt = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.width = w; canvas.height = hgt;
    ctx.drawImage(video, 0, 0, w, hgt);
    const rgba = ctx.getImageData(0, 0, w, hgt).data;
    const grey = new Uint8Array(w * hgt);
    for (let i = 0, j = 0; j < grey.length; i += 4, j++) grey[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    let bin = "";
    for (let i = 0; i < grey.length; i += 0x8000) bin += String.fromCharCode.apply(null, grey.subarray(i, i + 0x8000));
    scanner.busy = true;
    try {
      const text = await invoke("decode_qr", { width: w, height: hgt, data: btoa(bin) });
      if (text && scanner) { closeScanner(); onResult(text); toast("QR code read"); }
    } catch (_) {
      status.textContent = "Couldn't read that frame. Keep the code steady and well lit.";
    } finally {
      if (scanner) scanner.busy = false;
    }
  };
  scanner.timer = setInterval(tick, 300);
}

function closeScanner() {
  if (!scanner) return;
  clearInterval(scanner.timer);
  scanner.stream.getTracks().forEach((t) => t.stop());
  scanner.overlay.remove();
  scanner = null;
}

// ---------------------------------------------------------------------------------------------
// add a watch-only wallet
// ---------------------------------------------------------------------------------------------

function openWatchAdd() {
  state.watchAdd = { code: "", busy: false };
  state.view = { name: "watch_add" };
  render();
}

function renderWatchAdd() {
  const a = state.watchAdd || (state.watchAdd = { code: "", busy: false });
  const add = async () => {
    a.busy = true; render();
    const keyId = await call("add_watch_only", { code: a.code });
    a.busy = false;
    if (keyId) {
      state.watchOnly = (await call("watch_only_wallets")) || state.watchOnly;
      toast("Watch-only wallet added");
      openWallet(keyId);
    } else render();
  };
  return h("div", { class: "page" },
    h("h1", { text: "Add watch-only wallet" }),
    h("p", { class: "sub", text: "Follow a wallet's balance, history and receive addresses on this computer, without its devices. It can't spend." }),
    h("div", { class: "card stack" },
      h("p", { text: "On the computer that has the wallet, open it in Icebox and go to Details → Show watch-only code. Copy the code (it starts icebox-watch1:) and paste it here, or open a text file containing it." }),
      h("label", { class: "field" }, "Watch-only code",
        h("textarea", { id: "watch-code", rows: "4", spellcheck: "false", placeholder: "icebox-watch1:…", oninput: (e) => { a.code = e.target.value; } }, a.code),
      ),
      h("div", { class: "row" },
        h("button", { class: "btn primary", disabled: a.busy, onclick: add }, a.busy ? "Adding…" : "Add wallet"),
        scanButton((text) => { a.code = text.trim(); render(); }, "Scan QR code"),
        h("label", { class: "btn ghost file-btn" }, "Open a file…",
          h("input", {
            type: "file", accept: ".txt,text/plain", hidden: true,
            onchange: (e) => {
              const f = e.target.files && e.target.files[0];
              if (!f) return;
              f.text().then((t) => { a.code = t.trim(); render(); });
            },
          }),
        ),
      ),
      h("p", { class: "muted small", text: "Only Icebox watch-only codes work here. Descriptors from other wallets (such as Sparrow) can't be watched in Icebox yet." }),
    ),
  );
}

// The wallet's extended public key in BTCPay Server's format, so a shop can take payments
// straight into it. BTCPay can only watch: spending still needs the devices, here in Icebox.
function renderBtcpay(key, w) {
  if (!w.btcpay) return null;
  return h("div", { class: "stack" },
    h("h3", { text: "Accept payments with BTCPay Server" }),
    h("p", { class: "muted small", text: "Paste this in BTCPay: your store → Wallets → Bitcoin → Connect an existing wallet → Enter extended public key. BTCPay can see payments, never spend them." }),
    h("div", { class: "address-box small", text: w.btcpay }),
    h("div", { class: "row" }, h("button", { class: "btn", onclick: () => navigator.clipboard.writeText(w.btcpay).then(() => toast("Copied")) }, "Copy for BTCPay")),
    h("div", { class: "notice" },
      h("strong", { text: "Before taking real payments: " }),
      "check BTCPay's first address matches address #0 on the Receive tab, and use this wallet only for the shop.",
    ),
    more("btcpay",
      h("p", { text: "BTCPay and Icebox both hand out addresses from the wallet, so using it for other payments too can give two payers the same address." }),
      key.network === "bitcoin" ? h("p", { text: "Anyone who has this key can see every payment to the wallet, so only paste it into a BTCPay server you run or trust." }) : null,
    ),
    renderBtcpayWatch(key, w),
  );
}

// BTCPay gives each invoice a new address, and unpaid invoices leave gaps. Icebox normally asks
// its server about 50 addresses past the last one handed out, so a shop wallet needs it to look
// further, or a payment after a long run of unpaid invoices wouldn't show here.
function renderBtcpayWatch(key, w) {
  const ahead = w.btcpayAhead || 0;
  const set = async (n) => {
    if (await call("set_btcpay_watch", { keyId: key.key_id, ahead: n }) !== undefined) {
      w.btcpayAhead = n; w.btcpayDraft = null; w.addresses = null;
      toast(n ? `Watching ${n} addresses ahead` : "BTCPay watching switched off");
      render();
    }
  };
  // Switching on marks addresses as handed out, which can't be undone, so the amount is chosen
  // first and only applied with the button. Once on, it can only be widened.
  const draft = w.btcpayDraft;
  const choices = [100, 250, 500, 1000].filter((n) => !ahead || n >= ahead);
  const picker = (value, onchange) => h("select", { id: "btcpay-ahead", onchange },
    ...choices.map((n) => h("option", { value: String(n), selected: n === value }, `${n} addresses${n === 250 ? " (suggested)" : ""}`)));
  const box = h("div", { class: "stack" },
    h("label", { class: "row check-row" },
      h("input", {
        type: "checkbox", checked: ahead > 0 || draft !== null && draft !== undefined,
        onchange: (e) => {
          if (ahead) { if (!e.target.checked) set(0); }
          else { w.btcpayDraft = e.target.checked ? 250 : null; render(); }
        },
      }),
      h("span", { text: "Used with BTCPay Server: watch further ahead" }),
    ),
    h("p", { class: "muted small", text: "So a payment still shows here after a long run of unpaid invoices." }),
  );
  if (!ahead && draft) {
    box.append(
      h("label", { class: "field" }, "How far ahead", picker(draft, (e) => { w.btcpayDraft = Number(e.target.value); })),
      h("div", { class: "row" },
        h("button", { class: "btn small primary", onclick: () => set(w.btcpayDraft) }, "Start watching"),
        h("button", { class: "btn small ghost", onclick: () => { w.btcpayDraft = null; render(); } }, "Cancel"),
      ),
    );
  } else if (ahead) {
    box.append(h("label", { class: "field" }, "Watching ahead", picker(ahead, (e) => set(Number(e.target.value)))));
  }
  box.append(more("btcpay-watch",
    h("p", { text: "BTCPay gives each invoice its own address, and unpaid invoices leave addresses nobody pays. Icebox normally watches 50 addresses past the last one in use; with this on it watches further, and counts those addresses as handed out, so its own Receive tab starts after them and never clashes with BTCPay." }),
    h("p", { text: "Your Electrum server is told about more of your addresses, so for the most privacy use your own server. A newly watched address shows up after the next block." }),
    h("p", { text: "This can't be undone or narrowed: addresses already counted as handed out stay that way, and switching it off only stops watching further ahead. That's harmless." }),
  ));
  return box;
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
  state.settings = { servers: {}, dataDir: null, resetting: false };
  render();
  const [dataDir, ...servers] = await Promise.all([
    call("data_dir"),
    ...NETWORKS.map((network) => call("electrum_servers", { network })),
  ]);
  state.settings.dataDir = dataDir;
  for (const s of servers) if (s) state.settings.servers[s.network] = s;
  render();
}

async function restoreDefaultServers(networks, quiet) {
  const st = state.settings;
  for (const network of networks) {
    if (await call("restore_default_electrum", { network }) === undefined) return;
    const s = await call("electrum_servers", { network });
    if (s && st) st.servers[network] = s;
  }
  toast(quiet ? "Settings back to the defaults" : `${networkLabel(networks[0])} servers back to the defaults`);
  render();
}

// ---------------------------------------------------------------------------------------------
// logs and keyboard shortcuts
// ---------------------------------------------------------------------------------------------

async function openLogs() {
  state.view = { name: "logs" };
  state.logs = { text: null };
  render();
  const text = await call("read_logs");
  state.logs = { text: text === undefined ? "" : text || "" };
  render();
  const box = $("log-text");
  if (box) box.scrollTop = box.scrollHeight;
}

function renderLogs() {
  const l = state.logs || { text: null };
  return h("div", { class: "page" },
    h("div", { class: "page-head" }, h("div", {},
      h("h1", { text: "Logs" }),
      h("p", { class: "sub", text: "What Icebox has been doing: devices plugging in, server connections, errors. Useful when reporting a problem." }),
    )),
    h("div", { class: "notice", text: "Logs never contain backup words or keys, and don't list your addresses or amounts. They can include device and wallet ids, server names and the ids of payments you sent, so read them before sharing, and only send them to someone you trust (e.g. by email to the Icebox maintainer, not in a public issue)." }),
    h("div", { class: "card" },
      l.text === null
        ? h("p", { class: "muted", text: "Loading…" })
        : h("textarea", { id: "log-text", class: "log-box mono", readonly: true, spellcheck: "false", value: l.text || "The log is empty." }),
      h("div", { class: "row" },
        h("button", { class: "btn small", disabled: !l.text, onclick: () => navigator.clipboard.writeText(l.text).then(() => toast("Log copied")) }, "Copy"),
        h("button", { class: "btn small", onclick: () => call("show_log_file") }, "Show log file"),
        h("button", { class: "btn small ghost", onclick: openLogs }, "Refresh"),
        h("button", { class: "btn small ghost", onclick: () => openHelp("bug") }, "Report a bug"),
      ),
    ),
  );
}

const SHORTCUT_LIST = [
  ["N", "New multi-sig wallet"], ["R", "Receive"], ["S", "Send"], ["D", "Devices"],
  ["B", "Hide or show balances"], [",", "Settings"], ["/", "Keyboard shortcuts"], ["Q", "Quit Icebox"],
];

function renderShortcuts() {
  const mod = /Mac/.test(navigator.platform || navigator.userAgent || "") ? "⌘" : "Ctrl+";
  return h("div", { class: "page" },
    h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Keyboard shortcuts" }))),
    h("div", { class: "card" }, h("div", { class: "list" },
      ...SHORTCUT_LIST.map(([key, what]) => h("div", { class: "item" },
        h("span", { text: what }),
        h("kbd", { text: mod + key }),
      )),
    )),
  );
}

/** Opens a fixed help page in the browser (the URL is built in Rust). Works in demo mode too. */
function openHelp(page) {
  const run = tauri ? tauri.core.invoke("open_help", { page }) : invoke("open_help", { page });
  Promise.resolve(run).catch((e) => toast(String(e), true));
}

function renderSettings() {
  const st = state.settings || { servers: {} };
  const page = h("div", { class: "page" },
    h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Settings" }))),
  );
  const card = h("div", { class: "card" },
    h("h2", { text: "Electrum servers" }),
    h("p", { class: "muted", text: "Where Icebox reads the blockchain. For the most privacy, point mainnet at your own node, e.g. tcp://umbrel.local:50001 or ssl://your-node:50002. The defaults are the same servers the official Frostsnap app uses." }),
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
        s.default_primary !== undefined
          ? h("button", {
            class: "btn small ghost",
            title: `Primary ${s.default_primary}, backup ${s.default_backup}`,
            onclick: () => restoreDefaultServers([network]),
          }, "Restore defaults")
          : null,
      ),
    ));
  }
  page.append(card);
  page.append(renderPriceSettings());
  page.append(h("div", { class: "card" },
    h("h2", { text: "Privacy" }),
    h("label", { class: "row check-row" },
      h("input", { type: "checkbox", checked: state.hideBalance, onchange: toggleHideBalance }),
      h("span", { text: "Hide amounts (balances and payment history show as •••••). Also View → Hide or show balances, or Ctrl+B." }),
    ),
  ));
  page.append(h("div", { class: "card" },
    h("h2", { text: "Troubleshooting" }),
    h("p", { class: "muted", text: "Icebox keeps a log of what it did (devices, server connections, errors). If something goes wrong, the log helps work out why." }),
    h("div", { class: "row" }, h("button", { class: "btn small", onclick: openLogs }, "View logs")),
  ));
  page.append(h("div", { class: "card" },
    h("h2", { text: "Restore default settings" }),
    h("p", { class: "muted", text: "Puts every network's Electrum servers back to the defaults, shows amounts again and switches prices off. Wallets, devices, labels and saved restores aren't touched." }),
    h("div", { class: "row" }, h("button", {
      class: "btn small", disabled: st.resetting,
      onclick: async () => {
        st.resetting = true; render();
        await restoreDefaultServers(NETWORKS.filter((n) => st.servers[n]), true);
        if (state.hideBalance) await toggleHideBalance();
        if (state.prices.settings && state.prices.settings.enabled) await savePriceSettings({ enabled: false });
        st.resetting = false; render();
      },
    }, st.resetting ? "Restoring…" : "Restore all defaults")),
  ));
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
      if (state.eraseMany && state.eraseMany.sent) {
        for (const id of state.eraseMany.sent) if (!e.devices.some((d) => d.id === id)) state.eraseMany.gone.add(id);
      }
      break;
    case "watch_only":
      state.watchOnly = e.wallets || [];
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
        // The device keeps showing its tick until told to stop: send it home after a moment.
        later(1500, () => { if (state.backup && state.backup.device_id === e.device_id) { state.backup = null; call("clear_device_screens"); render(); } });
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
      later(2500, () => call("clear_device_screens"));
      break;
    }
    case "wallet_changed":
      if (state.wallet && state.wallet.keyId === e.key_id) refreshWallet();
      return;
    case "chain": {
      // Reconnecting to the server can bring news the page hasn't fetched yet.
      const before = state.chain[e.network];
      state.chain[e.network] = e;
      if (e.state === "connected" && (!before || before.state !== "connected") &&
          state.wallet && state.wallet.data && state.wallet.data.network === e.network) refreshWallet();
      break;
    }
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
    case "watch_add": return openWatchAdd();
    case "hide_balances": return toggleHideBalance();
    case "demo": return enterDemo();
    case "about": return openAbout();
    case "updates": return openAbout().then(checkForUpdates);
    case "logs": return openLogs();
    case "shortcuts": state.view = { name: "shortcuts" }; return render();
    case "guide": return openHelp("guide");
    case "report_bug": return openHelp("bug");
  }
}

// Keyboard shortcuts. On Windows the webview has keyboard focus and swallows the menu's own
// shortcuts, so the page handles them too. lastMenu stops a double action on systems where both
// the menu and the page see the key.
const SHORTCUTS = { n: "new_wallet", r: "receive", s: "send", d: "devices", b: "hide_balances", ",": "settings", "/": "shortcuts", q: "quit" };
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

// Belt and braces for the wallet page: refresh every 30 s while it's open, and as soon as the app
// comes back to the front (Android pauses the page in the background, and events sent meanwhile
// can be missed).
setInterval(() => { if (state.view.name === "wallet" && !document.hidden) refreshWallet(); }, 30000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.view.name === "wallet") refreshWallet();
});

async function main() {
  $("new-wallet-btn").addEventListener("click", startWizard);
  const restoreBtn = $("restore-btn");
  if (restoreBtn) restoreBtn.addEventListener("click", openRestore);
  const watchAddBtn = $("watch-add-btn");
  if (watchAddBtn) watchAddBtn.addEventListener("click", openWatchAdd);
  $("devices-btn").addEventListener("click", () => { state.view = { name: "devices" }; render(); });
  $("settings-btn").addEventListener("click", openSettings);
  // Phones: the menu button opens the drawer; choosing anything in it closes it again.
  fixAndroidInsets();
  if ($("drawer-btn")) {
    $("drawer-btn").addEventListener("click", () => setDrawer(!document.body.classList.contains("drawer-open")));
    $("drawer-backdrop").addEventListener("click", () => setDrawer(false));
    $("mobile-devices").addEventListener("click", () => { setDrawer(false); state.view = { name: "devices" }; render(); });
    for (const b of document.querySelectorAll("[data-menu]")) b.addEventListener("click", () => runMenu(b.dataset.menu));
    document.querySelector(".sidebar").addEventListener("click", (e) => { if (e.target.closest("button")) setDrawer(false); });
  }

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
  state.savedRestores = (await call("saved_restores")) || [];
  state.watchOnly = (await call("watch_only_wallets")) || [];
  state.hideBalance = (await call("hide_balance")) === true;
  await loadPriceSettings();
  state.ready = true;
  if (state.keys.length) openWallet(state.keys[0].key_id);
  else render();
}

main();
