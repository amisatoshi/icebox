# Security policy

Icebox coordinates Bitcoin wallets. Please treat anything that could affect someone's funds or
privacy as a security issue, and report it privately.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**

1. Preferred: use GitHub's private reporting. Go to the **Security** tab of this repository, then
   **Report a vulnerability**.
2. Or email **hello@blockchainology.co.uk** with the subject "Icebox security".

Please include what you found, how to reproduce it, the Icebox version (Help → About) and your
operating system. A minimal proof of concept helps a lot.

**Never send real backup words, private keys or a mainnet wallet's descriptor**, not even to us.
Reproduce on Signet with throwaway devices or demo mode.

## What to expect

| Step | Target |
|------|--------|
| We confirm we've received it | within 3 working days |
| First assessment and severity | within 10 working days |
| Fix or mitigation for critical issues | as fast as safely possible; we'll keep you updated |
| Public advisory | after a fixed release is out, credited to you unless you'd rather not be named |

We follow coordinated disclosure and ask you to give us a reasonable chance to ship a fix before
publishing. We won't take legal action over good-faith research that follows this policy.

## Scope

In scope:

- this repository: `crates/icebox-core`, `src-tauri`, `ui`, build and release workflows
- the release installers published on this repository's Releases page

Especially interested in:

- anything that could make a device sign something the user didn't intend
- addresses or amounts shown in Icebox that differ from what devices show or sign
- leaks of wallet data (descriptors, addresses, balances) outside the user's data folder
- ways for web content or other programs to drive Icebox (it should have no network port and only
  its own commands)
- tampering with the build or release pipeline

Out of scope here (report upstream instead):

- the Frostsnap device firmware and the `frostsnap_core` / `frostsnap_coordinator` crates:
  see [frostsnap/frostsnap SECURITY.md](https://github.com/frostsnap/frostsnap/blob/master/SECURITY.md).
  If you're unsure where an issue lives, report it here and we'll coordinate.
- issues that need an already-compromised computer with no further escalation
- public Electrum servers seeing which addresses you query (documented; use your own node)

## Supported versions

Icebox is pre-1.0. Only the latest release gets security fixes.

## Verifying a download

Each release lists SHA-256 checksums, and the installers carry GitHub build provenance. To check
an installer was built by this repository's release workflow from a tagged commit:

```bash
gh attestation verify Icebox_0.2.0_x64_en-US.msi --repo amisatoshi/icebox
```
