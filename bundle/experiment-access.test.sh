#!/usr/bin/env bash
# Offline proof that the experiment ACL keeps the app, the endpoint's creator and
# the admin group, removes only the workspace-wide `users` grant, and leaves
# `users` in place when the grants it depends on do not verify.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-experiment-access-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

PASS=0
FAIL=0

ok() { printf '  ok    %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }

ADMIN=Example_PIA_Admin
APP_SP=7f3c1a20-2222-3333-4444-555555555555

mkdir -p "$WORK/bin"
cat > "$WORK/bin/databricks" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
case "$1 $2" in
  "bundle validate") cat "$BUNDLE_FIXTURE" ;;
  "experiments get-by-name") printf '%s\n' '{"experiment":{"experiment_id":"exp-1"}}' ;;
  "apps get") printf '{"service_principal_client_id":"%s"}\n' "$APP_SP" ;;
  "serving-endpoints get") printf '{"id":"endpoint-id","creator":"%s"}\n' "${FAKE_ENDPOINT_CREATOR:-}" ;;
  "permissions get") cat "$ACL_STATE" ;;
  "permissions update")
    [[ "${UPDATE_IGNORED:-}" == "1" ]] && { printf '{}\n'; exit 0; }
    json="${@: -1}"
    ACL_JSON="$json" python3 - "$ACL_STATE" <<'PY'
import json, os, sys
state = json.load(open(sys.argv[1]))
for entry in json.loads(os.environ["ACL_JSON"])["access_control_list"]:
    level = entry.pop("permission_level")
    state["access_control_list"].append({**entry, "all_permissions": [{"permission_level": level, "inherited": False}]})
json.dump(state, open(sys.argv[1], "w"))
PY
    printf '{}\n'
    ;;
  "permissions set")
    json="${@: -1}"
    ACL_JSON="$json" python3 - "$ACL_STATE" <<'PY'
import json, os, sys
state = json.load(open(sys.argv[1]))
inherited = [
    {**e, "all_permissions": [p for p in e.get("all_permissions", []) if p.get("inherited")]}
    for e in state["access_control_list"]
]
inherited = [e for e in inherited if e["all_permissions"]]
direct = []
for entry in json.loads(os.environ["ACL_JSON"])["access_control_list"]:
    level = entry.pop("permission_level")
    direct.append({**entry, "all_permissions": [{"permission_level": level, "inherited": False}]})
json.dump({"access_control_list": direct + inherited}, open(sys.argv[1], "w"))
PY
    printf '{}\n'
    ;;
  *) printf 'unexpected databricks call: %s\n' "$*" >&2; exit 2 ;;
esac
SH
chmod +x "$WORK/bin/databricks"

bundle_fixture() {
  {
    printf '{"variables":{"experiment_path":{"value":"/Shared/pia"},"app_name":{"value":"test-app"},'
    printf '"serving_endpoint_name":{"value":"test-endpoint"},"app_admin_group":{"value":"%s"}}}' "$1"
  } > "$WORK/bundle.json"
}

entry() {
  printf '{"%s":"%s","all_permissions":[{"permission_level":"%s","inherited":%s}]}' "$1" "$2" "$3" "${4:-false}"
}

acl() {
  local IFS=,
  printf '{"access_control_list":[%s]}' "$*" > "$WORK/acl.json"
}

run_access() {
  : > "$WORK/calls"
  env -u PIA_BUNDLE_JSON_CACHE PATH="$WORK/bin:$PATH" CALLS="$WORK/calls" ACL_STATE="$WORK/acl.json" \
    BUNDLE_FIXTURE="$WORK/bundle.json" APP_SP="$APP_SP" FAKE_ENDPOINT_CREATOR="${FAKE_ENDPOINT_CREATOR:-}" TARGET=test PROFILE=test-profile \
    bash "$HERE/experiment-access.sh" --apply > "$WORK/output" 2>&1
}

holds() {
  python3 - "$WORK/acl.json" "$1" "$2" "$3" <<'PY'
import json, sys
path, kind, name, level = sys.argv[1:]
for e in json.load(open(path))["access_control_list"]:
    if e.get(kind) == name and any(p["permission_level"] == level for p in e["all_permissions"]):
        raise SystemExit(0)
raise SystemExit(1)
PY
}

echo "experiment-access.sh"

bundle_fixture "$ADMIN"
acl "$(entry user_name owner@example.com CAN_MANAGE)" "$(entry group_name users CAN_EDIT)" \
  "$(entry group_name admins CAN_MANAGE true)"
if FAKE_ENDPOINT_CREATOR=deployer@example.com run_access; then
  ok "restricts a workspace-wide ACL"
else
  bad "restriction failed: $(cat "$WORK/output")"
fi
holds group_name users CAN_EDIT && bad "the users grant survived" || ok "removes the workspace-wide users grant"
holds service_principal_name "$APP_SP" CAN_EDIT && ok "keeps the app service principal at CAN_EDIT" \
  || bad "the app service principal lost access"
holds user_name deployer@example.com CAN_EDIT && ok "grants the endpoint's creator CAN_EDIT for trace logging" \
  || bad "the endpoint's creator was not granted"
holds group_name "$ADMIN" CAN_READ && ok "grants the admin group CAN_READ" || bad "the admin group was not granted"
holds user_name owner@example.com CAN_MANAGE && ok "keeps the owner's direct grant" || bad "the owner's grant was dropped"
holds group_name admins CAN_MANAGE && ok "keeps inherited entries" || bad "an inherited entry was dropped"

if run_access && ! grep -q '^permissions update\|^permissions set' "$WORK/calls"; then
  ok "writes nothing on a second run"
else
  bad "a second run changed the ACL: $(cat "$WORK/calls")"
fi

bundle_fixture ""
acl "$(entry group_name users CAN_EDIT)"
if run_access && ! grep -q '"group_name": ""' "$WORK/calls"; then
  ok "a target with no admin group grants no empty group name"
else
  bad "empty admin group handling is wrong: $(cat "$WORK/calls")"
fi

bundle_fixture "$ADMIN"
acl "$(entry group_name users CAN_EDIT)"
if UPDATE_IGNORED=1 run_access; then
  bad "an unverified grant was accepted"
elif holds group_name users CAN_EDIT && ! grep -q '^permissions set' "$WORK/calls"; then
  ok "leaves the users grant in place when the grants do not verify"
else
  bad "unexpected outcome when the grants did not verify: $(cat "$WORK/output")"
fi

if grep -q 'EXPERIMENT_ACCESS="$BUNDLE_ROOT/bundle/experiment-access.sh"' "$HERE/app-release.sh" \
  && grep -q 'if ! TARGET="$TARGET" PROFILE="$PROFILE" bash "$EXPERIMENT_ACCESS" --apply; then' "$HERE/app-release.sh" \
  && grep -qx 'run_experiment_access' "$HERE/app-release.sh"; then
  ok "app-release.sh runs the experiment ACL step and only warns when it fails"
else
  bad "app-release.sh does not run experiment-access.sh --apply as a non-fatal step"
fi

if grep -q 'group_name: users' "$HERE/../resources/player_insights_experiment.experiment.yml"; then
  bad "the bundle still declares a workspace-wide experiment grant"
else
  ok "the bundle declares no workspace-wide experiment grant"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
