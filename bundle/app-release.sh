#!/usr/bin/env bash
# Build and deploy app code to the app created by the bundle.
#
# The bundle owns app configuration and resource attachments. This script builds
# and uploads the dependency-free build/deploy tree, applies Lakebase grants,
# and deploys that source to the existing app. Use --rollback-to to point the app
# at a known-good workspace source directory.
#
# Usage:
#   TARGET=<your-target>                             bundle/app-release.sh          # dry run
#   TARGET=<your-target>                             bundle/app-release.sh --apply
#   TARGET=customer PROFILE=<their-profile>  bundle/app-release.sh --apply
#   TARGET=<your-target> bundle/app-release.sh --apply --certify   # also issue a certificate
#   TARGET=<your-target> bundle/app-release.sh --apply --rollback-to /Workspace/.../previous-src
#
# The generated build/deploy/app.yaml contains deployment-specific values. This
# script restores the tracked file on every exit path.
#
# TARGET has no default. PROFILE is optional for a target that names its profile in
# databricks.yml; every other target must state one.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
source "$(dirname "${BASH_SOURCE[0]}")/decisions-gate.sh"

APPLY=false; ROLLBACK_TO=""; CERTIFY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true ;;
    --certify) CERTIFY_RUN=true ;;
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
# Resolve the target once and share it with child checks.
seed_bundle_cache

APP_NAME="$(bundle_var app_name)"
SRC_PATH="$(bundle_var app_source_code_path)"
APP_DIR="$BUNDLE_ROOT/player-insights-agent"
DEPLOY_TREE="$APP_DIR/build/deploy"
APP_DB_GRANT="$BUNDLE_ROOT/bundle/app-db-grant.sh"

run_app_db_grant() {
  [[ -f "$APP_DB_GRANT" ]] || die "bundle/app-db-grant.sh is missing. Refusing to deploy
without the Postgres grants and AppKit cache ownership remediation this release promises."
  TARGET="$TARGET" PROFILE="$PROFILE" bash "$APP_DB_GRANT"
}

step "App release configuration (target: $TARGET)"
note "app            $APP_NAME"
note "profile        $PROFILE"
note "source path    $SRC_PATH"
note "local artefact $DEPLOY_TREE"

# Before BOTH exits below, so a dry run reports it and a rollback is held to it too.
#
# The rollback path is deliberately inside the gate rather than outside it. It changes
# nothing about this target's configuration, which is what tempts you to exempt it, but
# it is still a decision about what a reader will be looking at ten seconds later, and
# an exempt path is the one people learn to reach for. There is no flag past this.
decisions_gate || exit $?

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
  run_app_db_grant
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
  0. run bundle/release-gate.sh: the permissions the app declares against the
     ones it documents and the ones it holds, and every declared resource
     attached to the live app. THIS ONE STOPS THE RELEASE before anything is
     built. ~7s, two workspace reads.
     Run it now, without releasing:  TARGET=$TARGET bundle/release-gate.sh
  1. resolve the MLflow experiment id for '$TARGET' out of the bundle
  2. npm run build:deploy        (vite client build + esbuild server bundle)
  3. print the findings of any local advisory checks this tree carries.
     They never gate this release.
  4. check the app owns its Postgres schema. THIS ONE STOPS THE RELEASE, before
     anything is uploaded: ownership cannot be repaired by a later deploy.
  5. resolve the app role, direct Lakebase branch host, Postgres database and
     operator role from the live bundle resources, then run
     scripts/grant-app-db-access.mjs. This STOPS the release on failure.
  6. databricks workspace import-dir build/deploy $SRC_PATH --overwrite
  7. databricks apps deploy $APP_NAME --source-code-path $SRC_PATH
  8. fail if a declared OAuth scope is not in effect. The code is deployed by
     then; the app needs a stop/start, which this prints.
  9. restore player-insights-agent/build/deploy/app.yaml, which the build wrote
     this deployment's administrators and experiment id into. Tracked file, and
     it publishes; nothing to remember afterwards.

Certification is NOT part of a release: it cost 16s of 175s, gated nothing, and
ended every run with forty lines of NOT ATTESTED. Add --certify, or run
bundle/certify-release.sh against the deployment whenever you want the record.
EOF
  exit 0
fi

# THE GATE, FIRST, BEFORE ANYTHING IS BUILT OR UPLOADED.
#
# Nothing above this line has touched the workspace or the deploy tree, so a
# refusal here costs the operator seven seconds and leaves the running app exactly
# as it was. What it asks and -- more importantly -- what it deliberately does NOT
# ask is written at the top of bundle/release-gate.sh, in one place, so nobody has
# to read two scripts to learn which checks gate a release.
#
# IT IS THE WHOLE POINT THAT THIS ONE BLOCKS. The advisory suites below report and
# continue, and the certification runner was moved behind --certify precisely
# because it printed without gating. This is the opposite: a permission the app
# does not hold, a resource it was told to use and has not got, or a read this
# project promises out loud that it cannot do. Every one of those has taken this
# deployment down or misreported it to a reader in the last day.
#
# NOT ON THE ROLLBACK PATH, which returns above this line. A rollback re-points
# the app at a source directory that was known good; refusing it over a
# data-access finding would keep a broken deployment broken to protect a
# governance claim that the rollback does not change.
#
# A CHILD PROCESS, SO IT COSTS NO EXTRA RESOLUTION. seed_bundle_cache above
# exported the resolved bundle, and PROFILE is passed explicitly because the cache
# is keyed on target AND profile: without it the gate resolves the bundle again and
# costs 16s instead of the measured 6s.
#
# ABSENCE IS TOLERATED, AND SAID OUT LOUD. The gate drives checkers that read the
# demo data-loading sources, which are excluded from the published tree, so it is
# excluded with them and a customer's checkout does not carry it. Dying
# here would make every customer release stop on a file we deliberately did not
# give them. This is the same treatment bundle/scope-contract.py gets below, for
# the same reason -- and it is NOT a skip mode: no flag reaches it, and in this
# repository the file is there.
RELEASE_GATE="$BUNDLE_ROOT/bundle/release-gate.sh"
if [[ -f "$RELEASE_GATE" ]]; then
  TARGET="$TARGET" PROFILE="$PROFILE" bash "$RELEASE_GATE" || exit $?
else
  note "This tree carries no release gate, so the permissions and the declared"
  note "resources were NOT checked. Nothing below asks those questions before"
  note "the upload. Establish them by hand if this deployment matters:"
  note "'databricks apps get $APP_NAME -o json' shows the resources and the"
  note "effective scopes."
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
# Postgres schema the app owns inside Lakebase. Default player_insights; the
# release bakes the resolved var into PLAYER_INSIGHTS_APP_SCHEMA so Connections
# and DDL agree with the bundle.
LAKEBASE_APP_SCHEMA="$(bundle_var lakebase_app_schema)"
# Same treatment, and empty is the normal case: it means the app keeps its
# compiled default judge. bundle_var_or_empty rather than bundle_var so an empty
# value passes while a variable DELETED from databricks.yml still stops the
# release.
JUDGE_ENDPOINT="$(bundle_var_or_empty judge_endpoint)"
note "benchmark judge      ${JUDGE_ENDPOINT:-(app default)}"

# Where app telemetry lands, built from the two bundle variables that already
# name it rather than declared a third time. A target with no export
# destinations resolves to empty even though the app-owned schema exists:
# ingestion is billed, so a customer target opts into no charge. The app reports
# empty as "not configured" rather than guessing.
TELEMETRY_CATALOG="$(bundle_var_or_empty app_catalog)"
TELEMETRY_SCHEMA_NAME="$(bundle_var_or_empty app_telemetry_schema)"
TELEMETRY_DESTINATIONS_COUNT="$(bundle_json | python3 -c '
import json,sys
app=json.load(sys.stdin).get("resources",{}).get("apps",{}).get("player_insights_app",{})
print(len(app.get("telemetry_export_destinations") or []))
')"
if [[ -n "$TELEMETRY_CATALOG" && -n "$TELEMETRY_SCHEMA_NAME" && "$TELEMETRY_DESTINATIONS_COUNT" -gt 0 ]]; then
  TELEMETRY_SCHEMA="${TELEMETRY_CATALOG}.${TELEMETRY_SCHEMA_NAME}"
  note "app telemetry        $TELEMETRY_SCHEMA"
else
  TELEMETRY_SCHEMA=""
  note "app telemetry        off for this target (no destinations set, so nothing ingests"
  note "                     and nothing is billed)"
fi

# The user API scopes this target declares, passed into the container so the app
# can compare a forwarded token against them and tell a reader whose sign-in is
# older than a declaration what to do about it.
#
# READ OUT OF THE RESOLVED APP RESOURCE, not out of the variable, and not written
# down a second time in app source. `app_user_api_scopes` is a complex variable
# that targets override, so the resolved `user_api_scopes` on the app resource is
# the only form that is both interpolated and target-correct: the customer target
# takes the default and the demo target adds to it, so the two lists differ in
# length and in content. A literal list compiled into the app would tell every
# user of the shorter deployment that their sign-in is missing permissions the app
# never asked for, which is exactly the confidently-wrong diagnosis this whole
# mechanism exists to remove.
#
# No count is given here on purpose. This comment said "four and seven" until
# 2026-08-17, having been written before the Vector Search pair landed, and
# player-insights-agent/app.yaml carried the same stale pair plus the difference
# between them until the same day. The number is a function of a target's variable
# and goes stale every time a scope is added, which is the one thing that makes a
# reader distrust the rest of a comment. `bundle summary -t <target>` prints the
# resolved list, and bundle/scope-contract.json carries it per target, generated.
#
# Same extraction as bundle/preflight.sh Fact 4, which checks the authored list
# against `effective_user_api_scopes` on the live app and STOPS the release when
# they disagree. That gate is what makes this list safe to hand the app: a scope
# declared and not yet in effect cannot survive a release, so a declared scope
# missing from one person's token is about that person's session rather than about
# the app's own restart state.
#
# Empty is a working release. The app reports "undetermined" and says nothing to
# anybody, which is the honest degradation.
DECLARED_SCOPES="$(bundle_json | python3 -c '
import json, sys
app = json.load(sys.stdin).get("resources", {}).get("apps", {}).get("player_insights_app", {})
print(",".join(app.get("user_api_scopes") or []))
' 2>/dev/null || true)"
if [[ -n "$DECLARED_SCOPES" ]]; then
  note "user API scopes      $DECLARED_SCOPES"
else
  note "user API scopes      could not be resolved from the bundle. The app will not be"
  note "                     able to tell a reader that their sign-in is short of a"
  note "                     permission it asks for, and will say so rather than guess."
fi

# The deployment's seed administrators, as addresses. THE VALUE IS NEVER IN A
# TRACKED FILE, which is why this is the one variable read from two places.
#
# `var.admin_emails` is DECLARED and REQUIRED in databricks.yml, but its value
# never belongs in that tracked file or in a target: the declaration publishes,
# the value must not. A deployment writes its own list into the git-ignored
# .databricks/bundle/<target>/variable-overrides.json, which is where app_catalog
# and warehouse_id already live, so the list survives across releases without
# anyone remembering it and without one workspace's employees being compiled
# into every build of this bundle.
#
# The environment wins, for a one-off that should not change what the target
# records. Neither route is more private than the other once the build runs:
# whichever supplied the value, it is written into build/deploy/app.yaml, which
# IS tracked. That file is uploaded from the local build tree by `workspace
# import-dir` below and does not have to be committed to reach the container.
# Do not commit it after a release that set this. See the note the deploy-tree
# generator prints.
#
# Empty must stop before build or deploy. Otherwise the app starts successfully
# while every admin route returns 403, including the editor that would appoint
# the first administrator.
ADMIN_EMAILS="${PLAYER_INSIGHTS_ADMIN_EMAILS:-$(bundle_var_or_empty admin_emails)}"
if [[ -n "$ADMIN_EMAILS" ]]; then
  note "administrators       $ADMIN_EMAILS"
else
  die "admin_emails is required. Set it in
.databricks/bundle/$TARGET/variable-overrides.json, or re-run with
PLAYER_INSIGHTS_ADMIN_EMAILS='a@example.com'. Without it the deployment is
self-locking: every admin route refuses every caller."
fi
if [[ "$(printf '%s' "$SHARED_RAIL" | tr '[:upper:]' '[:lower:]')" == "true" ]]; then
  note "conversation rail    SHARED: every user sees every user's conversations"
else
  note "conversation rail    per-user (shared_conversation_rail=${SHARED_RAIL:-<empty>})"
fi

# THE RELEASE PUTS THE GENERATED app.yaml BACK, rather than printing a reminder.
#
# build/deploy/app.yaml is TRACKED and PUBLISHES, and the build below writes this
# deployment's administrators, experiment id, telemetry schema and scopes into it.
# A routine `git add` afterwards is the whole leak, and
# player-insights-agent/scripts/deploy-app-yaml.test.ts fails while an address is
# on disk, which is what a passing `npm test` depends on. The upload reads the
# local tree directly, so restoring it after the upload costs the deployment
# nothing.
#
# Registered BEFORE the build, so a build or a deploy that fails partway still
# leaves the file as it found it -- that was the case the printed reminder never
# covered, because a failed release does not reach the note.
#
# NOT RESTORED IF IT WAS ALREADY MODIFIED. Another agent may be mid-rebuild in
# this working copy, and `git restore` over their in-flight edit would be a worse
# failure than the one this prevents. Then it says so instead.
DEPLOY_APP_YAML_REL="player-insights-agent/build/deploy/app.yaml"
DEPLOY_APP_YAML_PREBUILT_DIRTY=false
if git -C "$BUNDLE_ROOT" rev-parse --git-dir >/dev/null 2>&1 \
   && git -C "$BUNDLE_ROOT" ls-files --error-unmatch "$DEPLOY_APP_YAML_REL" >/dev/null 2>&1; then
  git -C "$BUNDLE_ROOT" diff --quiet -- "$DEPLOY_APP_YAML_REL" \
    || DEPLOY_APP_YAML_PREBUILT_DIRTY=true
  restore_deploy_app_yaml() {
    git -C "$BUNDLE_ROOT" diff --quiet -- "$DEPLOY_APP_YAML_REL" && return 0
    if [[ "$DEPLOY_APP_YAML_PREBUILT_DIRTY" == true ]]; then
      printf '\n  %s\n' "$DEPLOY_APP_YAML_REL was already modified before this release, so it"
      printf '  %s\n' "was left alone. If it carries administrator addresses, do not commit it:"
      printf '  %s\n' "git restore $DEPLOY_APP_YAML_REL"
      return 0
    fi
    git -C "$BUNDLE_ROOT" restore -- "$DEPLOY_APP_YAML_REL" 2>/dev/null \
      || git -C "$BUNDLE_ROOT" checkout -- "$DEPLOY_APP_YAML_REL" 2>/dev/null \
      || { printf '\n  %s\n' "could not restore $DEPLOY_APP_YAML_REL. Do it by hand before committing:"
           printf '  %s\n' "git restore $DEPLOY_APP_YAML_REL"; return 0; }
    printf '\n  %s\n' "restored $DEPLOY_APP_YAML_REL (it carried this deployment's own values,"
    printf '  %s\n' "and it is a tracked file that publishes to customers)"
  }
  on_exit restore_deploy_app_yaml
fi

step "Building the dependency-free deploy tree"
(cd "$APP_DIR" \
  && PLAYER_INSIGHTS_TARGET="$TARGET" \
     PLAYER_INSIGHTS_EXPERIMENT_ID="$EXPERIMENT_ID" \
     PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL="$SHARED_RAIL" \
     PLAYER_INSIGHTS_JUDGE_ENDPOINT="$JUDGE_ENDPOINT" \
     PLAYER_INSIGHTS_TELEMETRY_SCHEMA="$TELEMETRY_SCHEMA" \
     PLAYER_INSIGHTS_USER_API_SCOPES="$DECLARED_SCOPES" \
     PLAYER_INSIGHTS_ADMIN_EMAILS="$ADMIN_EMAILS" \
     PLAYER_INSIGHTS_APP_SCHEMA="$LAKEBASE_APP_SCHEMA" \
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
# FOUND BY A MARKER, NOT NAMED BY A PATH, and the publication is the reason
# rather than taste. The advisory suites are excluded from the published tree,
# so a hardcoded filename here left a customer reading a release script that
# points at a file their checkout does not contain, which the publication
# tooling reports as a dead reference. A suite declares itself instead, which
# also matches what the step already claimed to do: run whatever this tree
# carries, however many that is.
ADVISORY_CHECKS=()
for candidate in "$BUNDLE_ROOT"/bundle/*.sh; do
  grep -q '^# advisory-suite:' "$candidate" 2>/dev/null && ADVISORY_CHECKS+=("$candidate")
done

step "Local advisory checks, if this tree carries any"
if [ "${#ADVISORY_CHECKS[@]}" -eq 0 ]; then
  note "This tree carries none, so nothing was checked here. They are development"
  note "checks against the maintainers' own estate, and no release depends on them."
  note ""
  note "What they would have reported is still worth establishing by hand, because"
  note "none of it fails loudly: both app resources attached, every scope the bundle"
  note "authors in effect, the serving endpoint reachable, and the app's Postgres"
  note "grants made. 'databricks apps get $APP_NAME -o json' shows the first two as"
  note "the platform holds them; the app's own /api/storage reports the last."
else
  for suite in "${ADVISORY_CHECKS[@]}"; do
    if ! TARGET="$TARGET" PROFILE="$PROFILE" bash "$suite" --live; then
      note ""
      note "$(basename "$suite") did not exit cleanly. Continuing with the release:"
      note "these report, they do not gate. Read the findings above: a deployment they"
      note "describe will start and serve HTTP 200 while being wrong as each one names."
    fi
  done
fi

# Ownership is checked here rather than left to the advisory pass above, because
# it is the one Postgres condition a release cannot repair and a redeploy cannot
# clear. Grants do not confer it, and the role running this cannot transfer it.
# The app's boot DDL is refused for as long as the objects exist, so shipping
# over it means shipping a deployment whose next schema change silently will not
# apply.
#
# Two failure modes, told apart on purpose: exit 1 is a finding and stops the
# release, exit 2 is a check that could not run and does not. A check that is
# unavailable is not evidence of a problem, and blocking a release on one
# teaches people to skip the step.
step "Postgres ownership"
OWNERSHIP_STATUS=0
OWNERSHIP_OUT="$(cd "$APP_DIR" \
  && PLAYER_INSIGHTS_APP_SCHEMA="$LAKEBASE_APP_SCHEMA" \
     node scripts/check-db-ownership.mjs --app "$APP_NAME" --profile "$PROFILE" 2>&1)" \
  || OWNERSHIP_STATUS=$?
printf '%s\n' "$OWNERSHIP_OUT" | sed 's/^/  /'
if [[ "$OWNERSHIP_STATUS" -eq 1 ]]; then
  die "The app does not own the schema it maintains, so its boot DDL is refused.
Nothing has been uploaded or deployed. Follow the steps printed above, then
re-run this release."
elif [[ "$OWNERSHIP_STATUS" -ne 0 ]]; then
  note ""
  note "Ownership could not be established, which is not the same as it being wrong."
  note "Continuing with the release. If the app's schema turns out to be owned by a"
  note "developer role, its boot log will say so on the next start."
fi

run_app_db_grant

step "Uploading to $SRC_PATH"
databricks workspace import-dir "$DEPLOY_TREE" "$SRC_PATH" --overwrite --profile "$PROFILE"

# A bundle-created app has no active deployment yet. Its compute commonly
# settles at STOPPED, and `apps deploy` then refuses with "start the app first".
# Existing apps are already ACTIVE, so this is a greenfield-only transition.
APP_COMPUTE_STATE="$(databricks apps get "$APP_NAME" --profile "$PROFILE" -o json \
  | python3 -c 'import json,sys; print((json.load(sys.stdin).get("compute_status") or {}).get("state") or "")')"
if [[ "$APP_COMPUTE_STATE" != "ACTIVE" ]]; then
  step "Starting app compute for the first deployment"
  note "compute state is ${APP_COMPUTE_STATE:-unknown}; apps deploy requires ACTIVE compute"
  databricks apps start "$APP_NAME" --profile "$PROFILE" --timeout 20m
fi

step "Deploying app $APP_NAME"
databricks apps deploy "$APP_NAME" --source-code-path "$SRC_PATH" --profile "$PROFILE"

step "Status"
APP_JSON="$(databricks apps get "$APP_NAME" --profile "$PROFILE" -o json)"
printf '%s' "$APP_JSON" | python3 -c "
import json,sys
a=json.load(sys.stdin)
print('  app_status      :', a.get('app_status',{}).get('state'))
print('  deployment      :', a.get('active_deployment',{}).get('status',{}).get('state'))
print('  url             :', a.get('url'))
"

# A scope the app declares but does not hold is the quietest failure this system
# has. Scopes take effect at START, not at deploy, so a bundle deploy that adds
# one leaves the app running on the old set with the new set written down. The
# app cannot see the difference, nothing logs it, and the symptom arrives later
# as a permission error or a sign-in loop that looks like a bug in the code.
#
# Compared in one direction only. `effective` also carries scopes the platform
# adds for itself, which are not drift.
step "OAuth scopes in effect"
SCOPE_STATUS=0
printf '%s' "$APP_JSON" | python3 -c "
import json,sys
a=json.load(sys.stdin)
declared=set(a.get('user_api_scopes') or [])
effective=set(a.get('effective_user_api_scopes') or [])
for scope in sorted(declared|effective):
    where='both' if scope in declared and scope in effective else ('declared only' if scope in declared else 'platform')
    print(f'  {scope:45s} {where}')
missing=sorted(declared-effective)
if missing:
    print()
    print('  DECLARED BUT NOT IN EFFECT: ' + ', '.join(missing))
sys.exit(1 if missing else 0)
" || SCOPE_STATUS=$?
if [[ "$SCOPE_STATUS" -ne 0 ]]; then
  die "The app is running without scopes its configuration declares.
The code is deployed; this is a runtime state, not a bad build. Scopes are read
when the app STARTS, so a deploy alone will not pick them up:

  databricks apps stop $APP_NAME --profile \"$PROFILE\"
  databricks apps start $APP_NAME --profile \"$PROFILE\"

Consent is all or nothing. If a scope stays absent after a restart, this
workspace will not issue it, and every user will loop at sign-in before reaching
the app rather than see an error. Remove it from the target in databricks.yml."
fi

# Arch#3, the THIRD leg. The step above holds declared against effective, which
# are the two the platform can answer. Neither of them notices when the prose
# explaining what a scope is FOR stops matching the scopes there are, and that is
# the leg this repository has actually got wrong: a comment claiming the app and
# model lists matched when one spelling carried `:read` and the other did not, and
# three counts across two files of which two were stale within a day of the Vector
# Search pair landing. bundle/scope-contract.json is generated from databricks.yml,
# the probe table and the agent's own constants, so that leg is now checkable
# rather than merely written down.
#
# NO EXTRA API CALL. It reads the $APP_JSON this step already fetched, so the
# added cost is one python process on a file. `validate` was being run 14 times
# per release before the resolution was cached once, and a gate that quietly adds
# a workspace round trip is how that comes back.
step "Scope contract: declared vs documented vs effective"
if [[ -x "$BUNDLE_ROOT/bundle/scope-contract.py" || -f "$BUNDLE_ROOT/bundle/scope-contract.py" ]]; then
  CONTRACT_APP_JSON="$(mktemp "${TMPDIR:-/tmp}/pia-app-json.XXXXXX")"
  printf '%s' "$APP_JSON" > "$CONTRACT_APP_JSON"
  CONTRACT_STATUS=0
  python3 "$BUNDLE_ROOT/bundle/scope-contract.py" --check --live "$CONTRACT_APP_JSON" \
    || CONTRACT_STATUS=$?
  rm -f "$CONTRACT_APP_JSON"
  # Exit 2 is "could not run", which is not a finding and must not stop a release
  # over a check that was unavailable; exit 1 is the disagreement itself.
  if [[ "$CONTRACT_STATUS" -eq 1 ]]; then
    die "The scopes this deployment declares, documents and holds do not agree.

Read the FAIL lines above. If the contract is simply behind the bundle:

  python3 bundle/scope-contract.py --generate

and commit the result. If a scope is declared and not in effect, that is the
restart above, not a contract problem."
  elif [[ "$CONTRACT_STATUS" -ne 0 ]]; then
    # SAID OUT LOUD, because it was not before. Exit 2 deliberately does not stop
    # the release, but until now it also printed nothing of its own, so a release
    # whose contract check never ran looked exactly like one where it passed --
    # and the loudest way to reach exit 2 is to DELETE bundle/scope-contract.json,
    # which is the artifact the whole check compares against. A gate that a
    # missing file turns off quietly is the shape this repository keeps shipping:
    # a leak rule that matched nothing, four suites that asserted nothing, a `sed`
    # script whose every rule was a no-op. All of them exited without complaint.
    note ""
    note "NOT CHECKED. The scope contract could not run (exit $CONTRACT_STATUS), so the"
    note "documented leg was not compared against anything. Read the COULD NOT RUN"
    note "line above: this is not the three legs agreeing, it is nobody having asked."
    note ""
    note "This does not stop the release, on purpose -- an unavailable check is not a"
    note "finding. But do not read the rest of this run as having covered it. If"
    note "bundle/scope-contract.json is missing, restore or regenerate it:"
    note ""
    note "  python3 bundle/scope-contract.py --generate   # then commit the result"
  fi
else
  note "This tree carries no bundle/scope-contract.py, so the documented leg was"
  note "not checked. The declared-vs-effective comparison above still ran."
fi

# LAST, and in SHADOW, on purpose.
#
# Last because it asks the RUNNING app about itself through its own public
# routes. Run any earlier and it would certify the deployment this release just
# replaced, which is worse than not certifying at all: it would produce a
# durable record, against a release tuple naming the new build, out of the old
# one's answers.
#
# Shadow because a gate that stops a demo is worse than no gate. The runner
# exits 0 in this mode whatever it finds, and the `if !` covers the other case:
# a crash here would report a broken release over a deployment that is already
# up and correct. The verdict is in the certificate either way, so promoting on
# it later is a matter of reading the record rather than of rerunning anything.
#
# The gating checks above are deliberately NOT removed in favour of this. They
# stop the release BEFORE the upload, and ownership in particular cannot be
# repaired afterwards.
step "Release certification (shadow, never gates)"
CERTIFY="$BUNDLE_ROOT/bundle/certify-release.sh"
if [ "$CERTIFY_RUN" != true ]; then
  # OPT-IN SINCE 2026-08-17, and the reason is measured. It cost 16 seconds of a
  # 175-second release, gated nothing, and ended every run with about forty lines
  # of NOT ATTESTED -- which is the last thing on screen after a deploy, so it
  # buried the scope table and the app URL above it. Its verdict is a durable
  # record to read later, not something to produce before anybody has asked.
  #
  # UNCHANGED AND STILL RUNNABLE, on this release or on a deployment somebody
  # else made:  TARGET=$TARGET bundle/certify-release.sh
  note "Not run. Pass --certify to issue a certificate for this release, or run"
  note "bundle/certify-release.sh against the deployment at any time: it only reads."
elif [ ! -f "$CERTIFY" ]; then
  note "This tree carries no certification runner, so no certificate was issued."
elif ! TARGET="$TARGET" PROFILE="$PROFILE" bash "$CERTIFY"; then
  note ""
  note "Certification did not run to completion. The release itself is unaffected:"
  note "everything above already happened, and this step only records what it found."
fi
