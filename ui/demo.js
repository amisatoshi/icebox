"use strict";
/*
 * Demo mode: a simulated Icebox backend with pretend devices and test coins.
 *
 * It answers the same commands as the real Rust side, so the whole app can be tried without
 * owning Frostsnap devices — for workshops, demos and onboarding. Nothing here touches USB, the
 * network or the real wallet database; it all lives in memory and is gone on exit.
 *
 * createIceboxDemo(emit, options) returns { invoke(cmd, args) }. `emit(event)` delivers events
 * exactly as the Rust side would.
 */
window.createIceboxDemo = function createIceboxDemo(emit, options) {
  const opts = options || {};
  const later = (ms, fn) => setTimeout(fn, ms);
  const send = (payload) => later(0, () => emit(payload));
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const now = () => Math.floor(Date.now() / 1000);

  const device = (extra) => Object.assign({
    id: (Math.random() < 0.5 ? "02" : "03") + hex(64),
    name: null, needs_name: true, ready: true, nonces: 0,
    firmware_digest: hex(64), firmware: "v0.4.0", firmware_status: "expected",
  }, extra || {});

  const devs = [device(), device(), device()];
  if (opts.extraDevices) {
    // used by the developer preview to show the warning states
    devs.push(device({ firmware: "v0.3.0", firmware_status: "older" }));
    devs.push(device({ ready: false }));
  }

  const keys = [];
  const wallets = {};   // key_id -> { height, txs, nextIndex }
  let sessions = [];
  let pending = null;
  let pendingSend = null;
  const previewNames = {};
  // Restore scan: which devices hold which (pretend) wallet shares.
  let scanning = false;
  const oldWallet = { name: "Old savings", network: "signet", threshold: 2, groupId: "demo-old:" + hex(64) };
  const heldBy = {};    // device id -> [{ groupId, name, network, threshold, share }]
  let savedRestores = []; // [{ restoration_id, groupId, name, network, threshold, devices: [{ id, share_number }] }]
  let olderPlugged = 0;   // how many of the older wallet's two devices have been plugged in

  const savedView = (r) => {
    const found = r.devices.length; const restorable = found >= r.threshold;
    return {
      restoration_id: r.restoration_id, name: r.name, network: r.network, threshold: r.threshold, found, incompatible: 0, restorable,
      devices: r.devices.map((d) => { const dev = devs.find((x) => x.id === d.id); return { id: d.id, name: dev ? dev.name : d.name, share_number: d.share_number, fits: restorable ? "yes" : "unknown", connected: !!dev }; }),
    };
  };
  // Like the real app: devices that belong to a saved restore are recorded in it as they answer.
  const absorb = () => {
    for (const r of savedRestores) for (const d of devs) for (const h of heldBy[d.id] || []) {
      if (h.groupId === r.groupId && !r.devices.some((x) => x.id === d.id)) r.devices.push({ id: d.id, name: d.name, share_number: h.share });
    }
  };

  const emitDevices = () => devs.forEach((d) => (d.needs_name = !d.name)) || send({ kind: "devices", devices: devs });
  const emitKeys = () => send({ kind: "keys", keys });
  const findKey = (keyId) => keys.find((k) => k.key_id === keyId);

  function address(network, index) {
    const prefix = network === "bitcoin" ? "bc1p" : "tb1p";
    // deterministic per index so "the same address" stays the same
    let h = "", x = index * 2654435761 >>> 0;
    while (h.length < 58) { x = (x * 1103515245 + 12345) >>> 0; h += x.toString(32); }
    return prefix + h.slice(0, 58).replace(/[^a-z0-9]/g, "q");
  }

  function qr(text) {
    // a decorative pattern, not a scannable code: the demo address isn't real anyway
    let cells = "";
    for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) {
      const finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
      const on = finder ? (x % 6 === 0 || y % 6 === 0 || (x % 14 > 1 && x % 14 < 5 && y % 14 > 1 && y % 14 < 5) || x === 20 || y === 20)
        : ((text.charCodeAt((x * 21 + y) % text.length) + x * y) % 3 === 0);
      if (on) cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
    // Deliberately unscannable and labelled: a scannable demo address could lead someone to send
    // real coins to an address nobody can spend from.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 25 25"><rect x="-2" y="-2" width="25" height="25" fill="#fff"/>${cells}`
      + `<rect x="-2" y="8" width="25" height="5" fill="#f7931a"/>`
      + `<text x="10.5" y="11.6" font-family="sans-serif" font-size="2.6" font-weight="700" text-anchor="middle" fill="#1b1204">DEMO - NOT REAL</text></svg>`;
    return "data:image/svg+xml;base64," + btoa(svg);
  }

  function walletView(keyId) {
    const k = findKey(keyId); const w = wallets[keyId];
    let balance = 0, pendingIncoming = 0;
    for (const tx of w.txs) {
      if (tx.confirmations === 0 && tx.net_value > 0) pendingIncoming += tx.net_value;
      else balance += tx.net_value;
    }
    return { key_id: keyId, network: k.network, height: w.height, balance, pending_incoming: pendingIncoming, txs: w.txs.slice().reverse() };
  }

  function signingEvent(s) {
    send({
      kind: "signing", session_id: s.session_id, got_shares: s.got_shares.slice(), needed_from: s.signers.slice(),
      connected_but_need_request: s.signers.filter((id) => !s.got_shares.includes(id) && !s.asked.includes(id) && devs.some((d) => d.id === id && d.ready)),
      finished: s.signed, aborted: null,
    });
  }

  const handlers = {
    startup_status: () => "ok",
    app_info: () => ({ version: "0.2.0", frostsnap_rev: "233f93b6d4ad16552596fad4f80e7a44b9fe4c60", expected_firmware: "v0.4.0", data_dir: "(demo mode: nothing is saved)" }),
    data_dir: () => "(demo mode: nothing is saved)",
    list_devices: () => devs,
    list_keys: () => keys,

    // Like real devices, the name only shows on the device's screen while typing; it's saved
    // to the device when the wallet is created.
    preview_device_name: ({ deviceId, name }) => { previewNames[deviceId] = name; },

    replenish_nonces: ({ deviceIds }) => {
      let done = 0; const total = deviceIds.length * 4;
      const tick = () => {
        done += 2;
        send({ kind: "nonces", devices: deviceIds, completed_streams: Math.min(done, total), total_streams: total, finished: done >= total, aborted: false });
        if (done < total) later(140, tick);
        else { devs.forEach((d) => { if (deviceIds.includes(d.id)) d.nonces = 16; }); emitDevices(); }
      };
      later(100, tick);
    },

    start_restore_scan: () => { scanning = true; later(600, () => send({ kind: "restore_scan_changed" })); },
    restore_candidates: () => {
      if (scanning) absorb();
      const groups = {};
      const add = (groupId, name, network, threshold, d, share, status) => {
        const g = groups[groupId] = groups[groupId] || { group_id: groupId, name, network, threshold, found: 0, status, devices: [] };
        g.devices.push({ id: d.id, name: d.name, share_number: share, connected: true }); g.found = g.devices.length;
      };
      for (const k of keys) k.devices.forEach((kd) => { const d = devs.find((x) => x.id === kd.id); if (d) add(k.key_id + ":demo", k.name, k.network, k.threshold, d, kd.share_index, "already_here"); });
      for (const d of devs) for (const h of heldBy[d.id] || []) add(h.groupId, h.name, h.network, h.threshold, d, h.share, "need_more");
      const list = Object.values(groups);
      list.forEach((g) => {
        if (g.status === "already_here") return;
        const saved = savedRestores.find((r) => r.groupId === g.group_id);
        g.status = saved ? "saved" : g.found >= g.threshold ? "ready" : "need_more";
      });
      const asked = devs.filter((d) => d.ready);
      return { answered: scanning ? asked.map((d) => d.id) : [], waiting: [], candidates: list, saved: savedRestores.map(savedView) };
    },
    saved_restores: () => savedRestores.map(savedView),
    save_restore: ({ groupId }) => {
      if (groupId !== oldWallet.groupId) throw "demo mode can only save the pretend older wallet";
      const holders = devs.filter((d) => (heldBy[d.id] || []).some((h) => h.groupId === groupId));
      const r = { restoration_id: hex(32), groupId, name: oldWallet.name, network: oldWallet.network, threshold: oldWallet.threshold,
        devices: holders.map((d) => ({ id: d.id, name: d.name, share_number: heldBy[d.id].find((h) => h.groupId === groupId).share })) };
      savedRestores.push(r);
      send({ kind: "restore_scan_changed" });
      return r.restoration_id;
    },
    cancel_saved_restore: ({ restorationId }) => { savedRestores = savedRestores.filter((r) => r.restoration_id !== restorationId); send({ kind: "restore_scan_changed" }); return null; },
    finish_saved_restore: ({ restorationId }) => {
      const r = savedRestores.find((x) => x.restoration_id === restorationId);
      if (!r || r.devices.length < r.threshold) throw "not enough matching shares yet";
      savedRestores = savedRestores.filter((x) => x !== r);
      return handlers.restore_wallet({ groupId: r.groupId, saved: r.devices });
    },
    // Plugs in the older wallet's devices one at a time (Delta, then Echo), to show restoring
    // across places. Plugging in Echo unplugs Delta, as if it had stayed at the first place.
    demo_plug_restore_devices: () => {
      if (olderPlugged >= 2) return;
      const i = olderPlugged++;
      if (i === 1) {
        const delta = devs.find((d) => d.name === "Delta");
        if (delta) devs.splice(devs.indexOf(delta), 1);
      }
      const d = device({ name: ["Delta", "Echo"][i], needs_name: false, nonces: 8 });
      heldBy[d.id] = [{ groupId: oldWallet.groupId, name: oldWallet.name, network: oldWallet.network, threshold: oldWallet.threshold, share: i + 1 }];
      devs.push(d);
      emitDevices();
      later(300, () => send({ kind: "restore_scan_changed" }));
    },
    restore_wallet: ({ groupId, saved }) => {
      if (groupId !== oldWallet.groupId) throw "demo mode can only restore the pretend older wallet";
      const holders = saved
        ? saved.map((d) => ({ id: d.id, name: d.name }))
        : devs.filter((d) => (heldBy[d.id] || []).some((h) => h.groupId === groupId));
      if (holders.length < oldWallet.threshold) throw "not enough matching shares yet";
      const keyId = hex(64);
      keys.push({ key_id: keyId, name: oldWallet.name, network: oldWallet.network, threshold: oldWallet.threshold, access_structure_id: hex(64),
        devices: holders.map((d, i) => ({ id: d.id, name: d.name, share_index: i + 1, backup_done: null })) });
      holders.forEach((d) => { heldBy[d.id] = []; });
      send({ kind: "restore_scan_changed" });
      wallets[keyId] = { height: 268431, nextIndex: 7, txs: [
        { txid: hex(64), net_value: 4200000, fee: 141, confirmations: 2210, timestamp: now() - 86400 * 400 },
        { txid: hex(64), net_value: -650000, fee: 180, confirmations: 900, timestamp: now() - 86400 * 120 },
      ] };
      emitKeys();
      return keyId;
    },

    erase_device: ({ deviceId }) => {
      send({ kind: "erase", device_id: deviceId, confirmed: false });
      later(1500, () => {
        send({ kind: "erase", device_id: deviceId, confirmed: true });
        const d = devs.find((d) => d.id === deviceId);
        if (d) { d.name = null; d.nonces = 0; d.ready = false; emitDevices(); later(900, () => { d.ready = true; emitDevices(); }); }
      });
    },

    start_keygen: ({ deviceIds, threshold, name, network }) => {
      const code = hex(8);
      const base = { keygen_id: hex(32), threshold, devices: deviceIds, got_shares: [], session_acks: [], all_acks: false, check_code: null, finished: null, aborted: null };
      send({ kind: "keygen", ...base });
      later(500, () => send({ kind: "keygen", ...base, got_shares: deviceIds, check_code: code }));
      deviceIds.forEach((id, i) => later(1100 + i * 500, () => send({ kind: "keygen", ...base, got_shares: deviceIds, check_code: code, session_acks: deviceIds.slice(0, i + 1), all_acks: i === deviceIds.length - 1 })));
      pending = { name, network, threshold, deviceIds };
    },

    delete_wallet: ({ keyId }) => {
      const i = keys.findIndex((k) => k.key_id === keyId);
      if (i >= 0) keys.splice(i, 1);
      delete wallets[keyId];
      emitKeys();
      return null;
    },

    finalize_keygen: () => {
      const p = pending; const keyId = hex(64);
      p.deviceIds.forEach((id) => { const d = devs.find((d) => d.id === id); if (d && previewNames[id]) d.name = previewNames[id]; });
      emitDevices();
      keys.push({
        key_id: keyId, name: p.name, network: p.network, threshold: p.threshold, access_structure_id: hex(64),
        devices: p.deviceIds.map((id, i) => ({ id, name: (devs.find((d) => d.id === id) || {}).name, share_index: i + 1, backup_done: false })),
      });
      // a little test-coin history so the wallet has something to show
      wallets[keyId] = { height: 268431, nextIndex: 0, txs: [
        { txid: hex(64), net_value: 1500000, fee: 141, confirmations: 40, timestamp: now() - 86400 * 3 },
        { txid: hex(64), net_value: -300000, fee: 154, confirmations: 12, timestamp: now() - 86400 },
      ] };
      emitKeys();
      later(4000, () => {
        wallets[keyId].txs.push({ txid: hex(64), net_value: 50000, fee: 141, confirmations: 0, timestamp: null });
        send({ kind: "wallet_changed", key_id: keyId });
      });
      return keyId;
    },

    display_backup: ({ deviceId }) => later(1200, () => send({ kind: "display_backup", device_id: deviceId, confirmed: true, closed: true })),
    check_backup: ({ deviceId }) => later(1500, () => send({ kind: "check_backup", device_id: deviceId, valid: true })),
    mark_address_shared: ({ keyId, index }) => { const w = wallets[keyId]; w.shared = Math.max(w.shared || 0, index + 1); return null; },
    addresses: ({ keyId }) => {
      const k = findKey(keyId); const w = wallets[keyId]; const n = Math.max(w.nextIndex, w.shared || 0);
      return Array.from({ length: n + 1 }, (_, i) => ({ index: i, address: address(k.network, i + 1), used: i < 2 && w.txs.length > 0, shared: i < (w.shared || 0) })).reverse();
    },
    address: ({ keyId, index }) => { const k = findKey(keyId); const a = address(k.network, index + 1); return { index, address: a, used: index < 2 && wallets[keyId].txs.length > 0, qr_svg: qr(a) }; },
    descriptor_qr: () => qr("demo descriptor"),
    btcpay_scheme: () => `tpubDemo${hex(70)}-[taproot]`,
    mark_backup_complete: ({ keyId, deviceId }) => { const k = findKey(keyId); k.devices.find((d) => d.id === deviceId).backup_done = true; emitKeys(); },
    descriptor: ({ keyId }) => `tr([${hex(8)}/86'/1'/0']tpubDemo${hex(70)}/<0;1>/*)#${hex(8)}  (demo)`,

    wallet: ({ keyId }) => walletView(keyId),
    next_address: ({ keyId }) => {
      const w = wallets[keyId]; const index = w.nextIndex++; const a = address(findKey(keyId).network, index + 1);
      return { index, address: a, used: false, qr_svg: qr(a) };
    },
    verify_address: ({ keyId }) => {
      const k = findKey(keyId);
      later(400, () => send({ kind: "verify_address", target_devices: k.devices.map((d) => d.id), connected_devices: k.devices.map((d) => d.id).filter((id) => devs.some((d) => d.id === id)) }));
    },

    fee_estimates: () => [{ target_blocks: 1, sat_per_vb: 12 }, { target_blocks: 3, sat_per_vb: 8 }, { target_blocks: 6, sat_per_vb: 5 }, { target_blocks: 25, sat_per_vb: 2 }],
    prepare_send: ({ keyId, address: to, amount, feerate }) => {
      const v = walletView(keyId); const fee = Math.round(154 * feerate);
      if (!/^(tb1|bc1|bitcoin:)/i.test((to || "").trim())) throw "that is not a valid bitcoin address";
      const send_ = amount === null ? v.balance - fee : amount;
      if (send_ <= 0 || send_ + fee > v.balance) throw "can't build that payment: insufficient balance";
      pendingSend = { keyId, to: to.trim().replace(/^bitcoin:/i, "").split("?")[0], amount: send_, fee, feerate };
      return { recipient: pendingSend.to, amount: send_, fee, change: amount === null ? null : v.balance - send_ - fee, input_count: 2, feerate };
    },
    start_send: ({ keyId, signerIds }) => {
      if (!pendingSend) throw "prepare the payment first";
      const s = { session_id: hex(64), key_id: keyId, txid: hex(64), fee: pendingSend.fee, feerate: pendingSend.feerate,
        recipients: [{ address: pendingSend.to, amount: pendingSend.amount }], signers: signerIds, got_shares: [], asked: [], signed: false };
      sessions.push(s); pendingSend = null; signingEvent(s); return s.session_id;
    },
    request_device_sign: ({ sessionId, deviceId }) => {
      const s = sessions.find((s) => s.session_id === sessionId);
      s.asked.push(deviceId); signingEvent(s);
      later(1200, () => { s.got_shares.push(deviceId); s.signed = s.got_shares.length === s.signers.length; signingEvent(s); });
    },
    resume_signing: ({ sessionId }) => { const s = sessions.find((s) => s.session_id === sessionId); if (s) { s.asked = []; signingEvent(s); } },
    sessions: ({ keyId }) => sessions.filter((s) => s.key_id === keyId).map((s) => ({ ...s })),
    cancel_sign_session: ({ sessionId }) => { sessions = sessions.filter((s) => s.session_id !== sessionId); },
    broadcast: ({ sessionId }) => {
      const s = sessions.find((s) => s.session_id === sessionId);
      wallets[s.key_id].txs.push({ txid: s.txid, net_value: -(s.recipients[0].amount + s.fee), fee: s.fee, confirmations: 0, timestamp: now() });
      sessions = sessions.filter((x) => x !== s);
      later(5000, () => { const tx = wallets[s.key_id].txs.find((t) => t.txid === s.txid); if (tx) { tx.confirmations = 1; tx.timestamp = now(); send({ kind: "wallet_changed", key_id: s.key_id }); } });
      return s.txid;
    },
    cancel_protocol: () => { scanning = false; },

    electrum_servers: ({ network }) => ({ network, primary: "(demo: no server used)", backup: "(demo: no server used)" }),
    set_electrum_servers: () => { throw "Electrum settings can't be changed in demo mode"; },
    reconnect: () => {},
  };

  later(300, () => send({ kind: "chain", network: "signet", state: "connected", url: "demo" }));

  return {
    invoke: async (cmd, args) => {
      const handler = handlers[cmd];
      if (!handler) throw `demo mode: "${cmd}" isn't simulated`;
      const result = handler(args || {});
      return result === undefined ? null : result;
    },
  };
};
