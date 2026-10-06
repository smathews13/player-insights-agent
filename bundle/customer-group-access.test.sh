#!/usr/bin/env bash
# Offline proof that the endpoint and App grants read the customer access groups
# from the bundle, PATCH their level for each, verify the result, are a no-op for
# a target with no groups, and fail rather than skip when a bundle read fails.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-customer-group-access-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

PASS=0
FAIL=0

ok() { printf '  ok    %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }

ENGINEER=S_TK2_Databricks_globalmartech_PIA_Engineer
EXEC=S_TK2_Databricks_globalmartech_PIA_Exec
ADMIN=S_TK2_Databricks_globalmartech_PIA_Admin

mkdir -p "$WORK/bin"
cat > "$WORK/bin/databricks" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
EMPTY_ACL='{"access_control_list":[]}'
case "$1 $2" in
  "bundle validate")
    [[ "${BUNDLE_BROKEN:-}" == "1" ]] && { echo 'bundle exploded' >&2; exit 1; }
    cat "$BUNDLE_FIXTURE"
    ;;
  "serving-endpoints get")
    printf '%s\n' '{"id":"endpoint-id"}'
    ;;
  "permissions update")
    : > "$UPDATED_MARKER"
    printf '%s\n' '{}'
    ;;
  "permissions get")
    # The ACL before any write, then the ACL the write produced.
    if [[ -e "$UPDATED_MARKER" ]]; then
      printf '%s\n' "$PERMISSIONS_FIXTURE"
    else
      printf '%s\n' "${PERMISSIONS_BEFORE:-$EMPTY_ACL}"
    fi
    ;;
  *)
    printf 'unexpected databricks call: %s\n' "$*" >&2
    exit 2
    ;;
esac
SH
chmod +x "$WORK/bin/databricks"

bundle_fixture() {
  printf '{"variables":{"serving_endpoint_name":{"value":"test-endpoint"},"app_name":{"value":"test-app"},'
  printf '"app_engineer_group":{"value":"%s"},"app_exec_group":{"value":"%s"},"app_admin_group":{"value":"%s"}}}' \
    "$1" "$2" "$3"
}

granted() {
  local level="$1" entries=() name
  shift
  for name in "$@"; do
    entries+=("{\"group_name\":\"$name\",\"all_permissions\":[{\"permission_level\":\"$level\",\"inherited\":false}]}")
  done
  local IFS=,
  printf '{"access_control_list":[%s]}' "${entries[*]}"
}

run_grant() {
  local script="$1" permissions="$2"
  : > "$WORK/calls"
  rm -f "$WORK/updated"
  env -u PIA_BUNDLE_JSON_CACHE PATH="$WORK/bin:$PATH" CALLS="$WORK/calls" UPDATED_MARKER="$WORK/updated" \
    BUNDLE_FIXTURE="$WORK/bundle.json" PERMISSIONS_FIXTURE="$permissions" \
    TARGET=test PROFILE=test-profile \
    bash "$HERE/$script" --apply > "$WORK/output" 2>&1
}

check_script() {
  local script="$1" level="$2" object="$3"
  echo "$script"

  bundle_fixture "$ENGINEER" "$EXEC" "$ADMIN" > "$WORK/bundle.json"
  if run_grant "$script" "$(granted "$level" "$ENGINEER" "$EXEC" "$ADMIN")"; then
    ok "grants and verifies all three configured groups"
  else
    bad "grant with all groups held failed: $(cat "$WORK/output")"
  fi
  local update name
  update="$(grep "^permissions update $object" "$WORK/calls" || true)"
  for name in "$ENGINEER" "$EXEC" "$ADMIN"; do
    if [[ "$update" == *"\"group_name\": \"$name\", \"permission_level\": \"$level\""* ]]; then
      ok "PATCH carries $level for $name"
    else
      bad "PATCH is missing $level for $name: $update"
    fi
  done

  if run_grant "$script" "$(granted "$level" "$ENGINEER" "$ADMIN")"; then
    bad "a group missing from the verified ACL was accepted"
  elif grep -q "verification failed for: $EXEC" "$WORK/output"; then
    ok "fails closed and names the group the ACL did not grant"
  else
    bad "unexpected failure output: $(cat "$WORK/output")"
  fi

  bundle_fixture "" "$EXEC" "" > "$WORK/bundle.json"
  run_grant "$script" "$(granted "$level" "$EXEC")" >/dev/null
  update="$(grep "^permissions update $object" "$WORK/calls" || true)"
  if [[ "$update" == *"$EXEC"* && "$update" != *'"group_name": ""'* ]]; then
    ok "skips an empty group instead of granting an empty name"
  else
    bad "empty group handling is wrong: $update"
  fi

  bundle_fixture "" "" "" > "$WORK/bundle.json"
  if run_grant "$script" '{}' && ! grep -q '^permissions\|^serving-endpoints' "$WORK/calls"; then
    ok "a target with no groups leaves the ACL untouched"
  else
    bad "empty groups still touched the ACL: $(cat "$WORK/calls")"
  fi

  if BUNDLE_BROKEN=1 run_grant "$script" '{}'; then
    bad "an unreadable bundle was treated as 'no groups configured'"
  else
    ok "an unreadable bundle fails instead of skipping the grant"
  fi

  bundle_fixture "$ENGINEER" "$EXEC" "$ADMIN" > "$WORK/bundle.json"
  PERMISSIONS_BEFORE="$(granted CAN_MANAGE "$ADMIN")" \
    run_grant "$script" "$(granted "$level" "$ENGINEER" "$EXEC" "$ADMIN")" >/dev/null
  update="$(grep "^permissions update $object" "$WORK/calls" || true)"
  if [[ "$update" == *"$ENGINEER"* && "$update" != *"$ADMIN"* ]]; then
    ok "leaves a group that already holds CAN_MANAGE out of the write"
  else
    bad "a group holding CAN_MANAGE was re-sent at $level: $update"
  fi

  if PERMISSIONS_BEFORE="$(granted "$level" "$ENGINEER" "$EXEC" "$ADMIN")" run_grant "$script" '{}' \
    && ! grep -q '^permissions update' "$WORK/calls"; then
    ok "writes nothing when every group already holds the level"
  else
    bad "re-sent a grant every group already held: $(cat "$WORK/calls")"
  fi

  bundle_fixture "  $ENGINEER " "$EXEC" "$ADMIN" > "$WORK/bundle.json"
  local lower_admin
  lower_admin="$(printf '%s' "$ADMIN" | tr '[:upper:]' '[:lower:]')"
  if run_grant "$script" "$(granted "$level" "$ENGINEER" "$EXEC" "$lower_admin")" \
    && grep -q "\"group_name\": \"$ENGINEER\"," "$WORK/calls"; then
    ok "trims group names and verifies them case-insensitively"
  else
    bad "trim or case-insensitive verification failed: $(cat "$WORK/output")"
  fi

  # The group lookups themselves failing, after the rest of the bundle resolved.
  printf '{"variables":{"serving_endpoint_name":{"value":"test-endpoint"},"app_name":{"value":"test-app"}}}' \
    > "$WORK/bundle.json"
  if run_grant "$script" '{}'; then
    bad "a failed group lookup was treated as 'no groups configured'"
  elif grep -q "app_engineer_group is not declared" "$WORK/output"; then
    ok "a failed group lookup fails instead of skipping the grant"
  else
    bad "unexpected group lookup failure output: $(cat "$WORK/output")"
  fi
}

check_script endpoint-user-access.sh CAN_QUERY "serving-endpoints endpoint-id"
check_script app-user-access.sh CAN_USE "apps test-app"

if grep -q 'endpoint-user-access.sh" --apply; then' "$HERE/agent-release.sh"; then
  ok "agent-release.sh runs the endpoint grant and only warns when it fails"
else
  bad "agent-release.sh does not run endpoint-user-access.sh --apply as a non-fatal step"
fi
if grep -q '^run_app_user_access$' "$HERE/app-release.sh" \
  && grep -q 'if ! TARGET="$TARGET" PROFILE="$PROFILE" bash "$APP_USER_ACCESS" --apply; then' "$HERE/app-release.sh"; then
  ok "app-release.sh runs the App grant and only warns when it fails"
else
  bad "app-release.sh does not run app-user-access.sh --apply as a non-fatal step"
fi
if [[ "$(grep -c 'run_app_user_access' "$HERE/app-release.sh")" -eq 2 ]]; then
  ok "the rollback path does not run the App grant"
else
  bad "run_app_user_access is called somewhere other than the main release path"
fi
if grep -q 'permissions:' <(sed -n '/^targets:/,$p' "$HERE/../databricks.yml" | grep -A3 'player_insights_app:'); then
  bad "databricks.yml declares App permissions, which replace the whole App ACL on deploy"
else
  ok "databricks.yml leaves the App ACL to the PATCH grants"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
