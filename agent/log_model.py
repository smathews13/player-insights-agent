from __future__ import annotations

import dataclasses
import json
import os
import sys
from pathlib import Path

import mlflow
from databricks.sdk import WorkspaceClient
from mlflow.models.auth_policy import AuthPolicy, SystemAuthPolicy, UserAuthPolicy
from mlflow.models.resources import (
    DatabricksGenieSpace,
    DatabricksServingEndpoint,
    DatabricksSQLWarehouse,
    DatabricksTable,
    DatabricksVectorSearchIndex,
)
from mlflow.tracking import MlflowClient

from config import (
    DATA_GENIE_ROLE_LABEL,
    DICTIONARY_GENIE_ROLE_LABEL,
    Settings,
)
from host_metadata_probe import bound as bound_host_metadata_probe
from preflight import (
    BUILD_SHA_VAR,
    DIRTY_SUFFIX,
    WideningCheckUnavailable,
    newly_granted_tables,
    resolve_build_stamp,
    resolve_declared_manifest,
    widening_refusal,
)
from semantic_retrieval import MODEL_CONFIG_KEY as SEMANTIC_INDEX_KEY
from semantic_retrieval import (
    SEMANTIC_INDEX_ENV,
    VECTOR_SEARCH_SCOPES,
    resolve_index,
)
from unattributed_figures import ALLOW_UNATTRIBUTED_FIGURES_ENV
from unattributed_figures import MODEL_CONFIG_KEY as ALLOW_UNATTRIBUTED_KEY
from unattributed_figures import announce as announce_waiver
from unattributed_figures import resolve as resolve_waiver
from user_authorization import (
    MODEL_CONFIG_KEY,
    USER_AUTHORIZATION_ENV,
    announce,
    api_scopes,
    resolve,
)

ROOT = Path(__file__).parent
# BEFORE ANYTHING BUILDS A CLIENT, including the ones MLflow builds for itself in
# set_experiment and in the registry call at the end. The SDK probes
# {host}/.well-known/databricks-config while constructing every Config, gives it a
# 300-second retry budget by default, and on a machine where that endpoint does
# not answer spends five minutes reaching the fallback values it started with.
# That was the majority of a release's elapsed time. See host_metadata_probe.
bound_host_metadata_probe()
# Deliberately a FLAG, not an environment variable: the failure this gate exists
# for is an environment variable that went missing, so the approval cannot be one
# more piece of shell state.
ALLOW_WIDENING = "--allow-widening" in sys.argv[1:]
# Which identity the served version runs its data calls as. Resolved once, here,
# because this is the only moment the resources named below and the client the
# agent builds are in one process. Fails closed.
user_auth = announce(resolve(os.getenv(USER_AUTHORIZATION_ENV)), at_log_time=True)
settings = Settings.from_env()
experiment = os.getenv("PLAYER_INSIGHTS_EXPERIMENT", "/Shared/player-insights-agent")
model_name = os.getenv(
    "PLAYER_INSIGHTS_MODEL_NAME",
    f"{settings.catalog}.{settings.schema}.player_insights_agent",
)

mlflow.set_tracking_uri("databricks")
mlflow.set_registry_uri("databricks-uc")
mlflow.set_experiment(experiment)

# Passthrough grants the serving principal only the tables named in `resources`,
# and a Genie space fails outright if ONE table it curates is missing, so the list
# must cover every table both spaces are built on. There is no catalog or schema
# resource type; each table is named individually, generated from
# `catalog_allowlist` rather than hand-maintained.
#
# Enumeration failures stop the log rather than shrinking the manifest, because a
# short manifest produces an endpoint that advertises tables it cannot read.
workspace = WorkspaceClient()
manifest, manifest_notes = resolve_declared_manifest(settings, workspace)


def _genie_title(space_id: str, role_label: str) -> str:
    """The space's own title, or the role label when Genie will not answer.

    Titles travel in the artifact so refusal text and tool descriptions can
    name a space without another round trip at answer time. A failed fetch must
    not block the log: the id still works, and a role label is more useful than
    a bare hex when the title never arrived.
    """

    try:
        space = workspace.genie.get_space(space_id)
        title = str(getattr(space, "title", None) or "").strip()
        if title:
            return title
    except Exception as error:  # noqa: BLE001 - any failure falls back
        print(
            f"WARNING: could not resolve Genie title for {role_label} "
            f"({space_id}): {error}. Baking the role label instead."
        )
    return role_label


data_genie_title = _genie_title(settings.data_genie_space_id, DATA_GENIE_ROLE_LABEL)
dictionary_genie_title = _genie_title(
    settings.dictionary_genie_space_id, DICTIONARY_GENIE_ROLE_LABEL
)
settings = dataclasses.replace(
    settings,
    data_genie_space_title=data_genie_title,
    dictionary_genie_space_title=dictionary_genie_title,
)
print(
    f"Genie titles: data={data_genie_title!r} · dictionary={dictionary_genie_title!r}"
)

# Printed before anything is logged, not only in the JSON summary at the end:
# a governance note that arrives after the model is registered has been filed
# rather than read.
for note in manifest_notes:
    if note.startswith(("WARNING:", "GOVERNANCE:")):
        print(f"\n{note}\n")

# "Wider on purpose" and "wider by accident" are indistinguishable from inside a
# single run, so compare against what Unity Catalog says the live version was
# granted and require the difference to be stated. Narrowing passes without a
# flag: it takes access away, and it announces itself.
try:
    previous_version, newly_granted, no_longer_granted = newly_granted_tables(
        workspace, model_name, manifest
    )
except WideningCheckUnavailable as error:
    # Fails OPEN, loudly. Blocking a release because the registry would not
    # answer trades a silent widening for an outage, and this gate is a second
    # opinion: every refusal it raises is also reachable from manifest_dryrun.py.
    print(f"WARNING: the previous release could not be compared against: {error}")
    previous_version, newly_granted, no_longer_granted = None, (), ()

if newly_granted and not ALLOW_WIDENING:
    assert previous_version is not None
    raise SystemExit(widening_refusal(model_name, previous_version, newly_granted))
if newly_granted:
    # The audit entry for a deliberate widening, printed in full so the run log
    # says which tables and not just how many.
    print(
        f"WIDER REACH, APPROVED ON THE COMMAND LINE (--allow-widening): "
        f"{len(newly_granted)} table(s) that version {previous_version} does not declare "
        "will be granted to the serving principal:"
    )
    for table in newly_granted:
        print(f"  + {table}")
if no_longer_granted:
    # Not gated, but not silent: this is how an applied denylist looks, and also
    # how a dropped data contract looks.
    print(
        f"NARROWING: {len(no_longer_granted)} table(s) granted to version "
        f"{previous_version} will not be declared here: " + ", ".join(no_longer_granted)
    )

# ONE OBJECT BUILDS BOTH the resources and the baked configuration, so the list
# the agent reads back at answer time cannot disagree with the list that was
# granted. The build stamp is resolved here because log time is the last moment
# anything knows what this artifact was built from.
build_sha = resolve_build_stamp()
settings = dataclasses.replace(settings, declared_manifest=manifest, build_sha=build_sha)
if not build_sha:
    print(
        "WARNING: no build stamp could be resolved (no git repository and no "
        f"{BUILD_SHA_VAR}). This version will report its build as unknown, and "
        "app-versus-model skew will not be detectable on the Sources page."
    )
elif build_sha.endswith(DIRTY_SUFFIX):
    print(
        f"WARNING: building from a tree with uncommitted tracked changes ({build_sha}). "
        "The stamp records it, but the release sequence asks for a clean worktree "
        "because the artifact cannot be reproduced from any commit."
    )

# Empty for every deployment that has not been given an AI Search index, which
# is the default: the index is an hourly charge nobody acquires by upgrading.
# Read here rather than in the container for the usual reason, and a typo fails
# THIS script rather than the model load, which is the cheaper of the two.
semantic_index = resolve_index(settings, os.environ.get(SEMANTIC_INDEX_ENV, ""))

# The escape valve for a missing semantic metric layer, resolved and ANNOUNCED
# here so a release that relaxes the evidence gateway says so on the way past
# rather than only in the served model's logs. Strict on anything but the exact
# string, which includes a value nobody set.
allow_unattributed = announce_waiver(
    resolve_waiver(os.environ.get(ALLOW_UNATTRIBUTED_FIGURES_ENV)), at_log_time=True
)

resources = [
    DatabricksServingEndpoint(endpoint_name=settings.llm_endpoint),
    DatabricksGenieSpace(genie_space_id=settings.data_genie_space_id),
    DatabricksGenieSpace(genie_space_id=settings.dictionary_genie_space_id),
    DatabricksSQLWarehouse(warehouse_id=settings.warehouse_id),
    *(DatabricksTable(table_name=table) for table in manifest),
    # One more dependency on the model version, and it counts against the same
    # Unity Catalog ceiling the manifest does. Declared only when configured, so
    # a release with no semantic layer does not spend a dependency saying so.
    *([DatabricksVectorSearchIndex(index_name=semantic_index)] if semantic_index else []),
]

# MLflow refuses `resources` and `auth_policy` together, so under user
# authorization the declared list MOVES into the system half of an AuthPolicy
# rather than disappearing. It goes on granting the passthrough principal what it
# granted before, the LLM endpoint included, which is why the orchestrator works
# without anyone holding CAN QUERY on it.
#
# A second, narrower authorization then runs beside it: Genie and SQL calls carry
# the invoker's downscoped token and the warehouse enforces the CALLER's grants.
# The manifest becomes an upper bound rather than a floor, which is why
# `list_data_assets` and every answer's caveats say so: a row filter does not
# fail, it returns fewer rows.
scopes = api_scopes(settings) if user_auth.enabled else ()
# Added here rather than inside `api_scopes`, which derives its list from
# `settings` and cannot see a release decision that is not one. Both scopes, and
# only when an index is configured: the downscoped token is the user's, so every
# scope it carries is one more API the agent could be made to call with it.
if user_auth.enabled and semantic_index:
    scopes = (*scopes, *VECTOR_SEARCH_SCOPES)
if user_auth.enabled and not scopes:
    raise SystemExit(
        "Refusing to log with user authorization and no API scopes. A "
        "UserAuthPolicy with an empty scope list downscopes the invoker's token "
        "to nothing, so every Genie and SQL call fails at the endpoint, and it "
        "fails there rather than here, because MLflow does not validate scopes. "
        "This means no Genie space and no warehouse were configured, which is a "
        "misconfiguration in its own right."
    )
authorization: dict[str, object] = (
    {
        "auth_policy": AuthPolicy(
            system_auth_policy=SystemAuthPolicy(resources=resources),
            user_auth_policy=UserAuthPolicy(api_scopes=list(scopes)),
        )
    }
    if user_auth.enabled
    else {"resources": resources}
)

# The manifest in full, not just its length: it can change between two releases
# nobody edited, and every line becomes a SELECT grant.
print(
    json.dumps(
        {
            "declared_tables": len(manifest),
            "manifest": list(manifest),
            "scopes": list(settings.catalog_allowlist),
            "denylist": list(settings.catalog_denylist),
            "compared_against_version": previous_version,
            "newly_granted": list(newly_granted),
            "no_longer_granted": list(no_longer_granted),
            "build_sha": build_sha or None,
            "notes": manifest_notes,
            # Beside the manifest, because the two together are the whole of
            # what this release authorizes.
            "execution_identity": user_auth.mode,
            "api_scopes": list(scopes),
            "semantic_index": semantic_index or None,
            # In the machine-readable summary as well as in the announcement, so a
            # release record can be diffed rather than read.
            "evidence_gateway": allow_unattributed.mode,
        },
        indent=2,
    )
)

# Decisions a RELEASE makes, as opposed to values that name a workspace. They
# travel in the same baked configuration without being `Settings` fields: the
# execution mode because the client the agent builds at answer time must match
# the policy registered here, and the index because the prompt logged here
# offers the search tool only where one exists, so a served version whose tool
# list and declared resources disagreed would advertise a search it cannot do.
release_decisions = {
    MODEL_CONFIG_KEY: user_auth.enabled,
    SEMANTIC_INDEX_KEY: semantic_index,
    # Baked rather than read from the container's environment, because a served
    # entity inherits nothing from this shell and because the decision belongs to
    # the VERSION: "was that answer produced under a permissive gateway" has to be
    # answerable from the artifact months later, not from whatever a deployer's
    # environment happens to hold at the time somebody asks.
    ALLOW_UNATTRIBUTED_KEY: allow_unattributed.enabled,
}

# The serving container inherits none of this script's environment, so the
# configuration travels inside the artifact. Written from the same `settings`
# that named the resources above, so what the agent runs on and what it is
# granted cannot disagree.
with mlflow.start_run(run_name="log_player_insights_agent"):
    model_info = mlflow.pyfunc.log_model(
        name="agent",
        # The execution mode travels with the configuration because the client
        # the agent builds at answer time must match the policy registered here.
        # Merged in rather than made a `Settings` field, which names workspace
        # values rather than identities.
        model_config={**settings.as_model_config(), **release_decisions},
        python_model=str(ROOT / "agent.py"),
        code_paths=[
            str(ROOT / "charts.py"),
            str(ROOT / "config.py"),
            str(ROOT / "contracts.py"),
            # The correlation id's shape rule and the facts it tags a trace with.
            # agent.py imports it at module scope, so a version logged without it
            # fails to LOAD rather than serving untagged traces.
            str(ROOT / "correlation.py"),
            # The reference notebook's stateless Data Source Finder boundary.
            # agent.py imports it at module scope, so a version logged without
            # it fails to LOAD.
            str(ROOT / "data_source_finder.py"),
            # agent.py imports this at module scope and calls it before every
            # turn, so a version logged without it refuses nothing: it fails to
            # LOAD, which at least fails loudly.
            str(ROOT / "execution_identity.py"),
            # The admission control, the failure codes, and the SQL guard, all of
            # which tools.py imports at module scope. Missing any is not a
            # degraded agent: it is a model that fails to LOAD, with the guard's
            # absence indistinguishable from any other import error.
            str(ROOT / "evidence.py"),
            str(ROOT / "failures.py"),
            # Stable operating guidance travels with the artifact. The payload
            # deliberately contains no customer facts; knowledge.py reads these
            # markdown files at model load and the prompts keep governed tools
            # as the only source of factual answers.
            str(ROOT / "knowledge"),
            str(ROOT / "knowledge.py"),
            # agent.py imports this at module scope and calls it on the return of
            # every LLM call, so it is a load-time dependency rather than an
            # observability nicety: a version logged without it fails to LOAD.
            str(ROOT / "llm_usage.py"),
            # config.py imports from this at module scope, so without it the
            # model fails to LOAD inside the container, long after the log ran.
            str(ROOT / "preflight.py"),
            # The provenance derivation, imported at module scope by agent.py and
            # called on every answer.
            str(ROOT / "provenance.py"),
            str(ROOT / "route_disclosure.py"),
            str(ROOT / "runtime_settings.py"),
            str(ROOT / "sql_policy.py"),
            # Added by the packaging test rather than by hand, which is the point
            # of that test: the semantic search tool arrived imported at module
            # scope and unlisted here, and nothing before serving would have said
            # so. Not this workstream's code, fixed here because a model that
            # cannot load is worse than a red test.
            str(ROOT / "semantic_layer.py"),
            str(ROOT / "semantic_retrieval.py"),
            str(ROOT / "tool_repetition.py"),
            str(ROOT / "tools.py"),
            str(ROOT / "unattributed_figures.py"),
            str(ROOT / "user_authorization.py"),
        ],
        **authorization,
        registered_model_name=model_name,
        input_example={
            "input": [
                {
                    "role": "user",
                    "content": "Compare active players by brand and title over the last 30 days.",
                }
            ]
        },
        pip_requirements=[
            "mlflow>=3.14.0",
            "databricks-sdk>=0.81.0",
            # CAPPED BELOW 3.0 ON PURPOSE. openai 3 swapped its transport from
            # `httpx` to `httpx2`, and both clients that reach the reasoning model
            # build an `httpx.Client` and hand it over as `http_client`: the one in
            # config.py, and the SDK's own `get_open_ai_client`. Under openai 3 the
            # first thing that happens is the import below going missing, and
            # lifting the cap without rewriting both call sites onto httpx2 only
            # moves the failure into the constructor.
            #
            # This is not a version nobody asked for: the range was open, openai 3
            # was published between two releases of this agent, and the second one
            # served every question a 400.
            "openai>=1.66.0,<3",
            "pydantic>=2.10.0",
            # DECLARED, though openai still carries it, because config.py imports
            # it directly and a dependency that arrives through somebody else's
            # requirements can leave the same way. It did.
            #
            # Worth more care than the others: this import runs when the first
            # question is asked rather than at load, so its absence passes every
            # deployment check, leaves the endpoint READY, and is first read by
            # whoever is being demoed to.
            "httpx>=0.27,<1",
            # The SQL guard imports this at module load. Without it the endpoint
            # fails to load, which beats serving unvalidated SQL.
            "sqlglot>=30.14.0",
        ],
    )

# `prod` is a signpost, not a dependency: deploy_agent.py is passed an explicit
# --model-version and the endpoint pins versions by number.
#
# ALIAS THE VERSION THIS RUN REGISTERED. Taking the registry's highest version
# instead lets two concurrent logs race, and the loser stamps `prod` onto the
# winner's version.
#
# Reading it back: Unity Catalog omits `aliases` from GetRegisteredModel unless
# include_aliases=true, so a plain `registered-models get` reports none.
version = model_info.registered_model_version
if version is None:
    raise RuntimeError(
        f"log_model did not register a version of {model_name}; refusing to move the "
        "'prod' alias, because the alias would then point at some earlier run's version."
    )
version = str(version)
client = MlflowClient(registry_uri="databricks-uc")
client.set_registered_model_tag(model_name, "astrolabe", "true")
client.set_registered_model_alias(model_name, "prod", version)
print(
    json.dumps(
        {
            "model_name": model_name,
            "model_version": version,
            # The scopes this version actually baked, on the SAME last stdout line
            # agent-release.sh reads model_version from. The scope gate tails that
            # one line and refuses when it carries no api_scopes, so the logged leg
            # of the model scope check has nothing to verify without it.
            "api_scopes": list(scopes),
            "model_uri": model_info.model_uri,
            "experiment": experiment,
        }
    )
)
