# Setting up the Icebox repository on GitHub

A checklist for publishing Icebox as a well-run open-source project. Most of it is automated by
`scripts/github-setup.sh`; the rest takes a few clicks. Work through it in order.

## 1. Before the first push

- [ ] **Account security.** Turn on two-factor authentication on every account with write
      access (Settings → Password and authentication). Use a passkey or authenticator app, not SMS.
- [ ] **Commit signing.** Create an SSH signing key and tell git and GitHub about it:
      ```bash
      ssh-keygen -t ed25519 -C "icebox signing" -f ~/.ssh/icebox_signing
      # Windows PowerShell: use $HOME\.ssh\icebox_signing and "$HOME/.ssh/icebox_signing.pub" below
      git config --global gpg.format ssh
      git config --global user.signingkey ~/.ssh/icebox_signing.pub
      git config --global commit.gpgsign true
      git config --global tag.gpgsign true
      ```
      Then add `~/.ssh/icebox_signing.pub` at GitHub → Settings → SSH and GPG keys →
      **New SSH key → Key type: Signing key**. Commits will show **Verified**.
- [ ] **Replace `OWNER`** with your GitHub username or organisation in the repo files:
      ```bash
      grep -rl "OWNER" --exclude-dir=target --exclude-dir=.git . \
        | xargs sed -i 's/OWNER/your-github-name/g'
      ```
      (On Windows, run that in Git Bash.) It's in `CODEOWNERS`, `CHANGELOG.md`, `SECURITY.md`,
      the issue template links and README badges.
- [ ] **Commit `Cargo.lock` from a successful local build.** CI builds with `--locked`, so the
      lock file must already include the Tauri crates. Run `cargo tauri build` once, then commit
      the updated `Cargo.lock`.
- [ ] **Use an organisation** (e.g. a `blockchainology` org) rather than a personal account if
      others will maintain it. Ownership, teams and billing are easier to hand over later.

Then create the repository **as private** (no template, README, licence or .gitignore: the folder
already has them) and push. Starting private lets CI run and get fixed before anyone sees it:

```bash
git init -b main
git add .
git commit -s -m "Initial commit of Icebox"
git remote add origin git@github.com:OWNER/icebox.git
git push -u origin main
```

Open the **Actions** tab and wait for the first CI run (about 15–20 minutes). Fix anything red
before going public.

## 2. Going public, then applying the settings

When you're ready: Settings → General → Danger Zone → **Change visibility → Public**. Run the
script *after* this: several settings (rulesets on a free plan, private vulnerability reporting,
secret scanning) only work on public repositories.

```bash
gh auth login                       # as the repo admin
scripts/github-setup.sh OWNER/icebox
```

This sets:

| Area | Setting | Why |
|------|---------|-----|
| General | Description, topics, Discussions on; Wiki and Projects off | Findable; one place for docs (the repo) |
| Merging | Squash only, auto-delete branches, "update branch" button | Clean, linear, reviewable history |
| Security | Dependabot alerts and security updates | Know about vulnerable dependencies |
| Security | Private vulnerability reporting | Matches SECURITY.md; reports stay private |
| Security | Secret scanning + push protection | Blocks accidentally pushed keys and tokens |
| Actions | Default token **read-only**; Actions can't approve PRs | Least privilege; each workflow asks for what it needs |
| Actions | Only GitHub-owned + 4 named third-party actions allowed | Shrinks the supply-chain surface |
| Actions | Approval needed for workflows from outside contributors | Stops drive-by PRs running code in CI |
| Environment | `release`: you must approve; only `v*` tags | No release without a human saying yes |
| Ruleset `main` | PRs only, CI must pass, **signed commits**, linear history, no force-push or delete | Nothing lands unreviewed or unsigned |
| Ruleset tags | Only admins create `v*` tags; nobody moves or deletes them | Release tags are permanent |
| Labels | triage, security, good first issue, devices, ui… | Matches the issue templates |

**Solo for now?** The `main` ruleset needs 0 approvals so you can merge your own PRs (CI still
has to pass). When a second maintainer joins, raise it to 1 and tick "Require review from Code
Owners" (Settings → Rules → Rulesets → Protect main).

## 3. A few clicks the API can't do

- [ ] **Social preview.** Settings → General → Social preview → upload
      `docs/social-preview.png` (1280×640). This is what shows when the repo link is shared on X.
- [ ] **Fork PR workflow approval**, if the script printed a warning: Settings → Actions →
      General → "Approval for running fork pull request workflows from contributors" →
      **Require approval for all external contributors**.
- [ ] **Discussions categories.** Discussions → ⚙️ → keep *Q&A*, *Ideas*, *Show and tell*,
      *Announcements* (maintainers only).
- [ ] **DCO check.** Install the free [DCO GitHub App](https://github.com/apps/dco) on the repo,
      then add `DCO` to the required status checks in the `main` ruleset. It fails PRs whose
      commits aren't signed off (see CONTRIBUTING.md).
- [ ] **Sponsorship (optional).** Add `.github/FUNDING.yml` (GitHub Sponsors, Geyser, or a
      Lightning address link) to show a Sponsor button.
- [ ] **OpenSSF Best Practices badge (optional).** Fill in the questionnaire at
      [bestpractices.dev](https://www.bestpractices.dev/). Most answers are already "yes" thanks to
      this setup, and the badge reassures security-minded users.

## 4. What the workflows do

| Workflow | When | What |
|----------|------|------|
| `ci.yml` | every PR and push to main | rustfmt, clippy (warnings are errors), tests on Linux; compile check on Windows; interface checks (JS syntax, no inline scripts, no `innerHTML`); `cargo-deny` for vulnerabilities, licences and dependency sources |
| `release.yml` | pushing a `v*` tag | builds `.msi`, `.deb`, `.rpm`, `.AppImage` from scratch (no cache); records **build provenance**; waits for your approval; creates a **draft** release with `SHA256SUMS` |
| `codeql.yml` | PRs, main, weekly | static analysis of the interface JavaScript and of the workflows themselves |
| `scorecard.yml` | main, weekly | OpenSSF Scorecard: rates the repo's security practices, shown as a README badge |
| `dependabot.yml` | weekly | grouped PRs for Rust crates and Actions (Frostsnap crates are moved by hand on purpose) |

Every third-party action is **pinned to a full commit SHA**, with the version in a comment.
Dependabot updates the SHAs, so a hijacked tag can't swap in different code.

**First CI run:** CI treats compiler warnings as errors and checks dependency licences. If it
fails on a warning or on a licence `deny.toml` doesn't list, fix the warning, or (after checking
the licence is compatible) add it to `deny.toml`.

## 5. Making a release

1. Bump the version in `src-tauri/Cargo.toml`, `crates/icebox-core/Cargo.toml` and
   `src-tauri/tauri.conf.json`; move **Unreleased** in `CHANGELOG.md` under the new version.
2. Merge to main, then sign and push the tag:
   ```bash
   git tag -s v0.2.0 -m "Icebox 0.2.0"
   git push origin v0.2.0
   ```
3. Actions → release → **Review deployments** → approve.
4. Open the draft release, verify and install the files, add the CHANGELOG section, tick
   **Set as a pre-release** while Icebox is 0.x, and **Publish**.

Never move or re-push a release tag. If a build fails or the draft has a problem, fix it on main
and release the next patch version (e.g. 0.2.1).

Users can then verify an installer:

```bash
gh attestation verify Icebox_0.2.0_x64_en-US.msi --repo OWNER/icebox
```

## 6. Licence

Icebox is **MIT**, the same licence as the Frostsnap crates it builds on: short, well understood,
and compatible with almost everything. Contributors agree to it through the DCO sign-off
(CONTRIBUTING.md), so there's no separate contributor agreement to manage.
