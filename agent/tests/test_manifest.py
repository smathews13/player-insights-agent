"""How the declared-table manifest is generated, and what it refuses.

Automatic authentication passthrough grants exactly the `DatabricksTable`
resources named at log time and nothing else, and the manifest is generated from
`catalog_allowlist`. That makes the allowlist load-bearing, and makes a mis-scoped
entry expensive: there is no `DatabricksCatalog` resource type, so a bare catalog
means one resource per table for every table in it. Hence the refusals below.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml
from mlflow.models.resources import DatabricksTable

import manifest_dryrun
from config import BAKED_KEYS, ENV_VARS, PROFILE_VAR, MissingConfiguration, Settings
from preflight import (
    BUILD_SHA_VAR,
    DECLARED_TABLES,
    DIRTY_SUFFIX,
    MANIFEST_FROM_SCHEMA,
    MAX_DECLARED_TABLES,
    MAX_GENIE_CURATED_TABLES,
    OBSERVED_DEPENDENCY_REFUSAL,
    PAYLOAD_TABLE_SIGNATURE,
    WARN_DECLARED_TABLES,
    ScopeError,
    WideningCheckUnavailable,
    discovery_scopes,
    is_inference_payload_table,
    newly_granted_tables,
    resolve_build_stamp,
    resolve_declared_manifest,
    widening_refusal,
)
from tools import (
    BLOCKED_COLUMNS,
    UNRETURNABLE_COLUMNS,
    SqlRefused,
    parse_sql,
    refuse_restricted_columns,
    validate_sql,
)

#: The columns `databricks.agents.deploy()` gives an inference payload table,
#: in full, so the signature is tested against the real shape rather than
#: against the four columns it happens to look for.
PAYLOAD_COLUMNS = (
    "databricks_request_id",
    "request_date",
    "client_request_id",
    "request_time",
    "status_code",
    "sampling_fraction",
    "execution_duration_ms",
    "request",
    "response",
    "logging_error_codes",
    "served_entity_id",
    "requester",
)


def settings(**overrides) -> Settings:
    base = dict(
        llm_endpoint="databricks-claude-sonnet-4-6",
        warehouse_id="wh-123",
        data_genie_space_id="space-data",
        dictionary_genie_space_id="space-dict",
        catalog="test_catalog",
        schema="test_schema",
        catalog_allowlist=("test_catalog.test_schema",),
        max_output_tokens=2500,
    )
    base.update(overrides)
    return Settings(**base)


class FakeCatalog:
    """Unity Catalog as the identity logging the model sees it.

    `columns` gives a table a shape; anything unnamed there gets one ordinary
    column, which is what the exclusion rules should see for a normal table.
    `unscreenable` withholds column metadata entirely, standing in for a
    listing that returned none.
    """

    def __init__(
        self,
        scopes: dict[str, list[str]],
        error: Exception | None = None,
        columns: dict[str, tuple[str, ...]] | None = None,
        unscreenable: tuple[str, ...] = (),
    ):
        self._scopes = scopes
        self._error = error
        self._columns = columns or {}
        self._unscreenable = set(unscreenable)
        self.listed: list[str] = []
        self.tables = SimpleNamespace(list=self._list)
        self.schemas = SimpleNamespace(list=self._list_schemas)

    def _list_schemas(self, catalog_name):
        names = sorted(
            scope.split(".", 1)[1]
            for scope in self._scopes
            if scope.startswith(f"{catalog_name}.")
        )
        return [SimpleNamespace(name=name) for name in names]

    def _list(self, catalog_name, schema_name):
        scope = f"{catalog_name}.{schema_name}"
        self.listed.append(scope)
        if self._error:
            raise self._error
        return [
            SimpleNamespace(name=name, columns=self._shape(name))
            for name in self._scopes.get(scope, [])
        ]

    def _shape(self, name):
        if name in self._unscreenable:
            return None
        return [
            SimpleNamespace(name=column) for column in self._columns.get(name, ("id",))
        ]


CONTRACT = FakeCatalog({"test_catalog.test_schema": list(DECLARED_TABLES)})


class FakeGenie:
    """A workspace whose Genie spaces have curated tables, as `genie` mode reads them.

    Returns the space's serialized definition, which is where curation actually
    lives. Faking the parsed result instead would let the parser rot against the
    shape the API returns, which is the half of this that has any way of being
    wrong.
    """

    def __init__(
        self,
        spaces: dict[str, list[str]],
        error: Exception | None = None,
        serialized: dict[str, str | None] | None = None,
    ):
        self._spaces = spaces
        self._error = error
        self._serialized = serialized or {}
        self.asked: list[str] = []
        self.genie = SimpleNamespace(get_space=self._get_space)
        # Present so a mode confusion shows up as the wrong tables rather than as
        # an AttributeError: `genie` mode must not enumerate, and `schema` mode
        # run against this object must not silently find nothing.
        self.tables = SimpleNamespace(list=self._list)

    def _get_space(self, space_id, include_serialized_space=None):
        self.asked.append(space_id)
        if self._error:
            raise self._error
        assert include_serialized_space, "curation only comes back when it is asked for"
        if space_id in self._serialized:
            body = self._serialized[space_id]
        else:
            tables = [
                {"identifier": name} for name in self._spaces.get(space_id, [])
            ]
            body = json.dumps({"data_sources": {"tables": tables}})
        return SimpleNamespace(space_id=space_id, serialized_space=body)

    def _list(self, catalog_name, schema_name):
        raise AssertionError("genie mode must not enumerate a schema")


def genie_settings(**overrides) -> Settings:
    overrides.setdefault("catalog_allowlist", ("test_catalog", "customer_catalog"))
    return settings(manifest_source="genie", **overrides)


#: What the customer deployment looked like: their own catalog and schema, their
#: own table names, and not one of our six contract names anywhere in it.
THEIRS = (
    "customer_catalog.player_insights.dim_account",
    "customer_catalog.player_insights.fact_session",
    "customer_catalog.player_insights.fact_transaction",
)


# ---------------------------------------------------------------------------
# manifest_source=genie: declaring what will actually be asked
# ---------------------------------------------------------------------------


def test_genie_mode_declares_a_customers_own_tables_without_asking_for_ours():
    """The incident, as a test.

    A customer deploying this bundle was blocked because it kept telling him to
    create catalogs and tables whose names mean nothing to him. In `schema` mode
    the six contract names are unioned in unconditionally, so his manifest got
    six DatabricksTable resources for tables that do not exist and six probes
    that fail on the report an operator trusts. The documented way out was to
    create views projecting his columns onto our names.

    In `genie` mode his spaces decide, and our vocabulary never comes up.
    """

    workspace = FakeGenie({"space-data": list(THEIRS), "space-dict": [THEIRS[0]]})

    manifest, notes = resolve_declared_manifest(genie_settings(), workspace)

    assert manifest == THEIRS
    assert not [name for name in manifest if name.split(".")[-1] in DECLARED_TABLES]
    # Both spaces read, and the duplicate collapsed rather than declared twice.
    assert workspace.asked == ["space-data", "space-dict"]
    assert any("space-data" in note for note in notes)


def test_schema_mode_is_what_a_deployment_naming_nothing_still_gets():
    # The default has to be the old behaviour exactly, or every existing
    # deployment changes what it grants on its next release.
    assert settings().manifest_source == "schema"
    assert resolve_declared_manifest(settings(), CONTRACT) == resolve_declared_manifest(
        settings(manifest_source="schema"), CONTRACT
    )


def test_genie_mode_is_opt_in_because_defaulting_it_would_narrow_the_demo():
    """The decision, locked, so changing it has to be deliberate.

    Our own Genie space resources curate exactly the six contract tables, and the
    demo schema holds more than that. So a genie DEFAULT would silently narrow the
    demo's manifest to the curated six on the next release, and
    `newly_granted_tables` classifies a narrowing as needing no approval, so it
    would land with no refusal and no audit line, silently narrowing what the demo
    can answer.

    If this test is in your way because you are making genie the default, the thing
    to check first is what happens to a target whose spaces curate a subset of its
    allowlisted scopes. See the reasoning above MANIFEST_SOURCES.
    """

    assert Settings(
        llm_endpoint="e",
        warehouse_id="w",
        data_genie_space_id="d",
        dictionary_genie_space_id="y",
        catalog="c",
        schema="s",
        catalog_allowlist=("c.s",),
        max_output_tokens=1,
    ).manifest_source == MANIFEST_FROM_SCHEMA

    # A curated subset of a wider schema: schema mode declares the schema, genie
    # mode declares the subset. This is the shape of the demo, and the difference
    # is what a default flip would apply to every target at once.
    wider = FakeCatalog({"test_catalog.test_schema": [*DECLARED_TABLES, "raw_purchases"]})
    curated = [f"test_catalog.test_schema.{name}" for name in DECLARED_TABLES]

    enumerated, _ = resolve_declared_manifest(settings(), wider)
    from_spaces, _ = resolve_declared_manifest(
        genie_settings(), FakeGenie({"space-data": curated, "space-dict": curated})
    )

    assert "test_catalog.test_schema.raw_purchases" in enumerated
    assert "test_catalog.test_schema.raw_purchases" not in from_spaces


def test_genie_mode_cannot_silently_declare_nothing():
    """The argument against defaulting, tested rather than assumed.

    The worry is a customer with no Genie spaces adopted at log time getting an
    empty manifest and an agent that can read nothing: a worse failure than the
    181 dependencies, because it is quiet. Every route to an empty manifest is a
    refusal that names the fix, which is what makes opt-in safe to offer at all.
    """

    cases = (
        genie_settings(data_genie_space_id="", dictionary_genie_space_id=""),
        genie_settings(dictionary_genie_space_id=""),
    )
    workspaces = (FakeGenie({}), FakeGenie({"space-data": []}))
    for setting, workspace in zip(cases, workspaces, strict=True):
        with pytest.raises(ScopeError) as raised:
            resolve_declared_manifest(setting, workspace)
        assert MANIFEST_FROM_SCHEMA in str(raised.value)

    # And a space id that names a space nobody can read.
    with pytest.raises(ScopeError):
        resolve_declared_manifest(
            genie_settings(), FakeGenie({}, error=PermissionError("no such space"))
        )


def test_genie_mode_collapses_the_deployment_that_unity_catalog_refused():
    """181 tables to 10, which is the whole reason to prefer this to a bigger ceiling.

    The bound is the platform's rather than our arithmetic: a Genie space holds at
    most MAX_GENIE_CURATED_TABLES tables, so a manifest built from two of them
    cannot reach the dependency limit however wide the underlying schema is.
    """

    wide = {
        "test_catalog.test_schema": [
            *DECLARED_TABLES,
            *(f"unrelated_{index}" for index in range(OBSERVED_DEPENDENCY_REFUSAL)),
        ]
    }
    with pytest.raises(ScopeError) as refused:
        resolve_declared_manifest(settings(), FakeCatalog(wide))
    assert str(MAX_DECLARED_TABLES) in str(refused.value)

    curated = [f"test_catalog.test_schema.{name}" for name in DECLARED_TABLES]
    manifest, _ = resolve_declared_manifest(
        genie_settings(), FakeGenie({"space-data": curated[:5], "space-dict": curated[5:]})
    )

    assert len(manifest) == len(DECLARED_TABLES)
    assert len(manifest) <= MAX_GENIE_CURATED_TABLES * 2


def test_the_governance_note_does_not_claim_governance_changed():
    """The trade-off, stated as the code behaves rather than as the mode implies.

    An earlier version of this note said the cross-label refusal, the
    restricted-column refusal and the net-bookings convention all "degrade to
    prompt-level guardrails" when the contract is undeclared. Checked against the
    code, that is wrong three times over, and the tests below this one establish
    each part. Two of the three are enforced by column name and are unaffected by
    any manifest; the third never had an enforced form at all, and no longer has
    a requested form either now that the compiled knowledge is gone.

    So nothing about governance changes with the manifest. An operator reading a
    release has to be able to tell that: "governance is degraded" would send them
    looking for a control that was turned off, and there isn't one.
    """

    _, notes = resolve_declared_manifest(
        genie_settings(), FakeGenie({"space-data": list(THEIRS), "space-dict": [THEIRS[0]]})
    )

    governance = next(note for note in notes if note.startswith("GOVERNANCE:"))

    assert "STILL ENFORCED" in governance
    assert "crm_customer_ref" in governance and "NATURAL" in governance
    assert "Unity Catalog grants" in governance
    # The note used to list what an undeclared contract WITHHELD from the model.
    # There is no such body of text any more, so a note still describing one
    # would send an operator looking for guidance that cannot be restored.
    assert "withheld" not in governance.lower()
    assert "compiled knowledge" not in governance.lower()
    # The residual risk, which is the one people assume away: the guard's column
    # lists are our names, and it says so rather than implying broader cover.
    assert "in either manifest_source mode" in governance
    assert "BLOCKED_COLUMNS" in governance


def test_the_restricted_column_refusal_does_not_depend_on_the_manifest():
    """Established by calling it, because "silently not fire" is the easy assumption.

    `refuse_restricted_columns` takes a parsed tree and nothing else. It has no
    access to Settings, to the manifest, or to manifest_source, so it cannot behave
    differently between the two modes, and it refuses a table nobody declared just
    as readily as one of ours.
    """

    for sql in (
        "SELECT email FROM gold_player_180d_summary",
        "SELECT email FROM nobody.declared.this",
        "SELECT count(*) FROM a JOIN b ON a.crm_customer_ref = b.crm_customer_ref",
        "SELECT count(*) FROM a JOIN b USING (crm_customer_ref)",
        "SELECT count(*) FROM a NATURAL JOIN b",
    ):
        with pytest.raises(SqlRefused):
            refuse_restricted_columns(parse_sql(sql))


def test_the_refusal_fails_open_on_a_schema_that_names_its_identifiers_differently():
    """The residual risk, and it is not caused by genie mode.

    The guard's column lists are OUR names. A schema calling the same real
    identifiers `account_email` or `customer_ref` matches nothing and is passed,
    in `schema` mode exactly as much as in `genie` mode. Asserted rather than left
    implicit because an operator who believes the guard covers a schema it has
    never heard of is who this costs, and because a future change that makes these
    refuse should have to come past this test and update the note with it.
    """

    for sql in (
        "SELECT account_email FROM customer_catalog.player_insights.dim_account",
        "SELECT gamer_tag, customer_ref FROM customer_catalog.player_insights.dim_account",
        "SELECT count(*) FROM a JOIN b ON a.customer_ref = b.customer_ref",
    ):
        refuse_restricted_columns(parse_sql(sql))


def test_the_net_bookings_convention_is_neither_enforced_nor_requested():
    """It was prompt text, and the SQL guard never referred to it.

    So it did not degrade from enforced to requested when the contract was
    undeclared; and now that the compiled knowledge is gone it is not requested
    either. What matters for governance is that it was never in the guard, which
    is what this pins: removing the prompt text turned nothing off.
    """

    assert "net_bookings_usd" not in BLOCKED_COLUMNS | UNRETURNABLE_COLUMNS


def test_a_genie_manifest_that_happens_to_hold_the_contract_says_nothing_about_governance():
    """The note is about this manifest, not about the mode.

    Our own spaces curate the contract. Telling an operator their governance is
    degraded when the tables the refusals bind to are right there in the manifest
    would be false, and a warning that fires when it does not apply is a warning
    people learn to skip.
    """

    curated = [f"test_catalog.test_schema.{name}" for name in DECLARED_TABLES]
    _, notes = resolve_declared_manifest(
        genie_settings(), FakeGenie({"space-data": curated, "space-dict": curated})
    )

    assert not [note for note in notes if note.startswith("GOVERNANCE:")]


def test_a_space_that_curates_nothing_stops_the_release():
    """Not a warning. In this mode the curation IS the manifest.

    A space with no data sources yields an endpoint granted nothing, which fails
    on its first question with a permission error rather than at release time
    with a sentence naming the cause.
    """

    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(
            genie_settings(), FakeGenie({"space-data": list(THEIRS), "space-dict": []})
        )

    message = str(raised.value)
    assert "dictionary" in message and "space-dict" in message
    assert "manifest_source=schema" in message, "the refusal has to name the way out"


def test_a_space_that_cannot_be_read_stops_the_release_rather_than_declaring_half():
    # Half a manifest is the worst outcome available: the endpoint answers
    # whichever questions belong to the space that was read and fails the rest,
    # which reads as a model quality problem rather than a permissions one.
    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(
            genie_settings(),
            FakeGenie({"space-data": list(THEIRS)}, error=PermissionError("nope")),
        )

    assert "space-data" in str(raised.value)


def test_genie_mode_with_no_space_configured_refuses_instead_of_declaring_nothing():
    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(
            genie_settings(data_genie_space_id="", dictionary_genie_space_id=""),
            FakeGenie({}),
        )

    assert "data_genie_space_id" in str(raised.value)


def test_the_dry_run_says_that_in_prose_rather_than_raising_a_traceback(monkeypatch, capsys):
    """Because the refusal above cannot be reached the way an operator gets there.

    Both space ids are REQUIRED in every mode, so `Settings.from_env` raises
    before `resolve_declared_manifest` is ever called and the sentence tested
    above is unreachable from the command line. What the deployer got instead
    was a MissingConfiguration traceback that never mentioned manifest_source,
    on the first command the documentation tells them to run. Setup is where
    this project has burned people, so a stack trace is not an acceptable answer
    to a mode that was switched on and left unconfigured.
    """

    monkeypatch.delenv(PROFILE_VAR, raising=False)
    for key in ("data_genie_space_id", "dictionary_genie_space_id"):
        monkeypatch.delenv(ENV_VARS[key], raising=False)
    monkeypatch.setenv(ENV_VARS["manifest_source"], "genie")

    assert manifest_dryrun.main() == 1

    printed = capsys.readouterr().out
    assert "REFUSED" in printed
    assert ENV_VARS["data_genie_space_id"] in printed
    # The mode is the half the generic message cannot know about: in `genie` the
    # spaces are the generator, so an unset id is an empty manifest rather than a
    # Genie call that fails later.
    assert f"{ENV_VARS['manifest_source']}=genie" in printed
    assert f"{ENV_VARS['manifest_source']}=schema" in printed, "name the way out"


def test_a_curated_name_that_is_not_three_part_is_dropped_rather_than_guessed_at():
    """Resolving a bare name against the agent's own catalog would grant SELECT.

    Every entry in this manifest becomes a real grant to the serving principal,
    so inventing the catalog for an ambiguous name risks granting access to a
    table nobody named. Dropping it costs a table the space could not identify.
    """

    workspace = FakeGenie(
        {"space-data": [*THEIRS, "just_a_table", "schema.table", "a.b.c.d"]}
    )

    manifest, _ = resolve_declared_manifest(
        genie_settings(dictionary_genie_space_id=""), workspace
    )

    assert manifest == THEIRS


def test_the_denylist_still_vetoes_a_curated_table():
    """An explicit "never declare this" outranks a space's curation.

    The denylist is the operator saying a table must not be granted. A Genie
    space curating it is not new information about whether it should be.
    """

    manifest, notes = resolve_declared_manifest(
        genie_settings(
            dictionary_genie_space_id="", catalog_denylist=("*.fact_transaction",)
        ),
        FakeGenie({"space-data": list(THEIRS)}),
    )

    assert "customer_catalog.player_insights.fact_transaction" not in manifest
    assert len(manifest) == 2
    assert any("excluded" in note for note in notes)


def test_a_curated_table_outside_data_catalogs_is_refused():
    """data_catalogs is the complete boundary even in Genie manifest mode."""

    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(
            genie_settings(
                dictionary_genie_space_id="",
                catalog_allowlist=("different_catalog.allowed",),
            ),
            FakeGenie({"space-data": list(THEIRS)}),
        )

    assert "outside data_catalogs" in str(raised.value)


def test_everything_curated_being_excluded_is_a_refusal_not_an_empty_manifest():
    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(
            genie_settings(dictionary_genie_space_id="", catalog_denylist=("*",)),
            FakeGenie({"space-data": list(THEIRS)}),
        )

    assert "could read nothing" in str(raised.value)


def test_a_space_with_no_serialized_definition_reads_as_curating_nothing():
    # Rather than as an AttributeError forty lines later. An older workspace, or
    # an identity that can see the space but not its definition, both land here.
    with pytest.raises(ScopeError):
        resolve_declared_manifest(
            genie_settings(dictionary_genie_space_id=""),
            FakeGenie({}, serialized={"space-data": None}),
        )


def test_an_unrecognised_manifest_source_fails_at_model_load():
    """Where a missing catalog fails, not thirty seconds into the first question.

    It decides what the model declares, so a typo quietly falling back to the
    default would change the agent's reach without saying anything.
    """

    with pytest.raises(MissingConfiguration) as raised:
        Settings.from_env(
            env={
                "PLAYER_INSIGHTS_CATALOG": "c",
                "PLAYER_INSIGHTS_SCHEMA": "s",
                "PLAYER_INSIGHTS_WAREHOUSE_ID": "w",
                "PLAYER_INSIGHTS_DATA_GENIE_ID": "d",
                "PLAYER_INSIGHTS_DICTIONARY_GENIE_ID": "y",
                "PLAYER_INSIGHTS_MANIFEST_SOURCE": "genie-spaces",
            }
        )

    message = str(raised.value)
    assert "'schema'" in message and "'genie'" in message


def test_the_manifest_source_is_baked_so_a_deployed_version_cannot_misreport_it():
    """Which mode a version was logged in is a property of that version.

    It is how anyone looking at a deployed endpoint can tell whether the
    contract-bound governance behaviours were in force. A served entity able to
    claim `genie` while holding an enumerated manifest, or the reverse, would
    make that unanswerable.
    """

    assert "manifest_source" in BAKED_KEYS
    logged = genie_settings().as_model_config()
    assert logged["manifest_source"] == "genie"


# ---------------------------------------------------------------------------
# What a scope means
# ---------------------------------------------------------------------------


def test_a_bare_catalog_is_preserved_as_a_whole_catalog_scope():
    """data_catalogs allows a catalog or a narrower catalog.schema."""

    assert discovery_scopes(settings(catalog_allowlist=("test_catalog",))) == [
        "test_catalog"
    ]


def test_multiple_whole_catalogs_are_valid_data_scopes():
    assert discovery_scopes(
        settings(catalog_allowlist=("test_catalog", "partner_catalog"))
    ) == ["test_catalog", "partner_catalog"]


def test_an_explicit_schema_scope_is_taken_as_written():
    scopes = discovery_scopes(
        settings(catalog_allowlist=("test_catalog.test_schema", "partner_catalog.shared"))
    )
    assert scopes == ["test_catalog.test_schema", "partner_catalog.shared"]


def test_scope_order_is_stable_and_duplicates_collapse():
    # Two log runs of one configuration have to produce the same resource list,
    # or a re-log looks like a permission change in review.
    scopes = discovery_scopes(
        settings(
            catalog_allowlist=(
                "test_catalog.b",
                "test_catalog.a",
                "test_catalog.b",
                "test_catalog",
            )
        )
    )
    assert scopes == ["test_catalog.b", "test_catalog.a", "test_catalog"]


def test_information_schema_is_refused_because_the_endpoint_cannot_read_it():
    """Measured, not assumed: it is backed by the `system` catalog.

    Declaring it would put tables in `list_data_assets` that fail at query time,
    which is the one thing reading the manifest instead of Unity Catalog exists
    to prevent.
    """

    with pytest.raises(ScopeError) as raised:
        discovery_scopes(settings(catalog_allowlist=("test_catalog.information_schema",)))

    assert "system" in str(raised.value)


def test_a_four_part_entry_is_refused_rather_than_truncated():
    with pytest.raises(ScopeError):
        discovery_scopes(settings(catalog_allowlist=("a.b.c",)))


def test_an_empty_allowlist_stops_the_log_instead_of_declaring_nothing():
    # An empty manifest is an endpoint that can read nothing at all, which is
    # indistinguishable from a permissions outage once it is deployed.
    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(settings(catalog_allowlist=()), CONTRACT)

    assert "could read nothing" in str(raised.value)


# ---------------------------------------------------------------------------
# What lands in the manifest
# ---------------------------------------------------------------------------


def test_the_manifest_is_every_table_unity_catalog_exposes_in_scope():
    workspace = FakeCatalog(
        {"test_catalog.test_schema": ["silver_one", "gold_two", *DECLARED_TABLES]}
    )

    manifest, notes = resolve_declared_manifest(settings(), workspace)

    assert "test_catalog.test_schema.silver_one" in manifest
    assert "test_catalog.test_schema.gold_two" in manifest
    assert workspace.listed == ["test_catalog.test_schema"]
    assert any("2 table(s)" in note or "table(s)" in note for note in notes)


def test_every_name_is_fully_qualified_because_that_is_what_a_resource_needs():
    manifest, _ = resolve_declared_manifest(settings(), CONTRACT)

    assert manifest
    assert all(name.count(".") == 2 for name in manifest)


def test_several_scopes_are_unioned_in_the_order_they_were_configured():
    workspace = FakeCatalog(
        {
            "test_catalog.test_schema": list(DECLARED_TABLES),
            "partner_catalog.shared": ["partner_one"],
        }
    )

    manifest, notes = resolve_declared_manifest(
        settings(catalog_allowlist=("test_catalog", "partner_catalog.shared")), workspace
    )

    assert "partner_catalog.shared.partner_one" in manifest
    assert workspace.listed == ["test_catalog.test_schema", "partner_catalog.shared"]
    assert any("partner_catalog.shared: 1 table(s)" in note for note in notes)


def test_a_contract_table_that_does_not_exist_is_reported_not_declared():
    """The union is conditional now, and this test used to assert the opposite.

    It asserted that all six contract names land in the manifest even when the
    listing returned none of them, on the reasoning that a Genie space fails as a
    whole if one of its tables is unreadable, so dropping one would produce a model
    whose first Genie call fails.

    The premise holds; the conclusion does not follow. Declaring a DatabricksTable
    resource for a table that does not exist does not make the space work:
    passthrough grants SELECT on a name, and there is nothing behind the name. The
    space fails on its first call either way. So the union never prevented that
    failure; it only delayed the discovery, while causing two failures of its own:
    six phantom resources on every customer schema, and a manifest that named
    tables the deployment could not read.

    What replaces it is more information rather than less: the table is absent from
    the manifest, and the notes say which and what it means.
    """

    workspace = FakeCatalog({"test_catalog.test_schema": ["something_else"]})

    manifest, notes = resolve_declared_manifest(settings(), workspace)

    assert manifest == ("test_catalog.test_schema.something_else",)
    for table in DECLARED_TABLES:
        assert f"test_catalog.test_schema.{table}" not in manifest

    warning = [note for note in notes if note.startswith("WARNING:")]
    assert warning, "an absent contract has to be reported, or this is a silent drop"
    assert all(table in warning[0] for table in DECLARED_TABLES)


def test_all_of_the_contract_absent_reads_as_somebody_elses_data_model():
    # Ordinary and supported. A customer is simply not built on our tables, and
    # telling them to fix something would send them back to creating views named
    # after our demo, the incident this whole change exists to end.
    _, notes = resolve_declared_manifest(
        settings(), FakeCatalog({"test_catalog.test_schema": ["dim_account"]})
    )

    warning = next(note for note in notes if note.startswith("WARNING:"))
    assert "not built on our" in warning
    assert "nothing here needs" in warning


def test_some_of_the_contract_absent_is_the_case_worth_stopping_on():
    """Dangerous in both readings, which is why it gets different advice.

    Either this is our schema and the listing did not return what it should have,
    or it is a schema that partly collides with our names, in which case the
    collision is a coincidence and the columns behind those names are not ours.
    Either way it is the deployment that reads as authoritative while being wrong.
    """

    _, notes = resolve_declared_manifest(
        settings(),
        FakeCatalog({"test_catalog.test_schema": [*DECLARED_TABLES[:3], "dim_account"]}),
    )

    warning = next(note for note in notes if note.startswith("WARNING:"))
    assert "worth stopping on" in warning
    assert "USE SCHEMA" in warning, "one of the two readings is a permissions problem"
    assert "coincidence" in warning, "and the other is a name collision"


def test_a_full_contract_still_declares_every_one_of_it():
    # The demo's case, and it has to be untouched by the conditional union.
    manifest, notes = resolve_declared_manifest(settings(), CONTRACT)

    for table in DECLARED_TABLES:
        assert f"test_catalog.test_schema.{table}" in manifest
    assert not [note for note in notes if note.startswith("WARNING:")]
    assert not [note for note in notes if note.startswith("GOVERNANCE:")]


def test_a_scope_that_lists_nothing_stops_the_log():
    # Either the scope is wrong or the logging identity lacks USE SCHEMA. Both
    # produce an endpoint that can read nothing from it, and both are cheap to
    # fix now and expensive to find after an 11-minute endpoint update.
    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(settings(), FakeCatalog({}))

    assert "USE SCHEMA" in str(raised.value)


# ---------------------------------------------------------------------------
# An empty schema is not a bad scope
#
# The gate refused ANY scope that listed no tables, and a bare catalog entry
# expands to every schema in the catalog, so one empty schema anywhere in it
# stopped the release. `cdp_share_prod` holds four schemas of production data
# and an empty `default`, and the release died on `default` while telling the
# operator the scope was wrong. The only way past was to hand-list the non-empty
# schemas, which is a list that goes stale the moment a schema is added.
# ---------------------------------------------------------------------------


#: A whole catalog as one is actually shaped: several schemas with data in them
#: and one the platform created that nothing has written to.
MIXED_CATALOG = {
    "share_catalog.default": [],
    "share_catalog.brand_a_production": ["fact_session", "dim_title"],
    "share_catalog.brand_b_production": ["fact_purchase"],
}


def test_one_empty_schema_does_not_refuse_a_catalog_full_of_tables():
    workspace = FakeCatalog(MIXED_CATALOG)

    manifest, notes = resolve_declared_manifest(
        settings(catalog_allowlist=("share_catalog",)), workspace
    )

    assert manifest == (
        "share_catalog.brand_a_production.dim_title",
        "share_catalog.brand_a_production.fact_session",
        "share_catalog.brand_b_production.fact_purchase",
    )
    # Skipped, and said so. Silence would hide a schema an operator expected
    # tables in, which is the half of the old refusal worth keeping.
    skipped = [note for note in notes if "exposed no tables and were skipped" in note]
    assert skipped, "an empty schema is ordinary, but it is not nothing"
    assert "share_catalog.default" in skipped[0]


def test_the_empty_schema_needs_no_hand_listing_to_get_past():
    """The bare catalog entry and the hand-listed one declare the same tables.

    Hand-listing the non-empty schemas was the workaround, and it is worse than
    the bug: the list is a snapshot of one day's catalog, and a schema added
    afterwards is silently outside the agent's reach.
    """

    bare, _ = resolve_declared_manifest(
        settings(catalog_allowlist=("share_catalog",)), FakeCatalog(MIXED_CATALOG)
    )
    hand_listed, _ = resolve_declared_manifest(
        settings(
            catalog_allowlist=(
                "share_catalog.brand_a_production",
                "share_catalog.brand_b_production",
            )
        ),
        FakeCatalog(MIXED_CATALOG),
    )

    assert bare == hand_listed


def test_an_app_catalogs_unwritten_schemas_do_not_stop_a_release():
    """The same defect from the other side, and the one that would recur.

    A deployment declares a telemetry schema and an assets schema before
    anything writes to either, so its own app catalog holds two empty schemas on
    the first release by construction.
    """

    workspace = FakeCatalog(
        {
            "app_catalog.player_insights": ["gold_player_180d_summary"],
            "app_catalog.player_insights_telemetry": [],
            "app_catalog.astrolabe_app_assets": [],
        }
    )

    manifest, _ = resolve_declared_manifest(
        settings(catalog_allowlist=("app_catalog",)), workspace
    )

    assert manifest == ("app_catalog.player_insights.gold_player_180d_summary",)


def test_a_catalog_whose_every_schema_is_empty_is_still_a_refusal():
    """The failure the message describes, and the only one it can distinguish.

    Nothing visible anywhere in the entry genuinely means the entry names the
    wrong scope or the identity lacks USE SCHEMA on it.
    """

    workspace = FakeCatalog({"share_catalog.default": [], "share_catalog.staging": []})

    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(settings(catalog_allowlist=("share_catalog",)), workspace)

    message = str(raised.value)
    assert "'share_catalog'" in message, "the refusal names the entry, not one schema"
    assert "share_catalog.default" in message, "and what the identity could see"
    assert "USE SCHEMA" in message


def test_a_catalog_that_exposes_no_schemas_at_all_names_that_as_the_finding():
    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(
            settings(catalog_allowlist=("share_catalog",)), FakeCatalog({})
        )

    assert "no schemas at all" in str(raised.value)


def test_an_entry_with_tables_is_unaffected_by_another_entry_being_empty():
    """Per-entry, not per-release: an empty entry is still that entry's refusal."""

    workspace = FakeCatalog(
        {"share_catalog.brand_a_production": ["fact_session"], "other_catalog.default": []}
    )

    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(
            settings(catalog_allowlist=("share_catalog", "other_catalog")), workspace
        )

    assert "'other_catalog'" in str(raised.value)


def test_explicit_production_schemas_build_the_whole_69_table_manifest():
    """The production trim is schema-level and does not truncate table listings.

    `2k_production` cannot be represented whole under the 90-table ceiling: its
    121 tables exceed the budget before any other schema is added. The other
    three production schemas fit together at 69, and every table in each must
    survive the explicit-schema path.
    """

    scopes = {
        "cdp_share_prod.northwind_production": [f"northwind_{index}" for index in range(41)],
        "cdp_share_prod.global_production": [f"global_{index}" for index in range(25)],
        "cdp_share_prod.acme_production": [f"acme_{index}" for index in range(3)],
    }

    manifest, _ = resolve_declared_manifest(
        settings(catalog_allowlist=tuple(scopes)),
        FakeCatalog(scopes),
    )

    assert len(manifest) == 69
    assert {
        name.rsplit(".", 1)[0]
        for name in manifest
    } == set(scopes)


def test_an_empty_explicit_schema_is_an_empty_entry_and_still_refuses():
    """Skipping applies inside a catalog, not to an explicitly empty entry.

    When `catalog.schema` is listed directly, that schema is the whole
    `data_catalogs` entry. Zero visible tables there is still the real scope
    failure, even when another explicit entry exposes tables.
    """

    workspace = FakeCatalog(
        {
            "cdp_share_prod.northwind_production": ["fact_session"],
            "cdp_share_prod.empty_production": [],
        }
    )

    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(
            settings(
                catalog_allowlist=(
                    "cdp_share_prod.northwind_production",
                    "cdp_share_prod.empty_production",
                )
            ),
            workspace,
        )

    message = str(raised.value)
    assert "'cdp_share_prod.empty_production'" in message
    assert "whole entry" in message.lower()


def test_a_failed_listing_stops_the_log_rather_than_shrinking_the_manifest():
    workspace = FakeCatalog({}, error=RuntimeError("PERMISSION_DENIED: cannot list schema"))

    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(settings(), workspace)

    assert "partial listing" in str(raised.value)


def test_too_many_tables_is_refused_because_each_one_is_a_grant():
    """The ceiling that stops a mis-scoped entry becoming a bulk grant.

    The demo's own catalog holds 5,446 tables across 421 unrelated schemas. With
    no ceiling, one wrong entry grants the serving principal SELECT across all
    of them and buries the six tables the agent is about.
    """

    workspace = FakeCatalog(
        {"test_catalog.test_schema": [f"table_{index}" for index in range(MAX_DECLARED_TABLES + 1)]}
    )

    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(settings(), workspace)

    message = str(raised.value)
    assert str(MAX_DECLARED_TABLES) in message
    assert "catalog.schema" in message


def test_the_ceiling_sits_below_the_only_refusal_anyone_has_measured():
    """The defect this pair of constants exists to close.

    The ceiling was 250 and Unity Catalog refused a real customer deployment at
    181 dependencies. A guard above the platform's own limit is not a guard: the
    release died inside `mlflow.pyfunc.log_model` with an opaque registry error
    instead of here, and `manifest_dryrun.py` reported 181 tables as fine on the
    way in.

    The assertion is deliberately an inequality rather than an equality on a
    number. UC's cap is documented nowhere (no resource-limits row, no error
    condition, no SDK docstring), and nobody has bisected it, so any specific
    ceiling this file asserted would be a claim it cannot support. What it can
    support is "below the one refusal we have seen".
    """

    assert MAX_DECLARED_TABLES < OBSERVED_DEPENDENCY_REFUSAL
    # And above what a deployment has a documented reason to need, or the guard
    # refuses correct configurations: a Genie space holds at most 30 tables, so
    # two fully-curated spaces are the largest manifest genie mode can produce.
    assert WARN_DECLARED_TABLES < MAX_DECLARED_TABLES
    assert WARN_DECLARED_TABLES == MAX_GENIE_CURATED_TABLES * 2


def test_the_refusal_names_genie_mode_before_it_names_the_allowlist():
    """Which fix is offered first is the substance, not the phrasing.

    A deployment that hits the ceiling is usually one whose allowlist points at a
    real schema of a real size. "Narrow catalog_allowlist" asks them to hide
    their own data model; declaring what their Genie spaces already curate asks
    them for nothing. The refusal has to lead with the second.
    """

    workspace = FakeCatalog(
        {"test_catalog.test_schema": [f"table_{index}" for index in range(MAX_DECLARED_TABLES + 1)]}
    )

    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(settings(), workspace)

    message = str(raised.value)
    assert message.index("manifest_source=genie") < message.index("catalog_allowlist")
    # The measurement, so a reader can tell our budget from the platform's limit.
    assert str(OBSERVED_DEPENDENCY_REFUSAL) in message
    assert "documented nowhere" in message


def test_a_manifest_past_two_spaces_worth_is_reported_not_refused():
    """Between the warning and the ceiling, the release still happens.

    The warning is the signal an operator needs before the refusal arrives, and
    refusing here instead would break every deployment sitting legitimately in
    that band, of which the demo is nearly one.
    """

    workspace = FakeCatalog(
        {
            "test_catalog.test_schema": [
                *DECLARED_TABLES,
                *(f"table_{index}" for index in range(WARN_DECLARED_TABLES)),
            ]
        }
    )

    manifest, notes = resolve_declared_manifest(settings(), workspace)

    assert len(manifest) > WARN_DECLARED_TABLES
    warning = [note for note in notes if note.startswith("WARNING:")]
    assert warning, "a manifest over the warning threshold has to say so in the notes"
    assert str(OBSERVED_DEPENDENCY_REFUSAL) in warning[0]
    assert "manifest_source=genie" in warning[0]


def test_a_manifest_under_the_warning_threshold_says_nothing_about_size():
    # The demo's own manifest is ten tables. A size note on every run would be
    # noise, and noise is what stops the warning above being read.
    _, notes = resolve_declared_manifest(settings(), CONTRACT)

    assert not [note for note in notes if note.startswith("WARNING:")]


# ---------------------------------------------------------------------------
# What is kept out
#
# Enumerating a schema proposes declaring everything in it, and the endpoint
# writes its own inference payload table into the agent's schema. Declaring that
# grants the agent SELECT on every question ever asked of it, every answer, and
# the requester.
# ---------------------------------------------------------------------------


def test_the_endpoints_own_payload_table_is_excluded_without_being_configured():
    """The exclusion that must not depend on an operator remembering."""

    workspace = FakeCatalog(
        {"test_catalog.test_schema": [*DECLARED_TABLES, "player_insights_agent_payload"]},
        columns={"player_insights_agent_payload": PAYLOAD_COLUMNS},
    )

    manifest, notes = resolve_declared_manifest(settings(), workspace)

    assert "test_catalog.test_schema.player_insights_agent_payload" not in manifest
    assert any("inference payload table" in note for note in notes)


def test_the_payload_table_is_recognised_by_shape_not_by_our_name_for_it():
    """A customer's payload table is named after THEIR endpoint.

    Matching our literal 'player_insights_agent_payload' would exclude nothing on
    their workspace, which is where this defect actually costs something: their
    users' questions, in a table the agent can read, on their first deploy.
    """

    workspace = FakeCatalog(
        {"test_catalog.test_schema": [*DECLARED_TABLES, "acme_player_agent_payload"]},
        columns={"acme_player_agent_payload": PAYLOAD_COLUMNS},
    )

    manifest, _ = resolve_declared_manifest(settings(), workspace)

    assert "test_catalog.test_schema.acme_player_agent_payload" not in manifest


def test_a_table_that_merely_shares_a_column_name_is_not_excluded():
    # The signature has to be narrow enough that an ordinary analytical table
    # with a `request` or `response` column keeps its grant.
    workspace = FakeCatalog(
        {"test_catalog.test_schema": [*DECLARED_TABLES, "support_tickets"]},
        columns={"support_tickets": ("ticket_id", "request", "response")},
    )

    manifest, _ = resolve_declared_manifest(settings(), workspace)

    assert "test_catalog.test_schema.support_tickets" in manifest


def test_the_signature_is_evaluated_against_the_real_payload_shape():
    payload = SimpleNamespace(
        name="anything_at_all",
        columns=[SimpleNamespace(name=column) for column in PAYLOAD_COLUMNS],
    )
    ordinary = SimpleNamespace(name="gold_summary", columns=[SimpleNamespace(name="id")])

    assert PAYLOAD_TABLE_SIGNATURE <= set(PAYLOAD_COLUMNS)
    assert is_inference_payload_table(payload) is True
    assert is_inference_payload_table(ordinary) is False
    # Not False: unknown is a gap to report, not a table that was cleared.
    assert is_inference_payload_table(SimpleNamespace(name="x", columns=None)) is None


def test_a_table_that_could_not_be_screened_is_declared_but_reported():
    """Fail-open, deliberately, and loudly.

    Refusing to log because a listing returned no column metadata would make the
    release depend on an SDK detail. Declaring it silently is how the payload
    table gets back in. So it is declared and named in the notes, where the dry
    run puts it in front of an operator.
    """

    workspace = FakeCatalog(
        {"test_catalog.test_schema": [*DECLARED_TABLES, "mystery"]},
        unscreenable=("mystery",),
    )

    manifest, notes = resolve_declared_manifest(settings(), workspace)

    assert "test_catalog.test_schema.mystery" in manifest
    assert any("could not be screened" in note for note in notes)
    assert any("mystery" in note for note in notes)


def test_the_denylist_excludes_by_bare_name_pattern():
    workspace = FakeCatalog(
        {
            "test_catalog.test_schema": [
                *DECLARED_TABLES,
                "raw_purchases",
                "raw_player_profiles",
                "validation_results",
            ]
        }
    )

    manifest, notes = resolve_declared_manifest(
        settings(catalog_denylist=("raw_*", "validation_results")), workspace
    )

    assert "test_catalog.test_schema.raw_purchases" not in manifest
    assert "test_catalog.test_schema.raw_player_profiles" not in manifest
    assert "test_catalog.test_schema.validation_results" not in manifest
    assert any("catalog_denylist pattern 'raw_*'" in note for note in notes)


def test_the_denylist_also_matches_a_fully_qualified_name():
    workspace = FakeCatalog({"test_catalog.test_schema": [*DECLARED_TABLES, "scratch"]})

    manifest, _ = resolve_declared_manifest(
        settings(catalog_denylist=("test_catalog.test_schema.scratch",)), workspace
    )

    assert "test_catalog.test_schema.scratch" not in manifest


def test_an_exclusion_is_not_undone_by_the_data_contract_union():
    """The ordering requirement, stated as a test.

    Exclusions are applied to the listing, and the contract is unioned in after.
    A contract table caught by an exclusion therefore has two possible outcomes,
    and the quiet one (re-adding it) would make the deny list advisory.
    """

    denied = f"test_catalog.test_schema.{DECLARED_TABLES[0]}"

    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(settings(catalog_denylist=(DECLARED_TABLES[0],)), CONTRACT)

    message = str(raised.value)
    assert denied in message
    assert "data contract" in message
    assert "catalog_denylist" in message


def test_the_contract_is_protected_from_the_built_in_rule_too():
    # Not reachable today, but the check covers both kinds of exclusion rather
    # than only the configurable one, so a future signature change cannot
    # silently strip a contract table.
    workspace = FakeCatalog(
        {"test_catalog.test_schema": list(DECLARED_TABLES)},
        columns={DECLARED_TABLES[0]: PAYLOAD_COLUMNS},
    )

    with pytest.raises(ScopeError) as raised:
        resolve_declared_manifest(settings(), workspace)

    assert "inference payload table" in str(raised.value)


def test_a_contract_table_missing_from_the_listing_is_still_protected():
    # The deny list is checked against the contract itself, not only against
    # what the listing returned, so an entry naming a contract table fails even
    # when that table was absent from the scope.
    workspace = FakeCatalog({"test_catalog.test_schema": ["something_else"]})

    with pytest.raises(ScopeError):
        resolve_declared_manifest(
            settings(catalog_denylist=(DECLARED_TABLES[-1],)), workspace
        )


def test_an_excluded_table_is_refused_by_the_guard_as_well_as_ungranted():
    """The equality the manifest exists to hold, checked on the excluded side.

    An excluded table is not granted, so the guard has to refuse it too;
    otherwise the agent writes SQL that reaches the warehouse and fails there,
    which reads like missing data rather than a policy decision.
    """

    workspace = FakeCatalog(
        {"test_catalog.test_schema": [*DECLARED_TABLES, "player_insights_agent_payload"]},
        columns={"player_insights_agent_payload": PAYLOAD_COLUMNS},
    )
    manifest, _ = resolve_declared_manifest(settings(), workspace)
    served = dataclasses.replace(settings(), declared_manifest=manifest)

    with pytest.raises(ValueError, match="Not in the declared table set"):
        validate_sql(
            "SELECT requester, request FROM "
            "test_catalog.test_schema.player_insights_agent_payload",
            served.readable_tables,
        )


def test_the_denylist_travels_inside_the_artifact():
    # Baked so the artifact records why tables are missing from its own
    # manifest. Nothing re-applies it at serving time (the manifest is already
    # filtered), but a reader of the model config can see what shaped it.
    logged = settings(catalog_denylist=("raw_*",)).as_model_config()

    assert logged["catalog_denylist"] == ["raw_*"]

    served = Settings.from_env(
        env={
            "PLAYER_INSIGHTS_CATALOG": "test_catalog",
            "PLAYER_INSIGHTS_SCHEMA": "test_schema",
            "PLAYER_INSIGHTS_WAREHOUSE_ID": "wh-123",
            "PLAYER_INSIGHTS_DATA_GENIE_ID": "space-data",
            "PLAYER_INSIGHTS_DICTIONARY_GENIE_ID": "space-dict",
        },
        baked=logged,
    )
    assert served.catalog_denylist == ("raw_*",)


def test_the_denylist_can_be_set_from_the_environment_outside_serving():
    served = Settings.from_env(
        env={
            "PLAYER_INSIGHTS_CATALOG": "test_catalog",
            "PLAYER_INSIGHTS_SCHEMA": "test_schema",
            "PLAYER_INSIGHTS_WAREHOUSE_ID": "wh-123",
            "PLAYER_INSIGHTS_DATA_GENIE_ID": "space-data",
            "PLAYER_INSIGHTS_DICTIONARY_GENIE_ID": "space-dict",
            "PLAYER_INSIGHTS_CATALOG_DENYLIST": "raw_*, validation_results",
        },
        baked={},
    )

    assert served.catalog_denylist == ("raw_*", "validation_results")


def test_the_payload_table_appearing_later_does_not_change_the_manifest():
    """A fresh workspace declares one set; a re-log declares another.

    The payload table only exists after the first deploy, so the same
    configuration enumerates a different schema the second time round with
    nobody editing anything. With the exclusion in place that drift disappears
    rather than being something an operator has to notice.
    """

    before = FakeCatalog({"test_catalog.test_schema": list(DECLARED_TABLES)})
    after = FakeCatalog(
        {"test_catalog.test_schema": [*DECLARED_TABLES, "player_insights_agent_payload"]},
        columns={"player_insights_agent_payload": PAYLOAD_COLUMNS},
    )

    first, _ = resolve_declared_manifest(settings(), before)
    second, _ = resolve_declared_manifest(settings(), after)

    assert first == second


# ---------------------------------------------------------------------------
# What the running agent reads back
# ---------------------------------------------------------------------------


def test_the_manifest_travels_inside_the_artifact():
    manifest, _ = resolve_declared_manifest(settings(), CONTRACT)
    logged = dataclasses.replace(settings(), declared_manifest=manifest).as_model_config()

    assert logged["declared_manifest"] == list(manifest)

    served = Settings.from_env(
        env={
            "PLAYER_INSIGHTS_CATALOG": "test_catalog",
            "PLAYER_INSIGHTS_SCHEMA": "test_schema",
            "PLAYER_INSIGHTS_WAREHOUSE_ID": "wh-123",
            "PLAYER_INSIGHTS_DATA_GENIE_ID": "space-data",
            "PLAYER_INSIGHTS_DICTIONARY_GENIE_ID": "space-dict",
        },
        baked=logged,
    )
    assert served.readable_tables == manifest


def test_the_guard_accepts_exactly_the_tables_the_endpoint_was_granted():
    """The gap this module closes, stated as one equality.

    Two sets used to be derived independently: what `validate_sql` accepted (from
    `catalog_allowlist`) and what the serving principal could read (a hand-written
    resource list). Anything in the first but not the second reached the warehouse
    and failed there with a permissions error, which reads like missing data.

    Both are now the manifest. So the guard accepts a table if and only if the
    endpoint holds a grant on it.
    """

    workspace = FakeCatalog(
        {"test_catalog.test_schema": [*DECLARED_TABLES, "gold_extra_summary"]}
    )
    manifest, _ = resolve_declared_manifest(settings(), workspace)
    served = dataclasses.replace(settings(), declared_manifest=manifest)

    # The grant as MLflow serializes it into the artifact, which is what auth
    # passthrough reads to decide what the serving principal may select from.
    granted = {
        entry["name"]
        for table in manifest
        for entry in DatabricksTable(table_name=table).to_dict()["table"]
    }
    assert granted == set(served.readable_tables)

    for table in manifest:
        assert validate_sql(f"SELECT * FROM {table}", served.readable_tables) == [table]

    # A table in the allowlisted scope but absent from the listing is absent from
    # the manifest, so it is refused here rather than at the warehouse.
    with pytest.raises(ValueError, match="Not in the declared table set"):
        validate_sql(
            "SELECT * FROM test_catalog.test_schema.not_listed", served.readable_tables
        )


def test_log_model_declares_and_bakes_the_same_manifest():
    """A source-level trip-wire, because the two uses are eleven lines apart.

    `log_model.py` cannot be imported to be tested: it logs a model as a side
    effect of import. But the property that matters is textual: one variable both
    names the `DatabricksTable` resources and travels in `model_config`. Splitting
    them into two derivations is how the guard and the grants diverge again, and it
    would not fail anything else in this suite.
    """

    source = (Path(__file__).resolve().parents[1] / "log_model.py").read_text()

    assert "manifest, manifest_notes = resolve_declared_manifest(" in source
    assert "DatabricksTable(table_name=table) for table in manifest" in source
    # Not anchored on the closing paren: the same call carries other log-time
    # values (the build stamp), and this trip-wire is about the manifest.
    assert "dataclasses.replace(settings, declared_manifest=manifest" in source
    # Spread rather than passed whole, because the execution identity travels in
    # the same config without being a `Settings` field. The property this guards
    # is unchanged and is why it is anchored on the call rather than on the whole
    # argument: whatever else is merged in, `settings` (the object that named
    # the resources) is still what supplies the baked configuration.
    assert "model_config={**settings.as_model_config()" in source


def test_a_model_logged_before_the_manifest_existed_still_loads():
    """The defaulted-field pattern, for the same reason `charts` is defaulted.

    The agent and the app deploy separately, so an endpoint can be serving a
    version logged before this field existed. Requiring it would turn every such
    version into a failed model load; falling back to the data contract is
    narrower than that version's real reach, never wider.
    """

    served = settings(declared_manifest=())

    assert served.readable_tables == tuple(
        f"test_catalog.test_schema.{table}" for table in DECLARED_TABLES
    )


# ---------------------------------------------------------------------------
# The widening gate
#
# `catalog_denylist` narrows the generated manifest, so a release that loses it
# re-declares the excluded tables and re-grants SELECT on them, without erroring.
# The variable lives in databricks.yml, which fixes the cause. These cover the
# backstop: a release compares what it is about to declare against what the live
# version was granted, and refuses a superset.
# ---------------------------------------------------------------------------


class FakeRegistry:
    """Unity Catalog's record of a registered model's versions.

    Only the two calls the comparison makes: list the versions, and read one
    version's table dependencies. `dependencies=None` stands in for a version UC
    has not populated, which must not read as "granted nothing".
    """

    def __init__(
        self,
        versions: dict[int, tuple[str, ...] | None],
        list_error: Exception | None = None,
        get_error: Exception | None = None,
    ):
        self._versions = versions
        self._list_error = list_error
        self._get_error = get_error
        self.model_versions = SimpleNamespace(list=self._list, get=self._get)

    def _list(self, full_name, **_):
        if self._list_error:
            raise self._list_error
        return [SimpleNamespace(version=version) for version in sorted(self._versions)]

    def _get(self, full_name, version, **_):
        if self._get_error:
            raise self._get_error
        tables = self._versions[int(version)]
        if tables is None:
            return SimpleNamespace(model_version_dependencies=None)
        return SimpleNamespace(
            model_version_dependencies=SimpleNamespace(
                dependencies=[
                    SimpleNamespace(table=SimpleNamespace(table_full_name=name))
                    for name in tables
                ]
            )
        )


GRANTED = ("c.s.players", "c.s.sessions")


def test_a_manifest_that_matches_the_live_version_is_not_a_widening():
    previous, added, removed = newly_granted_tables(
        FakeRegistry({9: GRANTED}), "c.s.agent", GRANTED
    )

    assert (previous, added, removed) == (9, (), ())


def test_a_lost_denylist_is_caught_as_newly_granted_tables():
    """The exact scenario, expressed as what it does to the manifest.

    A denylist of `raw_*` excluded two tables from version 9. It was shell state,
    the shell is clean, and the tables come back. That is a SELECT grant on each
    of them and a widened SQL guard, so it has to stop.
    """

    widened = (*GRANTED, "c.s.raw_purchases", "c.s.raw_events")

    previous, added, removed = newly_granted_tables(
        FakeRegistry({9: GRANTED}), "c.s.agent", widened
    )

    assert previous == 9
    assert added == ("c.s.raw_purchases", "c.s.raw_events")
    assert removed == ()


def test_the_refusal_names_every_table_and_the_flag_that_approves_it():
    message = widening_refusal("c.s.agent", 9, ["c.s.raw_purchases"])

    assert "c.s.raw_purchases" in message
    assert "catalog_denylist" in message
    assert "--allow-widening" in message


def test_narrowing_is_reported_but_is_not_a_widening():
    """Applying a denylist for the first time removes tables, and that is fine.

    Access taken away is already loud (a data-contract table that goes missing
    fails its Genie space on the first call), so it is reported, not gated.
    """

    previous, added, removed = newly_granted_tables(
        FakeRegistry({9: (*GRANTED, "c.s.raw_purchases")}), "c.s.agent", GRANTED
    )

    assert (previous, added, removed) == (9, (), ("c.s.raw_purchases",))


def test_the_comparison_uses_the_highest_version_not_the_first_listed():
    previous, added, _ = newly_granted_tables(
        FakeRegistry({7: ("c.s.only_in_7",), 9: GRANTED}), "c.s.agent", GRANTED
    )

    assert previous == 9
    assert added == ()


def test_a_first_release_has_nothing_to_compare_against():
    previous, added, removed = newly_granted_tables(FakeRegistry({}), "c.s.agent", GRANTED)

    assert (previous, added, removed) == (None, (), ())


@pytest.mark.parametrize(
    "registry",
    [
        FakeRegistry({9: None}),
        FakeRegistry({9: ()}),
        FakeRegistry({9: GRANTED}, list_error=RuntimeError("PERMISSION_DENIED")),
        FakeRegistry({9: GRANTED}, get_error=RuntimeError("PERMISSION_DENIED")),
    ],
    ids=["dependencies-not-populated", "no-dependencies", "list-fails", "get-fails"],
)
def test_an_unreadable_previous_version_is_unavailable_not_a_pass(registry):
    """The distinction the gate turns on.

    A version whose dependencies UC has not populated looks exactly like a
    version that was granted nothing. Reporting the second would make every
    release a 'widening' of everything, which trains an operator to pass
    --allow-widening reflexively and disarms the check for the release that
    matters.
    """

    with pytest.raises(WideningCheckUnavailable):
        newly_granted_tables(registry, "c.s.agent", GRANTED)


def test_log_model_gates_on_the_widening_and_fails_open_when_it_cannot_tell():
    """A source-level trip-wire, for the same reason as the manifest one above.

    `log_model.py` logs a model on import, so the wiring cannot be executed in a
    test. What must hold is textual: the comparison runs against the manifest that
    was just resolved, a widening without the flag stops the log, and a registry
    that will not answer produces a warning rather than an outage.
    """

    source = (Path(__file__).resolve().parents[1] / "log_model.py").read_text()

    assert 'ALLOW_WIDENING = "--allow-widening" in sys.argv[1:]' in source
    assert "newly_granted_tables(\n        workspace, model_name, manifest\n    )" in source
    assert "if newly_granted and not ALLOW_WIDENING:" in source
    assert "raise SystemExit(widening_refusal(" in source
    assert "except WideningCheckUnavailable as error:" in source


def test_the_release_script_writes_the_denylist_down_and_clears_what_it_cannot():
    """Every key in `config.py`'s ENV_VARS has a stated home. Read this if it failed.

    IF YOU ADDED A SETTING AND THIS TEST IS NOW FAILING, it is not in your way.
    It is asking you one question: where does your value come from on the machine
    that logs the model? Answer it by putting the key in one of the three sets
    below, and doing what that set implies. Do not delete the key from the sets to
    make the test pass; that is the defect the test exists to catch, and it will
    not show up anywhere else.

    The defect: `catalog_denylist` was read by `Settings.from_env`, baked into the
    model artifact, and documented as the knob a customer uses to narrow what
    their agent can read, while existing nowhere in `databricks.yml` and being
    exported by none of `agent-release.sh`'s values. So it lived in whichever
    shell happened to run the release. A re-log from a clean shell dropped it, the
    excluded tables came back as `DatabricksTable` resources, auth passthrough
    granted the serving principal `SELECT` on each, and `validate_sql` began
    accepting them. Nothing errored. The only trace was `"denylist": []` in
    stdout, which is exactly what a correct run that never had one prints.

    A setting the bundle does not write is a setting the deploying laptop decides,
    and when it narrows data access, forgetting it widens data access silently.
    That is why this asserts closure over the whole set rather than over the one
    key that happened to be found.
    """

    source = (Path(__file__).resolve().parents[2] / "bundle" / "agent-release.sh").read_text()

    #: Written down in databricks.yml and exported from it, so a stale shell value
    #: THE VALUE NAMES SOMETHING ABOUT ONE WORKSPACE. It gets a variable in
    #: databricks.yml and an `export` here, so the bundle is the single place it is
    #: written down and a stale shell value cannot survive into a log. This is the
    #: right home for almost everything.
    exported = {
        "catalog",
        "schema",
        "warehouse_id",
        "data_genie_space_id",
        "dictionary_genie_space_id",
        "llm_endpoint",
        "llm_gateway",
        "catalog_allowlist",
        "catalog_denylist",
        "max_output_tokens",
        "manifest_source",
    }
    #: THE CODE OWNS IT AND NO OPERATOR SHOULD SET IT. The release `unset`s it, so
    #: a value left in a shell cannot reach a logged model at all. `tables` is the
    #: data contract our own demo estate is built to; `declared_manifest` is
    #: generated at log time.
    cleared = {
        "tables",
        "declared_manifest",
        "data_genie_space_title",
        "dictionary_genie_space_title",
    }
    #: THE REPOSITORY ANSWERS IT BETTER THAN ANY CONFIGURATION COULD. Neither
    #: exported nor cleared: a build stamp in the bundle goes stale, and clearing
    #: it takes away the only source a checkout without git has.
    #: `resolve_build_stamp` reads git FIRST, so the environment cannot override
    #: the repository, which is what a new key must earn before joining this set.
    derived = {"build_sha"}

    unclassified = set(ENV_VARS) - (exported | cleared | derived)
    assert not unclassified, (
        f"{sorted(unclassified)}: config.py can resolve these from the environment, and "
        "the release neither writes them down nor clears them, so they reach a logged "
        "model from whatever shell ran it, and the model's behaviour depends on a laptop. "
        "Pick a category above. See this test's docstring."
    )
    assert not (exported | cleared | derived) - set(ENV_VARS), (
        "a key was classified here but no longer exists in ENV_VARS: delete it from the "
        "set, and check the release script is not still exporting a name nothing reads"
    )
    for key in exported:
        assert f"export {ENV_VARS[key]}=" in source, f"{ENV_VARS[key]} is not exported"
    for key in cleared:
        assert f"unset {ENV_VARS[key]}" in source, f"{ENV_VARS[key]} is not cleared"
    for key in derived:
        assert ENV_VARS[key] not in source, f"{ENV_VARS[key]} is the repository's to decide"
    assert "bundle_var_or_empty catalog_denylist" in source


def test_the_denylist_is_declared_in_the_bundle_with_an_empty_default():
    """Where the defect actually was.

    Read by config.py, baked into the artifact, documented as the customer's
    knob, and absent from databricks.yml, so it lived in a shell. An empty
    default is the correct value; being declared is what makes it visible to
    `bundle validate` and to anyone reading the target.
    """

    bundle = yaml.safe_load((Path(__file__).resolve().parents[2] / "databricks.yml").read_text())
    variables = bundle["variables"]

    assert "catalog_denylist" in variables, "config.py reads it; the bundle must declare it"
    assert variables["catalog_denylist"]["default"] == ""


def test_the_empty_denylist_on_the_demo_target_reads_as_a_decision():
    """An empty exclusion list has to say whether anyone chose it.

    An empty `catalog_denylist` with nothing beside it invites the next reader to
    conclude nobody got round to narrowing it, and to helpfully narrow it. The
    demo target states the value and marks it as deliberate.

    SKIPPED WHERE THAT TARGET IS NOT DECLARED: the published tree has it removed
    from databricks.yml outright, and a test that fails on a target the file does
    not contain fails the first `pytest` anyone runs after cloning.
    """

    bundle = (Path(__file__).resolve().parents[2] / "databricks.yml").read_text()
    if "\n  example:" not in bundle:
        pytest.skip("the demo target is not declared in this databricks.yml")
    demo = bundle.split("\n  example:", 1)[1].split("\n  customer:", 1)[0]

    assert "catalog_denylist" in demo, "it states its denylist rather than inheriting it"
    assert "needs no additional table exclusions" in demo, (
        "the empty value reads as a decision, not an omission"
    )
    assert "payload" in demo, "the one real exclusion, and how it is recognised, is named"


def test_the_production_target_declares_its_69_table_schema_scope():
    """The deployed scope is the reviewed whole-schema trim, not a bare catalog."""

    bundle = yaml.safe_load((Path(__file__).resolve().parents[2] / "databricks.yml").read_text())
    targets = bundle.get("targets") or {}
    if "customer" not in targets:
        pytest.skip("the production target is not declared in this databricks.yml")

    variables = targets["customer"]["variables"]
    assert variables["manifest_source"] == "", "the schemas must generate the manifest"
    assert variables["data_catalogs"] == [
        "cdp_share_prod.northwind_production",
        "cdp_share_prod.global_production",
        "cdp_share_prod.acme_production",
    ]


def test_no_target_can_declare_that_its_figures_are_not_real():
    """The variable is gone, and no target may bring it back as an override.

    A bundle variable is the one place this could return without touching a line
    of Python: `bundle validate` accepts an override for a variable that is
    declared, and the release script would export it. Both halves are asserted,
    because a target setting a variable nothing declares is the shape a
    reinstatement would most plausibly take.

    Read out of the file rather than inferred from behaviour, since the point is
    that a reader of databricks.yml finds no such knob to turn.
    """

    bundle = yaml.safe_load((Path(__file__).resolve().parents[2] / "databricks.yml").read_text())

    assert "synthetic_data" not in bundle["variables"]
    for name, target in (bundle.get("targets") or {}).items():
        declared = (target.get("variables") or {}).keys()
        assert "synthetic_data" not in declared, f"{name} declares the removed variable"


def test_every_declared_target_asks_questions_as_the_person_who_asked_them():
    """Per-user governance is a per-target declaration, and silence is the default.

    The variable DEFAULTS to `system-passthrough` so that a deployment nobody
    configured keeps the behaviour it has always had. That default is right for an
    unconfigured target and wrong for both of ours: the demo shows the governance
    story, and the customer estate enforces its label split through its own Unity
    Catalog grants, row filters and column masks, none of which mean anything if
    every question arrives as one shared principal.

    This asserts the DECLARATION only. Applying it is bundle/agent-release.sh,
    which logs every version with the policy and takes no flag for it; the
    certification runner reads what the served artifact was actually logged with,
    so it still has something independent to hold the deployment against. A target
    that loses this line still deploys, and silently stops mapping reads to the
    reader, which is exactly the regression worth a test.

    SKIPPED WHERE THE TARGETS ARE NOT DECLARED, for the reason the tests above
    skip: the published tree removes them.
    """

    bundle = yaml.safe_load((Path(__file__).resolve().parents[2] / "databricks.yml").read_text())
    targets = bundle.get("targets") or {}
    if "example" not in targets or "customer" not in targets:
        pytest.skip("neither target is declared in this databricks.yml")

    assert bundle["variables"]["execution_identity"]["default"] == "system-passthrough", (
        "an unconfigured deployment must keep the behaviour it already had"
    )
    for name in ("example", "customer"):
        assert targets[name]["variables"]["execution_identity"] == "user-authorization", (
            f"{name} must ask questions as the signed-in user, not as the serving principal"
        )


def test_the_bundle_declares_no_genie_space_and_no_lakebase_resource():
    """The bundle ATTACHES to existing Genie spaces and Lakebase; it creates neither.

    Asserted as the absence of the resource files, because `include:
    resources/*.yml` is what turns one of them into a bundle-managed resource.
    A Genie space declared there is overwritten wholesale on deploy -- curated
    tables and instructions both -- and a Lakebase project/branch/database
    declared there is created, owned, and destroyed with the bundle.

    This replaces a test that asserted the two spaces took their table lists from
    bundle variables. That was the right check for a bundle that populated the
    spaces. This one is the right check for a bundle that must not.

    The curated reference bodies still exist, under genie/, which is deliberately
    not part of `include:`.
    """

    root = Path(__file__).resolve().parents[2]
    spaces = sorted(p.name for p in (root / "resources").glob("*.genie_space.yml"))
    assert spaces == [], (
        f"resources/ declares Genie spaces again ({spaces}), so a deploy would "
        "overwrite the live spaces. Attach by genie_data_space_id instead."
    )
    postgres = sorted(p.name for p in (root / "resources").glob("*.postgres.yml"))
    assert postgres == [], (
        f"resources/ declares Lakebase resources again ({postgres}), so a deploy "
        "would create and own the project, branch and database. Attach with the "
        "app's `postgres` resource binding instead."
    )


def test_no_lakebase_owner_role_variable_survives():
    """Nothing may reintroduce an owner role: only creating a database needed one.

    SKIPPED WHERE THE VARIABLES ARE NOT DECLARED, matching the tests above: the
    published tree strips them.
    """

    bundle = yaml.safe_load((Path(__file__).resolve().parents[2] / "databricks.yml").read_text())
    variables = bundle.get("variables") or {}
    if not variables:
        pytest.skip("this databricks.yml declares no variables")
    for name in ("lakebase_owner_role_id", "postgres_owner_role_name"):
        assert name not in variables, (
            f"{name} is back. A database owner role is an input to CREATING a "
            "database, and this bundle attaches to one that exists. Reintroducing "
            "it puts a personal role id into a customer-facing deployment input."
        )


# ---------------------------------------------------------------------------
# The build stamp
#
# The model, the app and the client are released separately and nothing on the
# wire says which build each one is. These cover the half of the remedy on this
# side: deriving the stamp, and reporting its absence as absence.
# ---------------------------------------------------------------------------

SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736"


def fake_git(head: str | None = SHA, dirt: str = ""):
    """A stand-in for the git subprocess, so these stay hermetic."""

    def run(args, cwd):
        if args[0] == "rev-parse":
            return head
        if args[0] == "status":
            return dirt
        raise AssertionError(f"unexpected git call: {args}")

    return run


def test_the_stamp_is_the_commit_the_build_came_from():
    assert resolve_build_stamp(env={}, git=fake_git()) == SHA


def test_a_tree_with_uncommitted_changes_stamps_itself_dirty():
    """The release asks for a clean worktree; this is what says it was not."""

    stamp = resolve_build_stamp(env={}, git=fake_git(dirt=" M agent/agent.py"))

    assert stamp == f"{SHA}{DIRTY_SUFFIX}"


def test_git_beats_a_stale_environment_variable():
    """A value that lies is worse than one that is absent.

    `PLAYER_INSIGHTS_BUILD_SHA` left over in some shell from an earlier release
    would otherwise stamp this artifact with a commit it was not built from,
    which is the failure the stamp exists to catch, reintroduced by the stamp.
    """

    stamp = resolve_build_stamp(env={BUILD_SHA_VAR: "stale" * 8}, git=fake_git())

    assert stamp == SHA


def test_the_environment_supplies_the_stamp_where_there_is_no_repository():
    """A CI checkout without history, or anywhere else git cannot answer."""

    stamp = resolve_build_stamp(env={BUILD_SHA_VAR: SHA}, git=fake_git(head=None))

    assert stamp == SHA


def test_no_git_and_no_variable_is_empty_rather_than_a_guess():
    assert resolve_build_stamp(env={}, git=fake_git(head=None)) == ""

