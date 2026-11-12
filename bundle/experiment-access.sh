#!/usr/bin/env bash
# Restrict the agent's MLflow experiment to the identities that need it.
#
# Traces hold each person's question, the SQL it ran and the figures it
# returned. A workspace-wide grant lets anyone in the workspace read another
# person's traces, which on a deployment shared by several labels is a
# cross-label read that Unity Catalog never sees. This script:
#
#   1. adds CAN_EDIT for the app service principal (feedback, probes, trace
#      reads) and the serving endpoint's creator (trace logging), and CAN_READ
#      for var.app_admin_group when one is set;
#   2. verifies those entries;
#   3. only then removes the direct `users` grant, keeping every other entry.
#
# Steps 1-2 are PATCHes. Step 3 rewrites the experiment's direct ACL without the
# `users` entry and is skipped when that entry is absent. Dev and Prod share one
# experiment, so each target's release adds its own app service principal and
# never removes the other's.
#
#   TARGET=<target> PROFILE=<profile> bundle/experiment-access.sh --apply

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

[[ "${1:-}" == "--apply" ]] || die "This command changes experiment permissions. Re-run with --apply."

require_cmd databricks
require_cmd python3
require_target
resolve_profile
seed_bundle_cache

EXPERIMENT="$(bundle_var experiment_path)"
APP_NAME="$(bundle_var app_name)"
ENDPOINT="$(bundle_var serving_endpoint_name)"
ADMIN_GROUP="$(bundle_var_or_empty app_admin_group)"
ADMIN_GROUP="${ADMIN_GROUP#"${ADMIN_GROUP%%[![:space:]]*}"}"
ADMIN_GROUP="${ADMIN_GROUP%"${ADMIN_GROUP##*[![:space:]]}"}"

json_field() {
  python3 -c '
import json, sys
value = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    value = value.get(key) if isinstance(value, dict) else None
print(str(value or "").strip())
' "$1"
}

EXPERIMENT_ID="$(databricks experiments get-by-name "$EXPERIMENT" --profile "$PROFILE" -o json | json_field experiment.experiment_id)" \
  || die "Could not read MLflow experiment '$EXPERIMENT'."
[[ -n "$EXPERIMENT_ID" ]] || die "MLflow experiment '$EXPERIMENT' was not found."

APP_SP="$(databricks apps get "$APP_NAME" --profile "$PROFILE" -o json | json_field service_principal_client_id)" \
  || die "Could not read App '$APP_NAME'."
[[ -n "$APP_SP" ]] || die "App '$APP_NAME' reported no service principal."

ENDPOINT_CREATOR=""
if ENDPOINT_JSON="$(databricks serving-endpoints get "$ENDPOINT" --profile "$PROFILE" -o json 2>/dev/null)"; then
  ENDPOINT_CREATOR="$(printf '%s' "$ENDPOINT_JSON" | json_field creator)"
fi

note "experiment     $EXPERIMENT ($EXPERIMENT_ID)"
note "app SP         $APP_SP"
note "endpoint owner ${ENDPOINT_CREATOR:-<unknown; not granted>}"
note "admin group    ${ADMIN_GROUP:-<none>}"

# Principals as kind=name pairs. A creator with an @ is a user; anything else
# is a service principal application id.
PRINCIPALS=("service_principal_name=$APP_SP:CAN_EDIT")
if [[ -n "$ENDPOINT_CREATOR" ]]; then
  if [[ "$ENDPOINT_CREATOR" == *@* ]]; then
    PRINCIPALS+=("user_name=$ENDPOINT_CREATOR:CAN_EDIT")
  else
    PRINCIPALS+=("service_principal_name=$ENDPOINT_CREATOR:CAN_EDIT")
  fi
fi
[[ -n "$ADMIN_GROUP" ]] && PRINCIPALS+=("group_name=$ADMIN_GROUP:CAN_READ")

BEFORE="$(databricks permissions get experiments "$EXPERIMENT_ID" --profile "$PROFILE" -o json)" \
  || die "Could not read the experiment ACL. The profile identity needs CAN_MANAGE on '$EXPERIMENT'."

plan_grants() {
  PERMISSIONS_JSON="$1" python3 - "${PRINCIPALS[@]}" <<'PY'
import json, os, sys

RANK = {"CAN_READ": 1, "CAN_EDIT": 2, "CAN_MANAGE": 3}
held = {}
for entry in json.loads(os.environ["PERMISSIONS_JSON"]).get("access_control_list") or []:
    for kind in ("user_name", "group_name", "service_principal_name"):
        name = str(entry.get(kind) or "").strip().lower()
        if not name:
            continue
        best = max(
            (RANK.get(str(p.get("permission_level") or ""), 0) for p in entry.get("all_permissions") or []),
            default=0,
        )
        held[(kind, name)] = max(held.get((kind, name), 0), best)

missing = []
for spec in sys.argv[1:]:
    principal, level = spec.rsplit(":", 1)
    kind, name = principal.split("=", 1)
    if held.get((kind, name.strip().lower()), 0) < RANK[level]:
        missing.append({kind: name, "permission_level": level})
print(json.dumps({"access_control_list": missing}) if missing else "")
PY
}

step "Granting the identities that use the experiment"
GRANTS="$(plan_grants "$BEFORE")" || die "Could not plan the experiment grants."
if [[ -n "$GRANTS" ]]; then
  databricks permissions update experiments "$EXPERIMENT_ID" --profile "$PROFILE" --json "$GRANTS" >/dev/null \
    || die "Could not grant experiment access. The profile identity needs CAN_MANAGE on '$EXPERIMENT'."
fi
AFTER="$(databricks permissions get experiments "$EXPERIMENT_ID" --profile "$PROFILE" -o json)" \
  || die "Could not read the experiment ACL back to verify the grants."
[[ -z "$(plan_grants "$AFTER")" ]] \
  || die "The experiment grants did not verify, so the workspace-wide grant was left in place."
note "verified app, endpoint owner and admin access"

step "Removing the workspace-wide 'users' grant"
REPLACEMENT="$(PERMISSIONS_JSON="$AFTER" python3 <<'PY'
import json, os

acl = json.loads(os.environ["PERMISSIONS_JSON"]).get("access_control_list") or []
if not any(str(e.get("group_name") or "") == "users" and any(
        not p.get("inherited") for p in e.get("all_permissions") or []) for e in acl):
    print("")
    raise SystemExit(0)
kept = []
for entry in acl:
    if str(entry.get("group_name") or "") == "users":
        continue
    principal = {k: entry[k] for k in ("user_name", "group_name", "service_principal_name") if entry.get(k)}
    for permission in entry.get("all_permissions") or []:
        if permission.get("inherited"):
            continue
        kept.append({**principal, "permission_level": permission["permission_level"]})
print(json.dumps({"access_control_list": kept}))
PY
)" || die "Could not plan the removal of the 'users' grant."
if [[ -z "$REPLACEMENT" ]]; then
  note "no direct 'users' grant; nothing to remove"
  exit 0
fi
databricks permissions set experiments "$EXPERIMENT_ID" --profile "$PROFILE" --json "$REPLACEMENT" >/dev/null \
  || die "Could not remove the 'users' grant from '$EXPERIMENT'."
FINAL="$(databricks permissions get experiments "$EXPERIMENT_ID" --profile "$PROFILE" -o json)" \
  || die "Could not read the experiment ACL back after removing 'users'."
[[ -z "$(plan_grants "$FINAL")" ]] \
  || die "Removing 'users' also removed a required grant. Re-run this script to restore it."
note "removed the workspace-wide grant; every other entry kept"
