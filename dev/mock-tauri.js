// Developer preview only (not shipped): stands in for Tauri so ui/ runs in a normal browser.
// Uses the same simulated backend as the in-app demo mode, plus two extra devices that show the
// firmware-warning and still-connecting states.
(function () {
  const listeners = [];
  const demo = window.createIceboxDemo((payload) => listeners.forEach((cb) => cb({ payload })), { extraDevices: true });
  window.__TAURI__ = {
    core: { invoke: (cmd, args) => demo.invoke(cmd, args) },
    event: { listen: async (name, cb) => { if (name === "icebox") listeners.push(cb); return () => {}; } },
  };
})();
