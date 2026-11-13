#!/usr/bin/env bash
# One-time upgrade for an installation that took the November 2026 security
# release through Deploy from Git. Runs the steps a Git deploy cannot: the model
# release and the access settings the app release normally applies. No bundle
# deploy, and the app itself is not redeployed.
#
# Usage:
#   TARGET=<target> PROFILE=<profile> bundle/upgrade-after-git-deploy.sh               # preview
#   TARGET=<target> PROFILE=<profile> bundle/upgrade-after-git-deploy.sh --apply
#   ... --apply --skip-model    # access settings only; release the model separately
#
# Every step is safe to repeat. See UPGRADE.md.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

APPLY=false; SKIP_MODEL=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true ;;
    --skip-model) SKIP_MODEL=true ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

require_cmd databricks
require_cmd python3
require_target
resolve_profile
seed_bundle_cache

HERE="$BUNDLE_ROOT/bundle"
APP_NAME="$(bundle_var app_name)"
SERVING_ENDPOINT="$(bundle_var serving_endpoint_name)"
CROSS_LABEL_KEYS="$(bundle_var_or_empty cross_label_key_columns)"
IDENTITY_COLUMNS="$(bundle_var_or_empty identity_columns)"

step "Upgrade plan (target: $TARGET, profile: $PROFILE)"
note "app       $APP_NAME"
note "endpoint  $SERVING_ENDPOINT"
if $SKIP_MODEL; then
  note "1. model release            skipped (--skip-model)"
else
  note "1. model release            bundle/agent-release.sh --apply"
fi
note "2. app self-grant           bundle/app-acl-self-grant.sh"
note "3. app access for groups    bundle/app-user-access.sh --apply"
note "4. warehouse and Genie      bundle/gate3-access.sh --apply"
note "5. experiment access        bundle/experiment-access.sh --apply"
note "6. endpoint policy          bundle/ai_gateway_policy.py --apply (request log off)"
note "7. report                   bundle/security-posture.sh (read-only)"

if ! $SKIP_MODEL; then
  step "Protected column settings baked into the model"
  note "cross_label_key_columns  ${CROSS_LABEL_KEYS:-(not set)}"
  note "identity_columns         ${IDENTITY_COLUMNS:-(not set)}"
  if [[ -z "$CROSS_LABEL_KEYS" ]]; then
    note "WARNING: cross_label_key_columns is not set. The public repository uses a neutral"
    note "name for the key that links one player across labels, so the model will not refuse"
    note "your real key column. Set it in .databricks/bundle/$TARGET/variable-overrides.json"
    note "before applying. See UPGRADE.md."
  fi
fi

if ! $APPLY; then
  step "Preview only. Re-run with --apply to make these changes."
  exit 0
fi

FAILED=()
attempt() {
  local name="$1"; shift
  step "$name"
  if ! "$@"; then
    note "WARNING: $name did not complete. Fix the error above and re-run this script."
    FAILED+=("$name")
  fi
}

if ! $SKIP_MODEL; then
  step "Model release"
  TARGET="$TARGET" PROFILE="$PROFILE" bash "$HERE/agent-release.sh" --apply \
    || die "The model release failed. Nothing else was changed. Fix the error above and re-run."
fi

attempt "App self-grant" env TARGET="$TARGET" PROFILE="$PROFILE" bash "$HERE/app-acl-self-grant.sh"
attempt "App access for groups" env TARGET="$TARGET" PROFILE="$PROFILE" bash "$HERE/app-user-access.sh" --apply
attempt "Warehouse and Genie access" env TARGET="$TARGET" PROFILE="$PROFILE" bash "$HERE/gate3-access.sh" --apply
attempt "Experiment access" env TARGET="$TARGET" PROFILE="$PROFILE" bash "$HERE/experiment-access.sh" --apply
attempt "Endpoint policy" python3 "$HERE/ai_gateway_policy.py" --endpoint "$SERVING_ENDPOINT" --profile "$PROFILE" --apply

step "Security posture report (read-only)"
TARGET="$TARGET" PROFILE="$PROFILE" bash "$HERE/security-posture.sh" \
  || note "The report lists findings above. They describe this workspace's setup; review them with your admins."

if (( ${#FAILED[@]} )); then
  step "Upgrade finished with ${#FAILED[@]} step(s) to repeat"
  for name in "${FAILED[@]}"; do note "- $name"; done
  exit 1
fi
step "Upgrade complete"
