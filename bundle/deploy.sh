#!/usr/bin/env bash
# Safely reconcile the complete bundle, including the Databricks App.
#
# This wrapper intentionally does not run `bundle plan`: affected CLI versions
# have crashed in the direct App planner, and `bundle deploy` already prints the
# proposed changes and asks for confirmation. It never auto-approves them.
#
# Usage:
#   TARGET=<target> PROFILE=<profile> bash bundle/deploy.sh
#   PLAYER_INSIGHTS_AGENT_CONFIRMED_NO_LIVE_DEPLOY=true \
#     TARGET=<target> PROFILE=<profile> \
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
require_cmd node
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

if [[ "$FORCE_LOCK" == true && "${PLAYER_INSIGHTS_AGENT_CONFIRMED_NO_LIVE_DEPLOY:-}" != true ]]; then
  die "--force-lock is only for a stale lock after confirming no deploy is live.
Confirm that first, then set PLAYER_INSIGHTS_AGENT_CONFIRMED_NO_LIVE_DEPLOY=true and retry."
fi

resolve_profile
seed_bundle_cache

# AppKit hardcodes its cache schema as `appkit`, so Dev and Prod require separate
# databases even though they share one Lakebase project and branch. Create each
# missing database idempotently from the private owner-role input.
if [[ "$TARGET" == "dev" || "$TARGET" == "prod" ]]; then
  TARGET="$TARGET" PROFILE="$PROFILE" PIA_BUNDLE_JSON_CACHE="$PIA_BUNDLE_JSON_CACHE" \
    bash "$BUNDLE_ROOT/bundle/ensure-lakebase-database.sh"
fi

# Dev is the single bundle-state owner of the existing shared model schema and
# MLflow experiment. Adopt both during the normal deploy instead of trying to
# create replacements with names that already exist. Bind remains interactive:
# its diff is part of the deploy review, not an auto-approved bootstrap shortcut.
if [[ "$TARGET" == "dev" ]]; then
  APP_CATALOG="$(bundle_var app_catalog)"
  APP_SCHEMA="$(bundle_var app_schema)"
  SCHEMA_FULL_NAME="${APP_CATALOG}.${APP_SCHEMA}"
  databricks schemas get "$SCHEMA_FULL_NAME" --profile "$PROFILE" -o json >/dev/null \
    || die "Existing model schema '$SCHEMA_FULL_NAME' was not found."
  BOUND_SCHEMA="$(
    databricks bundle summary -t dev --profile "$PROFILE" -o json 2>/dev/null \
      | python3 -c '
import json,sys
try: body=json.load(sys.stdin)
except Exception: print(""); raise SystemExit(0)
print((((body.get("resources") or {}).get("schemas") or {})
       .get("player_insights_schema") or {}).get("id") or "")
' || true
  )"
  if [[ "$BOUND_SCHEMA" != "$SCHEMA_FULL_NAME" ]]; then
    step "Adopting the existing registered-model schema"
    databricks bundle deployment bind player_insights_schema "$SCHEMA_FULL_NAME" \
      -t dev --profile "$PROFILE"
  fi

  EXPERIMENT_PATH="$(bundle_var experiment_path)"
  EXPERIMENT_ID="$(databricks experiments get-by-name "$EXPERIMENT_PATH" \
    --profile "$PROFILE" -o json | python3 -c '
import json,sys
body=json.load(sys.stdin)
print((body.get("experiment") or body).get("experiment_id") or "")
')"
  [[ -n "$EXPERIMENT_ID" ]] || die "Existing MLflow experiment '$EXPERIMENT_PATH' was not found."
  BOUND_EXPERIMENT="$(
    databricks bundle summary -t dev --profile "$PROFILE" -o json 2>/dev/null \
      | python3 -c '
import json,sys
try: body=json.load(sys.stdin)
except Exception: print(""); raise SystemExit(0)
print((((body.get("resources") or {}).get("experiments") or {})
       .get("player_insights_experiment") or {}).get("id") or "")
' || true
  )"
  if [[ "$BOUND_EXPERIMENT" != "$EXPERIMENT_ID" ]]; then
    step "Adopting the existing shared MLflow experiment"
    databricks bundle deployment bind player_insights_experiment "$EXPERIMENT_ID" \
      -t dev --profile "$PROFILE"
  fi
fi

# Apps bind endpoint names, not model versions. Reconcile the shared registered
# model automatically before creating either App: Dev=N, Prod=N-1. Existing
# endpoints already on those versions are left untouched.
if [[ "$TARGET" == "dev" || "$TARGET" == "prod" ]]; then
  step "Reconciling Dev and Prod model endpoints"
  PROFILE="$PROFILE" bash "$BUNDLE_ROOT/bundle/sync-dev-prod-endpoints.sh" --apply
fi

# The App resource binds the private Genie MCP signing key on its first bundle
# creation, so the key must exist before `bundle deploy` tries to create the App.
# Agent release calls the same helper again and receives the public half; the
# helper is idempotent and never exports the private value.
SIGNING_KEY_HELPER="$BUNDLE_ROOT/bundle/genie-mcp-signing-key.sh"
[[ -f "$SIGNING_KEY_HELPER" ]] || die "$SIGNING_KEY_HELPER is missing. Refusing to create an App whose
declared secret binding cannot be satisfied."
step "Ensuring the app-to-model signing key exists"
TARGET="$TARGET" PROFILE="$PROFILE" PIA_BUNDLE_JSON_CACHE="$PIA_BUNDLE_JSON_CACHE" \
  bash "$SIGNING_KEY_HELPER" >/dev/null

VECTOR_ENDPOINT="$(bundle_var_or_empty semantic_index_endpoint)"

ARGS=(bundle deploy -t "$TARGET" --profile "$PROFILE")
[[ "$FORCE_LOCK" == true ]] && ARGS+=(--force-lock)

step "Deploying the complete bundle (target: $TARGET, profile: $PROFILE)"
note "Review the CLI change list. This wrapper never passes --auto-approve."
note "The App is bundle-owned; do not create it by hand or exclude it with --select."
(cd "$BUNDLE_ROOT" && databricks "${ARGS[@]}")

if [[ -n "$VECTOR_ENDPOINT" ]]; then
  step "Applying the Player Insights Agent resource tag"
  (cd "$BUNDLE_ROOT/agent" \
    && DATABRICKS_CONFIG_PROFILE="$PROFILE" \
       uv run --python 3.13 python ../bundle/tag-resources.py --vector-endpoint "$VECTOR_ENDPOINT")
  note "AI Search indexes expose no custom-tag field or patch API. Their billed"
  note "compute is attributed through the tagged endpoint '$VECTOR_ENDPOINT'."
fi
note "The SQL warehouse, Genie spaces, foundation-model endpoint, and Lakebase"
note "project are attached resources, not artifacts this bundle owns; deploy does"
note "not mutate their tags."
