# Contributing to Icebox

Thanks for helping. Icebox handles people's money, so we optimise for **correctness and
reviewability** over speed. Small, focused pull requests get merged fastest.

## Ground rules

- **Security issues go to [SECURITY.md](SECURITY.md)**, never to public issues.
- **Never paste real backup words, private keys, descriptors or mainnet addresses** into issues,
  PRs, logs or screenshots. Use Signet, demo mode, or blur them.
- Be kind. We follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting set up

Follow **Building** in the [README](README.md). Then:

```bash
cargo test -p icebox-core        # core tests
cargo tauri dev                  # run the app
```

No devices? Use **Help → Try demo mode** in the app, or open `dev/preview.html` in a browser to
work on the interface with simulated devices (run `python3 dev/sync-preview.py` after changing
`ui/index.html`).

## How the code is organised

| Path | What | Review bar |
|------|------|------------|
| `crates/icebox-core/` | Coordinator service on top of the official Frostsnap crates | **High**: anything touching keys, signing, transactions or persistence needs two approvals |
| `src-tauri/` | Thin Tauri shell: one command per action, menu, config | High for `tauri.conf.json` (CSP) and `capabilities/` |
| `ui/` | Plain HTML/CSS/JS, no dependencies | Normal |
| `ui/demo.js` | Simulated backend for demo mode | Normal (must never touch real devices) |
| `.github/` | CI, release and security workflows | **High**: supply-chain sensitive |

Principles we hold to:

- **Lean on upstream.** Cryptography, device protocol and wallet logic come from
  `frostsnap_core` / `frostsnap_coordinator`. Icebox wires them up; it doesn't reimplement them.
  Mirror how the official app (`frostsnapp/rust/src/coordinator.rs`) uses an API when in doubt.
- **No new JavaScript dependencies** in `ui/`. No bundler, no npm. Text from devices or the
  network is always inserted with `textContent`, never as HTML.
- **No new Tauri plugins or permissions** without a short note in the PR on why it's needed.
- **The device screen is the source of truth.** Never weaken a flow that asks the user to check
  something on the device.

## Making a change

1. For anything bigger than a small fix, open an issue first so we can agree the approach.
2. Branch from `main`. Keep the PR to one logical change.
3. Before pushing:
   ```bash
   cargo fmt --all
   cargo clippy --workspace --all-targets -- -D warnings
   cargo test --workspace
   node --check ui/app.js ui/demo.js
   ```
4. Test what you changed. For device flows, on **Signet with real devices** if you have them, and
   say so in the PR. For UI-only changes, demo mode is fine.
5. Update `CHANGELOG.md` under **Unreleased**.
6. Open the PR and fill in the template. CI must pass.

## Sign your commits off (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA.
It's a statement that you wrote the change or have the right to submit it under the project's
licence. Add it with `-s`:

```bash
git commit -s -m "Show firmware version on the devices page"
```

which adds `Signed-off-by: Your Name <you@example.com>` to the message. PRs without sign-off on
every commit can't be merged. Forgot? `git rebase --signoff main` then force-push your branch.

Signing commits cryptographically (GPG or SSH, so GitHub shows "Verified") is strongly encouraged
and required for maintainers.

## Licence

Icebox is licensed under the [MIT licence](LICENSE). By submitting a contribution (and signing
it off, above) you agree it's licensed under the same terms.

## Releases (maintainers)

1. Update the version in `src-tauri/Cargo.toml`, `crates/icebox-core/Cargo.toml` and
   `src-tauri/tauri.conf.json`; move **Unreleased** in `CHANGELOG.md` under the new version.
2. Merge to `main`, then tag from `main`: `git tag -s v0.2.0 -m "Icebox 0.2.0" && git push origin v0.2.0`.
3. The release workflow builds Windows and Linux installers, checksums and provenance into a
   **draft** release. A maintainer approves the `release` environment, checks the files, then
   publishes.
