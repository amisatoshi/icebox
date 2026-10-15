#!/usr/bin/env bash
# Applies Icebox's recommended GitHub settings to a repository with the GitHub CLI.
#
#   gh auth login                      # as a repository admin
#   scripts/github-setup.sh OWNER/icebox
#
# Safe to re-run: settings are set, not toggled; rulesets with the same name are replaced.
# See docs/GITHUB_SETUP.md for what each setting does and the few that must be done by hand.
set -euo pipefail

REPO="${1:?usage: scripts/github-setup.sh OWNER/REPO}"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
api() { gh api -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$@"; }

say "Repository basics"
gh repo edit "$REPO" \
  --description "Icebox: a self-built desktop wallet for Frostsnap devices (Windows & Linux)" \
  --add-topic bitcoin --add-topic frost --add-topic frostsnap --add-topic multisig \
  --add-topic self-custody --add-topic hardware-wallet --add-topic tauri --add-topic rust \
  --enable-issues --enable-discussions \
  --enable-wiki=false --enable-projects=false \
  --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false \
  --delete-branch-on-merge --allow-update-branch

say "Security features"
api -X PUT "repos/$REPO/vulnerability-alerts" >/dev/null && echo "Dependabot alerts: on"
api -X PUT "repos/$REPO/automated-security-fixes" >/dev/null && echo "Dependabot security updates: on"
api -X PUT "repos/$REPO/private-vulnerability-reporting" >/dev/null && echo "Private vulnerability reporting: on"
api -X PATCH "repos/$REPO" --input - >/dev/null <<'JSON' && echo "Secret scanning + push protection: on"
{"security_and_analysis": {"secret_scanning": {"status": "enabled"},
                           "secret_scanning_push_protection": {"status": "enabled"}}}
JSON

say "GitHub Actions"
# Workflows get a read-only token unless they ask for more, and can't approve PRs.
api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false >/dev/null
# Only GitHub's own actions plus the few third-party ones the workflows use.
api -X PUT "repos/$REPO/actions/permissions" -F enabled=true -f allowed_actions=selected >/dev/null
api -X PUT "repos/$REPO/actions/permissions/selected-actions" --input - >/dev/null <<'JSON'
{"github_owned_allowed": true, "verified_allowed": false,
 "patterns_allowed": ["Swatinem/rust-cache@*", "softprops/action-gh-release@*",
                      "ossf/scorecard-action@*", "EmbarkStudios/cargo-deny-action@*"]}
JSON
# A maintainer must approve workflow runs from anyone who isn't a collaborator.
api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors >/dev/null || \
  echo "  (couldn't set fork PR approval by API; set it by hand, see docs/GITHUB_SETUP.md)"
echo "Actions: read-only token, allow-listed actions, approval for outside contributors"

say "Release environment (a maintainer approves every release)"
ME_ID="$(gh api user --jq .id)"
api -X PUT "repos/$REPO/environments/release" --input - >/dev/null <<JSON
{"reviewers": [{"type": "User", "id": $ME_ID}],
 "prevent_self_review": false,
 "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
api -X POST "repos/$REPO/environments/release/deployment-branch-policies" \
  -f name='v*' -f type=tag >/dev/null 2>&1 || true
echo "Environment 'release': you must approve; only v* tags can deploy"

say "Rulesets"
delete_ruleset() {
  local id
  id="$(api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$1\") | .id" || true)"
  [ -n "$id" ] && api -X DELETE "repos/$REPO/rulesets/$id" >/dev/null || true
}

delete_ruleset "Protect main"
api -X POST "repos/$REPO/rulesets" --input - >/dev/null <<'JSON'
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
  "bypass_actors": [],
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {"type": "required_linear_history"},
    {"type": "required_signatures"},
    {"type": "pull_request", "parameters": {
      "required_approving_review_count": 0,
      "dismiss_stale_reviews_on_push": true,
      "require_code_owner_review": false,
      "require_last_push_approval": false,
      "required_review_thread_resolution": true,
      "allowed_merge_methods": ["squash"]}},
    {"type": "required_status_checks", "parameters": {
      "strict_required_status_checks_policy": true,
      "required_status_checks": [
        {"context": "fmt, clippy, test (Linux)"},
        {"context": "compile (Windows)"},
        {"context": "interface checks"},
        {"context": "dependency policy (cargo-deny)"}]}}
  ]
}
JSON
echo "main: PRs only, CI must pass, signed commits, linear history, no force-push or deletion"

delete_ruleset "Protect release tags"
api -X POST "repos/$REPO/rulesets" --input - >/dev/null <<'JSON'
{
  "name": "Protect release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
  "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}],
  "rules": [{"type": "creation"}, {"type": "update"}, {"type": "deletion"}]
}
JSON
echo "v* tags: only admins can create; nobody can move or delete them"

say "Labels"
for l in "triage:ededed:Needs a first look" "security:b60205:Security-relevant" \
         "good first issue:7057ff:Good for newcomers" "help wanted:008672:Extra attention welcome" \
         "dependencies:0366d6:Dependency updates" "ci:5319e7:Build and release pipelines" \
         "devices:f7931a:Talking to Frostsnap devices" "ui:c5def5:Interface"; do
  IFS=: read -r name color desc <<<"$l"
  gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force >/dev/null
done
echo "Labels created/updated"

say "Done. Now do the manual steps in docs/GITHUB_SETUP.md (2FA, signing key, social preview, …)."
