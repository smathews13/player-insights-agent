#!/usr/bin/env bash
# What `databricks bundle deploy` would DESTROY, asked before it is run.
#
# NOT MARKED `# advisory-suite:`, AND THAT IS THE POINT OF THE FILE. This gate
# blocks. The advisory suites report and are swallowed by bundle/app-release.sh,
# which is right for them: their findings are about workspace state OUTSIDE the
# artifact being released, so a release that ships over one still ships something
# correct. A plan that would delete a resource is the opposite -- it is a
# statement about what the next command does to the workspace -- so a green line
# and a continued run would be the worst of both.
#
# It is also NOT on the app release's path, and does not need to be:
# `bundle/app-release.sh` never runs `bundle deploy`. It uploads a source tree
# and calls `apps deploy`, so no plan of any shape changes what it is about to
# do, and a `delete` finding printed there would be a loud warning about a
# command nobody was running. Nothing in this repository runs `bundle deploy`;
# it is always a person at a terminal. So this is the step for that person:
#
#   TARGET=<target> bundle/plan-gate.sh && databricks bundle deploy -t <target>
#
# The `&&` is the whole design. Chained that way, an unreviewed destroy cannot
# reach the workspace, and the gate costs about 2 seconds against a deploy
# measured in minutes.
#
# ABOUT two seconds, not a decimal. The three places this file and bundle/README.md
# stated the cost said 1.6, 1.7 and 1.9 within a day of each other, all describing
# the same measurement -- which is the fault the rest of 2026-08-17 went to
# removing from app.yaml and databricks.yml, reappearing in the file that landed
# alongside the removal. A figure precise enough to disagree with itself and not
# load-bearing enough for anyone to re-measure should not be written to one
# decimal place in three files.
#
# WHY A GATE AND NOT A HABIT. `bundle deploy` prints its own plan and asks for
# confirmation, so in principle this is redundant. In practice a person who has
# typed `deploy` twenty times reads "Deploying resources..." and not the list
# above it, and the resources most worth not losing here are the ones that do
# not come back: `schemas.player_insights_schema` holds the curated tables, the
# registered model and the endpoint's inference tables, and
# `schemas.player_insights_telemetry_schema` holds app history that does not
# backfill. Both carry `prevent_destroy`, which stops `bundle destroy` -- it does
# NOT stop a `replace`, which is a delete and a create wearing one word.
#
# FAILS CLOSED ON AN ACTION IT HAS NEVER SEEN, which is the one design decision
# here worth defending. The CLI's vocabulary today is create/delete/replace/skip/
# update; this file allows the three that cannot lose anything and refuses
# everything else BY EXCLUSION, so a future CLI that introduces a sixth verb is
# refused by this gate rather than waved through it. A check that silently stops
# matching is this repository's most repeated bug -- a leak rule that matched
# nothing for months, four suites that asserted nothing, a `sed` script whose
# every rule was a no-op because BSD `sed` ignores `\b` and exits 0 anyway -- and
# every one of them exited 0. An allowlist of safe verbs cannot fail that way; a
# denylist of dangerous ones would.
#
# EXIT CODES follow bundle/app-release.sh's Postgres step, which tells the two
# apart on purpose:
#   0  the plan destroys nothing
#   1  a finding: the plan would delete or replace something
#   2  the check could not run, which is NOT evidence that the plan is safe
#
# Usage:
#   TARGET=<target> bundle/plan-gate.sh
#   TARGET=customer PROFILE=<their-profile> bundle/plan-gate.sh
#   TARGET=<target> PIA_PLAN_ALLOW_DESTROY=resources.jobs.old_job bundle/plan-gate.sh

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

require_cmd databricks
require_cmd python3
require_target

# DELIBERATELY NOT `resolve_profile`. That helper reads the profile out of the
# resolved bundle, which means `bundle validate`, which is around 8 seconds here
# against this gate's two -- it made the check several times its own cost to learn
# something the CLI already knows. `bundle plan -t <target>` reads `workspace.profile` from
# databricks.yml itself, so a target that names one needs nothing passed. PROFILE
# is forwarded only when the CALLER set it, which is what a target carrying no
# profile of its own (customer) needs.
#
# Keep it that way. `validate` was being run 14 times per release at ~7.5s each
# before the resolution was cached once, and a gate that re-introduces one for a
# value it does not need is how that comes back.
step "What a deploy would destroy (target: $TARGET)"

PLAN_ARGS=(bundle plan -t "$TARGET" -o json)
[[ -n "$PROFILE" ]] && PLAN_ARGS+=(--profile "$PROFILE")

PLAN_JSON=""
PLAN_ERR="$(mktemp "${TMPDIR:-/tmp}/pia-plan-err.XXXXXX")"
trap 'rm -f "$PLAN_ERR"' EXIT

# Keep the CLI's status. A direct-engine planner panic exits 139 and produces no
# JSON; losing that status under `|| true` made the one actionable stale-state
# failure look like every other empty-output failure.
set +e
PLAN_JSON="$(cd "$BUNDLE_ROOT" && databricks "${PLAN_ARGS[@]}" 2>"$PLAN_ERR")"
PLAN_STATUS=$?
set -e

if [[ -z "$PLAN_JSON" ]]; then
  note "COULD NOT RUN. 'databricks bundle plan' produced no output:"
  note ""
  sed 's/^/    /' "$PLAN_ERR" >&2 || true
  note ""
  note "This is NOT a clean plan. Nothing has been checked, so do not read this as"
  note "permission to deploy. Re-run the command yourself to see why:"
  note ""
  note "  (cd $BUNDLE_ROOT && databricks bundle plan -t $TARGET${PROFILE:+ --profile \"$PROFILE\"})"
  note ""
  if [[ "$PLAN_STATUS" -eq 139 ]] \
     || grep -Eq 'ResourceApp\.OverrideChangeDesc|SIGSEGV|segmentation violation' "$PLAN_ERR"; then
    note "The direct planner crashed while comparing the App with bundle state. If"
    note "the app or its app-owned schema was deleted manually, forget ONLY those"
    note "missing associations, then re-run this gate:"
    note ""
    note "  databricks bundle deployment unbind player_insights_app -t $TARGET${PROFILE:+ --profile \"$PROFILE\"}"
    note "  databricks bundle deployment unbind player_insights_schema -t $TARGET${PROFILE:+ --profile \"$PROFILE\"}"
    note ""
    note "Run only the line for each resource you confirmed is already absent."
    note "Unbind edits bundle state; it does not delete the workspace resource."
    note "Do NOT remove the whole state directory: it also tracks surviving jobs,"
    note "volumes and experiments, which a later deploy could duplicate or collide with."
    note "The serving endpoint is not a standalone bundle resource; forgetting the"
    note "deleted app also removes the stale endpoint binding nested in its state."
    note ""
  fi
  note "A target carrying no host of its own also needs PROFILE set, and a target"
  note "whose required variables are unset needs them passed or written into"
  note ".databricks/bundle/$TARGET/variable-overrides.json."
  exit 2
fi

# The decision lives in bundle/plan-gate.py, which takes a plan document on
# stdin. Split that way so the interesting half is testable without a workspace:
# a gate whose only proof is "it passed against today's deployment" is the shape
# of check this repository has been burned by.
set +e
printf '%s' "$PLAN_JSON" | TARGET="$TARGET" python3 "$BUNDLE_ROOT/bundle/plan-gate.py"
STATUS=$?
set -e

case "$STATUS" in
  0) note "" ; note "plan-gate OK. 'databricks bundle deploy -t $TARGET' removes nothing." ;;
  2) note "" ; note "plan-gate COULD NOT RUN. Treat the plan as unknown, not as safe." ;;
esac

exit "$STATUS"
