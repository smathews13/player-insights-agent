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
)
from mlflow.tracking import MlflowClient

from config import Settings
from preflight import (
    BUILD_SHA_VAR,
    DIRTY_SUFFIX,
    WideningCheckUnavailable,
    newly_granted_tables,
    resolve_build_stamp,
    resolve_declared_manifest,
    widening_refusal,
)
from user_authorization import (
    MODEL_CONFIG_KEY,
    USER_AUTHORIZATION_ENV,
    announce,
    api_scopes,
    resolve,
)

ROOT = Path(__file__).parent
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

resources = [
    DatabricksServingEndpoint(endpoint_name=settings.llm_endpoint),
    DatabricksGenieSpace(genie_space_id=settings.data_genie_space_id),
    DatabricksGenieSpace(genie_space_id=settings.dictionary_genie_space_id),
    DatabricksSQLWarehouse(warehouse_id=settings.warehouse_id),
    *(DatabricksTable(table_name=table) for table in manifest),
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
        },
        indent=2,
    )
)

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
        model_config={**settings.as_model_config(), MODEL_CONFIG_KEY: user_auth.enabled},
        python_model=str(ROOT / "agent.py"),
        code_paths=[
            str(ROOT / "charts.py"),
            str(ROOT / "config.py"),
            str(ROOT / "contracts.py"),
            # config.py imports from this at module scope, so without it the
            # model fails to LOAD inside the container, long after the log ran.
            str(ROOT / "preflight.py"),
            str(ROOT / "tools.py"),
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
            "openai>=1.66.0",
            "pydantic>=2.10.0",
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
client.set_registered_model_alias(model_name, "prod", version)
print(
    json.dumps(
        {
            "model_name": model_name,
            "model_version": version,
            "model_uri": model_info.model_uri,
            "experiment": experiment,
        }
    )
)
