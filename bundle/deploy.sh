#!/usr/bin/env bash
# One greenfield deployment path for every target.
#
# CLI 1.11 and 1.12 crash while planning source_code_path for an App that has
# no bound remote state. Create a no-compute shell through the Apps API, bind it
# to the bundle, deploy prerequisites, release the endpoint, then reconcile the
# complete bundle and release app code. Operators run this script; they do not
# hand-maintain a second App deployment path.
#
# Usage:
#   TARGET=<target> PROFILE=<profile> bundle/deploy.sh          # dry run
#   TARGET=<target> PROFILE=<profile> bundle/deploy.sh --apply

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

APPLY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

require_cmd databricks
require_cmd python3
require_target
resolve_profile
seed_bundle_cache

APP_NAME="$(bundle_var app_name)"
APP_DESCRIPTION="$(bundle_var app_description)"
PROFILE_ARGS=(--profile "$PROFILE")
BUNDLE_ARGS=(-t "$TARGET" "${PROFILE_ARGS[@]}")

PREREQUISITES=()
while IFS= read -r resource; do
  PREREQUISITES+=("$resource")
done < <(
  bundle_json | python3 -c '
import json, sys
resources = json.load(sys.stdin).get("resources") or {}
for group in sorted(resources):
    if group == "apps":
        continue
    for key in sorted(resources[group] or {}):
        print(f"{group}.{key}")
'
)
[[ "${#PREREQUISITES[@]}" -gt 0 ]] || die "target '$TARGET' resolved no pre-App resources"

SELECT_ARGS=()
for resource in "${PREREQUISITES[@]}"; do
  SELECT_ARGS+=(--select "$resource")
done

if [[ "$APPLY" != true ]]; then
  cat <<EOF

Dry run. Nothing was changed. Re-run with --apply to:
  1. create the no-compute App shell if '$APP_NAME' does not exist
  2. bind that shell to resources.apps.player_insights_app if needed
  3. deploy every non-App bundle resource
  4. run bundle/agent-release.sh --apply to create/update the endpoint
  5. deploy the complete bundle, including the bound App and all attachments
  6. run bundle/app-release.sh --apply for grants and source deployment

Target:  $TARGET
Profile: $PROFILE
EOF
  exit 0
fi

if databricks apps get "$APP_NAME" "${PROFILE_ARGS[@]}" >/dev/null 2>&1; then
  note "App shell '$APP_NAME' already exists."
else
  step "Creating no-compute App shell"
  databricks apps create "$APP_NAME" \
    --description "$APP_DESCRIPTION" \
    --no-compute \
    "${PROFILE_ARGS[@]}"
fi

BOUND_APP="$(
  databricks bundle summary "${BUNDLE_ARGS[@]}" -o json 2>/dev/null \
    | python3 -c '
import json, sys
try:
    app = json.load(sys.stdin).get("resources", {}).get("apps", {}).get("player_insights_app", {})
except Exception:
    app = {}
print(app.get("id") or app.get("name") or "")
' 2>/dev/null || true
)"
if [[ -z "$BOUND_APP" ]]; then
  step "Binding App shell to bundle state"
  databricks bundle deployment bind player_insights_app "$APP_NAME" \
    "${BUNDLE_ARGS[@]}" --auto-approve
else
  note "Bundle App is already bound as '$BOUND_APP'."
fi

step "Deploying bundle prerequisites"
databricks bundle deploy "${BUNDLE_ARGS[@]}" "${SELECT_ARGS[@]}"

step "Releasing agent model and endpoint"
TARGET="$TARGET" PROFILE="$PROFILE" "$BUNDLE_ROOT/bundle/agent-release.sh" --apply

step "Reconciling complete bundle"
databricks bundle deploy "${BUNDLE_ARGS[@]}"

step "Applying grants and releasing app source"
TARGET="$TARGET" PROFILE="$PROFILE" "$BUNDLE_ROOT/bundle/app-release.sh" --apply
