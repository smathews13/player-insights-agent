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
source "$(dirname "${BASH_SOURCE[0]}")/app-source-staging.sh"

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
# One working tree, one workspace source directory, one snapshot. A second app
# release on this machine must stop before either run builds or uploads; otherwise
# the active deployment can pair one build's index.html with another build's
# hashed assets and the browser receives HTML where it asked for JavaScript.
acquire_run_lock "app-release-${TARGET}-${PROFILE}"
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
  databricks apps deploy "$APP_NAME" --source-code-path "$ROLLBACK_TO" --mode SNAPSHOT --profile "$PROFILE"
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
  1. install exact package-lock dependencies with npm ci when node_modules is absent
  2. resolve the MLflow experiment id for '$TARGET' out of the bundle
  3. run the focused release-critical app/session/migration tests (not full Vitest)
  4. npm run build:deploy        (vite client build + esbuild server bundle)
  5. check the app owns its Postgres schema. THIS ONE STOPS THE RELEASE, before
     anything is uploaded: ownership cannot be repaired by a later deploy.
  6. resolve the app role, direct Lakebase branch host, Postgres database and
     operator role from the live bundle resources, then run
     scripts/grant-app-db-access.mjs. This STOPS the release on failure.
  7. verify the active deployment runs from Databricks' separate SNAPSHOT path,
     then safety-check that $SRC_PATH is this app's staging directory directly
     below /Workspace/Users/<current actor>/
  8. recursively delete ONLY that validated mutable staging directory, then
     databricks workspace import-dir build/deploy $SRC_PATH --overwrite
     A delete or import failure stops here; the active snapshot keeps running.
  9. databricks apps deploy $APP_NAME --source-code-path $SRC_PATH --mode SNAPSHOT
 10. restore player-insights-agent/build/deploy/app.yaml, which the build wrote
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

# Public customer clones deliberately carry no node_modules. Install the locked
# dependency tree before invoking TypeScript or Vite rather than failing with
# `tsc: command not found` halfway through an app release.
if [[ ! -d "$APP_DIR/node_modules" ]]; then
  step "Installing locked app build dependencies"
  (cd "$APP_DIR" && npm ci)
fi

# Release-critical only. The complete 7k+ Vitest suite, Python suite, typecheck,
# lint, format, and checker-regression suites live behind one explicit manual
# command: bundle/release-checks.sh full. Re-running those on every app upload
# made the release path slower without making this operation safer.
FAST_CHECKS="$BUNDLE_ROOT/bundle/release-checks.sh"
if [[ -f "$FAST_CHECKS" ]]; then
  bash "$FAST_CHECKS" fast
else
  die "bundle/release-checks.sh is missing, so the release-critical app, session,
migration, and access invariants were not checked. Restore it before releasing."
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
LLM_ENDPOINT="$(bundle_var llm_endpoint)"
note "foundation model     $LLM_ENDPOINT"

# Catalog, schema and Genie ids this release may read. Connections and the
# access gate used to ping the live agent for this list, which created ~1ms
# MLflow traces named `preflight`. They now read these env vars instead, and
# qualify the committed data contract when catalog+schema are present.
CATALOG="$(bundle_var app_catalog)"
SCHEMA="$(bundle_var app_schema)"
SEMANTIC_INDEX_ENDPOINT="$(bundle_var_or_empty semantic_index_endpoint)"
SEMANTIC_INDEX_NAME="$(bundle_var_or_empty semantic_index_name)"
if [[ -n "$SEMANTIC_INDEX_ENDPOINT" && -z "$SEMANTIC_INDEX_NAME" ]]; then
  die "semantic_index_endpoint is set but semantic_index_name is empty. Cost and
Connections need the active full index name to verify that endpoint billing
belongs to this deployment. Set semantic_index_name to the index used by the
served model, or clear semantic_index_endpoint for a deployment without it."
fi
if [[ -z "$SEMANTIC_INDEX_ENDPOINT" && -n "$SEMANTIC_INDEX_NAME" ]]; then
  die "semantic_index_name is set but semantic_index_endpoint is empty. Set both
active Vector Search identities or clear both."
fi
if [[ -n "${PLAYER_INSIGHTS_DATA_GENIE_ID:-}" ]]; then
  DATA_GENIE_ID="$PLAYER_INSIGHTS_DATA_GENIE_ID"
else
  DATA_GENIE_ID="$(bundle_var genie_data_space_id)"
fi
if [[ -n "${PLAYER_INSIGHTS_DICTIONARY_GENIE_ID:-}" ]]; then
  DICT_GENIE_ID="$PLAYER_INSIGHTS_DICTIONARY_GENIE_ID"
else
  DICT_GENIE_ID="$(bundle_var genie_dictionary_space_id)"
fi
note "data contract        $CATALOG.$SCHEMA"
note "data genie space     $DATA_GENIE_ID"
note "dictionary genie     $DICT_GENIE_ID"
note "semantic index       ${SEMANTIC_INDEX_NAME:-(not configured)}"
note "semantic endpoint    ${SEMANTIC_INDEX_ENDPOINT:-(not configured)}"

# One live source of truth before any upload. The index names its hosting
# endpoint; a second independently maintained release value may describe drift
# but may never be shipped as though it were current.
if [[ -n "$SEMANTIC_INDEX_NAME" ]]; then
  SEMANTIC_INDEX_JSON="$(databricks vector-search-indexes get-index "$SEMANTIC_INDEX_NAME" --profile "$PROFILE" -o json)" \
    || die "Could not read semantic index $SEMANTIC_INDEX_NAME. No app files were uploaded."
  read -r LIVE_SEMANTIC_ENDPOINT SEMANTIC_INDEX_READY < <(
    python3 -c 'import json,sys
body=json.load(sys.stdin)
print((body.get("endpoint_name") or "").strip(), str(bool((body.get("status") or {}).get("ready"))).lower())' \
      <<<"$SEMANTIC_INDEX_JSON"
  )
  [[ "$SEMANTIC_INDEX_READY" == "true" ]] \
    || die "Semantic index $SEMANTIC_INDEX_NAME is not ready. No app files were uploaded."
  [[ -n "$LIVE_SEMANTIC_ENDPOINT" ]] \
    || die "Semantic index $SEMANTIC_INDEX_NAME reported no hosting endpoint. No app files were uploaded."
  [[ "$SEMANTIC_INDEX_ENDPOINT" == "$LIVE_SEMANTIC_ENDPOINT" ]] \
    || die "semantic_index_endpoint does not match the active index host. Update the target override before release."
  SEMANTIC_ENDPOINT_JSON="$(
    databricks vector-search-endpoints get-endpoint "$LIVE_SEMANTIC_ENDPOINT" --profile "$PROFILE" -o json
  )" || die "Could not read semantic endpoint $LIVE_SEMANTIC_ENDPOINT. No app files were uploaded."
  SEMANTIC_ENDPOINT_STATE="$(
    python3 -c 'import json,sys; print(((json.load(sys.stdin).get("endpoint_status") or {}).get("state") or "").upper())' \
      <<<"$SEMANTIC_ENDPOINT_JSON"
  )"
  [[ "$SEMANTIC_ENDPOINT_STATE" == "ONLINE" ]] \
    || die "Semantic endpoint $LIVE_SEMANTIC_ENDPOINT is not ONLINE. No app files were uploaded."
fi

# The semantic rebuild job is bundle-owned when the target declares it. Its id
# is the billing join key; a name match would be guesswork and can collide with
# another deployment. Targets without the job keep the authored empty value.
INDEX_REBUILD_JOB_ID="$(bundle_json | python3 -c '
import json,sys
job=json.load(sys.stdin).get("resources",{}).get("jobs",{}).get("player_insights_semantic_rebuild",{})
print(job.get("id") or "")
')"
note "semantic rebuild job ${INDEX_REBUILD_JOB_ID:-(not declared)}"

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
ORGANIZATIONS="${PLAYER_INSIGHTS_ORGANIZATIONS:-$(bundle_var_or_empty organization_domains)}"
# Optional deployment-only feedback destination. These values never come from
# authored defaults or a public bundle variable; the release environment owns
# them and bundle-server writes them only into the generated app.yaml that this
# script uploads and restores on every exit path.
FEEDBACK_SLACK_URL="${PLAYER_INSIGHTS_FEEDBACK_SLACK_URL:-}"
FEEDBACK_SLACK_LABEL="${PLAYER_INSIGHTS_FEEDBACK_SLACK_LABEL:-}"
# Empty means the server uses its compiled, customer-neutral product defaults.
# A deployment may provide a validated JSON array / replace object, or an
# explicit {"mode":"extend","templates":[...]} object whose IDs must not
# collide with defaults. The environment wins over an optional private target
# overlay. Invalid overrides fail closed in the server instead of falling back.
PERSONA_TEMPLATE_OVERRIDE="${PLAYER_INSIGHTS_PERSONA_TEMPLATES:-}"
PERSONA_TEMPLATE_OVERLAY="$BUNDLE_ROOT/bundle/targets/$TARGET/persona-templates.json"
if [[ -z "$PERSONA_TEMPLATE_OVERRIDE" && -f "$PERSONA_TEMPLATE_OVERLAY" ]]; then
  PERSONA_TEMPLATE_OVERRIDE="$(python3 - "$PERSONA_TEMPLATE_OVERLAY" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.dumps(json.load(handle), separators=(",", ":")))
PY
)"
fi
IDLE_TIMEOUT="${PLAYER_INSIGHTS_IDLE_TIMEOUT_MINUTES:-$(bundle_var_or_empty app_idle_timeout_minutes)}"
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
     PLAYER_INSIGHTS_INDEX_REBUILD_JOB_ID="$INDEX_REBUILD_JOB_ID" \
     PLAYER_INSIGHTS_SHARED_CONVERSATION_RAIL="$SHARED_RAIL" \
     PLAYER_INSIGHTS_JUDGE_ENDPOINT="$JUDGE_ENDPOINT" \
     PLAYER_INSIGHTS_LLM_ENDPOINT="$LLM_ENDPOINT" \
     PLAYER_INSIGHTS_CATALOG="$CATALOG" \
     PLAYER_INSIGHTS_SCHEMA="$SCHEMA" \
     PLAYER_INSIGHTS_SEMANTIC_INDEX="$SEMANTIC_INDEX_NAME" \
     PLAYER_INSIGHTS_SEMANTIC_ENDPOINT="$SEMANTIC_INDEX_ENDPOINT" \
     PLAYER_INSIGHTS_DATA_GENIE_ID="$DATA_GENIE_ID" \
     PLAYER_INSIGHTS_DICTIONARY_GENIE_ID="$DICT_GENIE_ID" \
     PLAYER_INSIGHTS_TELEMETRY_SCHEMA="$TELEMETRY_SCHEMA" \
     PLAYER_INSIGHTS_USER_API_SCOPES="$DECLARED_SCOPES" \
     PLAYER_INSIGHTS_ADMIN_EMAILS="$ADMIN_EMAILS" \
     PLAYER_INSIGHTS_ORGANIZATIONS="$ORGANIZATIONS" \
     PLAYER_INSIGHTS_FEEDBACK_SLACK_URL="$FEEDBACK_SLACK_URL" \
     PLAYER_INSIGHTS_FEEDBACK_SLACK_LABEL="$FEEDBACK_SLACK_LABEL" \
     PLAYER_INSIGHTS_PERSONA_TEMPLATES="$PERSONA_TEMPLATE_OVERRIDE" \
     PLAYER_INSIGHTS_IDLE_TIMEOUT_MINUTES="$IDLE_TIMEOUT" \
     PLAYER_INSIGHTS_APP_SCHEMA="$LAKEBASE_APP_SCHEMA" \
     npm run build:deploy)

read -r SOURCE_FILE_COUNT SOURCE_BYTE_COUNT SOURCE_MANIFEST_SHA < <(
  app_source_manifest_summary "$DEPLOY_TREE"
)
note "source manifest      $SOURCE_FILE_COUNT files, $SOURCE_BYTE_COUNT bytes"
note "source manifest sha  $SOURCE_MANIFEST_SHA"

# The broad live advisory sweep remains useful before a handoff, but it repeats
# resource/scope reads already made by release-gate.sh and can wait 75 seconds on
# storage health. It is intentionally manual, not part of every code upload:
#   TARGET=<target> PROFILE=<profile> bundle/preflight.sh --live

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

step "Replacing validated staging source at $SRC_PATH"
clean_and_import_app_source "$DEPLOY_TREE" "$SRC_PATH" "$APP_NAME" "$PROFILE"

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
databricks apps deploy "$APP_NAME" --source-code-path "$SRC_PATH" --mode SNAPSHOT --profile "$PROFILE"

step "Status"
APP_JSON="$(databricks apps get "$APP_NAME" --profile "$PROFILE" -o json)"
printf '%s' "$APP_JSON" | python3 -c "
import json,sys
a=json.load(sys.stdin)
print('  app_status      :', a.get('app_status',{}).get('state'))
print('  deployment      :', a.get('active_deployment',{}).get('status',{}).get('state'))
print('  url             :', a.get('url'))
"

# release-gate.sh already compared declared, documented, and effective scopes
# before this code upload. `apps deploy` does not mutate the App resource or its
# OAuth policy, so repeating the same checker on the same contract here added no
# safety. The status read above remains the one post-deploy platform read.

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
