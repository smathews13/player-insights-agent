#!/usr/bin/env bash
# Safely reconcile the complete bundle, including the Databricks App.
#
# This wrapper intentionally does not run `bundle plan`: affected CLI versions
# have crashed in the direct App planner, and `bundle deploy` already prints the
# proposed changes and asks for confirmation. It never auto-approves them.
#
# Usage:
#   TARGET=<target> PROFILE=<profile> bash bundle/deploy.sh
#   PIA_CONFIRMED_NO_LIVE_DEPLOY=true TARGET=<target> PROFILE=<profile> \
#     bash bundle/deploy.sh --force-lock

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

FORCE_LOCK=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto-approve)
      die "--auto-approve is forbidden. Read and confirm the deploy's own change list;
an older bundle state destroyed an attached Lakebase project when approval was skipped."
      ;;
    --force-lock)
      FORCE_LOCK=true
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
  shift
done

require_cmd databricks
require_cmd python3
require_cmd uv
require_target

STATE_FILE="$BUNDLE_ROOT/.databricks/bundle/$TARGET/resources.json"
if [[ -f "$STATE_FILE" ]]; then
  STALE_LAKEBASE="$(
    python3 - "$STATE_FILE" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as handle:
        document = json.load(handle)
except Exception as error:
    print(f"UNREADABLE:{error}")
    raise SystemExit(0)

text = json.dumps(document, sort_keys=True)
tracked = [
    kind
    for kind in ("postgres_projects", "postgres_branches", "postgres_databases")
    if f'"{kind}"' in text
]
print(",".join(tracked))
PY
  )"
  if [[ "$STALE_LAKEBASE" == UNREADABLE:* ]]; then
    die "$STATE_FILE cannot be read as JSON (${STALE_LAKEBASE#UNREADABLE:}).
Refusing to deploy while the local resource state is unknown."
  fi
  if [[ -n "$STALE_LAKEBASE" ]]; then
    die "$STATE_FILE still tracks Lakebase resource types the current bundle only attaches:
  $STALE_LAKEBASE

Do not deploy and do not delete the whole state file. Migrate those old
postgres_* resources out of bundle state with the checkout that declared them;
unbinding changes state without deleting the live Lakebase objects."
  fi
fi

if [[ "$FORCE_LOCK" == true && "${PIA_CONFIRMED_NO_LIVE_DEPLOY:-}" != true ]]; then
  die "--force-lock is only for a stale lock after confirming no deploy is live.
Confirm that first, then set PIA_CONFIRMED_NO_LIVE_DEPLOY=true and retry."
fi

resolve_profile
seed_bundle_cache

VECTOR_ENDPOINT="$(bundle_var_or_empty semantic_index_endpoint)"

ARGS=(bundle deploy -t "$TARGET" --profile "$PROFILE")
[[ "$FORCE_LOCK" == true ]] && ARGS+=(--force-lock)

step "Deploying the complete bundle (target: $TARGET, profile: $PROFILE)"
note "Review the CLI change list. This wrapper never passes --auto-approve."
note "The App is bundle-owned; do not create it by hand or exclude it with --select."
(cd "$BUNDLE_ROOT" && databricks "${ARGS[@]}")

if [[ -n "$VECTOR_ENDPOINT" ]]; then
  step "Applying the legacy compatibility resource tag"
  (cd "$BUNDLE_ROOT/agent" \
    && DATABRICKS_CONFIG_PROFILE="$PROFILE" \
       uv run --python 3.13 python ../bundle/tag-resources.py --vector-endpoint "$VECTOR_ENDPOINT")
  note "AI Search indexes expose no custom-tag field or patch API. Their billed"
  note "compute is attributed through the tagged endpoint '$VECTOR_ENDPOINT'."
fi
note "The SQL warehouse, Genie spaces, foundation-model endpoint, and Lakebase"
note "project are attached resources, not artifacts this bundle owns; deploy does"
note "not mutate their tags."
