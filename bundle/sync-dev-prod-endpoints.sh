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
[[ "$DEV_MODEL" == "$PROD_MODEL" ]] || {
  printf 'ERROR: Dev model %s and Prod model %s differ; one-model promotion is impossible.\n' \
    "$DEV_MODEL" "$PROD_MODEL" >&2
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

# Prod first: if its safety gates fail, Dev remains on the previously approved
# version rather than advancing and leaving a two-version gap.
TARGET=prod PROFILE="$PROD_PROFILE" \
  PLAYER_INSIGHTS_RELEASE_RESULT_JSON= \
  bash "$AGENT_RELEASE" --apply --skip-log --model-version "$PROD_VERSION"

if [[ "$SKIP_DEV" != true ]]; then
  TARGET=dev PROFILE="$DEV_PROFILE" \
    PLAYER_INSIGHTS_RELEASE_RESULT_JSON= \
    bash "$AGENT_RELEASE" --apply --skip-log --model-version "$DEV_VERSION"
fi

printf '\nEndpoint reconciliation complete: Dev=%s, Prod=%s.\n' \
  "$DEV_VERSION" "$PROD_VERSION"
