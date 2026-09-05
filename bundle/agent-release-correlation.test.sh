#!/usr/bin/env bash
# Tests for the correlation gate in bundle/agent-release.sh.
#
# WHAT THESE ARE FOR: the gate refuses a release when a value somebody saved in
# the app disagrees with what the release would log. It has two ways to be wrong
# and only one of them is visible. Refusing a legitimate release is loud and gets
# fixed within the hour. PASSING something it was built to catch is silent. The
# old browser-route reader always returned 401 to automation because it had no
# app-session cookie. The replacement reads Lakebase directly with the release
# profile's OAuth credential and fails closed when that machine path cannot read.
#
# So each case below asserts an EXIT STATUS as well as the text. A gate that
# prints "REFUSED" and returns 0 satisfies any assertion made on output alone,
# which is exactly how the original defect survived review.
#
# HOW: the real script is run, unmodified, with `databricks`, `node` and `uv`
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
#   FAKE_READER_STATUS  the direct Lakebase reader's exit status
#   FAKE_SETTINGS_BODY  the bounded intentions document it returns
#   FAKE_APP_EXISTS     false to simulate a pre-bundle workspace

cat >"$STUBS/databricks" <<'STUB'
#!/usr/bin/env bash
# A LEADING `--profile <value>` is shifted off before dispatch. Typed
# subcommands this stub answers take the flag at the END (`apps get NAME
# --profile P`); keep shifting so a future call that puts the flag first still
# reaches the case arms below.
if [ "$1" = "--profile" ]; then shift 2; fi
case "$1 $2" in
  "bundle validate")
    # Only the fields agent-release.sh reads. Every variable it calls bundle_var
    # on must be present, and every one it calls bundle_var_or_empty on must be
    # DECLARED even when empty. That distinction is the point of the helper.
    #
    # A VARIABLE ADDED TO THE SCRIPT AND NOT ADDED HERE KILLS THE WHOLE SUITE,
    # not one case: the script exits during variable resolution, long before the
    # gate, so all nine cases fail with "not in output" and none of them is
    # about the gate. That is how it read when `allow_unattributed_figures` was
    # added, and again when `semantic_index_endpoint` was, for about fifty commits.
    # The failure is loud enough to notice but says nothing about its cause, so it
    # is written down here instead. To re-derive the list:
    #   rg -o 'bundle_var(_or_empty)? [a-z_]+' bundle/agent-release.sh | sort -u
    #
    # `execution_identity` will NOT appear in that command's output. The decisions
    # gate reads it straight out of the resolved bundle rather than through those
    # helpers, and D2 is a `must_be` rule, so an UNDECLARED variable CONTRADICTS it:
    # nothing in such a deployment asserts the decision. A target that omits it is
    # meant to be refused, so the value here is the one a real target carries.
    cat <<'JSON'
{
  "workspace": { "host": "https://fake-workspace.cloud.databricks.com" },
  "variables": {
    "app_catalog":              { "value": "test_catalog" },
    "app_schema":               { "value": "test_schema" },
    "warehouse_id":             { "value": "wh-test" },
    "model_name":               { "value": "test_catalog.test_schema.model" },
    "serving_endpoint_name":    { "value": "test-endpoint" },
    "serving_rollbacks_kept":   { "value": "0" },
    "experiment_path":          { "value": "/Shared/test" },
    "llm_endpoint":             { "value": "test-llm" },
    "llm_gateway":              { "value": "" },
    "data_catalogs":            { "value": ["test_catalog"] },
    "catalog_denylist":         { "value": "" },
    "max_output_tokens":        { "value": "4096" },
    "genie_data_space_id":      { "value": "" },
    "genie_dictionary_space_id":{ "value": "" },
    "manifest_source":          { "value": "" },
    "app_name":                 { "value": "test-app" },
    "allow_unattributed_figures": { "value": "" },
    "semantic_index_endpoint":  { "value": "" },
    "lakebase_app_schema":      { "value": "player_insights" },
    "execution_identity":       { "value": "user-authorization" }
  },
  "resources": { "apps": { "player_insights_app": { "name": "test-app" } } }
}
JSON
    ;;
  "apps get")
    [[ "${FAKE_APP_EXISTS-true}" == true ]] || exit 1
    printf '{"name":"test-app"}\n'
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

# The machine reader is a separate Node process. Its stub returns the same
# bounded JSON contract or an authorization failure without making a network
# connection. The curl stub is a tripwire: any browser-route fallback fails.
cat >"$STUBS/node" <<'STUB'
#!/usr/bin/env bash
if [[ "${FAKE_READER_STATUS-0}" != 0 ]]; then
  echo "ERROR: secure app-intention read failed: ${FAKE_READER_ERROR-machine credential refused}" >&2
  exit "${FAKE_READER_STATUS}"
fi
if [[ -n "${FAKE_SETTINGS_BODY+x}" ]]; then
  printf '%s\n' "$FAKE_SETTINGS_BODY"
else
  printf '%s\n' '{"source":"lakebase-direct-oauth","resources":[]}'
fi
STUB

cat >"$STUBS/curl" <<'STUB'
#!/usr/bin/env bash
echo "browser fallback was called" >&2
exit 99
STUB

# Needed only by `require_cmd uv`. Every uv call is past the gate, and no case
# here gets that far, because all of them are dry runs.
cat >"$STUBS/uv" <<'STUB'
#!/usr/bin/env bash
echo "stub uv should not have been reached: $*" >&2
exit 1
STUB

chmod +x "$STUBS/databricks" "$STUBS/node" "$STUBS/curl" "$STUBS/uv"

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
bad()  {
  FAIL=$((FAIL + 1))
  printf '  FAIL  %s\n' "$1"
  [[ -f "$LAST_OUT" ]] && while IFS= read -r line; do printf '        %s\n' "$line"; done <"$LAST_OUT"
}

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

# The direct reader shape: one entry per staged setting with the resource nested
# inside it. `catalog`/`catalog` are the real id and agentKey from
# shared/deployment-config.ts, so a rename fails these rather than passing
# against a shape the machine reader never sends.
#
# The app agrees with the bundle: same catalog, and it publishes an agentKey, so
# the comparison is live rather than inert.
AGREES='{"resources":[{"resource":{"id":"catalog","agentKey":"catalog","label":"Catalog"},
        "intended":"test_catalog","intendedBy":"someone@example.com",
        "intendedAt":"2026-08-06T10:00:00Z"}]}'
# Same shape, one value moved.
DISAGREES='{"resources":[{"resource":{"id":"catalog","agentKey":"catalog","label":"Catalog"},
        "intended":"someone_elses_catalog","intendedBy":"someone@example.com",
        "intendedAt":"2026-08-06T10:00:00Z"}]}'
# Nothing outstanding: the resource is published, but nobody has saved a value
# against it. This is the ordinary state of a healthy deployment, and it must
# read as a pass that looked rather than a pass that could not look.
NOTHING_SAVED='{"resources":[{"resource":{"id":"catalog","agentKey":"catalog","label":"Catalog"},
        "intended":null,"intendedBy":"","intendedAt":""}]}'

echo
echo "=== 1. machine OAuth reader failure: must REFUSE and stop the release ==="
FAKE_READER_STATUS=1 FAKE_READER_ERROR='401 Unauthorized: Bearer [REDACTED]' \
  run_release 401-no-flag; status=$?
expect_status nonzero "$status" "the release fails"
expect_text  "says the authoritative read failed"            "direct Lakebase OAuth reader failed"
expect_text  "refuses in as many words"                      "REFUSED."
expect_text  "names the required secure source"              "deployment_settings table"
expect_absent "does not call the browser fallback"           "browser fallback was called"
# The gate must STOP the run, not print its warning and carry on to the dry-run
# summary, which would report the release as having succeeded.
expect_absent "the run stopped at the gate, not after it"    "Dry run"

echo
echo "=== 2. the retired bypass flag is rejected rather than skipping the gate ==="
FAKE_READER_STATUS=1 \
  run_release 401-with-flag --ignore-app-intentions; status=$?
expect_status nonzero "$status" "the release refuses the bypass"
expect_text  "the retired flag is unknown"                   "unknown argument: --ignore-app-intentions"
expect_absent "the bypass never reaches the dry-run success" "Dry run"

echo
echo "=== 3. a 403 from the machine credential is the same refusal ==="
FAKE_READER_STATUS=1 FAKE_READER_ERROR='403 Forbidden' \
  run_release 403-no-flag; status=$?
expect_status nonzero "$status" "the release fails"
expect_text  "reports the secure reader failure"             "secure app-intention read failed"

echo
echo "=== 4. a machine caller whose stored intention agrees: passes ==="
FAKE_READER_STATUS=0 FAKE_APP_EXISTS=true FAKE_SETTINGS_BODY="$AGREES" \
  run_release 200-agrees; status=$?
expect_status 0 "$status" "the release proceeds"
expect_text  "reports the agreement"                         "and that is what this release logs"
expect_absent "nothing was refused"                          "REFUSED"

echo
echo "=== 5. a machine caller whose stored intention disagrees: refuses ==="
FAKE_READER_STATUS=0 FAKE_SETTINGS_BODY="$DISAGREES" \
  run_release 200-disagrees; status=$?
expect_status nonzero "$status" "the release fails"
expect_text  "refuses"                                       "REFUSED."
expect_text  "quotes the stored value"                       "someone_elses_catalog"
expect_absent "the run stopped at the gate"                  "Dry run"

echo
echo "=== 6. app not created yet: a legitimate greenfield pass ==="
FAKE_APP_EXISTS=false FAKE_READER_STATUS=0 FAKE_SETTINGS_BODY="$AGREES" \
  run_release no-app-url; status=$?
expect_status 0 "$status" "the release proceeds"
expect_text  "says why it could not look"                    "does not exist yet"

echo
echo "=== 7. authoritative table with nothing saved: a pass that LOOKED ==="
FAKE_APP_EXISTS=true FAKE_READER_STATUS=0 FAKE_SETTINGS_BODY="$NOTHING_SAVED" \
  run_release nothing-saved; status=$?
expect_status 0 "$status" "the release proceeds"
expect_text  "says it had nothing to disagree with"          "no outstanding intentions"
expect_absent "nothing was refused"                          "REFUSED"

echo
printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
(( FAIL == 0 )) || exit 1
# A FLOOR, NOT A TOTAL. `FAIL == 0` is also true of a run that asserted nothing:
# a stub the script could not build, a `run_release` that died before the first
# case, an early `exit` in a helper. This project has shipped three checks that
# passed while matching nothing, so the count is held to a floor here rather than
# left implied. Raise it when cases are added; it is deliberately below the
# current count so adding one case is not a two-file change.
readonly MIN_ASSERTIONS=20
(( PASS >= MIN_ASSERTIONS )) || {
    printf '\nFAIL  only %s assertions ran; at least %s are expected.\n' "$PASS" "$MIN_ASSERTIONS" >&2
    printf '      Nothing failed, but this run did not check what it claims to.\n' >&2
    exit 1
}
