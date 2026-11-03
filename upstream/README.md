# Keeping up with Frostsnap

Icebox builds on the official Frostsnap crates, pinned to one commit in the root `Cargo.toml`
(`rev = …`). Frostsnap fixes reach Icebox in two ways:

1. **Dependency fixes** (e.g. a TLS library): update Icebox's own `Cargo.lock` with
   `cargo update -p <crate>`. No pin change needed. cargo-deny in CI fails on known advisories, so
   these show up as a red "dependency policy" check.
2. **Frostsnap code or firmware changes**: move the pin to the matching Frostsnap commit, fix any
   API changes in `crates/icebox-core/src/service.rs`, test on devices, release.

`FROSTSNAP_RELEASE` holds the newest Frostsnap release that has been reviewed for Icebox.
`.github/workflows/upstream-watch.yml` checks Frostsnap's tags every day and opens an issue when
there's a newer one (GitHub emails you about new issues). After reviewing a release, update this
file and close the issue.

## Review log

- **v0.4.1** (27 Oct 2026): eMudhra CA compromise (RUSTSEC-2026-0382). Only `Cargo.lock` changed:
  `rustls-webpki` 0.103.16 and `webpki-roots` 1.0.11. Icebox applied the same update to its own lock
  file; no pin change. Firmware unchanged (v0.4.0).
- Not yet released (on Frostsnap `master` after v0.4.1): a new genuine-device check bound to device
  identity. It needs new device firmware, so Icebox waits for that release before moving the pin.
