#!/usr/bin/env bash
# Tests for the correlation gate in bundle/agent-release.sh.
#
# WHAT THESE ARE FOR: the gate refuses a release when a value proved in the app's
# Setup Wizard disagrees with what the release would log. It has two ways to be
# wrong and only one of them is visible. Refusing a legitimate release is loud and
# gets fixed within the hour. PASSING something it was built to catch is silent,
# and it stayed silent for a day: the 401 branch (the one every CI caller takes,
# because /api/setup cannot identify a service principal) printed a warning and
# returned success.
#
# So each case below asserts an EXIT STATUS as well as the text. A gate that
# prints "REFUSED" and returns 0 satisfies any assertion made on output alone,
# which is exactly how the original defect survived review.
#
# HOW: the real script is run, unmodified, with `databricks`, `curl` and `uv`
# replaced by stubs on PATH. Nothing here reimplements the gate. A test that
# restates the logic it is checking passes when the logic is wrong. Stubbing the
# CLI is also what lets a 401 be tested at all: the live app answers a human 200,
# and the branch that matters cannot be reached from this machine.
#
# Run:  bundle/agent-release-correlation.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable so the suite can be pointed at an older copy of the script to prove
# it catches the defect it was written for. A copy has to sit in this directory to
# find _lib.sh, which is how it is sourced. Used once, by hand:
#   git show <ref>:bundle/agent-release.sh > bundle/.old.sh
#   AGENT_RELEASE_SH=bundle/.old.sh bundle/agent-release-correlation.test.sh
SCRIPT="${AGENT_RELEASE_SH:-$HERE/agent-release.sh}"
[[ -x "$SCRIPT" ]] || { echo "not found: $SCRIPT" >&2; exit 1; }

STUBS="$(mktemp -d "${TMPDIR:-/tmp}/agent-release-test.XXXXXX")"
OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-release-out.XXXXXX")"
trap 'rm -rf "$STUBS" "$OUT_DIR"' EXIT

PASS=0
FAIL=0

# --- Stubs -------------------------------------------------------------------
#
# Driven by environment variables so each case can move one fact and leave the
# rest alone.
#
#   FAKE_HTTP_STATUS  what /api/setup returns
#   FAKE_SETUP_BODY   the body it returns with it
#   FAKE_APP_URL      empty to simulate an app that is not serving yet

cat >"$STUBS/databricks" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "bundle validate")
    # Only the fields agent-release.sh reads. Every variable it calls bundle_var
    # on must be present, and every one it calls bundle_var_or_empty on must be
    # DECLARED even when empty. That distinction is the point of the helper.
    cat <<'JSON'
{
  "workspace": { "host": "https://fake-workspace.cloud.databricks.com" },
  "variables": {
    "catalog":                  { "value": "test_catalog" },
    "schema":                   { "value": "test_schema" },
    "warehouse_id":             { "value": "wh-test" },
    "model_name":               { "value": "test_catalog.test_schema.model" },
    "serving_endpoint_name":    { "value": "test-endpoint" },
    "experiment_path":          { "value": "/Shared/test" },
    "llm_endpoint":             { "value": "test-llm" },
    "llm_gateway":              { "value": "" },
    "catalog_allowlist":        { "value": "test_catalog" },
    "catalog_denylist":         { "value": "" },
    "max_output_tokens":        { "value": "4096" },
    "genie_data_space_id":      { "value": "" },
    "genie_dictionary_space_id":{ "value": "" },
    "manifest_source":          { "value": "" },
    "app_name":                 { "value": "test-app" }
  },
  "resources": { "apps": { "player_insights_app": { "name": "test-app" } } }
}
JSON
    ;;
  "apps get")
    printf '{"url": "%s"}\n' "${FAKE_APP_URL-https://fake.databricksapps.com}"
    ;;
  "auth token")
    echo '{"access_token": "fake-token"}'
    ;;
  "auth describe")
    echo '{"details": {"host": "https://fake-workspace.cloud.databricks.com"}}'
    ;;
  *)
    echo "stub databricks: unexpected: $*" >&2
    exit 1
    ;;
esac
STUB

# The real call is `curl -sS --max-time 20 -w '\n%{http_code}' ...`, so the status
# arrives appended after a newline and the script splits on the LAST one. The stub
# has to reproduce that shape exactly, including the absence of a trailing newline
# on the body.
cat >"$STUBS/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n%s' "${FAKE_SETUP_BODY-}" "${FAKE_HTTP_STATUS-200}"
STUB

# Needed only by `require_cmd uv`. Every uv call is past the gate, and no case
# here gets that far, because all of them are dry runs.
cat >"$STUBS/uv" <<'STUB'
#!/usr/bin/env bash
echo "stub uv should not have been reached: $*" >&2
exit 1
STUB

chmod +x "$STUBS/databricks" "$STUBS/curl" "$STUBS/uv"

# --- Harness -----------------------------------------------------------------

# run_release <name> -> writes combined output to $OUT_DIR/<name>, returns the
# script's exit status. Dry run: no --apply, so nothing is logged or deployed
# whatever the gate decides.
LAST_OUT=""
run_release() {
  local name="$1"; shift
  LAST_OUT="$OUT_DIR/$name"
  PATH="$STUBS:$PATH" \
  TARGET=testtarget \
  PROFILE=test-profile \
  PLAYER_INSIGHTS_DATA_GENIE_ID=data-space-id \
  PLAYER_INSIGHTS_DICTIONARY_GENIE_ID=dict-space-id \
    bash "$SCRIPT" "$@" >"$LAST_OUT" 2>&1
  return $?
}

ok()   { PASS=$((PASS + 1)); printf '  ok    %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }

expect_status() {
  local want="$1" got="$2" what="$3"
  if [[ "$want" == nonzero ]]; then
    (( got != 0 )) && ok "$what (exit $got)" || bad "$what: expected nonzero, got $got"
  elif [[ "$got" == "$want" ]]; then
    ok "$what (exit $got)"
  else
    bad "$what: expected exit $want, got $got"
  fi
}

expect_text()  { grep -qF -- "$2" "$LAST_OUT" && ok "$1" || bad "$1: not in output"; }
expect_absent(){ grep -qF -- "$2" "$LAST_OUT" && bad "$1: present and should not be" || ok "$1"; }

# --- Fixtures ----------------------------------------------------------------

# The app agrees with the bundle: same catalog, and it publishes an agentKey, so
# the comparison is live rather than inert.
AGREES='{"steps":[{"id":"catalog-step","agentKey":"catalog","intended":"test_catalog",
        "proofCurrent":true,"proof":{"status":"ok","checkedAt":"2026-08-06T10:00:00Z"}}]}'
# Same shape, one value moved.
DISAGREES='{"steps":[{"id":"catalog-step","agentKey":"catalog","intended":"someone_elses_catalog",
        "proofCurrent":true,"proof":{"status":"ok","checkedAt":"2026-08-06T10:00:00Z"}}]}'

echo
echo "=== 1. service principal (401), no flag: must REFUSE and stop the release ==="
FAKE_HTTP_STATUS=401 FAKE_SETUP_BODY='{"error":"unauthorized"}' \
  run_release 401-no-flag; status=$?
expect_status nonzero "$status" "the release fails"
expect_text  "says the check was not read, with the status"  "NOT READ"
expect_text  "names the reason a CI caller hits this"        "service principal"
expect_text  "refuses in as many words"                      "REFUSED."
expect_text  "offers running it as a person"                 "run it as yourself"
expect_text  "names the flag as the deliberate way through"  "--ignore-app-intentions"
# The gate must STOP the run, not print its warning and carry on to the dry-run
# summary, which would report the release as having succeeded.
expect_absent "the run stopped at the gate, not after it"    "Dry run"
expect_absent "did not claim it released"                    "Released anyway"

echo
echo "=== 2. service principal (401) WITH the flag: releases, and says what it let through ==="
FAKE_HTTP_STATUS=401 FAKE_SETUP_BODY='{"error":"unauthorized"}' \
  run_release 401-with-flag --ignore-app-intentions; status=$?
expect_status 0 "$status" "the release proceeds"
expect_text  "the loud note is still in the log"             "NOT READ"
expect_text  "still explains the service principal case"     "service principal"
expect_text  "records that the flag did the releasing"       "Released anyway on --ignore-app-intentions"
expect_text  "reached the rest of the run"                   "Dry run"

echo
echo "=== 3. a 403 is the same finding as a 401 ==="
FAKE_HTTP_STATUS=403 FAKE_SETUP_BODY='{"error":"forbidden"}' \
  run_release 403-no-flag; status=$?
expect_status nonzero "$status" "the release fails"
expect_text  "reports the status it actually got"            "returned 403"

echo
echo "=== 4. a human caller whose app agrees: still passes ==="
FAKE_HTTP_STATUS=200 FAKE_SETUP_BODY="$AGREES" \
  run_release 200-agrees; status=$?
expect_status 0 "$status" "the release proceeds"
expect_text  "reports the agreement"                         "and that is what this release logs"
expect_absent "nothing was refused"                          "REFUSED"

echo
echo "=== 5. a human caller whose app disagrees: still refuses ==="
FAKE_HTTP_STATUS=200 FAKE_SETUP_BODY="$DISAGREES" \
  run_release 200-disagrees; status=$?
expect_status nonzero "$status" "the release fails"
expect_text  "refuses"                                       "REFUSED."
expect_text  "quotes the app's value"                        "someone_elses_catalog"
expect_absent "the run stopped at the gate"                  "Dry run"

echo
echo "=== 6. disagreement WITH the flag: releases, and the disagreement is on the record ==="
FAKE_HTTP_STATUS=200 FAKE_SETUP_BODY="$DISAGREES" \
  run_release 200-disagrees-with-flag --ignore-app-intentions; status=$?
expect_status 0 "$status" "the release proceeds"
# The flag must not skip the check itself: the disagreement is still printed, so
# the log says what was released over rather than only that something was.
expect_text  "the disagreement is still printed"             "someone_elses_catalog"
expect_text  "records that the flag did the releasing"        "Released anyway on --ignore-app-intentions"
expect_text  "reached the rest of the run"                    "Dry run"

echo
echo "=== 7. app not serving yet: a legitimate pass, unchanged ==="
FAKE_APP_URL="" FAKE_HTTP_STATUS=200 FAKE_SETUP_BODY="$AGREES" \
  run_release no-app-url; status=$?
expect_status 0 "$status" "the release proceeds"
expect_text  "says why it could not look"                    "is not serving yet"

echo
printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
