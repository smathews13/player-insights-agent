#!/usr/bin/env bash
# Pins the app-spec recovery contract after the stale SP-gate bootstrap path died.
#
# Specifically:
#   - --allow-missing-endpoint is refused (that flag existed only to mint an app
#     SP before a model/endpoint existed, for a Unity Catalog data gate that no
#     longer runs)
#   - the script source no longer offers a path past a missing endpoint
#   - normal release/bootstrap scripts do not write variable-overrides.json
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPEC="$HERE/app-spec.sh"
FAIL=0

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAIL=1; }

printf '==> app-spec bootstrap contract\n'

# --- 1. The flag is gone and says why ------------------------------------------
OUT="$(mktemp "${TMPDIR:-/tmp}/pia-app-spec-test.XXXXXX")"
STATUS=0
TARGET=example bash "$SPEC" --allow-missing-endpoint >"$OUT" 2>&1 || STATUS=$?
if [[ "$STATUS" -ne 0 ]] \
   && grep -q 'allow-missing-endpoint was removed' "$OUT" \
   && grep -q 'Unity Catalog data gate' "$OUT"; then
  pass "--allow-missing-endpoint is refused and names the deleted gate"
else
  fail "--allow-missing-endpoint must die with an explanation of the deleted SP gate"
  sed 's/^/        /' "$OUT"
fi
rm -f "$OUT"

# --- 2. Source does not reintroduce a bypass -----------------------------------
if grep -nE 'ALLOW_MISSING_ENDPOINT=true|proceeding on --allow-missing-endpoint' "$SPEC"; then
  fail "app-spec.sh still contains an allow-missing-endpoint bypass path"
else
  pass "app-spec.sh has no allow-missing-endpoint bypass path"
fi

# --- 3. Release/bootstrap scripts do not mutate ignored overrides --------------
#
# The temporary-old-endpoint workaround rewrote variable-overrides.json mid-deploy
# as hidden state. Normal flow must not. unbind-created-infra.sh may COPY overrides
# into a worktree for an explicit correction; that is not a release path.
MUTATORS=()
for script in \
  "$HERE/app-release.sh" \
  "$HERE/agent-release.sh" \
  "$HERE/app-spec.sh" \
  "$HERE/preflight.sh" \
  "$HERE/release-gate.sh" \
  "$HERE/adopt-example.sh"; do
  # Shell redirects / tee aimed at the overrides file. Ignore comments and the
  # common prose form `<target>/variable-overrides.json` (the `>` in `<target>`
  # is not a redirect).
  hits="$(
    grep -nE '(^|[^<])(>{1,2}|tee)[[:space:]]+([^[:space:]]*variable-overrides\.json)' "$script" \
      | grep -vE '^[[:space:]]*[0-9]+:[[:space:]]*#' \
      || true
  )"
  if [[ -n "$hits" ]]; then
    MUTATORS+=("$(basename "$script")")
  fi
done
if [[ "${#MUTATORS[@]}" -eq 0 ]]; then
  pass "normal release/bootstrap scripts do not write variable-overrides.json"
else
  fail "these scripts appear to write variable-overrides.json: ${MUTATORS[*]}"
fi

# --- 4. Warehouse binding comment stays about the app SP grant, not user data --
#
# The committed permission level may still be under debate (CAN_USE vs CAN_MANAGE),
# but the resource must not be described as granting the app SP governed-data
# access. Pin the app.yml comment that says governed reads use the signed-in user.
APP_YML="$HERE/../resources/player_insights_app.app.yml"
if grep -q 'Do not bind governed tables' "$APP_YML" \
   && grep -q 'signed-in user' "$APP_YML"; then
  pass "app.yml states governed reads use the signed-in user, not SP data bindings"
else
  fail "resources/player_insights_app.app.yml lost the user-authorization binding comment"
fi

printf '\n'
if [[ "$FAIL" -ne 0 ]]; then
  printf 'app-spec.test.sh: %s finding(s)\n' "$FAIL"
  exit 1
fi
printf 'app-spec.test.sh: ok\n'
