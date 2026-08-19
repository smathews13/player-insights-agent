#!/usr/bin/env bash
# Apply staged Connections / notebook hard knobs via a model re-log.
#
# Genie, warehouse, catalog and related values bake into AuthPolicy at log time.
# Connections stages "intended" settings; a notebook publishes a declaration.
# Neither is live until a new model version. This script is the shared entrypoint
# for that Apply path: resolve overrides, export the env vars agent-release
# already understands, then call the existing release.
#
# It does NOT silently re-log. Dry-run is the default. --apply requires
# --i-am-deploying.
#
# Usage:
#   TARGET=<target> bundle/apply-declaration.sh --plan --i-am-deploying \
#     [--declaration-json path] [--intended-json path] [--from-app]
#   TARGET=<target> bundle/apply-declaration.sh --apply --i-am-deploying ...
#
# Prefer --from-app when the app is reachable: it reads /api/settings the same
# way agent-release's correlation gate does, so intended values and the plan
# stay one document. Notebook JSON is optional and loses to Lakebase intended.
#
# Out of scope for v1: soft prompt overrides, changing the LLM AuthPolicy
# resource set beyond what log_model already declares, running a release from
# inside the app container.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

PLAN_ONLY=true
I_AM_DEPLOYING=false
FROM_APP=false
DECLARATION_JSON=""
INTENDED_JSON=""
ALLOW_WIDENING=false
RESULT_JSON=""
EXTRA_RELEASE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan) PLAN_ONLY=true ;;
    --apply) PLAN_ONLY=false ;;
    --i-am-deploying) I_AM_DEPLOYING=true ;;
    --from-app) FROM_APP=true ;;
    --declaration-json) DECLARATION_JSON="$2"; shift ;;
    --intended-json) INTENDED_JSON="$2"; shift ;;
    --allow-widening) ALLOW_WIDENING=true ;;
    --result-json) RESULT_JSON="$2"; shift ;;
    --ignore-app-intentions|--no-prune|--skip-log)
      EXTRA_RELEASE_ARGS+=("$1")
      ;;
    --model-version)
      EXTRA_RELEASE_ARGS+=("$1" "$2")
      shift
      ;;
    *) die "unknown argument: $1

Usage:
  TARGET=<target> bundle/apply-declaration.sh --plan --i-am-deploying
  TARGET=<target> bundle/apply-declaration.sh --apply --i-am-deploying [--from-app]
" ;;
  esac
  shift
done

if [[ "$I_AM_DEPLOYING" != true ]]; then
  die "Pass --i-am-deploying to confirm you intend to drive a model re-log from staged settings."
fi

require_cmd uv
require_cmd python3
require_target
resolve_profile
seed_bundle_cache

REPO_ROOT="$BUNDLE_ROOT"
RESOLVER=(uv run --project "$REPO_ROOT/agent" python "$REPO_ROOT/agent/apply_from_declaration.py" --i-am-deploying)

TMPDIR_APPLY="$(mktemp -d "${TMPDIR:-/tmp}/apply-declaration.XXXXXX")"
on_exit "rm -rf '$TMPDIR_APPLY'"

# --- Optional: pull intended settings from the running app -------------------
if [[ "$FROM_APP" == true ]]; then
  app_name="$(bundle_var app_name 2>/dev/null)" || app_name=""
  [[ -n "$app_name" ]] || die "--from-app needs var.app_name on this target."

  app_url="$(databricks apps get "$app_name" --profile "$PROFILE" -o json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("url") or "")' 2>/dev/null || true)"
  [[ -n "$app_url" ]] || die "App '$app_name' is not serving yet; cannot read /api/settings."

  token="$(databricks auth token --profile "$PROFILE" 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null || true)"
  [[ -n "$token" ]] || die "Could not mint an auth token for profile '$PROFILE'."

  INTENDED_JSON="$TMPDIR_APPLY/settings.json"
  http_status=""
  body="$(curl -sS --max-time 20 -w '\n%{http_code}' \
    -H "Authorization: Bearer $token" "$app_url/api/settings" 2>/dev/null || true)"
  http_status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [[ "$http_status" != "200" || -z "$body" ]]; then
    die "GET $app_url/api/settings returned HTTP ${http_status:-none}. Run as yourself (Apps identity header), not a service principal."
  fi
  printf '%s' "$body" > "$INTENDED_JSON"
  note "intended settings     read from $app_url/api/settings"
fi

RESOLVE_ARGS=()
[[ -n "$DECLARATION_JSON" ]] && RESOLVE_ARGS+=(--declaration-json "$DECLARATION_JSON")
[[ -n "$INTENDED_JSON" ]] && RESOLVE_ARGS+=(--intended-json "$INTENDED_JSON")

step "Resolve Apply plan"
"${RESOLVER[@]}" "${RESOLVE_ARGS[@]}" || die "Resolver failed."

PLAN_JSON="$TMPDIR_APPLY/plan.json"
"${RESOLVER[@]}" "${RESOLVE_ARGS[@]}" --json > "$PLAN_JSON"

EXPORTS="$TMPDIR_APPLY/exports.env"
"${RESOLVER[@]}" "${RESOLVE_ARGS[@]}" --print-env > "$EXPORTS"

if [[ ! -s "$EXPORTS" ]]; then
  note "No staged overrides. agent-release would use the bundle target alone."
else
  note "Overrides that would be exported:"
  while IFS= read -r line; do
    note "  $line"
  done < "$EXPORTS"
fi

if [[ "$PLAN_ONLY" == true ]]; then
  note ""
  note "Dry run only. To create a new model version:"
  note "  TARGET=$TARGET bundle/apply-declaration.sh --apply --i-am-deploying${FROM_APP:+ --from-app}${DECLARATION_JSON:+ --declaration-json $DECLARATION_JSON}"
  exit 0
fi

# Export overrides into this shell, then hand off to the existing release.
# shellcheck disable=SC1090
set -a
# shellcheck disable=SC1091
source "$EXPORTS"
set +a

RELEASE_ARGS=(--apply)
[[ "$ALLOW_WIDENING" == true ]] && RELEASE_ARGS+=(--allow-widening)
RELEASE_ARGS+=("${EXTRA_RELEASE_ARGS[@]+"${EXTRA_RELEASE_ARGS[@]}"}")

step "Hand off to bundle/agent-release.sh ${RELEASE_ARGS[*]}"
[[ -n "$RESULT_JSON" ]] && export PLAYER_INSIGHTS_RELEASE_RESULT_JSON="$RESULT_JSON"
exec "$REPO_ROOT/bundle/agent-release.sh" "${RELEASE_ARGS[@]}"
