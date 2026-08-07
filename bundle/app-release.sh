#!/usr/bin/env bash
# Push app CODE. THIS STEP IS IMPERATIVE BY NECESSITY.
#
# The bundle owns the app's CONFIGURATION (name, attached postgres and
# serving-endpoint resources, OAuth scopes, and which workspace directory holds
# its source). It does not own the code push, because the code that must reach
# the platform is not the repo: it is the esbuild output in build/deploy, a
# dependency-free tree with NO package.json. Databricks Apps runs `npm install`
# whenever the uploaded source contains one, and this app's tree is 508 packages
# / 714 MB with native binaries and a network-calling postinstall hook, on
# compute with no reliable npm registry egress. It hangs indefinitely. Without a
# package.json the platform logs "No dependencies file found. Skipping
# installation." and the deploy takes ~13 seconds.
#
# THIS IS THE ONLY WAY TO PUSH APP CODE. `npm run deploy` is a one-line alias
# for it (see player-insights-agent/package.json) rather than a second
# implementation, and everything environment-specific is read out of the bundle,
# so there is one place it is written down and one command that does it.
#
# A FAILED APP DEPLOY TAKES THE URL DOWN. It returns 502, with no automatic
# rollback. Keep the previous known-good source directory in the workspace and
# redeploy from it with --rollback-to (no rebuild, no upload; it only re-points
# the app).
#
# Usage:
#   TARGET=<your-target>                             bundle/app-release.sh          # dry run
#   TARGET=<your-target>                             bundle/app-release.sh --apply
#   TARGET=customer PROFILE=<their-profile>  bundle/app-release.sh --apply
#   TARGET=<your-target> bundle/app-release.sh --apply --rollback-to /Workspace/.../previous-src
#
# TARGET has no default. PROFILE is optional for a target that names its profile in
# databricks.yml; every other target must state one.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

APPLY=false; ROLLBACK_TO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true ;;
    --rollback-to)
      ROLLBACK_TO="${2:-}"
      [[ -n "$ROLLBACK_TO" ]] || die "--rollback-to needs the ABSOLUTE workspace path of a known-good source directory, e.g.
  --rollback-to /Workspace/Users/you@corp.com/player-insights-agent-src
List candidates with:  databricks workspace list <parent> --profile <profile>"
      shift ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

require_cmd databricks
require_cmd npm

require_target
resolve_profile

APP_NAME="$(bundle_var app_name)"
SRC_PATH="$(bundle_var app_source_code_path)"
APP_DIR="$BUNDLE_ROOT/player-insights-agent"
DEPLOY_TREE="$APP_DIR/build/deploy"

step "App release configuration (target: $TARGET)"
note "app            $APP_NAME"
note "profile        $PROFILE"
note "source path    $SRC_PATH"
note "local artefact $DEPLOY_TREE"

if [[ -n "$ROLLBACK_TO" ]]; then
  note "ROLLING BACK TO $ROLLBACK_TO"
  if [[ "$APPLY" != true ]]; then
    cat <<EOF

Dry run. Nothing was deployed. Re-run with --apply to:
  1. databricks apps deploy $APP_NAME --source-code-path $ROLLBACK_TO

Nothing is rebuilt or uploaded. This only re-points the app at a source
directory that is already in the workspace, so it is only a rollback if that
directory still holds the build you want.
EOF
    exit 0
  fi
  step "Re-pointing $APP_NAME at $ROLLBACK_TO"
  databricks apps deploy "$APP_NAME" --source-code-path "$ROLLBACK_TO" --profile "$PROFILE"
  step "Status"
  databricks apps get "$APP_NAME" --profile "$PROFILE" -o json \
    | python3 -c "
import json,sys
a=json.load(sys.stdin)
print('  app_status      :', a.get('app_status',{}).get('state'))
print('  deployment      :', a.get('active_deployment',{}).get('status',{}).get('state'))
print('  url             :', a.get('url'))
"
  exit 0
fi

if [[ "$APPLY" != true ]]; then
  cat <<EOF

Dry run. Nothing was built or deployed. Re-run with --apply to:
  1. resolve the MLflow experiment id for '$TARGET' out of the bundle
  2. npm run build:deploy        (vite client build + esbuild server bundle)
  3. print the findings of any local advisory checks this tree carries.
     They never gate this release.
  4. databricks workspace import-dir build/deploy $SRC_PATH --overwrite
  5. databricks apps deploy $APP_NAME --source-code-path $SRC_PATH
EOF
  exit 0
fi

# Run Explorer deep-links a stored trace into MLflow, which needs the experiment's
# NUMERIC id. Resolved per release rather than written into app.yaml as a literal,
# which would ship one workspace's experiment id to every deployment.
#
# Two steps, because the number exists only in the workspace: var.experiment_path
# gives the path for whichever target is being released, and the workspace turns
# that path into the id. `bundle summary` will not do it: an experiment's entry
# carries its name, not its id.
#
# Not fatal. A missing id costs the deep link and nothing else, and the trace id
# is still displayed; refusing to release over a broken hyperlink would be worse
# than releasing without one.
step "Resolving the MLflow experiment for $TARGET"
EXPERIMENT_PATH="$(bundle_var experiment_path)"
EXPERIMENT_ID="$(databricks experiments get-by-name "$EXPERIMENT_PATH" --profile "$PROFILE" -o json 2>/dev/null \
  | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
print((d.get('experiment') or d).get('experiment_id') or '')
" || true)"
if [[ -n "$EXPERIMENT_ID" ]]; then
  note "experiment           $EXPERIMENT_PATH"
  note "experiment id        $EXPERIMENT_ID"
else
  note "no experiment at $EXPERIMENT_PATH in this workspace yet."
  note "app.yaml keeps its empty value: Run Explorer will show trace ids without"
  note "a deep link. Re-run this release after 'bundle deploy' creates it."
fi

# Whether the rail shows everyone's conversations or only the caller's. Read
# out of the bundle so a customer configures it in databricks.yml rather than in
# app source, and so the value that shipped is recoverable from the target
# afterwards. bundle_var_or_empty, not bundle_var: an empty value is legitimate
# here and means the same as "false", while a variable DELETED from
# databricks.yml still stops the release. Telling those two apart is the point
# of putting it in the bundle at all.
SHARED_RAIL="$(bundle_var_or_empty shared_conversation_rail)"
# Same treatment, and empty is the normal case: it means the app keeps its
# compiled default judge. bundle_var_or_empty rather than bundle_var so an empty
# value passes while a variable DELETED from databricks.yml still stops the
# release.
JUDGE_ENDPOINT="$(bundle_var_or_empty judge_endpoint)"
note "benchmark judge      ${JUDGE_ENDPOINT:-(app default)}"
if [[ "$(printf '%s' "$SHARED_RAIL" | tr '[:upper:]' '[:lower:]')" == "true" ]]; then
  note "conversation rail    SHARED: every user sees every user's conversations"
else
  note "conversation rail    per-user (shared_conversation_rail=${SHARED_RAIL:-<empty>})"
fi

step "Building the dependency-free deploy tree"
(cd "$APP_DIR" \
  && PLAYER_INSIGHTS_EXPERIMENT_ID="$EXPERIMENT_ID" \
     PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL="$SHARED_RAIL" \
     PLAYER_INSIGHTS_JUDGE_ENDPOINT="$JUDGE_ENDPOINT" \
     npm run build:deploy)

# --live, not the static subset: the static checks cover build properties only
# (no package.json, minify pin, file sizes) and say nothing about whether the
# deployment is correct.
#
# ADVISORY, and never a gate. Hence `if !` rather than `set -e`, which also
# tolerates the check crashing outright, and the output is deliberately not
# redirected.
#
# ABSENCE IS A THIRD OUTCOME, distinct from clean and from unclean. These are
# development checks written against the maintainers' own demo estate, so they
# are not part of every tree. Left to the `if !` below, a missing file exits 127
# and prints "did not exit cleanly ... read its findings above" over a bash "No
# such file or directory", sending the operator to look for a broken release and
# for findings that were never produced.
ADVISORY_CHECKS="$BUNDLE_ROOT/bundle/preflight.sh"
step "Local advisory checks, if this tree carries any"
if [ ! -f "$ADVISORY_CHECKS" ]; then
  note "This tree carries none, so nothing was checked here. They are development"
  note "checks against the maintainers' own estate, and no release depends on them."
  note ""
  note "What they would have reported is still worth establishing by hand, because"
  note "none of it fails loudly: both app resources attached, every scope the bundle"
  note "authors in effect, the serving endpoint reachable, and the app's Postgres"
  note "grants made. 'databricks apps get $APP_NAME -o json' shows the first two as"
  note "the platform holds them; the app's own /api/storage reports the last."
elif ! TARGET="$TARGET" PROFILE="$PROFILE" bash "$ADVISORY_CHECKS" --live; then
  note ""
  note "The checks did not exit cleanly. Continuing with the release: they report,"
  note "they do not gate. Read their findings above: a deployment they describe will"
  note "start and serve HTTP 200 while being wrong in the way each one names."
fi

step "Uploading to $SRC_PATH"
databricks workspace import-dir "$DEPLOY_TREE" "$SRC_PATH" --overwrite --profile "$PROFILE"

step "Deploying app $APP_NAME"
databricks apps deploy "$APP_NAME" --source-code-path "$SRC_PATH" --profile "$PROFILE"

step "Status"
databricks apps get "$APP_NAME" --profile "$PROFILE" -o json \
  | python3 -c "
import json,sys
a=json.load(sys.stdin)
print('  app_status      :', a.get('app_status',{}).get('state'))
print('  deployment      :', a.get('active_deployment',{}).get('status',{}).get('state'))
print('  url             :', a.get('url'))
"
