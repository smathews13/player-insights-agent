#!/usr/bin/env bash
# Proof that bundle/model-user-auth-check.py refuses each way the model half of
# the user-authorization wiring can be missing, and passes only when it is whole.
#
# WHY THE SUITE EXISTS. A customer's first question came back as an HTTP 400
# carrying the SDK's `model_serving_user_credentials auth:` sentence, because the
# endpoint had no user credential to hand the container. The agent now answers
# that with a sentence a reader can act on; this gate is the other half, catching
# a version with no user auth policy at DEPLOY time instead. A gate whose failure
# has never been observed is a comment, and this repository has shipped four
# checks that could not fail.
#
# STANDARD LIBRARY ONLY for every assertion that counts. `bundle/run-checks.sh`
# discovers this file and CI runs it on a runner with no pip install, on the
# stated ground that a dependency is a way for a gate to stop running for reasons
# unrelated to what it checks. So the findings are proved through
# `--auth-policy-json`, which takes the same mapping MLflow hands back. The two
# MLflow doors are exercised at the end IF an agent environment is available, and
# skipped visibly when it is not, so a bare runner loses one thin call rather
# than the whole suite.
#
#   bundle/model-user-auth-check.test.sh

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
GATE="$HERE/model-user-auth-check.py"

PASS=0
FAIL=0
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-model-user-auth-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

# The release exports this and the gate defaults to it. Cleared here so every
# assertion states the mode it is testing, and one assertion below proves the
# default is really read.
unset PLAYER_INSIGHTS_USER_AUTHORIZATION

check_says() {
  local label="$1" expected="$2" needle="$3"; shift 3
  local out status
  out="$("$@" 2>&1)"
  status=$?
  if [[ "$status" != "$expected" ]] || ! printf '%s' "$out" | grep -qF -- "$needle"; then
    printf '  FAIL  %s\n        wanted exit %s and %q; got exit %s\n' \
      "$label" "$expected" "$needle" "$status"
    printf '%s\n' "$out" | sed 's/^/          /'
    FAIL=$((FAIL + 1)); return
  fi
  printf '  ok    %s\n' "$label"
  PASS=$((PASS + 1))
}

# A release summary in the shape log_model.py's last stdout line really has.
summary() {
  local file="$WORK/$1"; shift
  python3 - "$file" "$@" <<'PY'
import json, sys
json.dump(
    {
        "model_name": "a_catalog.a_schema.an_agent",
        "model_version": "12",
        "api_scopes": sys.argv[2:],
        "model_uri": "runs:/abc/agent",
    },
    open(sys.argv[1], "w"),
)
PY
  printf '%s' "$file"
}

# An MLmodel fragment, as JSON. $2 is a JSON value for `auth_policy`; the literal
# word `none` writes a document with no auth_policy key at all, which is what a
# version logged as though user authorization were off really looks like.
fragment() {
  local file="$WORK/$1"
  python3 - "$file" "$2" <<'PY'
import json, sys
policy = sys.argv[2]
document = {} if policy == "none" else {"auth_policy": json.loads(policy)}
json.dump(document, open(sys.argv[1], "w"))
PY
  printf '%s' "$file"
}

SYSTEM_HALF='"system_auth_policy": {"resources": {"api_version": "1", "databricks": {"genie_space": [{"name": "01ef0000"}]}}}'

WHOLE="$(fragment whole.json "{$SYSTEM_HALF, \"user_auth_policy\": {\"api_scopes\": [\"dashboards.genie\", \"sql\"]}}")"
NO_POLICY="$(fragment no-policy.json none)"
SYSTEM_ONLY="$(fragment system-only.json "{$SYSTEM_HALF}")"
EMPTY_SCOPES="$(fragment empty-scopes.json "{$SYSTEM_HALF, \"user_auth_policy\": {\"api_scopes\": []}}")"
SHORT="$(fragment short.json "{$SYSTEM_HALF, \"user_auth_policy\": {\"api_scopes\": [\"dashboards.genie\"]}}")"
NO_SYSTEM="$(fragment no-system.json '{"user_auth_policy": {"api_scopes": ["dashboards.genie", "sql"]}}')"

GOOD="$(summary good.json dashboards.genie sql)"

printf '\n==> a well-formed user-authorization release\n'
check_says "a version carrying the policy and every derived scope passes" 0 \
  "carries a user auth policy" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$WHOLE" --user-authorization true

check_says "and it names Genie, which is one of the two the agent really calls" 0 \
  "Genie is reachable as the invoker" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$WHOLE" --user-authorization true

check_says "the SQL scope is named too, not just counted" 0 \
  "SQL is reachable as the invoker" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$WHOLE" --user-authorization true

# THE PASS MUST NOT BE QUOTABLE AS "ON-BEHALF-OF-USER IS WORKING". The endpoint's
# own forwarding and the app's token forwarding are not in a model version, and a
# check that stayed silent about that would be read as having covered them.
check_says "a pass says what it did NOT verify: the endpoint's own forwarding" 0 \
  "whether the serving ENDPOINT was created with on-behalf-of-user" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$WHOLE" --user-authorization true

check_says "and that the app must forward the user's token to be the invoker" 0 \
  "forwards the signed-in user's token" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$WHOLE" --user-authorization true

check_says "and that MLflow never validated these scope strings" 0 \
  "does not validate them" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$WHOLE" --user-authorization true

check_says "and that a local file is not the registered version" 0 \
  "this read a LOCAL file, not the registered version" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$WHOLE" --user-authorization true

printf '\n==> the incident: a user-authorization release with no policy on the version\n'
check_says "no auth policy at all fails, and names the HTTP 400 it becomes" 1 \
  "carries NO auth policy at all" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$NO_POLICY" --user-authorization true

check_says "and it names the fix, which is a re-log and redeploy" 1 \
  "Re-log and redeploy through bundle/agent-release.sh" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$NO_POLICY" --user-authorization true

check_says "and rules out the three things an operator tries first" 1 \
  "a restart, a re-grant or a data reload cannot write this" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$NO_POLICY" --user-authorization true

check_says "a failure says what it did NOT verify too" 1 \
  "NOT verified by this check" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$NO_POLICY" --user-authorization true

check_says "a system-only policy fails: nothing mints a downscoped user token" 1 \
  "NO user_auth_policy in it" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$SYSTEM_ONLY" --user-authorization true

check_says "an empty api_scopes list fails, and says where it would have failed" 1 \
  "fails inside the container, at answer time" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$EMPTY_SCOPES" --user-authorization true

check_says "a policy missing a scope this release derived fails" 1 \
  "the downscoped token will not reach it" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$SHORT" --user-authorization true

check_says "a user policy with no system policy beside it fails" 1 \
  "no system_auth_policy beside it" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$NO_SYSTEM" --user-authorization true

check_says "a release that derived no scopes fails even against a whole policy" 1 \
  "derived NO api_scopes" \
  python3 "$GATE" --logged "$(summary empty.json)" --auth-policy-json "$WHOLE" --user-authorization true

printf '\n==> the flag: only "true" asks for a policy, and off is stated not assumed\n'
check_says "a release with the flag off is not failed for having no policy" 0 \
  "NOT CHECKED" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$NO_POLICY" --user-authorization false

check_says "but the operator is told such a version answers nothing" 0 \
  "refuse EVERY question" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$NO_POLICY" --user-authorization false

# The release's own rule: a well-meant "1" is not "true". Read the other way, a
# release that meant to turn user authorization on would be told its missing
# policy was expected.
check_says "an unrecognised flag value resolves to off, as the release resolves it" 0 \
  "NOT CHECKED" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$NO_POLICY" --user-authorization 1

check_says "the flag is read from the release's environment when not given" 1 \
  "carries NO auth policy at all" \
  env PLAYER_INSIGHTS_USER_AUTHORIZATION=true \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$NO_POLICY"

printf '\n==> a check that cannot run must not report a pass\n'
check_says "nothing saying which mode this release was is exit 2" 2 \
  "An unanswered question is not a pass" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$WHOLE"

printf 'not json' > "$WORK/bad.json"
check_says "an unreadable release summary is exit 2" 2 \
  "not readable JSON" \
  python3 "$GATE" --logged "$WORK/bad.json" --auth-policy-json "$WHOLE" --user-authorization true

printf '{"model_version": "12"}' > "$WORK/wrongshape.json"
check_says "a summary with no api_scopes key is exit 2, not zero scopes" 2 \
  "would otherwise look the same" \
  python3 "$GATE" --logged "$WORK/wrongshape.json" --auth-policy-json "$WHOLE" --user-authorization true

check_says "a missing summary is exit 2" 2 \
  "not readable JSON" \
  python3 "$GATE" --logged "$WORK/nope.json" --auth-policy-json "$WHOLE" --user-authorization true

check_says "an unreadable policy fragment is exit 2, not an absent policy" 2 \
  "The version's auth policy is UNKNOWN" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$WORK/bad.json" --user-authorization true

printf '{"auth_policy": "yes please"}' > "$WORK/weird.json"
check_says "a policy of a shape this check cannot read is exit 2" 2 \
  "Treat the version's policy as unknown" \
  python3 "$GATE" --logged "$GOOD" --auth-policy-json "$WORK/weird.json" --user-authorization true

printf '{"api_scopes": ["sql"]}' > "$WORK/nonames.json"
check_says "--registered with no model name in the summary is exit 2" 2 \
  "COULD NOT RUN" \
  python3 "$GATE" --logged "$WORK/nonames.json" --registered --user-authorization true

check_says "asking for no source at all is refused rather than defaulted" 2 \
  "one of the arguments" \
  python3 "$GATE" --logged "$GOOD" --user-authorization true

# THE DIRECTORY THE GATE IS INVOKED FROM MUST NOT DECIDE WHETHER IT RUNS. It
# reaches agent/user_authorization.py through its own parent to read the release's
# flag rule; resolved against the current working directory instead, it would die
# on a path that plainly exists and read as a missing file rather than as a bug.
for from in / "$HERE"; do
  check_says "the gate resolves the agent's flag rule when invoked from $from" 0 \
    "carries a user auth policy" \
    bash -c 'cd "$1" && exec python3 "$2" --logged "$3" --auth-policy-json "$4" --user-authorization true' \
    _ "$from" "$GATE" "$GOOD" "$WHOLE"
done

# --- The MLflow doors, when there is an environment that has MLflow ------------
#
# These are the two the RELEASE uses, and they are one call each onto the
# judgement every assertion above already proved. Skipped visibly rather than
# silently: a bare CI runner loses the thin call, not the suite, and says so.
printf '\n==> the MLflow doors (the release path), if an agent environment exists\n'
PY="$(cd "$REPO/agent" && uv run --python 3.13 python -c 'import mlflow, sys; print(sys.executable)' 2>/dev/null | tail -n 1)"
if [[ -z "$PY" || ! -x "$PY" ]]; then
  printf '  --    no environment with mlflow; --mlmodel and --registered not exercised\n'
else
  MLM="$WORK/mlmodel"
  mkdir -p "$MLM"
  {
    printf 'artifact_path: agent\nflavors: {}\nmlflow_version: 3.14.0\n'
    printf 'utc_time_created: "2026-01-01 00:00:00.000000"\n'
    printf 'auth_policy:\n  system_auth_policy:\n    resources:\n      api_version: "1"\n'
    printf '  user_auth_policy:\n    api_scopes:\n    - dashboards.genie\n    - sql\n'
  } > "$MLM/MLmodel"
  check_says "a real MLmodel carrying the policy passes through the MLflow reader" 0 \
    "carries a user auth policy" \
    "$PY" "$GATE" --logged "$GOOD" --mlmodel "$MLM" --user-authorization true

  MLM_BARE="$WORK/mlmodel-bare"
  mkdir -p "$MLM_BARE"
  {
    printf 'artifact_path: agent\nflavors: {}\nmlflow_version: 3.14.0\n'
    printf 'utc_time_created: "2026-01-01 00:00:00.000000"\n'
    printf 'resources:\n  api_version: "1"\n'
  } > "$MLM_BARE/MLmodel"
  check_says "a real MLmodel with no auth policy fails through the same reader" 1 \
    "carries NO auth policy at all" \
    "$PY" "$GATE" --logged "$GOOD" --mlmodel "$MLM_BARE" --user-authorization true

  check_says "an MLmodel that is not there is exit 2, not an absent policy" 2 \
    "The version's auth policy is UNKNOWN" \
    "$PY" "$GATE" --logged "$GOOD" --mlmodel "$WORK/no-such-model" --user-authorization true
fi

printf '\n'
if (( FAIL )); then
  printf 'FAIL  %d of %d assertions failed.\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
# The floor counts only the assertions that need nothing installed, because those
# are the ones a CI runner will really make.
if (( PASS < 29 )); then
  printf 'FAIL  only %d assertions ran; this suite has 29 that need no dependency.\n' "$PASS"
  exit 1
fi
printf 'PASS  %d assertions.\n' "$PASS"
