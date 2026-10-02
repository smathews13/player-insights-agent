#!/usr/bin/env bash
# Reconcile one registered model onto Dev=N and Prod=N-1 endpoints.
#
# A model endpoint does not follow a UC alias. Run this after a successful log;
# pass the version that was just registered so a concurrent log cannot move the
# target underneath this release.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
AGENT_RELEASE="${PIA_AGENT_RELEASE_SCRIPT:-$HERE/agent-release.sh}"
APPLY=false
SKIP_DEV=false
LATEST_VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true ;;
    --skip-dev) SKIP_DEV=true ;;
    --latest-version) LATEST_VERSION="${2:-}"; shift ;;
    *) printf 'ERROR: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

PROFILE="${PROFILE:-}"
DEV_PROFILE="${PLAYER_INSIGHTS_DEV_PROFILE:-$PROFILE}"
PROD_PROFILE="${PLAYER_INSIGHTS_PROD_PROFILE:-$PROFILE}"
[[ -n "$DEV_PROFILE" ]] || {
  printf 'ERROR: PROFILE or PLAYER_INSIGHTS_DEV_PROFILE is required.\n' >&2
  exit 2
}
[[ -n "$PROD_PROFILE" ]] || {
  printf 'ERROR: PROFILE or PLAYER_INSIGHTS_PROD_PROFILE is required.\n' >&2
  exit 2
}
[[ "$DEV_PROFILE" == "$PROD_PROFILE" ]] || {
  printf 'ERROR: Dev and Prod must use the same workspace profile when sharing one model, experiment, and data plane.\n' >&2
  exit 2
}

bundle_var_for() {
  local target="$1" profile="$2" name="$3"
  TARGET="$target" PROFILE="$profile" bash -c '
    source "$1"
    require_target
    resolve_profile
    load_bundle_json
    bundle_var "$2"
  ' _ "$HERE/_lib.sh" "$name"
}

DEV_MODEL="$(bundle_var_for dev "$DEV_PROFILE" model_name)"
PROD_MODEL="$(bundle_var_for prod "$PROD_PROFILE" model_name)"
DEV_ENDPOINT="$(bundle_var_for dev "$DEV_PROFILE" serving_endpoint_name)"
PROD_ENDPOINT="$(bundle_var_for prod "$PROD_PROFILE" serving_endpoint_name)"
DEV_EXPERIMENT="$(bundle_var_for dev "$DEV_PROFILE" experiment_path)"
PROD_EXPERIMENT="$(bundle_var_for prod "$PROD_PROFILE" experiment_path)"
DEV_SCALE_TO_ZERO="$(bundle_var_for dev "$DEV_PROFILE" serving_scale_to_zero)"
PROD_SCALE_TO_ZERO="$(bundle_var_for prod "$PROD_PROFILE" serving_scale_to_zero)"
[[ "$DEV_MODEL" == "$PROD_MODEL" ]] || {
  printf 'ERROR: Dev model %s and Prod model %s differ; one-model promotion is impossible.\n' \
    "$DEV_MODEL" "$PROD_MODEL" >&2
  exit 2
}
[[ "$DEV_EXPERIMENT" == "$PROD_EXPERIMENT" ]] || {
  printf 'ERROR: Dev experiment %s and Prod experiment %s differ; shared traces would split.\n' \
    "$DEV_EXPERIMENT" "$PROD_EXPERIMENT" >&2
  exit 2
}

experiment_id() {
  local path="$1" profile="$2"
  databricks experiments get-by-name "$path" --profile "$profile" -o json | python3 -c '
import json,sys
body=json.load(sys.stdin)
print((body.get("experiment") or body).get("experiment_id") or "")
'
}

DEV_EXPERIMENT_ID="$(experiment_id "$DEV_EXPERIMENT" "$DEV_PROFILE")"
PROD_EXPERIMENT_ID="$(experiment_id "$PROD_EXPERIMENT" "$PROD_PROFILE")"
[[ -n "$DEV_EXPERIMENT_ID" && -n "$PROD_EXPERIMENT_ID" ]] || {
  printf 'ERROR: the shared MLflow experiment could not be resolved in both targets.\n' >&2
  exit 2
}
[[ "$DEV_EXPERIMENT_ID" == "$PROD_EXPERIMENT_ID" ]] || {
  printf 'ERROR: Dev experiment id %s and Prod experiment id %s differ.\n' \
    "$DEV_EXPERIMENT_ID" "$PROD_EXPERIMENT_ID" >&2
  exit 2
}

VERSIONS="$(mktemp "${TMPDIR:-/tmp}/pia-model-versions.XXXXXX")"
trap 'rm -f "$VERSIONS"' EXIT
databricks model-versions list "$DEV_MODEL" --profile "$DEV_PROFILE" -o json > "$VERSIONS"

SELECT_ARGS=(--input "$VERSIONS")
[[ -z "$LATEST_VERSION" ]] || SELECT_ARGS+=(--latest-version "$LATEST_VERSION")
SELECTED="$(python3 "$HERE/select-dev-prod-model-versions.py" "${SELECT_ARGS[@]}")"
DEV_VERSION="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["dev"])' <<<"$SELECTED")"
PROD_VERSION="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["prod"])' <<<"$SELECTED")"

printf 'Registered model: %s\n' "$DEV_MODEL"
printf '  Dev  endpoint -> version %s\n' "$DEV_VERSION"
printf '  Prod endpoint -> version %s\n' "$PROD_VERSION"

if [[ "$APPLY" != true ]]; then
  printf '\nDry run. Re-run with --apply to reconcile endpoint traffic.\n'
  exit 0
fi

endpoint_matches() {
  local endpoint="$1" profile="$2" model="$3" version="$4" experiment_id="$5" experiment_path="$6" scale_to_zero="$7" document
  document="$(mktemp "${TMPDIR:-/tmp}/pia-endpoint-state.XXXXXX")"
  if ! databricks serving-endpoints get "$endpoint" --profile "$profile" -o json \
      >"$document" 2>/dev/null; then
    rm -f "$document"
    return 1
  fi
  local status=0
  python3 - "$document" "$model" "$version" "$experiment_id" "$experiment_path" "$scale_to_zero" <<'PY' || status=$?
import json
import sys

body = json.load(open(sys.argv[1], encoding="utf-8"))
model = sys.argv[2]
want = sys.argv[3]
experiment_id = sys.argv[4]
experiment_path = sys.argv[5]
scale_to_zero = sys.argv[6].strip().lower() in {"true", "1", "yes", "on"}
config = body.get("config") or {}
update = ((body.get("state") or {}).get("config_update") or "NONE").upper()
routes = ((config.get("traffic_config") or {}).get("routes") or [])
entities = config.get("served_entities") or config.get("served_models") or []
matching = [
    entity
    for entity in entities
    if str(entity.get("entity_name") or entity.get("model_name") or "") == model
    if str(entity.get("entity_version") or entity.get("model_version") or "") == want
]
matching_names = {
    str(entity.get("name") or entity.get("served_entity_name") or "")
    for entity in matching
}
traffic = {
    str(route.get("served_entity_name") or route.get("served_model_name") or ""):
    int(route.get("traffic_percentage") or 0)
    for route in routes
}
matching_traffic = sum(traffic.get(name, 0) for name in matching_names)
other_traffic = sum(share for name, share in traffic.items() if name not in matching_names)
environment_matches = any(
    str((entity.get("environment_vars") or {}).get("MLFLOW_EXPERIMENT_ID") or "")
    == experiment_id
    and str((entity.get("environment_vars") or {}).get("MLFLOW_EXPERIMENT_NAME") or "")
    == experiment_path
    and str((entity.get("environment_vars") or {}).get("MLFLOW_TRACKING_URI") or "")
    == "databricks"
    and str((entity.get("environment_vars") or {}).get("MLFLOW_TRACE_SAMPLING_RATIO") or "")
    == "1.0"
    for entity in matching
)
scale_matches = any(
    bool(entity.get("scale_to_zero_enabled")) == scale_to_zero
    for entity in matching
)
raise SystemExit(
    0
    if update in {"NONE", "NOT_UPDATING"}
    and matching_traffic == 100
    and other_traffic == 0
    and environment_matches
    and scale_matches
    else 1
)
PY
  rm -f "$document"
  return "$status"
}

# Prod first: if its safety gates fail, Dev remains on the previously approved
# version rather than advancing and leaving a two-version gap.
if endpoint_matches "$PROD_ENDPOINT" "$PROD_PROFILE" "$PROD_MODEL" "$PROD_VERSION" \
    "$PROD_EXPERIMENT_ID" "$PROD_EXPERIMENT" "$PROD_SCALE_TO_ZERO"; then
  printf 'Prod endpoint already serves version %s; no update needed.\n' "$PROD_VERSION"
else
  TARGET=prod PROFILE="$PROD_PROFILE" \
    PLAYER_INSIGHTS_RELEASE_RESULT_JSON= \
    bash "$AGENT_RELEASE" --apply --skip-log --model-version "$PROD_VERSION"
fi

if [[ "$SKIP_DEV" != true ]]; then
  if endpoint_matches "$DEV_ENDPOINT" "$DEV_PROFILE" "$DEV_MODEL" "$DEV_VERSION" \
      "$DEV_EXPERIMENT_ID" "$DEV_EXPERIMENT" "$DEV_SCALE_TO_ZERO"; then
    printf 'Dev endpoint already serves version %s; no update needed.\n' "$DEV_VERSION"
  else
    TARGET=dev PROFILE="$DEV_PROFILE" \
      PLAYER_INSIGHTS_RELEASE_RESULT_JSON= \
      bash "$AGENT_RELEASE" --apply --skip-log --model-version "$DEV_VERSION"
  fi
fi

printf '\nEndpoint reconciliation complete: Dev=%s, Prod=%s.\n' \
  "$DEV_VERSION" "$PROD_VERSION"
