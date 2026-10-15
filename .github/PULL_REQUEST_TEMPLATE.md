## What does this change?

<!-- One or two sentences. Link the issue: "Closes #123". -->

## How was it tested?

<!-- Delete what doesn't apply. -->
- [ ] `cargo test --workspace`
- [ ] Demo mode
- [ ] Signet with real devices (how many, firmware version):
- [ ] Windows
- [ ] Linux

## Checklist

- [ ] Every commit is signed off (`git commit -s`), see CONTRIBUTING.md
- [ ] `cargo fmt`, `cargo clippy -- -D warnings` and `node --check ui/*.js` pass
- [ ] `CHANGELOG.md` updated under **Unreleased**
- [ ] No backup words, keys, descriptors or mainnet addresses in code, tests, screenshots or logs
- [ ] No new JavaScript dependencies, Tauri plugins or permissions (or explained below)

## Security notes

<!-- Does this touch keys, signing, transactions, persistence, what devices display, the CSP,
     Tauri permissions, or CI/release? If so, explain what and why. Otherwise write "None". -->
