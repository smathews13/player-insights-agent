#!/usr/bin/env bash
# Log and deploy the agent model. THIS STEP IS IMPERATIVE BY NECESSITY.
#
# `databricks.agents.deploy()` does far more than create a serving endpoint: it
# provisions the review app, the feedback model, the auth policy that carries
# automatic authentication passthrough for the model's declared resources, and
# the inference tables. A `model_serving_endpoints` bundle resource declares only
# the core endpoint config, so declaring one here would fight agents.deploy on
# every deploy and would drop the passthrough policy the Genie calls depend on.
# The bundle therefore REFERENCES the endpoint by name (var.serving_endpoint_name)
# so the app can attach it, and this script owns its lifecycle.
#
# The same applies to the registered model: mlflow.pyfunc.log_model(
# registered_model_name=...) creates and versions it. A registered_models bundle
# resource would put every logged version inside `bundle destroy`'s blast radius.
#
# All configuration is read out of the bundle. There is no second copy.
#
# Usage:
#   TARGET=<your-target> bundle/agent-release.sh            # dry run
#   TARGET=<your-target> bundle/agent-release.sh --apply
#   ... --apply --skip-log --model-version 8    # deploy an already-logged version
#
# TARGET has no default. PROFILE is optional for a target that names its profile in
# databricks.yml; every other target must state one.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
source "$(dirname "${BASH_SOURCE[0]}")/decisions-gate.sh"

APPLY=false; SKIP_LOG=false; MODEL_VERSION=""; ALLOW_WIDENING=false; IGNORE_APP_INTENTIONS=false
# Remove superseded served entities once the traffic switch has settled. On by
# default: leaving them is what took the demo endpoint to ten entities and
# 40 DBU/h with nine of them answering nothing. How many rollbacks survive is
# var.serving_rollbacks_kept, not a flag, so it is written down per target. That
# variable now defaults to 0, so the normal release leaves NO rollback entity:
# the version a rollback would reach is the one released before the current fix.
# Retreating is still available and does not need capacity held open for it --
# the registry is never pruned, so any version can be re-served on demand.
PRUNE=true
# Every version is logged so Genie and SQL run as the identity that invoked the
# endpoint. This was a flag, and defaulting it to off cost a release: the app
# refuses every question when it is paired with a version logged without the
# policy, so the only value that ever worked here was true, and the flag existed
# only to be forgotten.
USER_AUTHORIZATION=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true ;;
    --skip-log) SKIP_LOG=true ;;
    --model-version) MODEL_VERSION="$2"; shift ;;
    # Releases even when the app holds an intention this release would not log.
    # See correlate_with_app. A flag rather than a silent tolerance, for the same
    # reason as --allow-widening: the disagreement is the finding.
    --ignore-app-intentions) IGNORE_APP_INTENTIONS=true ;;
    # Approves declaring tables the live version was not granted. Passed through
    # to log_model.py, which refuses to log a wider manifest without it. A flag
    # rather than an environment variable on purpose: the whole defect this
    # guards is a value that vanished from a shell.
    --allow-widening) ALLOW_WIDENING=true ;;
    # Leaves the superseded entities on the endpoint. For a release where
    # somebody wants several versions reachable for a while and will prune by
    # hand afterwards. The run still REPORTS what it would have removed, so
    # skipping the prune cannot look the same as having nothing to prune.
    --no-prune) PRUNE=false ;;
    # Accepted and does nothing: user authorization is now unconditional. Kept so
    # an older command line, or a transcript somebody is following, still runs.
    --user-authorization) ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

require_cmd databricks
require_cmd uv

require_target
resolve_profile
# One resolution of this target for the whole release, shared with anything this
# script spawns rather than paid for again by each of them.
seed_bundle_cache

CATALOG="$(bundle_var app_catalog)"
SCHEMA="$(bundle_var app_schema)"
WAREHOUSE_ID="$(bundle_var warehouse_id)"
MODEL_NAME="$(bundle_var model_name)"
ENDPOINT="$(bundle_var serving_endpoint_name)"
ROLLBACKS_KEPT="$(bundle_var serving_rollbacks_kept)"
EXPERIMENT="$(bundle_var experiment_path)"
LLM_ENDPOINT="$(bundle_var llm_endpoint)"
ALLOWLIST="$(bundle_var_csv data_catalogs)"
# Optional, and the only one here that is: an empty denylist is the normal case,
# so `bundle_var` would die on a target that has not set one.
DENYLIST="$(bundle_var_or_empty catalog_denylist)"
MAX_TOKENS="$(bundle_var max_output_tokens)"
# Also optional, for the same reason and then some: Unity AI Gateway is a
# binding a customer may or may not have, and empty (reach the serving endpoint
# directly) is both the default and what every target that predates this
# variable resolves to.
LLM_GATEWAY="$(bundle_var_or_empty llm_gateway)"
# Optional too, and defaulted in `Settings` rather than here, so that a target
# predating this variable resolves to the enumeration it has always done. What it
# selects is which tables become DatabricksTable resources. See MANIFEST_SOURCES
# in agent/preflight.py, including what `genie` costs in enforced governance.
MANIFEST_SOURCE="$(bundle_var_or_empty manifest_source)"
# NOTHING IS READ HERE ABOUT THE NATURE OF THE DATA. `synthetic_data` was read
# at this position, printed in the readout below, and exported into the log so
# the agent could append a sentence saying the figures were generated. Variable,
# readout and export are all gone; see databricks.yml.
# Optional, and empty is the safe case: the evidence gateway stays strict. NO
# TARGET SETS THIS, so reaching it requires editing databricks.yml, which is the
# point. It relaxes a control, and a control relaxed by a value nobody can find in
# a diff is a control that comes back off by accident. See databricks.yml.
ALLOW_UNATTRIBUTED_FIGURES="$(bundle_var_or_empty allow_unattributed_figures)"

# DERIVED FROM THE BUNDLE, because leaving it to the releaser's shell meant it was
# never set at all.
#
# The AI Search endpoint, the index over the semantic layer and the daily rebuild
# job went live on example on 2026-08-10, and every model version logged since has
# been logged WITHOUT this flag: `log_model.py` reads it from the environment, no
# target set it, this script never exported it, and nothing failed. So the tool was
# not offered, the served agent never queried the index, and the endpoint went on
# billing by the hour to answer nothing. Nothing surfaced it either, because a
# release with no semantic layer and one whose semantic layer was dropped look
# identical from every direction, which is what `semantic_retrieval.configuration_entry`
# was later added to fix.
#
# Tying it to `semantic_index_endpoint` puts the model's tool set and the resources
# the same bundle creates behind ONE decision. A target that declares an endpoint
# gets a model that searches the index that endpoint serves; a target that declares
# none, which is every customer target, gets no tool and no charge. The environment
# still wins when it is set, for adopting an index built elsewhere.
SEMANTIC_INDEX_ENDPOINT="$(bundle_var_or_empty semantic_index_endpoint)"
SEMANTIC_INDEX="${PLAYER_INSIGHTS_SEMANTIC_INDEX:-}"
SEMANTIC_INDEX_ORIGIN='set in the environment'
if [[ -z "$SEMANTIC_INDEX" ]]; then
  if [[ -n "$SEMANTIC_INDEX_ENDPOINT" ]]; then
    # `true` rather than a name: `resolve_index` derives it from this deployment's
    # catalog and schema, which is the same derivation the bundle's index name uses,
    # so the two cannot drift into a tool that queries an index nobody built.
    SEMANTIC_INDEX='true'
    SEMANTIC_INDEX_ORIGIN="derived: this target declares $SEMANTIC_INDEX_ENDPOINT"
  else
    SEMANTIC_INDEX_ORIGIN='none: this target declares no AI Search endpoint'
  fi
fi

# Genie space ids reach the model by one of three routes, in this order.
#
#   1. The environment, for the pre-deploy case: nothing has been created yet
#      and there is no bundle state to read an output out of.
#   2. `genie_*_space_id` in the bundle, for a deployment that ADOPTS a space it
#      did not create. A customer arriving with their own Genie estate has an id
#      already, and it is the value their analysts trust; the bundle creating a
#      second space over tables it invented does not replace that.
#   3. The bundle's own resource output, which is the ordinary case and is not a
#      variable at all: the space does not exist until `bundle deploy` makes it.
#
# Route 2 is why these are bundle variables rather than environment overrides
# only: a value that lives only in the shell that ran the release drops silently
# out of the next run from a clean one. See databricks.yml.
DATA_GENIE_ADOPTED="$(bundle_var_or_empty genie_data_space_id)"
DICT_GENIE_ADOPTED="$(bundle_var_or_empty genie_dictionary_space_id)"
DATA_GENIE_ID="${PLAYER_INSIGHTS_DATA_GENIE_ID:-${DATA_GENIE_ADOPTED:-$(bundle_resource_id genie_spaces data_genie_space)}}"
DICT_GENIE_ID="${PLAYER_INSIGHTS_DICTIONARY_GENIE_ID:-${DICT_GENIE_ADOPTED:-$(bundle_resource_id genie_spaces dictionary_genie_space)}}"
genie_origin() {
  # Which of the three routes a value came by. Printed, because "the id the
  # bundle made" and "the id the customer gave us" are the same shape of string
  # and produce very different deployments.
  if [[ -n "${1:-}" ]]; then printf 'from the environment'
  elif [[ -n "${2:-}" ]]; then printf 'ADOPTED, from the bundle variable'
  else printf 'created by this bundle'; fi
}

step "Agent release configuration (target: $TARGET)"
note "app catalog.schema    $CATALOG.$SCHEMA"
note "model                 $MODEL_NAME"
note "endpoint              $ENDPOINT"
note "rollbacks kept        $ROLLBACKS_KEPT$([[ "$PRUNE" == true ]] || echo '  (prune skipped: --no-prune)')"
note "experiment            $EXPERIMENT"
note "LLM endpoint          $LLM_ENDPOINT"
note "warehouse             $WAREHOUSE_ID"
note "data genie space      $DATA_GENIE_ID  ($(genie_origin "${PLAYER_INSIGHTS_DATA_GENIE_ID:-}" "$DATA_GENIE_ADOPTED"))"
note "dictionary genie      $DICT_GENIE_ID  ($(genie_origin "${PLAYER_INSIGHTS_DICTIONARY_GENIE_ID:-}" "$DICT_GENIE_ADOPTED"))"
note "data catalogs         $ALLOWLIST"
# Printed even when empty, and labelled, so "(none)" is a statement the operator
# read rather than a line they never saw. The failure this closes was invisible
# precisely because an absent denylist looked like every other run.
note "catalog denylist      ${DENYLIST:-(none)}"
# Same reasoning: printed even when empty. Which route the reasoning model was
# reached by is the sort of thing an operator should never have to infer.
note "AI Gateway            ${LLM_GATEWAY:-(none, direct to serving endpoint)}"
# Printed on every run for the same reason as the denylist: this was off for every
# release between 2026-08-10 and today while the endpoint it should have been using
# was online and billing, and nothing said so. An operator reading "(none)" against
# a target they know has an index is the check that was missing.
note "semantic index        ${SEMANTIC_INDEX:-(none)}  ($SEMANTIC_INDEX_ORIGIN)"
# No `data provenance` line is printed, because there is no longer a setting for
# an operator to get wrong: no release this script produces makes any claim about
# whether the data behind an answer is real or generated.
# Printed on every run, on or off, because "which identity did that answer run
# as" is the question this release changes and it should never be inferred.
#
# IDENTITY SPLIT (do not re-introduce an app-SP UC data gate here):
#   signed-in user  -- governed UC / Genie / SQL reads (execution_identity:
#                     user-authorization; the user's token)
#   app SP          -- app-owned Lakebase operational storage and non-data
#                     control-plane work only. Lakebase grants are checked after
#                     app creation (app-release / grant-app-db-access), not here.
# Asking Unity Catalog what the app SP can SELECT was wrong for this model: the
# deployer does not need READ_METADATA on customer catalogs merely to inspect
# the SP, and a fresh agent release must not require an app to exist first.
note "execution identity    user-authorization: governed UC/Genie/SQL run as"
note "                      the signed-in user. The app service principal is for"
note "                      Lakebase operational storage and control-plane work,"
note "                      not customer-data reads."
# Printed on every run for the same reason as the identity above: "why did that
# answer show a figure with no source" and "why did that chart refuse" are both
# this setting, and neither should have to be inferred from memory.
if [[ "$ALLOW_UNATTRIBUTED_FIGURES" == true ]]; then
  note "evidence gateway      PERMISSIVE (allow_unattributed_figures=true): Genie"
  note "                      figures that cannot be traced to a governed read are"
  note "                      ANSWERED WITH A CAVEAT rather than refused. For a demo"
  note "                      estate with no semantic metric layer. Protected-column"
  note "                      controls are unaffected."
else
  note "evidence gateway      strict (default): a Genie result whose figures cannot"
  note "                      be attributed is refused, and the model is told to ask"
  note "                      for a table instead."
fi

# Held against the standing decisions, HERE: after the readout, so the operator has
# just read the same values the gate is about to judge, and before the exports below,
# which is the last point at which nothing has happened yet. On a dry run it still
# runs, because a dry run is where somebody checks a target before committing to it.
#
# There is no flag past this and one must not be added. Every other gate in this
# script has one because every other gate asks a question about the world that can
# honestly be answered "I know, proceed". This one asks what we decided, and the
# failure it exists for was a synthetic-data setting that survived the instruction to
# remove it three times while being printed in this very readout on every run.
decisions_gate || exit $?

# These reach `log_model.py`, which resolves them into Settings and BAKES them
# into the model artifact (mlflow model_config). That is the only way they reach
# the serving container: a served entity inherits nothing from this shell, and
# the four variables it does carry are set by agents.deploy(). See config.py.
export DATABRICKS_CONFIG_PROFILE="$PROFILE"
export PLAYER_INSIGHTS_TARGET="$TARGET"
export PLAYER_INSIGHTS_CATALOG="$CATALOG"
export PLAYER_INSIGHTS_SCHEMA="$SCHEMA"
export PLAYER_INSIGHTS_WAREHOUSE_ID="$WAREHOUSE_ID"
export PLAYER_INSIGHTS_DATA_GENIE_ID="$DATA_GENIE_ID"
export PLAYER_INSIGHTS_DICTIONARY_GENIE_ID="$DICT_GENIE_ID"
export PLAYER_INSIGHTS_MODEL_NAME="$MODEL_NAME"
export PLAYER_INSIGHTS_ENDPOINT="$ENDPOINT"
export PLAYER_INSIGHTS_EXPERIMENT="$EXPERIMENT"
export PLAYER_INSIGHTS_LLM_ENDPOINT="$LLM_ENDPOINT"
export PLAYER_INSIGHTS_LLM_GATEWAY="$LLM_GATEWAY"
export PLAYER_INSIGHTS_CATALOG_ALLOWLIST="$ALLOWLIST"
export PLAYER_INSIGHTS_CATALOG_DENYLIST="$DENYLIST"
export PLAYER_INSIGHTS_MAX_OUTPUT_TOKENS="$MAX_TOKENS"
# Exported unconditionally, empty included, and for the denylist's reason rather
# than the gateway's: this decides how many tables the serving principal is
# granted SELECT on. A stale `genie` in an operator's shell would quietly release
# a model whose contract-bound governance behaviours are not in force, against a
# bundle that says nothing of the kind. Empty resolves to `schema` in Settings.
export PLAYER_INSIGHTS_MANIFEST_SOURCE="$MANIFEST_SOURCE"
# Always "true", and exported rather than assumed downstream, so a stale value in
# the operator's shell cannot decide which principal every data call runs as.
export PLAYER_INSIGHTS_USER_AUTHORIZATION="$USER_AUTHORIZATION"
# Exported unconditionally, empty included, for the reason above turned up one
# notch: this one decides whether figures a reader cannot check may reach a
# screen, and a stale "true" in an operator's shell must not be what decides it.
# Empty resolves to strict in `unattributed_figures`.
export PLAYER_INSIGHTS_ALLOW_UNATTRIBUTED_FIGURES="$ALLOW_UNATTRIBUTED_FIGURES"
# Exported unconditionally, empty included, and the empty half matters as much
# here as anywhere: a stale `true` in the shell of somebody who last released example
# would give a CUSTOMER target a search tool pointed at an index that workspace has
# no endpoint for, and every discovery step would fail inside a run. Empty means the
# tool is not offered at all, which is what a deployment with no semantic layer
# should look like.
export PLAYER_INSIGHTS_SEMANTIC_INDEX="$SEMANTIC_INDEX"

# The denylist is exported unconditionally, EMPTY INCLUDED. Assigning "" is the
# half that makes the bundle authoritative rather than merely consulted: without
# it, a stale PLAYER_INSIGHTS_CATALOG_DENYLIST in the operator's shell would
# survive into a release the bundle describes as having none, the same defect
# pointed the other way.
#
# Which leaves the rest of config.py's ENV_VARS. Three of them are read by
# `Settings.from_env` and have no bundle variable, so a value left in the shell
# would reach a release with nothing recording where it came from. None of the
# three should come from a shell, so the release clears them:
#
#   PLAYER_INSIGHTS_TABLES              the data contract, owned by
#                                       agent/preflight.py so the list that
#                                       grants access and the check that proves
#                                       it cannot drift. Overriding it can add
#                                       tables outside every allowlisted scope.
#   PLAYER_INSIGHTS_DECLARED_MANIFEST   generated at log time; log_model.py
#                                       overwrites it after from_env, so it is
#                                       already inert. Cleared so nobody has to
#                                       re-derive that to be sure.
#   PLAYER_INSIGHTS_*_GENIE_TITLE       resolved at log time from get_space.
#                                       Cleared so a laptop cannot invent a
#                                       title that disagrees with the space.
#
# Not cleared: the two Genie space ids above, which are documented overrides for
# the pre-deploy case.
unset PLAYER_INSIGHTS_TABLES
unset PLAYER_INSIGHTS_DECLARED_MANIFEST
unset PLAYER_INSIGHTS_DATA_GENIE_TITLE
unset PLAYER_INSIGHTS_DICTIONARY_GENIE_TITLE

# --- Does this release agree with what somebody saved in the app? ------------
#
# The failure this closes: a deployer opens the app, saves their warehouse id as
# the value they intend this deployment to use, and is told to run this script.
# They run it, from a laptop whose variable-overrides.json says something else. A
# model is logged with the OTHER value, and the app goes on reporting that
# resource as having an intended value that is not in effect, forever, with no
# explanation of why running the suggested command did not close it.
#
# Nothing is wrong with either half. The bundle is authoritative about what gets
# logged, and it should be. The app is honest that saving an intended value binds
# nothing, and it should be. What was missing is that the two were never
# compared, so a disagreement between them was silent, and silence is what every
# expensive failure in this system has in common.
#
# This does not make the app authoritative. It refuses, and says which value came
# from where. The deployer decides which one is right and fixes THAT, rather than
# discovering months later that a value somebody recorded described a workspace
# nobody deployed to.
#
# The join is `agentKey`, published by the app on each connected resource for
# this purpose, so there is no second copy of the resource-to-setting mapping. A
# copy of that mapping is how these two halves came to be able to disagree.
#
# READS /api/settings, HAVING READ /api/setup UNTIL 2026-08-10. The first-run
# wizard was deleted and its endpoint now answers 410 `setup_removed` to every
# caller by design, so this check reported "did not answer" on every run and
# passed. That is the worst state for a gate: permanently inert, still printing,
# and its noise teaching people to skim the release output where the live gates
# are. It was RE-POINTED rather than retired because the hazard did not go away
# with the wizard. `/api/settings` is its successor, it publishes the same
# `agentKey` vocabulary from the same shared/deployment-config.ts, and
# `resources[].intended` is exactly the old `steps[].intended`: a value somebody
# saved and has not applied. Retiring the check would have deleted the only
# thing that closes that loop.
#
# What did NOT survive the move is per-value proof of reachability. The wizard
# recorded whether it had watched a value work, which let this gate report a
# value proved UNREACHABLE instead of refusing over it. The settings payload has
# no equivalent, so that branch is gone rather than guessed at, and provenance is
# reported from `intendedBy`/`intendedAt` instead: who saved it and when.
correlate_with_app() {
  local app_name app_url token settings_json
  # `|| app_name=""` outside the substitution, not `|| true` inside it. bundle_var
  # reaches `die`, which is `exit 1`, and an `exit` in the left operand of `||`
  # ends the subshell without ever running the right one, so the substitution
  # still returned 1, `set -e` killed the release, and with stderr on /dev/null it
  # did so without printing anything. It also made the next line unreachable: a
  # target that declares no app_name could never get to the branch written for it.
  app_name="$(bundle_var app_name 2>/dev/null)" || app_name=""
  [[ -n "$app_name" ]] || { note "app                   (target declares none, nothing to correlate against)"; return 0; }

  app_url="$(databricks apps get "$app_name" --profile "$PROFILE" -o json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("url") or "")' 2>/dev/null || true)"
  if [[ -z "$app_url" ]]; then
    note "app intentions        not read: app '$app_name' is not serving yet."
    note "                      Expected before the first app release. Nothing to disagree with."
    return 0
  fi

  token="$(databricks auth token --profile "$PROFILE" 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null || true)"
  # Separate the status from the body, because a 401 here is a specific and
  # misleading failure: /api/settings is behind the app's identity gate, which
  # reads the `x-forwarded-email` header that Databricks Apps injects for a user.
  # A human's OAuth token gets that header and a 200. A service principal's does
  # not, so an automated caller is refused, and would otherwise fall into the
  # "did not answer" branch below and release unchecked, which is precisely the
  # silence this gate exists to break.
  local http_status=""
  settings_json=""
  if [[ -n "$token" ]]; then
    settings_json="$(curl -sS --max-time 20 -w '\n%{http_code}' \
      -H "Authorization: Bearer $token" "$app_url/api/settings" 2>/dev/null || true)"
    http_status="${settings_json##*$'\n'}"
    settings_json="${settings_json%$'\n'*}"
    [[ "$http_status" == "200" ]] || settings_json=""
  fi

  # REFUSES, rather than warning and returning 0 as it first did. A gate that
  # returns success for the one caller least able to satisfy it is not a gate: CI
  # is where a release goes out with nobody reading the output, so an advisory
  # note there is the same as no check at all. The escape hatch does the
  # releasing now, which is what makes it a decision rather than a tolerance.
  if [[ "$http_status" == "401" || "$http_status" == "403" ]]; then
    note "app intentions        NOT READ: $app_url/api/settings returned $http_status."
    note "                      That endpoint needs the identity header Apps injects for a"
    note "                      signed-in user. A service principal does not get one, so this"
    note "                      is the expected result from CI or any non-human caller."
    note ""
    note "REFUSED. The correlation check could not run, so nothing here can say this"
    note "release agrees with what the wizard proved."
    note ""
    note "  the caller is a service principal, and /api/settings cannot identify one"
    note ""
    note "    run it as yourself  -> re-run under your own profile, where the endpoint"
    note "                           answers and the check actually compares"
    note "    release regardless  -> add --ignore-app-intentions"
    note ""
    note "In CI, --ignore-app-intentions belongs in the pipeline definition, where"
    note "releasing without this check is a policy someone wrote down and can be asked"
    note "about. Until it is there, this is a release that may log a value the wizard"
    note "has already proved wrong, leaving the app reporting that step as pending for"
    note "good and the wizard still naming this command as the thing that would fix it."
    return 1
  fi

  if [[ -z "$settings_json" ]]; then
    note "app intentions        not read: $app_url/api/settings did not answer${http_status:+ (HTTP $http_status)}."
    if [[ "$http_status" == "404" || "$http_status" == "410" ]]; then
      # Named, because this exact shape is how the check went inert once before:
      # it kept calling /api/setup after the wizard was deleted, took the answer
      # of a route that is gone for the answer of a deployment with nothing to
      # say, and passed every run for it.
      note "                      $http_status means the route is not there, which is a STALE APP"
      note "                      BUILD rather than an app with no intentions. Deploy the app"
      note "                      (bundle/app-release.sh) and this check starts comparing again."
    fi
    note "                      Proceeding. This check can only ever add a refusal;"
    note "                      it is not a permission to release."
    return 0
  fi

  printf '%s' "$settings_json" | ABOUT_TO_LOG="$(python3 -c '
import json, os
print(json.dumps({
    "catalog": os.environ["PLAYER_INSIGHTS_CATALOG"],
    "schema": os.environ["PLAYER_INSIGHTS_SCHEMA"],
    "warehouse_id": os.environ["PLAYER_INSIGHTS_WAREHOUSE_ID"],
    "data_genie_space_id": os.environ["PLAYER_INSIGHTS_DATA_GENIE_ID"],
    "dictionary_genie_space_id": os.environ["PLAYER_INSIGHTS_DICTIONARY_GENIE_ID"],
    "llm_endpoint": os.environ["PLAYER_INSIGHTS_LLM_ENDPOINT"],
    "llm_gateway": os.environ["PLAYER_INSIGHTS_LLM_GATEWAY"],
    "catalog_allowlist": os.environ["PLAYER_INSIGHTS_CATALOG_ALLOWLIST"],
    "catalog_denylist": os.environ["PLAYER_INSIGHTS_CATALOG_DENYLIST"],
    "max_output_tokens": os.environ["PLAYER_INSIGHTS_MAX_OUTPUT_TOKENS"],
}))
')" python3 -c '
import json, os, sys

about = json.loads(os.environ["ABOUT_TO_LOG"])
payload = json.load(sys.stdin)
# /api/settings publishes one entry per CONNECTED_RESOURCE, each carrying the
# resource it describes and, when somebody has saved a value that is not in
# force, an `intended`. Everything below reads through this list, so a payload
# that is missing it is treated as "nothing to compare" rather than crashing the
# release on a KeyError.
resources = payload.get("resources") or []

def same(a, b):
    # Comma-separated lists are compared as sets: the allowlist means the same
    # thing whichever order it was typed in, and a refusal over ordering would
    # be noise that trains people to pass --ignore-app-intentions.
    norm = lambda v: {p.strip() for p in str(v).split(",") if p.strip()}
    if "," in str(a) or "," in str(b):
        return norm(a) == norm(b)
    return str(a).strip() == str(b).strip()

# An app build that predates this contract publishes no agentKey on any
# resource, so every comparison below would be skipped and the run would print
# "nothing to disagree with", a pass that means "I could not look". That is
# precisely the shape of silence this check exists to remove, so it is called out
# instead.
if resources and not any((entry.get("resource") or {}).get("agentKey") for entry in resources):
    print("  note  the running app publishes no `agentKey` on any connected resource, so")
    print("        this release could not be compared against anything it was told.")
    print("        That app build predates the correlation contract. Deploy the app")
    print("        (bundle/app-release.sh) and this check starts working; until then")
    print("        it is inert, and a value saved in the app can still silently")
    print("        disagree with what is logged here.")
    raise SystemExit(0)

disagreements, agreements, unreadable = [], [], []
for entry in resources:
    resource = entry.get("resource") or {}
    key = resource.get("agentKey")
    # `intended` is null unless somebody saved a value that is NOT in force, so
    # the absent case is the ordinary one and means there is nothing outstanding
    # for this resource. Only a real saved value reaches a comparison.
    intended = (entry.get("intended") or "").strip()
    name = resource.get("id") or resource.get("label") or "?"
    if not key or not intended:
        continue
    if key not in about:
        unreadable.append((name, key))
        continue
    if same(intended, about[key]):
        agreements.append((name, intended))
        continue
    # Who saved it and when, rather than whether it was ever proved to work. The
    # wizard used to record a per-value reachability check, which let a value it
    # had watched FAIL be reported instead of refused over; /api/settings keeps
    # no such record, so there is no honest way to reproduce that exemption and
    # it is not faked. The effect is that this gate is slightly stricter than it
    # was: every saved disagreement is a refusal, and --ignore-app-intentions is
    # the way past one.
    disagreements.append((name, key, intended, about[key], entry.get("intendedBy") or "", entry.get("intendedAt") or ""))

for name, value in agreements:
    print(f"  ok    {name}: the app asked for '\''{value}'\'' and that is what this release logs")
for name, key in unreadable:
    print(f"  note  {name} names setting '\''{key}'\'', which this release does not set. Not compared.")

if not disagreements:
    if not agreements and not unreadable:
        print("  ok    the app has no outstanding intentions to disagree with")
    raise SystemExit(0)

print("")
print("  REFUSED. Someone recorded a value in the app that this release would not log.")
print("")
for name, key, intended, mine, who, when in disagreements:
    print(f"    {name}  ({key})")
    saved = "   saved" + (f" by {who}" if who else "") + (f" at {when}" if when else "")
    print(f"      the app has     {intended!r}" + saved)
    print(f"      this would log  {mine!r}")
print("")
print("  Logging the second value would leave the first pending forever, with the")
print("  app still showing the command you just ran as the thing that would fix")
print("  it. Decide which is right:")
print("")
print("    the app is right   -> put the value in .databricks/bundle/<target>/variable-overrides.json")
print("                          (or the matching BUNDLE_VAR_*) and re-run this")
print("    the bundle is right-> clear the saved value on the app'\''s Connections page")
print("                          (DELETE /api/settings/values/<resource>)")
print("")
print("  To release anyway, knowing the app will keep reporting those resources as")
print("  having an intended value that is not in effect: --ignore-app-intentions")
raise SystemExit(1)
'
}

step "Correlating with what the app was told (target: $TARGET)"
# The flag downgrades a refusal; it no longer skips the check. Skipping it put
# one line in the log, "skipped on --ignore-app-intentions", which recorded
# that somebody passed a flag but not what the flag let through, so the trace was
# useless to whoever read it afterwards. Running the check either way means the
# release log always names the disagreement, or names the reason the comparison
# could not be made, and the flag's only effect is that the run continues.
if ! correlate_with_app; then
  if [[ "$IGNORE_APP_INTENTIONS" == true ]]; then
    note ""
    note "Released anyway on --ignore-app-intentions. The finding above stands: the"
    note "app will keep reporting as pending every step this release disagreed with,"
    note "or could not be compared against."
  else
    exit 1
  fi
fi

if [[ "$APPLY" != true ]]; then
  cat <<EOF

Dry run. Nothing was logged or deployed.

Re-run with --apply to:
  1. cd agent && uv run --python 3.13 python log_model.py
     (logs a new version, registers it in UC, points the 'prod' alias at it.
      The alias is a signpost; step 2 deploys by explicit version number)
  2. uv run --python 3.13 python deploy_agent.py --model-version <new>
  3. wait 60s for the traffic switch to settle
  4. smoke-test the endpoint
  5. remove superseded entities from the endpoint, keeping what serves plus
     $ROLLBACKS_KEPT idle rollback(s) (var.serving_rollbacks_kept). This is a
     change to the ENDPOINT only: every version stays registered in Unity
     Catalog and can be served again with deploy_agent.py --model-version N,
     which is the rollback path whether or not an idle entity is kept.
     Pass --no-prune to leave them, in which case the run reports what it
     would have removed rather than staying quiet about it.

Before --apply, confirm the model's declared resources still cover every table
both Genie spaces curate. A table outside the manifest fails nothing loudly: the
space fails every call with a passthrough credential error, and the agent's SQL
fallback answers anyway, so the endpoint looks healthy while it has stopped using
Genie at all.
See the manifest a log would declare, and every table it excludes with the
reason, without logging anything:
  (cd agent && uv run --python 3.13 python manifest_dryrun.py)

log_model.py stops if this release would declare tables the live version does not,
because it cannot tell a widening somebody chose from a catalog_denylist that went
missing. Reaching wider is often right. Record the decision with:
  --allow-widening
If the wider list is NOT what you want, narrow it in catalog_denylist rather than
by leaving the flag off, which narrows the agent and says nothing about why.
EOF
  exit 0
fi

LOG_SUMMARY=""
if [[ "$SKIP_LOG" != true ]]; then
  step "Logging model"
  LOG_ARGS=()
  [[ "$ALLOW_WIDENING" == true ]] && LOG_ARGS+=(--allow-widening)
  # KEPT, rather than consumed by a pipeline. log_model.py's last stdout line is the
  # release summary, and until now everything in it except model_version was thrown
  # away -- including api_scopes, which is the only record of what the new version
  # actually baked. The scope check below reads it. Same output reaches the
  # operator as before: this was already not displayed.
  LOG_STDOUT="$(mktemp "${TMPDIR:-/tmp}/pia-log-model.XXXXXX")"
  on_exit "rm -f '$LOG_STDOUT'"
  (cd "$BUNDLE_ROOT/agent" && uv run --python 3.13 python log_model.py "${LOG_ARGS[@]+"${LOG_ARGS[@]}"}" > "$LOG_STDOUT")
  MODEL_VERSION="$(python3 -c 'import json,sys; print(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])["model_version"])' "$LOG_STDOUT")"
  LOG_SUMMARY="$(mktemp "${TMPDIR:-/tmp}/pia-log-summary.XXXXXX")"
  on_exit "rm -f '$LOG_SUMMARY'"
  tail -n 1 "$LOG_STDOUT" > "$LOG_SUMMARY"
  note "logged version $MODEL_VERSION"
fi
[[ -n "$MODEL_VERSION" ]] || die "--model-version is required when --skip-log is set"

# The model's scopes, checked before this version is put in front of anybody.
#
# WHY HERE AND NOT "BEFORE REGISTRATION". There is no such point in this repository:
# log_model.py calls mlflow.pyfunc.log_model(registered_model_name=...), so logging
# and registering are one call. The earliest place a check can still stop something
# is here -- after the version exists, before deploy_agent.py puts it on the
# endpoint. A registered version that never serves answers no questions and costs
# nothing; a served one with the wrong scope set answers every question wrongly and
# looks healthy doing it.
#
# THE ONLY CHECK THE MODEL PATH HAS EVER HAD ON ITS OWN SCOPES. app-release.sh
# checks the APP's three legs against the app object, which says nothing about the
# model: a different token, from a different policy, validated by a different
# validator, on a different release. 0.04s.
#
# Exit 2 blocks as well as exit 1, for the same reason the service-principal gate a
# few hundred lines up says: "the question was never answered" is not "the answer
# was yes", and this repository has shipped four checks that could not fail.
step "The model's scopes: configured vs documented${LOG_SUMMARY:+ vs logged}"
MODEL_SCOPE_CHECK="$BUNDLE_ROOT/bundle/model-scope-check.py"
if [[ ! -f "$MODEL_SCOPE_CHECK" ]]; then
  die "bundle/model-scope-check.py is missing, so what scopes version $MODEL_VERSION
baked was never compared against what this target documents.

A missing checker is not a pass and there is no flag past this. Restore it:
  git restore bundle/model-scope-check.py"
fi
MODEL_SCOPE_ARGS=(--target "$TARGET")
[[ -n "$LOG_SUMMARY" ]] && MODEL_SCOPE_ARGS+=(--logged "$LOG_SUMMARY")
MODEL_SCOPE_STATUS=0
python3 "$MODEL_SCOPE_CHECK" "${MODEL_SCOPE_ARGS[@]}" || MODEL_SCOPE_STATUS=$?
case "$MODEL_SCOPE_STATUS" in
  0) : ;;
  1)
    die "Version $MODEL_VERSION does not carry the scopes this target asks for, or asks
for scopes nothing documents. It is registered in Unity Catalog and it has NOT been
deployed to $ENDPOINT, so nothing is answering questions with it.

Read the FAIL lines above. A scope the model bakes and the contract does not
document is a change nobody wrote down; a scope the contract documents and the
model does not carry means the agent will call that API and be refused at runtime,
which reads to a user as the agent being wrong rather than unauthorised.

Fix the cause and log again. If the contract is simply behind the bundle:
  python3 bundle/scope-contract.py --generate     # then commit the result
Deploy this version once it agrees:
  bundle/agent-release.sh --apply --skip-log --model-version $MODEL_VERSION"
    ;;
  2)
    die "What scopes version $MODEL_VERSION carries COULD NOT BE ESTABLISHED, so this
release does not know what the model it is about to serve can reach.

Read the COULD NOT RUN line above: this is not a finding and it is not a pass. The
version is registered and NOT deployed. Usually it is bundle/scope-contract.json
being absent, which is the artifact the documented leg compares against."
    ;;
  *)
    die "bundle/model-scope-check.py exited $MODEL_SCOPE_STATUS, which it has no documented
meaning for. Treat version $MODEL_VERSION's scopes as unknown and read the output
above before deploying it to $ENDPOINT."
    ;;
esac

step "Deploying version $MODEL_VERSION to $ENDPOINT"
(cd "$BUNDLE_ROOT/agent" && uv run --python 3.13 python deploy_agent.py --model-version "$MODEL_VERSION")

# A traffic switch is not atomic from the caller's point of view. Smoke-testing
# immediately measures the PREVIOUS version and will happily report success.
#
# POLLED RATHER THAN SLEPT, and fatal rather than a warning. This was a fixed 60s
# sleep followed by a check that PRINTED "WARNING: not in the served set yet" and
# let the script exit 0. An observed switch on this endpoint took ten minutes, so
# the warning was the normal outcome: every release ended by saying it could not
# confirm what it had just done, in a green run nobody re-read. A check whose
# failure is indistinguishable from success is not a check.
#
# Traffic is what is confirmed, not membership of the served set. A version can be
# served and carry 0% of the traffic, which means every question is still answered
# by the previous one.
step "Waiting for the traffic switch to settle, then confirming version $MODEL_VERSION"
deadline=$(( $(date +%s) + 1200 ))
while :; do
  state=$(databricks serving-endpoints get "$ENDPOINT" --profile "$PROFILE" -o json \
    | python3 -c "
import json,sys
body=json.load(sys.stdin)
cfg=body.get('config') or {}
update=((body.get('state') or {}).get('config_update')) or 'NONE'
routes=((cfg.get('traffic_config') or {}).get('routes')) or []
live={r.get('served_model_name','').rsplit('_',1)[-1]: r.get('traffic_percentage') or 0 for r in routes}
want='$MODEL_VERSION'
print(update, live.get(want, 0), sorted(k for k, v in live.items() if v))
")
  update=${state%% *}
  share=$(printf '%s' "$state" | awk '{print $2}')
  echo "  update=$update version $MODEL_VERSION at ${share}% traffic"
  [[ "$update" == 'NOT_UPDATING' || "$update" == 'NONE' ]] && (( share > 0 )) && break
  if (( $(date +%s) >= deadline )); then
    die "version $MODEL_VERSION is not taking traffic after 20 minutes. The endpoint may still be
updating: check $HOST/ml/endpoints/$ENDPOINT/ before deciding whether to redeploy, and do NOT
smoke-test yet, because the answers would come from the previous version."
  fi
  sleep 30
done
echo "  ok, version $MODEL_VERSION is taking traffic"

# --- The model half of the on-behalf-of-user wiring ---------------------------
#
# A customer's deployment failed on the FIRST question anyone asked, with an HTTP
# 400 carrying the SDK's `model_serving_user_credentials auth: Unable to
# authenticate using user_credentials` and nothing else. Model Serving had no user
# credential to hand the container. Nothing was wrong with the app, the data, the
# grants or Lakebase; the wiring around the model was wrong, and the first person
# to notice was a customer asking a question.
#
# HERE RATHER THAN BEFORE THE DEPLOY, because the claim is about the version that
# is ACTUALLY TAKING TRAFFIC, which the loop above has just established and which
# nothing earlier can. The policy itself is fixed at log time, so this cannot fail
# because of anything the deploy did -- when it fails, it is telling you that the
# thing now in front of people cannot answer, and it is better to hear that here
# than from a customer.
#
# Exit 2 blocks as well as exit 1, for the reason the scope gate a hundred lines
# up gives: "the question was never answered" is not "the answer was yes".
if [[ -n "$LOG_SUMMARY" ]]; then
  step "The served version's user auth policy"
  USER_AUTH_CHECK="$BUNDLE_ROOT/bundle/model-user-auth-check.py"
  [[ -f "$USER_AUTH_CHECK" ]] || die "bundle/model-user-auth-check.py is missing, so nothing confirmed that version
$MODEL_VERSION can act as the person asking. A missing checker is not a pass:
  git restore bundle/model-user-auth-check.py"
  USER_AUTH_STATUS=0
  # Under the agent's environment: it reads the registered version's MLmodel with
  # MLflow's own reader rather than parsing YAML a second way.
  (cd "$BUNDLE_ROOT/agent" && uv run --python 3.13 python "$USER_AUTH_CHECK" \
    --logged "$LOG_SUMMARY" --registered \
    --user-authorization "$USER_AUTHORIZATION") || USER_AUTH_STATUS=$?
  case "$USER_AUTH_STATUS" in
    0) : ;;
    1)
      die "Version $MODEL_VERSION is serving on $ENDPOINT and cannot act as the person asking.
Read the FAIL lines above. This is the fault that reaches a user as an HTTP 400 on
their first question, and no restart, re-grant or data change can write it: the
policy is decided when the model is logged. Re-run this script to log and deploy a
new version, or roll $ENDPOINT back to the previous one at
$HOST/ml/endpoints/$ENDPOINT/ while you do."
      ;;
    2)
      die "The user auth policy on version $MODEL_VERSION was not established either way.
Read the COULD NOT RUN line above: it is not a finding and it is not a pass. The
version IS deployed and IS taking traffic, so decide from the output whether to
roll back before anyone asks it a question."
      ;;
    *)
      die "bundle/model-user-auth-check.py exited $USER_AUTH_STATUS, which it has no documented
meaning for. Treat version $MODEL_VERSION's ability to run as the caller as unknown."
      ;;
  esac
else
  step "The served version's user auth policy: NOT CHECKED (--skip-log)"
  note "This run deployed version $MODEL_VERSION without logging it, so there is no release
  summary to check it against. The run that logged it checked it. If that run
  predates this gate, check it by hand:
    (cd agent && uv run --python 3.13 python ../bundle/model-user-auth-check.py --help)"
fi

# --- Take the superseded entities away ---------------------------------------
#
# The deploy above ADDED a served entity. Nothing here ever took one away, so
# the endpoint grew an idle replica per release, each holding provisioned
# capacity with scale_to_zero off. On the <your profile> endpoint that reached ten
# entities, nine at 0% traffic, 40 DBU/h against the 8 the live pair cost:
# about $54/day buying nothing. Deploying without pruning is what made that
# recur, so the prune belongs here rather than in somebody's calendar.
#
# IT REMOVES, IT DOES NOT ONLY REPORT. A release that ends by printing what it
# declined to do is the failure mode this repo already paid for once, a few
# dozen lines up: the traffic check used to warn and exit 0, the warning became
# the normal outcome, and nobody read it. A prune that only warns recurs on
# exactly the schedule an unpruned release does.
#
# It runs AFTER the traffic confirmation above, never before. The confirmation
# is what establishes that the new version is settled and taking 100%, which is
# the precondition the prune refuses to act without. The tool re-checks it
# against the live endpoint anyway rather than trusting this ordering.
#
# A failed prune does NOT fail the release. By this point the model is logged,
# deployed and serving; the release succeeded. Leftover idle capacity is a bill,
# not an outage, and exiting non-zero here would report a successful release as
# a broken one.
if [[ "$PRUNE" == true ]]; then
  step "Pruning superseded entities from $ENDPOINT (keeping what serves plus $ROLLBACKS_KEPT idle rollback(s))"
  "$BUNDLE_ROOT/bundle/prune-served-entities.py" \
    --endpoint "$ENDPOINT" --profile "$PROFILE" \
    --keep-rollbacks "$ROLLBACKS_KEPT" --apply \
    || note "WARNING: prune did not complete. The release itself is fine and $ENDPOINT is
  serving version $MODEL_VERSION. Idle entities are still provisioned and still
  billing; re-run when convenient:
    bundle/prune-served-entities.py --endpoint $ENDPOINT --profile '$PROFILE' --keep-rollbacks $ROLLBACKS_KEPT --apply"
else
  step "Skipping the prune (--no-prune)"
  "$BUNDLE_ROOT/bundle/prune-served-entities.py" \
    --endpoint "$ENDPOINT" --profile "$PROFILE" \
    --keep-rollbacks "$ROLLBACKS_KEPT" || true
fi

# Machine-readable handoff for callers such as the approved notebook helper.
# Human output is unchanged, and the file appears only after traffic and the
# post-traffic user-auth gate have succeeded.
if [[ -n "${PLAYER_INSIGHTS_RELEASE_RESULT_JSON:-}" ]]; then
  RESULT_TMP="${PLAYER_INSIGHTS_RELEASE_RESULT_JSON}.tmp.$$"
  MODEL_VERSION="$MODEL_VERSION" ENDPOINT="$ENDPOINT" python3 - "$RESULT_TMP" <<'PY'
import json
import os
import sys

with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(
        {
            "status": "succeeded",
            "model_version": os.environ["MODEL_VERSION"],
            "endpoint": os.environ["ENDPOINT"],
        },
        handle,
    )
    handle.write("\n")
PY
  mv "$RESULT_TMP" "$PLAYER_INSIGHTS_RELEASE_RESULT_JSON"
fi
