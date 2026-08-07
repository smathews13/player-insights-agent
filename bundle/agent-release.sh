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

APPLY=false; SKIP_LOG=false; MODEL_VERSION=""; ALLOW_WIDENING=false; IGNORE_APP_INTENTIONS=false
USER_AUTHORIZATION=false
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
    # Logs the version so its Genie and SQL calls execute as the identity that
    # INVOKED the endpoint, rather than as the model version's passthrough
    # principal. A flag for the same reason as --allow-widening: log_model.py
    # bakes this into the artifact and it cannot be changed afterwards, so the
    # one thing it must not depend on is a value left over in somebody's shell.
    --user-authorization) USER_AUTHORIZATION=true ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

require_cmd databricks
require_cmd uv

require_target
resolve_profile

CATALOG="$(bundle_var catalog)"
SCHEMA="$(bundle_var schema)"
WAREHOUSE_ID="$(bundle_var warehouse_id)"
MODEL_NAME="$(bundle_var model_name)"
ENDPOINT="$(bundle_var serving_endpoint_name)"
EXPERIMENT="$(bundle_var experiment_path)"
LLM_ENDPOINT="$(bundle_var llm_endpoint)"
ALLOWLIST="$(bundle_var catalog_allowlist)"
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
# Optional, and empty is the SAFE case rather than merely a legal one: it means
# the agent claims nothing about whether the data is real. Only the demo target
# sets it true. See databricks.yml for why the default is the load-bearing half.
SYNTHETIC_DATA="$(bundle_var_or_empty synthetic_data)"

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
note "catalog.schema        $CATALOG.$SCHEMA"
note "model                 $MODEL_NAME"
note "endpoint              $ENDPOINT"
note "experiment            $EXPERIMENT"
note "LLM endpoint          $LLM_ENDPOINT"
note "warehouse             $WAREHOUSE_ID"
note "data genie space      $DATA_GENIE_ID  ($(genie_origin "${PLAYER_INSIGHTS_DATA_GENIE_ID:-}" "$DATA_GENIE_ADOPTED"))"
note "dictionary genie      $DICT_GENIE_ID  ($(genie_origin "${PLAYER_INSIGHTS_DICTIONARY_GENIE_ID:-}" "$DICT_GENIE_ADOPTED"))"
note "catalog allowlist     $ALLOWLIST"
# Printed even when empty, and labelled, so "(none)" is a statement the operator
# read rather than a line they never saw. The failure this closes was invisible
# precisely because an absent denylist looked like every other run.
note "catalog denylist      ${DENYLIST:-(none)}"
# Same reasoning: printed even when empty. Which route the reasoning model was
# reached by is the sort of thing an operator should never have to infer.
note "AI Gateway            ${LLM_GATEWAY:-(none, direct to serving endpoint)}"
# Printed on every run, set or not, because this decides whether every answer
# this release produces tells the reader their figures are invented. Getting it
# wrong in either direction is a governance failure, and the release log is the
# one place an operator can see which way it went.
if [[ "$SYNTHETIC_DATA" == "true" ]]; then
  note "data provenance       synthetic: every answer will disclose that its figures"
  note "                      are invented. Correct for a demo estate ONLY."
else
  note "data provenance       ${SYNTHETIC_DATA:-(not declared)}: answers will make no claim about"
  note "                      whether the data is real or synthetic."
fi
# Printed on every run, on or off, because "which identity did that answer run
# as" is the question this release changes and it should never be inferred.
if [[ "$USER_AUTHORIZATION" == true ]]; then
  note "execution identity    user-authorization (--user-authorization): Genie and SQL"
  note "                      run as whoever invoked the endpoint, not as the"
  note "                      passthrough principal. That is the CALLING APPLICATION's"
  note "                      identity unless the app forwards the end user's token."
else
  note "execution identity    system-passthrough (default)"
fi

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
# Exported unconditionally, empty included, and this one for the sharpest version
# of the denylist's reason: a stale `true` in an operator's shell would release a
# customer-facing model that tells their analysts their production figures are
# fabricated, against a bundle that says nothing of the kind. Empty resolves to
# "no claim" in Settings.
export PLAYER_INSIGHTS_SYNTHETIC_DATA="$SYNTHETIC_DATA"
# Exported unconditionally, "false" included, for the reason the denylist below
# is: this decides which principal every data call runs as, and a stale value in
# the operator's shell must not be able to make that decision instead of the
# flag on the command line.
export PLAYER_INSIGHTS_USER_AUTHORIZATION="$USER_AUTHORIZATION"

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
#
# Not cleared: the two Genie space ids above, which are documented overrides for
# the pre-deploy case.
unset PLAYER_INSIGHTS_TABLES
unset PLAYER_INSIGHTS_DECLARED_MANIFEST

# --- Does this release agree with what the deployer proved in the app? -------
#
# The failure this closes: a deployer opens the Setup Wizard, types their
# warehouse id, watches the serving principal reach it, and is told to run this
# script. They run it, from a laptop whose variable-overrides.json says
# something else. A model is logged with the OTHER value, and the wizard goes on
# reporting that step as pending forever, with no explanation of why running the
# suggested command did not close it.
#
# Nothing was wrong with either half. The bundle is authoritative about what gets
# logged, and it should be. The wizard is honest that it binds nothing, and it
# should be. What was missing is that the two were never compared, so a
# disagreement between them was silent, and silence is what every expensive
# failure in this system has in common.
#
# This does not make the app authoritative. It refuses, and says which value
# came from where. The deployer decides which one is right and fixes THAT,
# rather than discovering months later that the wizard's green tick described a
# workspace nobody deployed to.
#
# The join is `agentKey`, published by the app on each step for this purpose, so
# there is no second copy of the step-id-to-setting mapping. A copy of that
# mapping is how these two halves came to be able to disagree.
correlate_with_app() {
  local app_name app_url token setup_json
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
  # misleading failure: /api/setup is behind the app's identity gate, which reads
  # the `x-forwarded-email` header that Databricks Apps injects for a user. A
  # human's OAuth token gets that header and a 200 (verified against the live
  # app). A service principal's does not, so an automated caller is refused,
  # and would otherwise fall into the "did not answer" branch below and release
  # unchecked, which is precisely the silence this gate exists to break.
  local http_status=""
  setup_json=""
  if [[ -n "$token" ]]; then
    setup_json="$(curl -sS --max-time 20 -w '\n%{http_code}' \
      -H "Authorization: Bearer $token" "$app_url/api/setup" 2>/dev/null || true)"
    http_status="${setup_json##*$'\n'}"
    setup_json="${setup_json%$'\n'*}"
    [[ "$http_status" == "200" ]] || setup_json=""
  fi

  # REFUSES, rather than warning and returning 0 as it first did. A gate that
  # returns success for the one caller least able to satisfy it is not a gate: CI
  # is where a release goes out with nobody reading the output, so an advisory
  # note there is the same as no check at all. The escape hatch does the
  # releasing now, which is what makes it a decision rather than a tolerance.
  if [[ "$http_status" == "401" || "$http_status" == "403" ]]; then
    note "app intentions        NOT READ: $app_url/api/setup returned $http_status."
    note "                      That endpoint needs the identity header Apps injects for a"
    note "                      signed-in user. A service principal does not get one, so this"
    note "                      is the expected result from CI or any non-human caller."
    note ""
    note "REFUSED. The correlation check could not run, so nothing here can say this"
    note "release agrees with what the wizard proved."
    note ""
    note "  the caller is a service principal, and /api/setup cannot identify one"
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

  if [[ -z "$setup_json" ]]; then
    note "app intentions        not read: $app_url/api/setup did not answer${http_status:+ (HTTP $http_status)}."
    note "                      Proceeding. This check can only ever add a refusal;"
    note "                      it is not a permission to release."
    return 0
  fi

  printf '%s' "$setup_json" | ABOUT_TO_LOG="$(python3 -c '
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
steps = payload.get("steps") or []

def same(a, b):
    # Comma-separated lists are compared as sets: the allowlist means the same
    # thing whichever order it was typed in, and a refusal over ordering would
    # be noise that trains people to pass --ignore-app-intentions.
    norm = lambda v: {p.strip() for p in str(v).split(",") if p.strip()}
    if "," in str(a) or "," in str(b):
        return norm(a) == norm(b)
    return str(a).strip() == str(b).strip()

# An app build that predates this contract publishes no agentKey on any step, so
# every comparison below would be skipped and the run would print "nothing to
# disagree with", a pass that means "I could not look". That is precisely the
# shape of silence this check exists to remove, so it is called out instead.
if steps and not any(step.get("agentKey") for step in steps):
    print("  note  the running app does not publish `agentKey` on its setup steps, so")
    print("        this release could not be compared against anything it was told.")
    print("        That app build predates the correlation contract. Deploy the app")
    print("        (bundle/app-release.sh) and this check starts working; until then")
    print("        it is inert, and a value proved in the wizard can still silently")
    print("        disagree with what is logged here.")
    raise SystemExit(0)

disagreements, agreements, unreadable, unreachable = [], [], [], []
for step in steps:
    key, intended = step.get("agentKey"), (step.get("intended") or "").strip()
    if not key or not intended:
        continue
    if key not in about:
        unreadable.append((step.get("id"), key))
        continue
    proof = step.get("proof") or {}
    proved = bool(step.get("proofCurrent")) and proof.get("status") == "ok"
    if same(intended, about[key]):
        agreements.append((step.get("id"), intended))
        continue
    # A value the wizard has on record as UNREACHABLE is not a competing
    # decision, so it is reported and not refused over.
    #
    # It only became reachable here at all because the wizard now stores a value
    # whose check failed instead of discarding it, which is what makes the
    # failure survive a closed browser. Left in with the disagreements, that
    # improvement would have bought a new way for a release to be refused on a
    # preflight verdict (the exact thing being removed) and would have refused
    # the release most likely to FIX it, since the grant a failed check asks for
    # usually arrives alongside one.
    #
    # The refusal below is about two people having recorded two different
    # answers, and this is not that: one of the two is on record as not working.
    if bool(step.get("proofCurrent")) and proof.get("status") == "failed":
        unreachable.append((step.get("id"), key, intended, about[key], proof.get("detail", "")))
        continue
    disagreements.append((step.get("id"), key, intended, about[key], proved, proof.get("checkedAt", "")))

for step_id, value in agreements:
    print(f"  ok    {step_id}: the app asked for '\''{value}'\'' and that is what this release logs")
for step_id, key in unreadable:
    print(f"  note  {step_id} names setting '\''{key}'\'', which this release does not set. Not compared.")
for step_id, key, intended, mine, detail in unreachable:
    print(f"  note  {step_id} ({key}): the app has {intended!r}, PROVED UNREACHABLE, and this")
    print(f"        release logs {mine!r}. Not refused over: a value that does not work is not")
    print(f"        a decision this release has to honour. The app will go on reporting that")
    print(f"        step until somebody clears it in the wizard. What failed: {detail}")

if not disagreements:
    if not agreements and not unreadable and not unreachable:
        print("  ok    the app has no outstanding intentions to disagree with")
    raise SystemExit(0)

print("")
print("  REFUSED. Someone recorded a value in the app that this release would not log.")
print("")
for step_id, key, intended, mine, proved, when in disagreements:
    print(f"    {step_id}  ({key})")
    print(f"      the app has     {intended!r}" + (f"   proved reachable at {when}" if proved else "   (recorded, not proved)"))
    print(f"      this would log  {mine!r}")
print("")
print("  Logging the second value would leave the first pending forever, with the")
print("  wizard still showing the command you just ran as the thing that would fix")
print("  it. Decide which is right:")
print("")
print("    the app is right   -> put the value in .databricks/bundle/<target>/variable-overrides.json")
print("                          (or the matching BUNDLE_VAR_*) and re-run this")
print("    the bundle is right-> clear the intention in the app'\''s Setup Wizard, or")
print("                          re-check the step with the bundle'\''s value")
print("")
print("  To release anyway, knowing the app will keep reporting those steps as")
print("  pending: --ignore-app-intentions")
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

if [[ "$SKIP_LOG" != true ]]; then
  step "Logging model"
  LOG_ARGS=()
  [[ "$ALLOW_WIDENING" == true ]] && LOG_ARGS+=(--allow-widening)
  MODEL_VERSION="$(cd "$BUNDLE_ROOT/agent" && uv run --python 3.13 python log_model.py "${LOG_ARGS[@]+"${LOG_ARGS[@]}"}" \
    | python3 -c 'import json,sys; print(json.loads(sys.stdin.read().strip().splitlines()[-1])["model_version"])')"
  note "logged version $MODEL_VERSION"
fi
[[ -n "$MODEL_VERSION" ]] || die "--model-version is required when --skip-log is set"

step "Deploying version $MODEL_VERSION to $ENDPOINT"
(cd "$BUNDLE_ROOT/agent" && uv run --python 3.13 python deploy_agent.py --model-version "$MODEL_VERSION")

# A traffic switch is not atomic from the caller's point of view. Smoke-testing
# immediately measures the PREVIOUS version and will happily report success.
step "Waiting 60s for the traffic switch to settle"
sleep 60

step "Confirming the endpoint is serving version $MODEL_VERSION"
databricks serving-endpoints get "$ENDPOINT" --profile "$PROFILE" -o json \
  | python3 -c "
import json,sys
cfg=json.load(sys.stdin).get('config',{})
served={e.get('entity_version') for e in cfg.get('served_entities',[])}
want='$MODEL_VERSION'
print('  served entity versions:', sorted(served))
print('  ok' if want in served else '  WARNING: version '+want+' is not in the served set yet')
"
