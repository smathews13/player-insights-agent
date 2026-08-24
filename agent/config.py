"""Where the running agent's configuration comes from.

`Settings.from_env()` runs at IMPORT time inside the serving container, which
inherits nothing from the shell that logged the model. So configuration travels
INSIDE the model artifact: `log_model.py` resolves it from the bundle target's
variables and hands it to `mlflow.pyfunc.log_model(model_config=...)`, and
`mlflow.models.ModelConfig()` reads it back here on load.

THE ARTIFACT WINS over the process environment. Those same log-time values name
the resources automatic authentication passthrough grants, so a runtime override
could aim the agent at a warehouse the model has no permission to use. One
version of the model is one configuration.

NOTHING THAT NAMES A WORKSPACE'S DATA MAY HAVE A DEFAULT. Missing configuration
raises at import, failing the model load loudly, rather than answering plausibly
about the wrong company.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

# The table declaration and the build stamp live in `preflight`, with the code
# that generates them, so there is one derivation of each.
from preflight import (
    BUILD_SHA_VAR,
    DECLARED_TABLES,
    MANIFEST_FROM_SCHEMA,
    MANIFEST_SOURCES,
)

#: Human-readable Genie space names when `get_space` is unavailable. Baked at
#: log time beside the ids so refusal text and tool descriptions can name a
#: space without a second API call at answer time.
DATA_GENIE_ROLE_LABEL = "Data Genie space"
DICTIONARY_GENIE_ROLE_LABEL = "Dictionary Genie space"

#: Field -> the environment variable that supplies it outside serving.
ENV_VARS = {
    "catalog": "PLAYER_INSIGHTS_CATALOG",
    "schema": "PLAYER_INSIGHTS_SCHEMA",
    "warehouse_id": "PLAYER_INSIGHTS_WAREHOUSE_ID",
    "data_genie_space_id": "PLAYER_INSIGHTS_DATA_GENIE_ID",
    "dictionary_genie_space_id": "PLAYER_INSIGHTS_DICTIONARY_GENIE_ID",
    # Resolved at log time from get_space(id).title (or a role label fallback).
    # Cleared by the release script so a laptop cannot invent them.
    "data_genie_space_title": "PLAYER_INSIGHTS_DATA_GENIE_TITLE",
    "dictionary_genie_space_title": "PLAYER_INSIGHTS_DICTIONARY_GENIE_TITLE",
    "llm_endpoint": "PLAYER_INSIGHTS_LLM_ENDPOINT",
    "llm_gateway": "PLAYER_INSIGHTS_LLM_GATEWAY",
    "catalog_allowlist": "PLAYER_INSIGHTS_CATALOG_ALLOWLIST",
    "catalog_denylist": "PLAYER_INSIGHTS_CATALOG_DENYLIST",
    "max_output_tokens": "PLAYER_INSIGHTS_MAX_OUTPUT_TOKENS",
    "tables": "PLAYER_INSIGHTS_TABLES",
    "declared_manifest": "PLAYER_INSIGHTS_DECLARED_MANIFEST",
    "manifest_source": "PLAYER_INSIGHTS_MANIFEST_SOURCE",
    "build_sha": BUILD_SHA_VAR,
}

#: Values that name one workspace's data. A wrong one produces confident answers
#: about the wrong environment rather than an error, which is why none of them
#: may be defaulted.
REQUIRED_KEYS = (
    "catalog",
    "schema",
    "warehouse_id",
    "data_genie_space_id",
    "dictionary_genie_space_id",
)

#: What `as_model_config` bakes into the artifact.
BAKED_KEYS = (
    *REQUIRED_KEYS,
    "data_genie_space_title",
    "dictionary_genie_space_title",
    "llm_endpoint",
    "llm_gateway",
    "catalog_allowlist",
    "catalog_denylist",
    "max_output_tokens",
    "tables",
    "declared_manifest",
    # Baked because it is a property of the manifest that was generated, not a
    # knob on the running agent: a served entity must never claim `genie` while
    # holding a manifest that was enumerated, or the reverse.
    "manifest_source",
    "build_sha",
)

# ---------------------------------------------------------------------------
# What it takes to change a value, once a deployment exists
#
# THE VOCABULARY FOR THE WHOLE DEPLOYMENT, not only for this module. The app's
# settings registry (player-insights-agent/shared/deployment-config.ts) uses
# these same five strings and has a test that parses this file to prove it uses
# no other, because both ends read them to decide whether to offer an edit box
# for a value that a form cannot actually change.
# ---------------------------------------------------------------------------

#: In the model artifact. Only a new model version changes it.
BAKED_AT_LOG_TIME = "model-version"
#: In the app container's environment. Only an app redeploy changes it.
APP_ENVIRONMENT = "app-redeploy"
#: The app reads it per request, so a stored override takes effect at once.
APP_RUNTIME = "app-runtime"
#: A literal in application source. Only editing and redeploying changes it.
APP_SOURCE = "app-source"
#: Read from a process environment a served entity does not inherit.
OUTSIDE_SERVING_ONLY = "agent-environment"

#: Every tier, so both ends can be checked against one list. These are
#: identifiers on a wire; the display copy lives with the screen that shows it.
MUTABILITY_TIERS = (
    BAKED_AT_LOG_TIME,
    APP_ENVIRONMENT,
    APP_RUNTIME,
    APP_SOURCE,
    OUTSIDE_SERVING_ONLY,
)

#: Field -> what it takes to change it. Every `ENV_VARS` key appears, so a field
#: added without deciding this fails the test that compares the two. EVERY FIELD
#: IS BAKED. `OUTSIDE_SERVING_ONLY` is kept in `MUTABILITY_TIERS` with no field
#: at that tier, because the TypeScript end carries display copy for it.
MUTABILITY = {key: BAKED_AT_LOG_TIME for key in ENV_VARS}

#: Where a resolved value came from. `artifact` is the only one a served
#: endpoint should ever report for a required key: the others mean the value
#: reached the agent by a route the model version does not record.
FROM_ARTIFACT = "artifact"
FROM_ENVIRONMENT = "environment"
FROM_PROFILE = "profile"
FROM_DEFAULT = "default"

#: Opt-in name for a known environment's values, for running from a laptop
#: without restating five ids. Asking by name is the point: they cannot arrive
#: by accident.
PROFILE_VAR = "PLAYER_INSIGHTS_CONFIG_PROFILE"
PROFILES: dict[str, dict[str, str]] = {
    "<your profile>": {
        "catalog": "<your_catalog>",
        "schema": "<your_schema>",
        "warehouse_id": "<sql-warehouse-id>",
        "data_genie_space_id": "<data-genie-space-id>",
        "dictionary_genie_space_id": "<dictionary-genie-space-id>",
    },
}


#: How the agent reaches its reasoning model. Empty is the default and posts to
#: ``{host}/serving-endpoints``; the other two route the same OpenAI-shaped call
#: through Unity AI Gateway, so the customer's rate limits, budgets, guardrails
#: and usage tracking apply. The paths are the ones
#: `databricks_openai._resolve_base_url` derives, not invented here.
GATEWAY_OFF = ""
GATEWAY_MLFLOW = "mlflow"
GATEWAY_OPENAI = "openai"

#: Mode -> the path appended to the workspace host. The agent calls
#: `chat.completions`, which lives under the MLflow-flavoured path; the native
#: OpenAI path is for a gateway fronting OpenAI models.
GATEWAY_PATHS = {
    GATEWAY_OFF: "/serving-endpoints",
    GATEWAY_MLFLOW: "/ai-gateway/mlflow/v1",
    GATEWAY_OPENAI: "/ai-gateway/openai/v1",
}


class MissingConfiguration(RuntimeError):
    """A value that identifies the deployment had no source.

    Raised rather than defaulted: inside serving this fails the model load, which
    is cheaper than an endpoint answering about somebody else's catalog.
    """


def _tuple(value: Any) -> tuple[str, ...]:
    """A comma-separated string or a YAML list, as a tuple of names."""

    if isinstance(value, str):
        return tuple(item.strip() for item in value.split(",") if item.strip())
    return tuple(str(item).strip() for item in value if str(item).strip())


def baked_config() -> dict[str, Any]:
    """Configuration MLflow injected from the model artifact, or ``{}``.

    ``ModelConfig()`` raises when no config is set, which is the normal case
    everywhere except inside a model load: at log time, in the preflight CLI,
    and in tests. That absence is not an error here: it just means the
    environment is the only source.
    """

    try:
        from mlflow.models import ModelConfig

        return dict(ModelConfig().to_dict() or {})
    except Exception:  # noqa: BLE001 - no config set, or no mlflow at all
        return {}


def _missing_message(missing: list[str], profile_name: str) -> str:
    variables = ", ".join(ENV_VARS[key] for key in missing)
    asked_for = (
        f"\nPLAYER_INSIGHTS_CONFIG_PROFILE={profile_name!r} is not a known profile; "
        f"known profiles: {', '.join(sorted(PROFILES))}."
        if profile_name and profile_name not in PROFILES
        else ""
    )
    return (
        f"Missing required Astrolabe configuration: {', '.join(missing)}."
        f"{asked_for}\n\n"
        "Inside the serving endpoint these arrive in the model artifact: "
        "bundle/agent-release.sh resolves the bundle target's variables and "
        "log_model.py bakes them in with mlflow.pyfunc.log_model(model_config=...). "
        "An endpoint missing them is serving a model version logged before that, or "
        "logged without the target's variables set. Re-log it from the target you "
        "mean to serve.\n\n"
        f"Outside serving, set: {variables}\n"
        "Or ask for a known environment by name, e.g. "
        f"{PROFILE_VAR}={next(iter(PROFILES))}.\n\n"
        "There is deliberately no default. A defaulted catalog, warehouse, or Genie "
        "space id answers questions correctly about the wrong workspace."
    )


class UnknownGateway(ValueError):
    """`llm_gateway` named something that is not a routing mode.

    Raised rather than falling back to the direct route. A typo that silently
    resolved to "off" would take a deployment the customer believes is governed
    by their gateway and quietly route around it: the one failure this whole
    binding exists to make impossible.
    """


def gateway_base_url(host: str, mode: str) -> str:
    """Where the reasoning model is reached, for this host and routing mode."""

    normalised = (mode or "").strip().lower()
    if normalised not in GATEWAY_PATHS:
        raise UnknownGateway(
            f"llm_gateway={mode!r} is not a routing mode. Use one of: "
            f"{', '.join(repr(name) for name in GATEWAY_PATHS)} "
            f"({GATEWAY_OFF!r} routes directly to the serving endpoint, which is "
            "the default and what a deployment with no AI Gateway wants)."
        )
    return host.rstrip("/") + GATEWAY_PATHS[normalised]


def open_ai_client(workspace: Any, mode: str) -> Any:
    """The OpenAI-compatible client for this workspace, on the route `mode` names."""

    if not mode:
        return workspace.serving_endpoints.get_open_ai_client()

    # Not `get_open_ai_client()` with a base_url override: that method hard-codes
    # the serving-endpoints suffix and documents base_url as reserved. Built
    # directly instead, with the same credentials it would have used.
    import httpx
    from openai import OpenAI

    config = workspace.config

    class _RefreshingBearer(httpx.Auth):
        """Re-reads the token per request, as the SDK's own client does.

        This client is built once per container and a served model outlives its
        token, so a header frozen at construction becomes a 401 some tens of
        minutes into the deployment's life.
        """

        def auth_flow(self, request: Any) -> Any:
            request.headers["Authorization"] = config.authenticate()["Authorization"]
            yield request

    return OpenAI(
        base_url=gateway_base_url(config.host, mode),
        api_key="databricks",  # unused; the auth flow above sets the header
        http_client=httpx.Client(auth=_RefreshingBearer()),
    )


def format_genie_space(space_id: str, title: str = "") -> str:
    """A space named for a human, with the id still present for the Genie UI.

    Refusal text, tool results and access probes all use this shape so a
    deployer looking at two spaces is told which one refused, in words they can
    recognise, without losing the hex they need to open Share.
    """

    space = (space_id or "").strip() or "(unset)"
    named = (title or "").strip()
    if named:
        return f"{named} ({space})"
    return space


@dataclass(frozen=True)
class Settings:
    llm_endpoint: str
    warehouse_id: str
    data_genie_space_id: str
    dictionary_genie_space_id: str
    catalog: str
    schema: str
    catalog_allowlist: tuple[str, ...]
    max_output_tokens: int
    #: Which route the reasoning model is reached by. One of `GATEWAY_PATHS`.
    #: Defaulted to off, so a deployment that names no gateway, including every
    #: version logged before this key existed, takes the direct route.
    llm_gateway: str = GATEWAY_OFF
    #: Human-readable Genie space titles, baked beside the ids at log time.
    #: Empty on versions logged before these fields existed; those keep naming
    #: spaces by id alone. A successful log always writes a title or a role
    #: label fallback, never blocks on a failed get_space.
    data_genie_space_title: str = ""
    dictionary_genie_space_title: str = ""
    #: Patterns naming tables that must never be declared, even inside an
    #: allowlisted scope. Applied after the scope listing and before the
    #: data-contract union, so an excluded table cannot be reintroduced.
    catalog_denylist: tuple[str, ...] = ()
    #: Schema-relative table names the agent depends on.
    tables: tuple[str, ...] = DECLARED_TABLES
    #: Every fully-qualified table named as a `DatabricksTable` resource at log
    #: time, generated from `catalog_allowlist` by
    #: `preflight.resolve_declared_manifest` and baked into the artifact.
    #:
    #: This is the agent's reach: passthrough grants the serving principal
    #: exactly these tables, so `list_data_assets` reads this back rather than
    #: querying Unity Catalog live and `validate_sql` refuses anything outside
    #: it. DEFAULTED EMPTY because a version logged before this field existed
    #: bakes no such key, and requiring it would fail its model load;
    #: `readable_tables` falls back to the data contract there.
    declared_manifest: tuple[str, ...] = ()
    #: How that manifest was generated. One of `preflight.MANIFEST_SOURCES`.
    #:
    #: ``schema`` enumerates every table in each `catalog_allowlist` scope and
    #: unions the data contract in. ``genie`` declares what the Genie spaces
    #: curate and nothing else, which is what a customer whose warehouse does not
    #: project onto our contract names needs.
    manifest_source: str = MANIFEST_FROM_SCHEMA
    # THERE IS NO FIELD HERE DESCRIBING THE NATURE OF THE DATA, deliberately.
    # `synthetic_data` used to sit at this position and gate a sentence stating
    # that the figures were generated. It is gone rather than defaulted off: no
    # deployment declares it, nothing reads it, and a version logged while it
    # existed simply carries a key this dataclass now ignores.
    #: The commit this version was logged from, so app-versus-model skew is
    #: readable. Defaulted empty for the same reason as `declared_manifest`, and
    #: empty means unknown: no reader may present it as agreement.
    build_sha: str = ""
    #: Field -> which route in `from_env` supplied it, as pairs so the dataclass
    #: stays frozen. Empty when the object was built by hand, which readers must
    #: present as unknown rather than as `artifact`. NOT in `BAKED_KEYS`: baking
    #: it would preserve the laptop's answer and report it as the endpoint's.
    sources: tuple[tuple[str, str], ...] = ()

    @property
    def namespace(self) -> str:
        return f"{self.catalog}.{self.schema}"

    def configuration_report(self) -> list[dict[str, Any]]:
        """Every resolved setting, with where it came from and what changes it.

        The provenance cannot be reconstructed later: a resolved value looks the
        same whichever route it took, and `environment` for a Genie space id
        inside a serving container is the silent misconfiguration this module
        exists to prevent.
        """

        origins = dict(self.sources)
        entries: list[dict[str, Any]] = []
        for key in ENV_VARS:
            value = getattr(self, key)
            entries.append(
                {
                    "key": key,
                    "env_var": ENV_VARS[key],
                    "value": list(value) if isinstance(value, tuple) else value,
                    "source": origins.get(key, ""),
                    "mutability": MUTABILITY[key],
                    "baked": key in BAKED_KEYS,
                    "required": key in REQUIRED_KEYS,
                }
            )
        return entries

    @property
    def readable_tables(self) -> tuple[str, ...]:
        """Fully-qualified tables the serving principal can actually read.

        The generated manifest when there is one; a version logged before the
        manifest existed falls back to the data contract, which is narrower than
        the truth for such a version and never wider, so the guard stays sound.
        """

        if self.declared_manifest:
            return self.declared_manifest
        return tuple(
            table if table.count(".") == 2 else f"{self.namespace}.{table}"
            for table in self.tables
        )

    def as_model_config(self) -> dict[str, Any]:
        """The configuration to bake into the model artifact at log time.

        Read back by `from_env` inside the serving container. Plain scalars and
        lists only: MLflow round-trips this through YAML.
        """

        values: dict[str, Any] = {}
        for key in BAKED_KEYS:
            value = getattr(self, key)
            values[key] = list(value) if isinstance(value, tuple) else value
        return values

    @classmethod
    def from_env(
        cls,
        env: Mapping[str, str] | None = None,
        baked: Mapping[str, Any] | None = None,
    ) -> Settings:
        """Resolve settings from the model artifact, then the environment.

        Raises `MissingConfiguration` rather than defaulting anything that names
        a workspace.
        """

        environment = os.environ if env is None else env
        artifact = dict(baked_config() if baked is None else baked)
        profile_name = (environment.get(PROFILE_VAR) or "").strip()
        profile = PROFILES.get(profile_name, {})

        # Recorded as each value is resolved rather than re-derived afterwards,
        # which would be a second copy of this precedence.
        origins: dict[str, str] = {}

        def resolve(key: str) -> Any:
            # The artifact is authoritative: it was written by the same run that
            # named the resources auth passthrough grants, so an environment
            # override could contradict the model's own permissions.
            value = artifact.get(key)
            if value not in (None, ""):
                origins[key] = FROM_ARTIFACT
                return value
            value = environment.get(ENV_VARS[key], "")
            if isinstance(value, str):
                value = value.strip()
            if value:
                origins[key] = FROM_ENVIRONMENT
                return value
            from_profile = profile.get(key)
            # The constructor supplies a compiled default for everything
            # allowed one, so "no source" and "defaulted" are the same state.
            origins[key] = FROM_PROFILE if from_profile else FROM_DEFAULT
            return from_profile

        resolved = {key: resolve(key) for key in ENV_VARS}
        missing = [key for key in REQUIRED_KEYS if not resolved[key]]
        if missing:
            raise MissingConfiguration(_missing_message(missing, profile_name))

        catalog = str(resolved["catalog"])
        allowlist = resolved["catalog_allowlist"] or catalog
        # Validated here rather than at first use, so an unrecognised mode
        # fails the model load rather than the first question.
        gateway = str(resolved["llm_gateway"] or GATEWAY_OFF).strip().lower()
        if gateway not in GATEWAY_PATHS:
            raise MissingConfiguration(
                f"{ENV_VARS['llm_gateway']}={resolved['llm_gateway']!r} is not a routing "
                f"mode. Use one of: {', '.join(repr(name) for name in GATEWAY_PATHS)}. "
                f"Leave it unset to reach the serving endpoint directly, which is what a "
                "deployment with no Unity AI Gateway wants."
            )
        manifest_source = str(resolved["manifest_source"] or MANIFEST_FROM_SCHEMA).strip().lower()
        if manifest_source not in MANIFEST_SOURCES:
            raise MissingConfiguration(
                f"{ENV_VARS['manifest_source']}={resolved['manifest_source']!r} is not a "
                f"manifest source. Use one of: "
                f"{', '.join(repr(name) for name in MANIFEST_SOURCES)}. This decides what "
                "the model declares as DatabricksTable resources, which is what automatic "
                "authentication passthrough grants, so a typo silently falling back to a "
                "default would change the agent's reach without saying so."
            )
        return cls(
            llm_endpoint=str(resolved["llm_endpoint"] or "databricks-claude-sonnet-4-6"),
            llm_gateway=gateway,
            warehouse_id=str(resolved["warehouse_id"]),
            data_genie_space_id=str(resolved["data_genie_space_id"]),
            dictionary_genie_space_id=str(resolved["dictionary_genie_space_id"]),
            data_genie_space_title=str(resolved["data_genie_space_title"] or ""),
            dictionary_genie_space_title=str(resolved["dictionary_genie_space_title"] or ""),
            catalog=catalog,
            schema=str(resolved["schema"]),
            catalog_allowlist=_tuple(allowlist),
            catalog_denylist=_tuple(resolved["catalog_denylist"] or ()),
            max_output_tokens=int(resolved["max_output_tokens"] or 4000),
            tables=_tuple(resolved["tables"] or DECLARED_TABLES),
            declared_manifest=_tuple(resolved["declared_manifest"] or ()),
            manifest_source=manifest_source,
            build_sha=str(resolved["build_sha"] or ""),
            sources=tuple(sorted(origins.items())),
        )
