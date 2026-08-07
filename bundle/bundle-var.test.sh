#!/usr/bin/env bash
# Tests for bundle_var and bundle_var_or_empty in bundle/_lib.sh.
#
# WHAT THIS IS FOR: a per-target `variables:` block does not land in the `value`
# field of `bundle validate -o json`. It lands in `default`. Both helpers read
# `value` first, so before the default fallback existed, a variable a target
# overrode read as empty and the release ran on the base default while
# `bundle validate` showed the override. That is silent: manifest_source: genie
# on the customer target validated correctly and logged a schema-mode manifest.
#
# The failure mode is invisible by construction, so each case asserts the value
# the helper RETURNS, not that the command succeeded.
#
# Run:  bundle/bundle-var.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STUBS="$(mktemp -d "${TMPDIR:-/tmp}/bundle-var-test.XXXXXX")"
trap 'rm -rf "$STUBS"' EXIT

PASS=0
FAIL=0

cat >"$STUBS/databricks" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "bundle validate")
    cat <<JSON
{
  "workspace": { "host": "https://fake-workspace.cloud.databricks.com" },
  "variables": {
    "set_by_value":      { "value": "from-value" },
    "overridden_target": { "default": "from-default" },
    "both_present":      { "default": "from-default", "value": "from-value" },
    "empty_default":     { "default": "", "value": "" },
    "null_both":         { "default": null }
  }
}
JSON
    ;;
  *) echo '{}' ;;
esac
STUB
chmod +x "$STUBS/databricks"
PATH="$STUBS:$PATH"

BUNDLE_ROOT="$HERE/.."
TARGET="test"
PROFILE=""
# shellcheck source=/dev/null
source "$HERE/_lib.sh"

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    PASS=$((PASS + 1)); printf '  ok    %s\n' "$label"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL  %s\n        expected %q, got %q\n' "$label" "$expected" "$actual"
  fi
}

echo "bundle_var_or_empty"
check "reads an explicit value" "from-value" "$(bundle_var_or_empty set_by_value)"
check "falls back to a per-target override in default" "from-default" "$(bundle_var_or_empty overridden_target)"
check "prefers value when both are present" "from-value" "$(bundle_var_or_empty both_present)"
check "returns empty for a legitimately empty variable" "" "$(bundle_var_or_empty empty_default)"
check "returns empty when both are null" "" "$(bundle_var_or_empty null_both)"

# `|| true` because _lib.sh sets -e: these two cases are meant to fail, and
# without the guard the suite exits at the first one instead of asserting on it.
undeclared="$(bundle_var_or_empty not_declared 2>&1 || true)"
if [[ "$undeclared" == *"not declared"* ]]; then
  PASS=$((PASS + 1)); printf '  ok    %s\n' "still dies on an undeclared variable"
else
  FAIL=$((FAIL + 1)); printf '  FAIL  %s\n        got %q\n' "still dies on an undeclared variable" "$undeclared"
fi

echo "bundle_var"
check "reads an explicit value" "from-value" "$(bundle_var set_by_value)"
check "falls back to a per-target override in default" "from-default" "$(bundle_var overridden_target)"

empty="$(bundle_var empty_default 2>&1 || true)"
if [[ "$empty" == *"no value for this target"* ]]; then
  PASS=$((PASS + 1)); printf '  ok    %s\n' "still dies on an empty required variable"
else
  FAIL=$((FAIL + 1)); printf '  FAIL  %s\n        got %q\n' "still dies on an empty required variable" "$empty"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
