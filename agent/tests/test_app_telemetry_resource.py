"""App telemetry: off unless a target says otherwise, and never in the agent's schema.

Two properties, both of which are cheap to break by hand and expensive to notice.

The first is that telemetry is OPT-IN. Ingestion is billed, and this bundle is
deployed into customer workspaces, so a destination that reaches the top level
as a default opts every deployment of this repo into a charge nobody agreed to.
That already happened once in this repo with the semantic layer's AI Search
endpoint, which billed by the hour for five days while nothing queried it.

The second is that the telemetry tables live OUTSIDE the agent's own schema.
`manifest_source` in its default `schema` mode enumerates every table in each
`catalog_allowlist` scope and declares one DatabricksTable resource per table,
which is what grants the serving principal SELECT. `otel_logs` records who
signed in and when. Put the two in one schema and enabling monitoring quietly
widens what the agent can be asked about, on the next re-log, with nothing in
the diff to say so.

READS THE PUBLISHED SHAPE, NOT JUST OURS. mirror/prune-bundle-target.py removes
the internal target from databricks.yml on the way out, so a published tree
declares no telemetry at all. The target-level assertions below iterate over
whatever targets are present rather than naming one, so this file passes on the
publication and still holds the internal tree to both properties.
"""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
BUNDLE = ROOT / "databricks.yml"
APP_RESOURCE = ROOT / "resources" / "player_insights_app.app.yml"
TELEMETRY_RESOURCE = ROOT / "resources" / "player_insights_telemetry.schema.yml"
APP_YAML = ROOT / "player-insights-agent" / "app.yaml"
APP_RELEASE = ROOT / "bundle" / "app-release.sh"

#: The environment variable the SERVER reads to find the telemetry tables.
#:
#: A third name for one destination, and the reason it exists is that the app
#: resource's `telemetry_export_destinations` is a PLATFORM setting: it tells
#: Databricks where to write, and the container never sees it. Without this
#: variable the server has no way to learn where the tables landed, and the Ops
#: tab would report telemetry as switched off on a deployment that is happily
#: ingesting -- correct-looking and wrong, with nothing on screen to say so.
SCHEMA_ENV = "PLAYER_INSIGHTS_TELEMETRY_SCHEMA"

#: The variable carrying the export destinations, and the one naming the schema
#: they are built from. Two variables that must move together; see
#: `test_a_target_declaring_one_telemetry_variable_declares_both`.
DESTINATIONS_VAR = "app_telemetry_destinations"
SCHEMA_VAR = "app_telemetry_schema"

#: The platform's own table names. It writes exactly these three, and the API
#: field each belongs under. A swap here is silent: logs would still be
#: ingested, into a table every query calls something else.
EXPECTED_TABLES = {
    "logs_table": "otel_logs",
    "metrics_table": "otel_metrics",
    "traces_table": "otel_spans",
}


def app_document() -> dict:
    return yaml.safe_load(APP_RESOURCE.read_text())


def bundle_document() -> dict:
    return yaml.safe_load(BUNDLE.read_text())


def targets() -> dict:
    return bundle_document().get("targets") or {}


def target_variables(target: dict) -> dict:
    return target.get("variables") or {}


def telemetry_targets() -> list[tuple[str, dict]]:
    """Every target that declares a telemetry destination, which may be none."""

    return [
        (name, body or {})
        for name, body in targets().items()
        if target_variables(body or {}).get(DESTINATIONS_VAR)
    ]


# ---------------------------------------------------------------------------
# Off by default
# ---------------------------------------------------------------------------


def test_the_base_app_omits_empty_destinations():
    """An empty API field crashes CLI 1.11/1.12 while creating the App."""

    app = app_document()["resources"]["apps"]["player_insights_app"]
    assert "telemetry_export_destinations" not in app


def test_the_destinations_default_to_empty():
    """Empty is the off state, and it is what an undeclared target renders."""

    declared = app_document()["variables"][DESTINATIONS_VAR]
    assert declared["type"] == "complex"
    assert declared["default"] == [], (
        "A default destination turns app telemetry on for every deployment of "
        "this bundle, and its ingestion is billed. Declare it in a target."
    )


def test_the_telemetry_schema_has_an_app_owned_default():
    assert app_document()["variables"][SCHEMA_VAR]["default"] == "player_insights_agent_telemetry"


def test_no_telemetry_is_declared_at_the_top_level():
    """A top-level value would reach every target, which is the failure mode."""

    top_level = bundle_document().get("variables") or {}
    for name in (DESTINATIONS_VAR, SCHEMA_VAR):
        assert name not in top_level, (
            f"{name} belongs in resources/player_insights_app.app.yml beside the "
            "resource it configures, and its value belongs in a target."
        )


# ---------------------------------------------------------------------------
# What a target that does opt in has to get right
# ---------------------------------------------------------------------------


def test_a_target_declaring_destinations_has_a_schema_name():
    """The schema has a safe default while destinations remain opt-in."""

    for _name, body in targets().items():
        variables = target_variables(body or {})
        has_destinations = bool(variables.get(DESTINATIONS_VAR))
        if has_destinations:
            assert variables.get(SCHEMA_VAR) or app_document()["variables"][SCHEMA_VAR]["default"]


def test_a_target_declaring_destinations_adds_the_app_field():
    """Only opt-in targets should send the optional field to the Apps API."""

    for name, body in telemetry_targets():
        app = body.get("resources", {}).get("apps", {}).get("player_insights_app", {})
        assert app.get("telemetry_export_destinations") == ("${var." + DESTINATIONS_VAR + "}"), (
            f"target {name!r} opts into telemetry but does not configure the App"
        )


def test_telemetry_never_lands_in_the_agents_own_schema():
    """The property this file exists for. See the module docstring."""

    for name, body in telemetry_targets():
        variables = target_variables(body)
        schema = variables.get(SCHEMA_VAR, app_document()["variables"][SCHEMA_VAR]["default"])
        assert schema != variables.get("app_schema"), (
            f"target {name!r} points app telemetry at the agent's own schema. The "
            "model's table manifest enumerates that schema, so the serving "
            "principal would be granted SELECT on a record of who signed in."
        )


def test_the_destination_tables_are_built_from_the_variables():
    """No catalog or schema written out, so there is one place to change it."""

    for name, body in telemetry_targets():
        for destination in target_variables(body)[DESTINATIONS_VAR]:
            for field, table in (destination["unity_catalog"]).items():
                assert table.startswith("${var.app_catalog}.${var." + SCHEMA_VAR + "}."), (
                    f"target {name!r} hardcodes a catalog or schema in {field}: {table!r}"
                )


def test_each_destination_names_the_three_tables_the_platform_writes():
    """Guards a copy-paste swap, which ingests fine and reads as an empty table."""

    for name, body in telemetry_targets():
        for destination in target_variables(body)[DESTINATIONS_VAR]:
            unity_catalog = destination["unity_catalog"]
            assert set(unity_catalog) == set(EXPECTED_TABLES), (
                f"target {name!r} does not name all three destination tables"
            )
            for field, expected in EXPECTED_TABLES.items():
                assert unity_catalog[field].endswith("." + expected), (
                    f"target {name!r} maps {field} to {unity_catalog[field]!r}, "
                    f"which does not end in {expected!r}"
                )


# ---------------------------------------------------------------------------
# What the SERVER is told, which is a different question from what the platform
# is told
# ---------------------------------------------------------------------------


def app_yaml_env() -> dict:
    """`app.yaml`'s env list, keyed by name."""

    document = yaml.safe_load(APP_YAML.read_text())
    return {entry["name"]: entry for entry in document.get("env") or []}


def test_the_server_is_told_where_the_telemetry_tables_are():
    """Otherwise Ops reports telemetry off on a deployment that is ingesting.

    `telemetry_export_destinations` configures the PLATFORM. It never reaches
    the container, so the server needs its own variable or it cannot read a
    table it has no name for. Reporting "not configured" while rows are being
    written is the failure this pins: it looks correct on screen.
    """

    assert SCHEMA_ENV in app_yaml_env(), (
        f"{SCHEMA_ENV} is missing from player-insights-agent/app.yaml, so the "
        "server has no way to learn where app telemetry lands and the Ops tab "
        "reports it as switched off however the bundle is configured."
    )


def test_the_telemetry_variable_ships_empty():
    """A real schema here is one workspace's catalog in every build.

    Same rule as PLAYER_INSIGHTS_ADMIN_EMAILS and PLAYER_INSIGHTS_EXPERIMENT_ID
    directly above it: this tree is published, so the value is resolved at
    release time for the target being released rather than written down here.
    Empty is read by the server as telemetry being off, which is one of its
    ordinary states and not an error.
    """

    entry = app_yaml_env()[SCHEMA_ENV]
    assert entry.get("value") == "", (
        f"{SCHEMA_ENV} carries a literal in app.yaml. That ships one "
        "workspace's catalog and schema into every build, including the "
        "published one. bundle/app-release.sh resolves it per target."
    )
    assert "valueFrom" not in entry, (
        f"{SCHEMA_ENV} cannot come from an app resource attachment: telemetry "
        "is a platform setting on the app rather than an attached resource."
    )


def test_the_release_builds_the_variable_from_the_bundle_and_not_by_hand():
    """The one place the two halves are held in step by machinery.

    `app_telemetry_schema` names the schema and `var.app_catalog` names the catalog,
    and the server wants them joined. A release that built this string from
    anything else would let the server read one schema while the platform wrote
    to another, and both would look fine.
    """

    release = APP_RELEASE.read_text()
    assert f"bundle_var_or_empty {SCHEMA_VAR}" in release, (
        f"bundle/app-release.sh no longer reads {SCHEMA_VAR}, so "
        f"{SCHEMA_ENV} is not built from the variable that creates the schema."
    )
    assert "bundle_var_or_empty app_catalog" in release, (
        "bundle/app-release.sh no longer reads the catalog, so the schema the "
        "server is given cannot be fully qualified."
    )
    assert f'{SCHEMA_ENV}="$TELEMETRY_SCHEMA"' in release, (
        f"bundle/app-release.sh does not export {SCHEMA_ENV} into the build, "
        "so the deployed app.yaml keeps its empty default and the server reads "
        "telemetry as off."
    )


def test_a_target_with_no_telemetry_gives_the_server_an_empty_value():
    """Empty must stay reachable, because it is the customer case.

    Ingestion is billed, so a customer target sets no destinations. The release
    has to resolve that to an empty string even though the app-owned telemetry
    schema exists.
    """

    release = APP_RELEASE.read_text()
    assert 'TELEMETRY_SCHEMA=""' in release, (
        "bundle/app-release.sh has no empty branch for a target that sets no "
        "telemetry schema, so a customer target would be given a partial name."
    )
    assert '"$TELEMETRY_DESTINATIONS_COUNT" -gt 0' in release, (
        "bundle/app-release.sh no longer checks whether telemetry destinations "
        "are enabled before exposing a schema to the server."
    )


def test_a_telemetry_target_creates_the_schema_it_writes_into():
    """Databricks creates the TABLES. Nothing creates the schema for us."""

    schemas = (yaml.safe_load(TELEMETRY_RESOURCE.read_text()).get("resources") or {}).get(
        "schemas"
    ) or {}
    declared = {schema.get("name") for schema in schemas.values() if isinstance(schema, dict)}
    assert "${var." + SCHEMA_VAR + "}" in declared
