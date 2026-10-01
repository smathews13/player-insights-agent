#!/usr/bin/env bash
# =============================================================================
# THE RELEASE GATE: the checks whose failure a CUSTOMER would see.
#
# THIS FILE IS THE ONE PLACE THE SPLIT IS WRITTEN DOWN. Nobody should have to
# read two scripts to learn which checks gate a release and which do not.
#
# WHY A SUBSET, AND NOT bundle/run-checks.sh. GitHub Actions is disabled for this
# repository by an enterprise administrator -- no workflow has ever run -- so the
# release path is the only place anything gates at all, and the temptation is to
# put everything in it. Measured, `bundle/run-checks.sh` is 31.8s, of which 31.3s
# is the fourteen SUITES: each one copies a checker, feeds it a broken input, and
# proves it can go red. That is regression protection for the CHECKERS, and its
# failure means a future change might slip past a check. Nobody's session breaks.
# The static checks it also runs -- the ones that ask whether THIS COMMIT is
# sound -- include the production artifact budgets before any release upload.
#
# So the gate below is the customer-visible subset, and the full tier remains
# available for a handover or a pre-customer sweep:
#
#     bash bundle/release-checks.sh full
#
# ---------------------------------------------------------------------------
# IN THE GATE, and what each one has already cost us:
#
#   permissions: declared vs documented   A scope declared in databricks.yml that
#                                         the contract does not document, or the
#                                         reverse. Workspace-free, 0.05s.
#   permissions: declared vs effective    The app running without a scope its
#                                         configuration declares. This is the
#                                         "five permissions reading Missing"
#                                         failure, and the 403s across the
#                                         Connections tab before it. app-release
#                                         already checks it AFTER the deploy,
#                                         where the code is already live; here it
#                                         is asked BEFORE anything is uploaded.
#   resources declared vs observed        A resource the bundle declares that is
#                                         not attached to the live app. This took
#                                         the public deploy down twice in one
#                                         day: the app starts, then fails, and
#                                         the platform's message names nothing.
#
# NOT HERE (removed): Unity Catalog "what can the app SP SELECT" checks. Governed
# UC/Genie/SQL reads use the signed-in user's token (`execution_identity:
# user-authorization`). The app SP is for Lakebase operational storage and
# non-data control-plane work; those grants are verified after app creation, not
# by asking UC effective-permissions on customer catalogs (which also forced
# READ_METADATA on the deployer and required an app to exist before agent
# release). Do not put that gate back.
#
# The model release path gates on one more, from bundle/agent-release.sh:
# bundle/model-scope-check.py, which is the only thing that has ever checked the
# MODEL's scopes -- a different token, set by a different policy, on a different
# release from the app's.
#
# ---------------------------------------------------------------------------
# NOT IN THE GATE, and this is the paragraph to read before adding one back.
#
# Everything below fails when we have written something down wrongly. Nothing
# below breaks a customer's session, and a release gate that stops a deploy over
# a naming quibble teaches people to route around gates -- which costs more than
# the quibble. Run them by hand, in the full runner, before a handover:
#
#   the checker suites                    They prove the
#                                         CHECKERS can go red. A checker that has
#                                         quietly stopped failing is a real
#                                         problem and it is CI's problem; there is
#                                         no deployment it makes worse.
#   metric views and governed metadata    A measure that averages a rate, a view
#                                         with no comment. Wrong figures in a
#                                         dashboard nobody has built yet, or a
#                                         CREATE the warehouse would refuse
#                                         anyway.
#   semantic drift                        Catalog wording vs indexed wording. The
#                                         index answers either way; the answers
#                                         are just built on older words.
#   warehouse-and-index, telemetry        Two more live legs, each needing its own
#                                         workspace document. Genuinely
#                                         customer-visible if they drift, and
#                                         deliberately left out for now because
#                                         each adds a round trip and neither has
#                                         broken a session yet. Add them here, not
#                                         somewhere else, if one ever does.
#   the "synthetic" wording guard         WANTED HERE AND CURRENTLY NOT CALLABLE.
#                                         bundle/sql-metadata-check.py holds it
#                                         (D1: nothing reader-facing may describe
#                                         the data as fabricated, including the
#                                         Unity Catalog comments that surface in
#                                         Catalog Explorer) together with the
#                                         metric-view checks above, and has no
#                                         flag to run one leg. The whole file is
#                                         0.06s, so cost is not the reason it is
#                                         out: including it would put metric-view
#                                         findings in front of a customer deploy.
#                                         It needs `--only wording` (or the leg
#                                         split into its own entry point) from
#                                         whoever owns that file, and then one
#                                         line here.
#
# ---------------------------------------------------------------------------
# HOW IT REUSES WHAT THE RELEASE ALREADY PAYS FOR. The bundle is resolved once per
# release and cached across processes (bundle/_lib.sh, seed_bundle_cache), so this
# adds no `bundle validate`. Of its two workspace reads, `apps get` is one the
# release makes anyway a few steps later, and `tables list` is one line duplicated
# out of bundle/capture-drift-evidence.sh because that script captures eight
# documents including a per-table sweep. The right fix there is an `--only`
# argument, from whoever owns it; this gate does not need six of the eight.
#
# Usage:
#   TARGET=example bundle/release-gate.sh                 # what app-release.sh runs
#   TARGET=example PROFILE='<your profile>' bundle/release-gate.sh
#
# Exit 0 clean, 1 a finding, 2 a check that could not run -- which is NOT a pass
# and stops the release too. Unanswered and found are different states; both block.
# =============================================================================

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

[ $# -eq 0 ] || die "release-gate.sh takes no arguments. TARGET and PROFILE come from the environment.
There is deliberately no flag that skips a check: a gate people route around stops being read."

require_cmd databricks
require_target
resolve_profile
seed_bundle_cache

APP_NAME="$(bundle_var app_name)"
CATALOG="$(bundle_var app_catalog)"
SCHEMA="$(bundle_var app_schema)"

DRIFT="$BUNDLE_ROOT/bundle/drift-check.py"
CONTRACT="$BUNDLE_ROOT/bundle/scope-contract.py"

if [[ ! -f "$DRIFT" || ! -f "$CONTRACT" ]]; then
  step "Public release gate (target: $TARGET)"
  PUBLIC_CHECK="$BUNDLE_ROOT/bundle/public-release-gate.py"
  [[ -f "$PUBLIC_CHECK" ]] || die "public-release-gate.py is missing."
  EXPECTED="$(mktemp "${TMPDIR:-/tmp}/pia-public-expected.XXXXXX")"
  LIVE="$(mktemp "${TMPDIR:-/tmp}/pia-public-live.XXXXXX")"
  on_exit "rm -f '$EXPECTED' '$LIVE'"
  bundle_json >"$EXPECTED"
  databricks apps get "$APP_NAME" --profile "$PROFILE" -o json >"$LIVE" \
    || die "The live App '$APP_NAME' could not be read."
  python3 "$PUBLIC_CHECK" --expected "$EXPECTED" --live "$LIVE" \
    || die "The live App does not match the resolved public bundle."
  exit 0
fi

# A MISSING CHECKER IS NOT A PASS. Deleting a file is the cheapest way to turn a
# gate off and it leaves nothing in a release log anybody re-reads. Named here so
# the refusal says which one.
for required in "$DRIFT" "$CONTRACT"; do
  [ -f "$required" ] || die "$(basename "$required") is missing, so the check it performs did not run.
This gate has no skip flag and a missing checker is not a pass. Restore it:
  git restore bundle/$(basename "$required")"
done

EVIDENCE="$(mktemp -d "${TMPDIR:-/tmp}/pia-release-gate.XXXXXX")"
on_exit "rm -rf '$EVIDENCE'"

FINDINGS=()
UNANSWERED=()

# Runs one check. A finding and a could-not-run are collected SEPARATELY, because
# they are different states and the operator has to be told which happened -- but
# both stop the release, so neither is a way through.
gate() {
  local label="$1"; shift
  local out status=0
  out="$("$@" 2>&1)" || status=$?
  case "$status" in
    0) printf '  ok    %s\n' "$label" ;;
    1) printf '  FAIL  %s\n' "$label"
       printf '%s\n' "$out" | sed 's/^/        /'
       FINDINGS+=("$label") ;;
    *) printf '  ????  %s (exit %s)\n' "$label" "$status"
       printf '%s\n' "$out" | sed 's/^/        /'
       UNANSWERED+=("$label") ;;
  esac
}

step "Release gate (target: $TARGET) -- the checks a customer would feel"

# --- 1. Permissions: declared vs documented. No workspace. --------------------
gate "permissions: what the bundle declares matches what the contract documents" \
  python3 "$CONTRACT" --check

# --- 2. The two workspace documents the live legs below compare against -------
#
# Captured here rather than left to bundle/capture-drift-evidence.sh, which
# captures eight documents including a `tables get` per table for the semantic
# leg. These two are the ones the customer-visible legs need.
CAPTURE_STATUS=0
databricks apps get "$APP_NAME" --profile "$PROFILE" -o json > "$EVIDENCE/app.json" 2>/dev/null \
  || CAPTURE_STATUS=$?
databricks tables list "$CATALOG" "$SCHEMA" --profile "$PROFILE" -o json > "$EVIDENCE/tables.json" 2>/dev/null \
  || CAPTURE_STATUS=$?
if [ "$CAPTURE_STATUS" -ne 0 ]; then
  # Not a finding, and not survivable either: the legs below would each report
  # COULD NOT RUN, and a release that says "not established" five times reads
  # exactly like one that passed to anybody skimming.
  die "The workspace could not be read as profile '$PROFILE', so what the live app
has attached and what the governed schema contains were never established.

This is not a finding and it is not a pass -- the questions were not asked.
Check that '$PROFILE' can see app '$APP_NAME' and $CATALOG.$SCHEMA."
fi

# --- 3. Permissions: declared vs effective, BEFORE the upload ----------------
#
# app-release.sh also compares these after the deploy, and that step stays: it is
# the one that can tell an operator to restart the app, and effective scopes can
# change between here and there. Asking here as well costs one python process on
# a file already captured, and turns "deployed, then told" into "told, then not
# deployed".
gate "permissions: what the app declares is what the app holds" \
  python3 "$DRIFT" --target "$TARGET" --evidence "$EVIDENCE" --leg scope-counts

# --- 4. Resources declared but not attached ----------------------------------
gate "resources: every resource the bundle declares is on the live app" \
  python3 "$DRIFT" --target "$TARGET" --evidence "$EVIDENCE" --leg resource-observed

# -----------------------------------------------------------------------------
printf '\n'
if [ "${#UNANSWERED[@]}" -gt 0 ]; then
  printf '  %d check(s) could not run:\n' "${#UNANSWERED[@]}"
  for label in "${UNANSWERED[@]}"; do printf '        %s\n' "$label"; done
  printf '\n'
fi
if [ "${#FINDINGS[@]}" -gt 0 ]; then
  printf '  %d finding(s):\n' "${#FINDINGS[@]}"
  for label in "${FINDINGS[@]}"; do printf '        %s\n' "$label"; done
  printf '\n'
fi
if [ "${#FINDINGS[@]}" -gt 0 ] || [ "${#UNANSWERED[@]}" -gt 0 ]; then
  cat >&2 <<EOF
BLOCKED. Nothing has been built, uploaded or deployed.

Every check above is one a customer would feel: a permission the app does not
hold, or a resource it was told to use and does not have. Fix the finding.

Do not widen a check to get past it, and do not move one out of this gate to
make a release go: the paragraph at the top of this file says what belongs here
and why, and the answer is not "whatever is currently green".
EOF
  [ "${#FINDINGS[@]}" -gt 0 ] && exit 1
  exit 2
fi
printf '  ok. Everything a customer would feel, checked before anything is uploaded.\n'
printf '      Full unit/type/lint/format/Python/bundle coverage is not repeated here.\n'
printf '      Run the manual audit with: bash bundle/release-checks.sh full\n'
