#!/usr/bin/env bash
# Emit the complete Databricks App spec for a target and optionally apply it.
#
# Apps updates replace the full spec. This script derives the complete body from
# the resolved bundle so resource attachments and OAuth scopes stay intact.
#
# Usage:
#   TARGET=<your-target>                            bundle/app-spec.sh            # print
#   TARGET=<your-target>                            bundle/app-spec.sh --apply
#   TARGET=customer PROFILE=<their-profile> bundle/app-spec.sh --apply
#
# TARGET has no default here, and that is deliberate even though databricks.yml
# does mark one target as `default: true`. A script that fell through to the
# bundle's default would aim a customer's recovery at whichever target happens to
# carry that flag rather than at the one they meant.
#
# PREFER THE BUNDLE. `bundle deploy` owns this resource and cannot produce a
# partial update either. Reach for this only when the bundle is not an option:
# recovering a wiped spec, or attaching resources to an app that was created
# outside the bundle (the git-deploy path).

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

APPLY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true ;;
    --allow-missing-endpoint)
      die "--allow-missing-endpoint was removed.

That flag existed so an app shell could be attached to a serving endpoint that
did not exist yet, solely to mint the app service principal before a model
release. The SP Unity Catalog data gate that needed that principal is gone;
governed reads run as the signed-in user. Create the endpoint with
bundle/agent-release.sh first, then create or update the app. There is no
escape hatch past a missing endpoint any more." ;;
    *) die "unknown argument: $1

  TARGET=<target> bundle/app-spec.sh [--apply]" ;;
  esac
  shift
done

require_cmd databricks
require_cmd python3

require_target
# Kept for the dry run's copy-paste hint. resolve_profile fills PROFILE in from
# the bundle when the target names one, and echoing a resolved value back as
# though the caller had to supply it produces an unquoted `PROFILE=two words`,
# which the shell reads as an assignment followed by a command.
CALLER_PROFILE="${PROFILE:-}"
resolve_profile
load_bundle_json

# --- The spec, straight out of the bundle ------------------------------------
#
# `bundle validate -o json` resolves every ${var.*} for the named target, so what
# comes back here is what `bundle deploy` would send. Two fields are dropped:
# `lifecycle` is bundle bookkeeping the Apps API does not accept, and
# `source_code_path` is owned by `apps deploy`, not by the app spec. Sending it
# here would be a second copy of a value bundle/app-release.sh already owns.
#
# Everything else is asserted rather than assumed. These checks cannot fire for a
# bundle that is internally consistent; they exist so that a bundle edit which
# quietly drops a load-bearing field stops this script instead of shipping a
# partial spec with replace semantics behind it.
# `mktemp -t PREFIX` (a prefix with no X's) is BSD-only syntax. GNU coreutils
# treats the argument as a template and refuses one with fewer than three X's,
# so on Linux this line aborts the script under `set -e` before it has done
# anything. The four other mktemp calls in this repo already use the form below;
# this file was the only one that did not.
FACTS="$(mktemp "${TMPDIR:-/tmp}/player-insights-app-spec-facts.XXXXXX")"
trap 'rm -f "$FACTS"' EXIT

# NO APOSTROPHES ANYWHERE BELOW, INCLUDING IN COMMENTS AND IN MESSAGE TEXT. The
# program is passed as a single-quoted shell argument, so an apostrophe in a word
# like "user's" closes that argument early, and bash then fails to parse the REST
# OF THE FILE, reporting an unexpected EOF at the closing line of the script
# rather than at the word responsible. Phrase it "of the signed-in user" instead.
SPEC="$(bundle_json | python3 -c '
import json, sys

REQUIRED_SCOPES = {
    # Resolves the attached endpoint into DATABRICKS_SERVING_ENDPOINT_NAME.
    "serving.serving-endpoints",
    # Requested so a forwarded user token can INVOKE the endpoint rather than
    # merely resolve it. It does not achieve that today: the invocation is
    # refused, the app retries as its own service principal, and the answer
    # discloses the fallback.
    #
    # KEEP THIS SET MINIMAL, and do not add a scope on the reasoning that an
    # unused one is harmless. Consent is all-or-nothing, so every scope here is a
    # way for a user who cannot be granted it to fail sign-in outright, with a
    # platform-level error the app never sees.
    "model-serving",
    # Lets the access gate re-run the dependency checks as the SIGNED-IN USER.
    "sql",
    # Lets the gate ask whether a Genie space is shared with the signed-in user.
    "dashboards.genie",
    # DELIBERATELY NOT THE `catalog.*`, `workspace.*` AND `vectorsearch.*`
    # SCOPES. This set is the hard floor for EVERY target -- a recovery aborts
    # without one -- so it holds only scopes whose absence is unrecoverable. The
    # catalog, workspace and Vector Search browse scopes are optional for the
    # login gate, so they stay out of this floor. All declared scopes are still
    # sent: the spec below
    # is generated from the resolved bundle, so whatever the target declares is
    # what goes. The tests that hold them are server/lib/user-api-scopes.test.ts,
    # which pins the shared default against the APIs the probes call, rather
    # than a list somebody has to remember to update.
}

bundle = json.load(sys.stdin)
apps = bundle.get("resources", {}).get("apps", {})
app = apps.get("player_insights_app")
if app is None:
    sys.exit(
        "the bundle resolved no app named player_insights_app.\n"
        "resources/player_insights_app.app.yml is what defines it."
    )

spec = {k: v for k, v in app.items() if k not in ("lifecycle", "source_code_path")}

problems = []

def unresolved(node, path="spec"):
    if isinstance(node, str):
        if "${" in node:
            problems.append(f"{path} still contains an unresolved reference: {node}")
    elif isinstance(node, dict):
        for k, v in node.items():
            unresolved(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            unresolved(v, f"{path}[{i}]")

unresolved(spec)

for field in ("name", "description"):
    if not spec.get(field):
        problems.append(f"spec.{field} is empty")

scopes = set(spec.get("user_api_scopes") or [])
missing = REQUIRED_SCOPES - scopes
if missing:
    problems.append(
        "user_api_scopes is missing " + ", ".join(sorted(missing)) + ".\n"
        "  Every one is load-bearing and this body REPLACES the live list, so\n"
        "  sending it would drop them. Fix resources/player_insights_app.app.yml."
    )

resources = {r.get("name"): r for r in (spec.get("resources") or [])}
postgres = resources.get("postgres", {}).get("postgres") or {}
endpoint = resources.get("serving-endpoint", {}).get("serving_endpoint") or {}
if not postgres.get("branch") or not postgres.get("database"):
    problems.append(
        "the `postgres` app resource is missing or incomplete.\n"
        "  Without it the app never resolves LAKEBASE_ENDPOINT, starts anyway,\n"
        "  returns HTTP 200 and answers from representative data."
    )
if not endpoint.get("name"):
    problems.append(
        "the `serving-endpoint` app resource is missing or incomplete.\n"
        "  Without it the app never resolves DATABRICKS_SERVING_ENDPOINT_NAME."
    )
warehouse = resources.get("sql-warehouse", {}).get("sql_warehouse") or {}
if not warehouse.get("id"):
    problems.append(
        "the `sql-warehouse` app resource is missing or incomplete.\n"
        "  Two things need it. app.yaml maps this resource to\n"
        "  DATABRICKS_SQL_WAREHOUSE_ID through `valueFrom`, which is how the app\n"
        "  learns which warehouse to run the access gate probe on, and the\n"
        "  attachment is what makes the PLATFORM ISSUE THE GRANT on it at deploy\n"
        "  time. Undeclared, neither the app service principal nor the deployer is\n"
        "  added to it.\n"
        "  The agent does not read the id from here: it takes its warehouse from\n"
        "  the model artifact, baked at log time from var.warehouse_id, so the two\n"
        "  can differ in a deployment that re-logs the model."
    )

if problems:
    sys.exit("\n".join(problems))

# Carried out of band for the workspace-identity checks below. The project id is
# the first path segment of the branch resource name.
print(postgres["branch"].split("/")[1], file=sys.stderr)
print(endpoint["name"], file=sys.stderr)
print(json.dumps(spec, indent=2, sort_keys=True))
' 2>"$FACTS")" || die "could not build the app spec for target '$TARGET':

$(cat "$FACTS" 2>/dev/null)"

LAKEBASE_PROJECT="$(sed -n 1p "$FACTS")"
ENDPOINT_NAME="$(sed -n 2p "$FACTS")"

APP_NAME="$(printf '%s' "$SPEC" | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')"

step "App spec for target '$TARGET'"
note "app             $APP_NAME"
note "profile         $PROFILE"
note "lakebase        $LAKEBASE_PROJECT"
note "endpoint        $ENDPOINT_NAME"
printf '\n%s\n' "$SPEC"

if [[ "$APPLY" != true ]]; then
  # Keep profile names with spaces quoted in the copy-paste command.
  PROFILE_HINT=""
  [[ -n "$CALLER_PROFILE" ]] && PROFILE_HINT=" PROFILE=\"$CALLER_PROFILE\""
  cat <<EOF

Dry run. Nothing was sent.

To apply, which REPLACES the live app spec in its entirety:
  TARGET=$TARGET$PROFILE_HINT bundle/app-spec.sh --apply
EOF
  exit 0
fi

# --- Guards that only matter when we are about to write ----------------------
#
# The spec above can only carry this target's values. What it cannot know is
# whether the WORKSPACE we are about to send it to is the one those values
# describe. These three checks establish that, and they are the reason the
# checked-in file could not be made safe: a file has no target to be checked
# against.

step "Checking the spec belongs to the workspace we are sending it to"

BUNDLE_HOST="$(bundle_json | python3 -c "
import json,sys
print((json.load(sys.stdin).get('workspace',{}).get('host') or '').rstrip('/'))
")"
PROFILE_HOST="$(databricks auth describe --profile "$PROFILE" -o json 2>/dev/null | python3 -c "
import json,sys
try:
    print((json.load(sys.stdin).get('details',{}).get('host') or '').rstrip('/'))
except Exception:
    print('')
")"
[[ -n "$PROFILE_HOST" ]] || die "could not resolve a workspace host for profile '$PROFILE'.
  databricks auth describe --profile \"$PROFILE\""
if [[ -n "$BUNDLE_HOST" && "$BUNDLE_HOST" != "$PROFILE_HOST" ]]; then
  die "target '$TARGET' describes $BUNDLE_HOST but profile '$PROFILE' points at $PROFILE_HOST.

Sending this spec would attach an app in one workspace to resources named in
another. Use the profile for the target's own workspace."
fi
note "host            $PROFILE_HOST"

# Lakebase is provisioned outside this bundle and named by id; a spec carrying
# another account's project id must not be applied here.
HERE="$(databricks postgres list-projects --profile "$PROFILE" -o json 2>/dev/null | python3 -c "
import json,sys
try:
    print(' '.join(sorted(p.get('project_id','') for p in (json.load(sys.stdin) or []))))
except Exception:
    print('')
")"
if [[ " $HERE " != *" $LAKEBASE_PROJECT "* ]]; then
  die "the spec names Lakebase project '$LAKEBASE_PROJECT', which does not exist in
this workspace.
  $(printf '%s' "${HERE:-(none)}" | tr ' ' '\n' | wc -l | tr -d ' ') projects here, listed by:
    databricks postgres list-projects --profile \"$PROFILE\"

This is the check that stops one account's app being attached to another
account's database. Either the target's lakebase_project_id is wrong, or the
Lakebase project has not been provisioned in this workspace yet. Create the
project outside the bundle, set lakebase_project_id to its id, and run this
afterwards."
fi
note "lakebase        $LAKEBASE_PROJECT exists here"

# Apps.Create and apps update both refuse (or attach to nothing) when the named
# endpoint is missing. The endpoint is created by agent-release.sh; run that
# before creating or recovering the app. There is deliberately no flag past this:
# the old --allow-missing-endpoint path existed only to mint an app SP for a
# Unity Catalog data gate that no longer runs.
if databricks serving-endpoints get "$ENDPOINT_NAME" --profile "$PROFILE" >/dev/null 2>&1; then
  note "endpoint        $ENDPOINT_NAME exists here"
else
  die "the spec attaches serving endpoint '$ENDPOINT_NAME', which does not exist in
this workspace.

Create it first:
  TARGET=$TARGET bundle/agent-release.sh --apply

Then re-run this. Applying a recovery against a missing endpoint would leave the
app attached to nothing: starting cleanly, returning HTTP 200, and answering
every question from representative data."
fi

# --- Apply -------------------------------------------------------------------

step "Applying (REPLACES the live app spec)"
PAYLOAD="$(mktemp "${TMPDIR:-/tmp}/player-insights-app-spec.XXXXXX")"
trap 'rm -f "$FACTS" "$PAYLOAD"' EXIT
printf '%s\n' "$SPEC" >"$PAYLOAD"

databricks apps update "$APP_NAME" --profile "$PROFILE" --json "@$PAYLOAD"

step "Verifying what the API kept"
databricks apps get "$APP_NAME" --profile "$PROFILE" -o json | python3 -c '
import json, sys
app = json.load(sys.stdin)
resources = [r.get("name") for r in (app.get("resources") or [])]
scopes = app.get("user_api_scopes") or []
print("  resources       " + (", ".join(resources) or "NONE"))
print("  user_api_scopes " + (", ".join(scopes) or "NONE"))
missing = {"postgres", "serving-endpoint", "sql-warehouse"} - set(resources)
if missing:
    sys.exit("\nthe update did not keep " + ", ".join(sorted(missing)))
'

cat <<'EOF'

Done. Two things this recovery command did NOT do, and both matter:

  1. Postgres grants are not restored by app-spec.sh. The canonical app release
     applies them automatically. If this recovery reattached `postgres` and no
     full release is needed, use the same target-aware hook, then restart:
       TARGET=<target> PROFILE=<profile> bundle/app-db-grant.sh
  2. Adding a user_api_scope needs a full app stop and start to take effect. A
     redeploy leaves it inert.

Verify against the LIVE app, not against psql. A psql session proves the grants
exist, not that the app picked them up:
  curl -s -H "Authorization: Bearer $(databricks auth token --profile "<profile>" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')" \
    "$APP_URL/api/storage"
EOF
