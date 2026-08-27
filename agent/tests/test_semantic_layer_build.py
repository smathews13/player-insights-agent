"""How the semantic layer is populated, and what it refuses to publish.

The build reads a customer's Unity Catalog and writes what it finds into a table
an index makes searchable, so every failure here is a disclosure failure rather
than a data-quality one. The tests that matter are the ones about what happens
when something cannot be read.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

import semantic_layer as sl
import semantic_layer_build as build
from config import Settings

STAMP = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)


def column(name: str, comment: str = "", mask: object = None) -> SimpleNamespace:
    return SimpleNamespace(name=name, type_text="string", comment=comment, mask=mask)


def table(
    full_name: str, columns=None, comment: str = "", properties=None, owner: str = ""
) -> SimpleNamespace:
    return SimpleNamespace(
        full_name=full_name,
        comment=comment,
        columns=columns if columns is not None else [column("a"), column("b")],
        properties=properties or {},
        owner=owner,
    )


class Privilege:
    """A privilege shaped like the SDK's enum, which is the whole point.

    `str()` of the real one is "Privilege.SELECT", not "SELECT". These fakes used
    to pass plain strings, the build uppercased `str(...)` and compared it to
    privilege names, and every assignment in a real workspace silently failed to
    match: the first live build produced eight entries readable by nobody and no
    error anywhere. Keep this shape.
    """

    def __init__(self, value: str):
        self.value = value

    def __str__(self) -> str:
        return f"Privilege.{self.value}"


def grants(*principals: tuple[str, str]) -> SimpleNamespace:
    return SimpleNamespace(
        privilege_assignments=[
            SimpleNamespace(
                principal=principal,
                privileges=[SimpleNamespace(privilege=Privilege(privilege))],
            )
            for principal, privilege in principals
        ]
    )


def dictionary_row(
    table_name: str,
    column_name: str,
    definition: str = "What the column means.",
    data_type: str = "string",
    sensitivity: str = "",
    guardrail: str = "",
) -> list[str]:
    """One data_dictionary row in the column order DICTIONARY_QUERY selects."""

    return [table_name, column_name, data_type, definition, sensitivity, guardrail]


class FakeWorkspace:
    """Only the five calls the build makes, so a new one shows up as an error."""

    def __init__(self, tables=None, effective=None, spaces=None, rows=None, state=None):
        from databricks.sdk.service.sql import StatementState

        self._tables = tables or {}
        self._effective = effective or {}
        self._spaces = spaces or {}
        self._rows = rows
        self._state = state or StatementState.SUCCEEDED
        #: Every statement the build asked for, so a test can assert the
        #: dictionary was actually read rather than assumed.
        self.statements: list[str] = []
        self.query_tag_calls: list[list[object]] = []
        self.tables = SimpleNamespace(get=self._get_table)
        self.grants = SimpleNamespace(get_effective=self._get_effective)
        self.genie = SimpleNamespace(get_space=self._get_space)
        self.statement_execution = SimpleNamespace(execute_statement=self._execute)

    def _execute(self, statement, warehouse_id, wait_timeout=None, query_tags=None):
        self.statements.append(statement)
        self.query_tag_calls.append(list(query_tags or []))
        return SimpleNamespace(
            status=SimpleNamespace(state=self._state, error="fake failure"),
            result=SimpleNamespace(data_array=self._rows),
        )

    def _get_table(self, full_name):
        if full_name not in self._tables:
            raise RuntimeError(f"no such table {full_name}")
        return self._tables[full_name]

    def _get_effective(self, securable_type, full_name):
        assert securable_type == "TABLE"
        if full_name not in self._effective:
            raise RuntimeError("PERMISSION_DENIED")
        return self._effective[full_name]

    def _get_space(self, space_id, include_serialized_space=False):
        if space_id not in self._spaces:
            raise RuntimeError(f"no such space {space_id}")
        return self._spaces[space_id]


def settings_for(*tables: str) -> Settings:
    # `tables` emptied as well as the manifest, because `readable_tables` falls
    # back to the data contract for a version logged before manifests existed,
    # and these tests are about what the manifest declares.
    return Settings(
        tables=(),
        llm_endpoint="e",
        warehouse_id="w",
        data_genie_space_id="space-data",
        dictionary_genie_space_id="space-dictionary",
        catalog="test_catalog",
        schema="test_schema",
        catalog_allowlist=("test_catalog.test_schema",),
        max_output_tokens=100,
        declared_manifest=tables,
    )


class TestScopeTokens:
    def test_all_account_users_becomes_the_public_token(self):
        workspace = FakeWorkspace(effective={"c.s.t": grants(("account users", "SELECT"))})
        tokens, note = build.scope_tokens(workspace, "c.s.t")
        assert tokens == (sl.PUBLIC_SCOPE,)
        assert note == ""

    def test_an_email_grantee_becomes_a_user_token(self):
        workspace = FakeWorkspace(effective={"c.s.t": grants(("A.Person@example.com", "SELECT"))})
        tokens, _ = build.scope_tokens(workspace, "c.s.t")
        assert tokens == (sl.user_scope("a.person@example.com"),)

    def test_a_group_grantee_becomes_a_group_token(self):
        workspace = FakeWorkspace(effective={"c.s.t": grants(("Analysts", "SELECT"))})
        tokens, _ = build.scope_tokens(workspace, "c.s.t")
        assert tokens == (sl.group_scope("Analysts"),)

    def test_all_privileges_counts_as_read(self):
        """A principal holding ALL_PRIVILEGES holds SELECT. Looking only for the
        literal string would hide an owner's own semantics from them."""

        workspace = FakeWorkspace(effective={"c.s.t": grants(("Owners", "ALL_PRIVILEGES"))})
        tokens, _ = build.scope_tokens(workspace, "c.s.t")
        assert tokens == (sl.group_scope("Owners"),)

    def test_a_non_read_privilege_grants_no_token(self):
        workspace = FakeWorkspace(effective={"c.s.t": grants(("Writers", "MODIFY"))})
        tokens, _ = build.scope_tokens(workspace, "c.s.t")
        assert tokens == ()

    def test_unreadable_grants_produce_no_token_and_a_note(self):
        """The direction to fail in. A build that could not read the grants must
        not decide the semantics are public."""

        workspace = FakeWorkspace(effective={})
        tokens, note = build.scope_tokens(workspace, "c.s.t")
        assert tokens == ()
        assert "match nobody" in note

    def test_a_privilege_is_read_by_value_and_not_by_str(self):
        """The bug this whole class now guards. The SDK hands back an enum whose
        `str()` is "Privilege.SELECT", so comparing the stringified form to
        privilege names matched nothing and the first real build produced a
        corpus visible to nobody, with no error to say why."""

        assignment = SimpleNamespace(privileges=[SimpleNamespace(privilege=Privilege("SELECT"))])
        assert build._privileges(assignment) == {"SELECT"}
        assert str(Privilege("SELECT")).upper() not in build.READ_PRIVILEGES

    def test_a_service_principal_grantee_produces_no_token(self):
        """Nobody signs in as one. A dozen of them hold SELECT on every table in
        this estate, and a token each would make the corpus look far more
        visible than it is while matching no caller."""

        application_id = "<app-service-principal-client-id>"
        workspace = FakeWorkspace(effective={"c.s.t": grants((application_id, "SELECT"))})
        tokens, _ = build.scope_tokens(workspace, "c.s.t")
        assert tokens == ()

    def test_the_owner_holds_a_token_without_holding_a_grant(self):
        """Ownership is not a grant and does not appear in the list, so an estate
        that governs by ownership would otherwise hide every table from the
        person who owns it."""

        workspace = FakeWorkspace(effective={"c.s.t": grants(("Analysts", "SELECT"))})
        tokens, _ = build.scope_tokens(workspace, "c.s.t", owner="owner@example.com")
        assert tokens == (sl.user_scope("owner@example.com"), sl.group_scope("Analysts"))


class TestTableEntries:
    def test_a_declared_table_becomes_an_entry_with_its_columns(self):
        workspace = FakeWorkspace(
            tables={"c.s.t": table("c.s.t", [column("spend", "Gross spend.")], "Purchases.")},
            effective={"c.s.t": grants(("account users", "SELECT"))},
        )
        result = build.table_source_entries(workspace, ["c.s.t"], STAMP)
        assert len(result.entries) == 1
        entry = result.entries[0]
        assert entry.entry_kind == sl.KIND_TABLE
        assert "spend" in entry.content
        assert "Purchases." in entry.content
        assert entry.authorized_scope == (sl.PUBLIC_SCOPE,)

    def test_a_masked_column_says_so(self):
        """The model choosing a column deserves to know a mask applies before it
        writes the SQL, not after reading the result."""

        workspace = FakeWorkspace(
            tables={"c.s.t": table("c.s.t", [column("email", "", mask=object())])},
            effective={"c.s.t": grants(("account users", "SELECT"))},
        )
        entry = build.table_source_entries(workspace, ["c.s.t"], STAMP).entries[0]
        assert "column mask" in entry.content

    def test_classification_comes_from_table_properties(self):
        workspace = FakeWorkspace(
            tables={
                "c.s.t": table(
                    "c.s.t",
                    properties={
                        build.LABEL_PROPERTY: "studio-one",
                        build.TITLE_PROPERTY: "game-one",
                        build.DOMAIN_PROPERTY: "monetisation",
                    },
                )
            },
            effective={"c.s.t": grants(("account users", "SELECT"))},
        )
        entry = build.table_source_entries(workspace, ["c.s.t"], STAMP).entries[0]
        assert (entry.label, entry.title, entry.domain) == (
            "studio-one",
            "game-one",
            "monetisation",
        )

    def test_an_unreadable_table_is_noted_and_skipped(self):
        workspace = FakeWorkspace(tables={}, effective={})
        result = build.table_source_entries(workspace, ["c.s.gone"], STAMP)
        assert result.entries == []
        assert any("not described" in note for note in result.notes)

    def test_a_table_with_no_columns_is_not_indexed(self):
        workspace = FakeWorkspace(
            tables={"c.s.t": table("c.s.t", [])},
            effective={"c.s.t": grants(("account users", "SELECT"))},
        )
        result = build.table_source_entries(workspace, ["c.s.t"], STAMP)
        assert result.entries == []
        assert any("not discovery" in note for note in result.notes)


def space(title: str, tables: list[str], questions=None, key="sample_questions"):
    document = {"data_sources": {"tables": [{"identifier": name} for name in tables]}}
    if questions:
        document[key] = questions
    return SimpleNamespace(title=title, serialized_space=json.dumps(document))


class TestGenieEntries:
    def test_a_space_becomes_a_data_product_naming_its_declared_tables(self):
        workspace = FakeWorkspace(spaces={"space-data": space("Player data", ["c.s.t"])})
        result = build.genie_entries(
            workspace, [("data", "space-data")], {"c.s.t": (sl.PUBLIC_SCOPE,)}, STAMP
        )
        products = [e for e in result.entries if e.entry_kind == sl.KIND_DATA_PRODUCT]
        assert len(products) == 1
        assert "c.s.t" in products[0].content
        assert products[0].authorized_scope == (sl.PUBLIC_SCOPE,)

    def test_a_curated_table_outside_the_manifest_is_left_out_and_noted(self):
        """Naming it would advertise something the agent has no grant to read,
        and the failure would arrive at the warehouse one turn later."""

        workspace = FakeWorkspace(spaces={"space-data": space("D", ["c.s.t", "c.s.other"])})
        result = build.genie_entries(
            workspace, [("data", "space-data")], {"c.s.t": (sl.PUBLIC_SCOPE,)}, STAMP
        )
        product = [e for e in result.entries if e.entry_kind == sl.KIND_DATA_PRODUCT][0]
        assert "c.s.other" not in product.content
        assert any("outside the declared manifest" in note for note in result.notes)

    def test_example_questions_become_entries(self):
        workspace = FakeWorkspace(
            spaces={"space-data": space("D", ["c.s.t"], ["Which title grew fastest?"])}
        )
        result = build.genie_entries(
            workspace, [("data", "space-data")], {"c.s.t": (sl.PUBLIC_SCOPE,)}, STAMP
        )
        questions = [e for e in result.entries if e.entry_kind == sl.KIND_EXAMPLE_QUESTION]
        assert [entry.name for entry in questions] == ["Which title grew fastest?"]

    def test_questions_are_found_under_any_known_key(self):
        """The serialized shape is not a documented contract, so the key is tried
        rather than assumed, and a space recording none is normal."""

        workspace = FakeWorkspace(
            spaces={"space-data": space("D", ["c.s.t"], ["Q?"], key="curated_questions")}
        )
        result = build.genie_entries(
            workspace, [("data", "space-data")], {"c.s.t": (sl.PUBLIC_SCOPE,)}, STAMP
        )
        assert any(e.entry_kind == sl.KIND_EXAMPLE_QUESTION for e in result.entries)

    def test_questions_are_found_in_the_shape_a_live_space_records_them(self):
        """The shape the demo spaces actually use, which none of the fixtures
        above matched: nested under `config`, with each question a LIST of
        strings. The first real build reported two data products and no
        questions, which reads as "these spaces have no examples" rather than as
        a parse that missed, and there is nothing in the output to tell them
        apart."""

        document = {
            "config": {
                "sample_questions": [
                    {"id": "1", "question": ["Compare active players by label"]},
                    {"id": "2", "question": ["How many addressable players per label?"]},
                ]
            }
        }
        assert build._example_questions(document) == [
            "Compare active players by label",
            "How many addressable players per label?",
        ]

    def test_an_unreadable_space_is_noted_rather_than_fatal(self):
        workspace = FakeWorkspace(spaces={})
        result = build.genie_entries(workspace, [("data", "missing")], {}, STAMP)
        assert result.entries == []
        assert any("not read" in note for note in result.notes)


class TestCuratedEntries:
    def test_a_curated_definition_may_claim_certification(self, tmp_path):
        path = tmp_path / "definitions.json"
        path.write_text(
            json.dumps(
                [
                    {
                        "kind": sl.KIND_METRIC,
                        "name": "active players",
                        "definition": "Distinct players with a session in the window.",
                        "certification": sl.CERTIFIED,
                        "scope": [sl.PUBLIC_SCOPE],
                    }
                ]
            )
        )
        entries = build.curated_entries(path, STAMP).entries
        assert entries[0].certification == sl.CERTIFIED
        assert entries[0].source == sl.SOURCE_CURATED

    def test_an_unknown_field_refuses_the_file(self, tmp_path):
        """A typo that silently dropped a filter dimension would leave the entry
        retrievable by people it was meant to be narrowed away from."""

        path = tmp_path / "d.json"
        path.write_text(json.dumps([{"kind": "term", "name": "x", "definiton": "typo"}]))
        with pytest.raises(build.BuildError, match="which nothing reads"):
            build.curated_entries(path, STAMP)

    def test_a_malformed_entry_refuses_the_whole_file(self, tmp_path):
        path = tmp_path / "d.json"
        path.write_text(json.dumps([{"kind": "rumour", "name": "x", "definition": "y"}]))
        with pytest.raises(build.BuildError):
            build.curated_entries(path, STAMP)


DICTIONARY = "test_catalog.test_schema.data_dictionary"
DESCRIBED = "test_catalog.test_schema.silver_players"


class TestDictionaryEntries:
    """The column-level definitions, and the ways they can go missing quietly.

    This source exists because the index held none: Unity Catalog's column
    comments are empty on every described table in the live estate, so before
    this the layer said which tables existed and never what a column MEANT. The
    tests worth having are the ones that fail when it stops contributing, since
    an index missing a whole category of content still answers.
    """

    def test_a_documented_column_becomes_a_term_inheriting_the_tables_scope(self):
        workspace = FakeWorkspace(
            rows=[
                dictionary_row(
                    "silver_players",
                    "crm_customer_ref",
                    definition="The CRM identity for a player.",
                    sensitivity="restricted",
                    guardrail="Never bridge identity across labels.",
                )
            ]
        )
        result = build.dictionary_entries(
            workspace,
            settings_for(DESCRIBED, DICTIONARY),
            {DESCRIBED: ("user:a@b.com",)},
            STAMP,
        )

        assert len(result.entries) == 1
        entry = result.entries[0]
        assert entry.entry_kind == sl.KIND_TERM
        assert entry.name == "silver_players.crm_customer_ref"
        assert entry.asset == DESCRIBED
        # The definition of a restricted column is itself a disclosure about that
        # column, so it must be readable by whoever may read the TABLE and not by
        # everyone who may read the dictionary.
        assert entry.authorized_scope == ("user:a@b.com",)
        assert "The CRM identity for a player." in entry.content
        assert "restricted" in entry.content
        assert "Never bridge identity across labels." in entry.content

    def test_the_dictionary_is_read_from_the_configured_deployment(self):
        workspace = FakeWorkspace(rows=[dictionary_row("silver_players", "a")])
        build.dictionary_entries(
            workspace, settings_for(DESCRIBED, DICTIONARY), {DESCRIBED: ("t",)}, STAMP
        )

        assert workspace.statements, "the dictionary was never actually queried"
        assert DICTIONARY in workspace.statements[0]
        assert {tag.key: tag.value for tag in workspace.query_tag_calls[0]} == {
            "application": "Astrolabe",
            "surface": "build",
            "tool": "dictionary_read",
        }

    def test_a_definition_of_an_undeclared_table_is_not_indexed(self):
        """The manifest rule, applied to the dictionary. A dictionary may document
        a table this release did not declare, and indexing that advertises
        something the agent has no grant to read."""

        workspace = FakeWorkspace(
            rows=[
                dictionary_row("silver_players", "a"),
                dictionary_row("secret_finance", "salary"),
            ]
        )
        result = build.dictionary_entries(
            workspace, settings_for(DESCRIBED, DICTIONARY), {DESCRIBED: ("t",)}, STAMP
        )

        assert [entry.name for entry in result.entries] == ["silver_players.a"]
        assert any("secret_finance" in note for note in result.notes)

    def test_a_declared_dictionary_that_contributes_nothing_fails_the_build(self):
        """THE GUARD. This is the failure mode that already happened silently: the
        definitions existed, the index held none of them, and every surface
        reported the build and the index healthy."""

        workspace = FakeWorkspace(rows=[])
        with pytest.raises(build.BuildError, match="contributed no column definitions"):
            build.dictionary_entries(
                workspace, settings_for(DESCRIBED, DICTIONARY), {DESCRIBED: ("t",)}, STAMP
            )

    def test_a_dictionary_of_only_undeclared_tables_fails_rather_than_thins(self):
        """The same guard by the other route. Every row skipped is indistinguishable
        from an empty dictionary to a reader of the index."""

        workspace = FakeWorkspace(rows=[dictionary_row("secret_finance", "salary")])
        with pytest.raises(build.BuildError, match="contributed no column definitions"):
            build.dictionary_entries(
                workspace, settings_for(DESCRIBED, DICTIONARY), {DESCRIBED: ("t",)}, STAMP
            )

    def test_a_row_with_no_definition_is_skipped_rather_than_indexed_empty(self):
        workspace = FakeWorkspace(
            rows=[
                dictionary_row("silver_players", "a", definition="   "),
                dictionary_row("silver_players", "b"),
            ]
        )
        result = build.dictionary_entries(
            workspace, settings_for(DESCRIBED, DICTIONARY), {DESCRIBED: ("t",)}, STAMP
        )

        assert [entry.name for entry in result.entries] == ["silver_players.b"]

    def test_an_undeclared_dictionary_is_a_note_and_not_a_failure(self):
        """An estate with no dictionary is normal, not broken. Only a DECLARED one
        that yields nothing is a failure."""

        workspace = FakeWorkspace(rows=[])
        result = build.dictionary_entries(workspace, settings_for(DESCRIBED), {}, STAMP)

        assert result.entries == []
        assert any("not declared" in note for note in result.notes)
        assert not workspace.statements


class TestBuild:
    def test_a_deployment_declaring_nothing_is_refused(self):
        workspace = FakeWorkspace()
        with pytest.raises(build.BuildError, match="declares no tables"):
            build.build(settings_for(), workspace)

    def test_a_build_carries_the_column_definitions_when_the_dictionary_is_declared(self):
        """THE WIRING GUARD, and it is deliberately a `build` test rather than a
        `dictionary_entries` one. Every unit test above still passes if the call is
        dropped out of `build`, which is exactly how a whole category of content
        goes missing from an index that still answers.
        """

        workspace = FakeWorkspace(
            tables={
                DESCRIBED: table(DESCRIBED),
                DICTIONARY: table(DICTIONARY),
            },
            effective={
                DESCRIBED: grants(("account users", "SELECT")),
                DICTIONARY: grants(("account users", "SELECT")),
            },
            rows=[dictionary_row("silver_players", "crm_customer_ref", sensitivity="restricted")],
        )
        result = build.build(settings_for(DESCRIBED, DICTIONARY), workspace)

        terms = [entry for entry in result.entries if entry.entry_kind == sl.KIND_TERM]
        assert [entry.name for entry in terms] == ["silver_players.crm_customer_ref"]
        assert terms[0].authorized_scope, "a definition no token matches is retrievable by nobody"

    def test_the_asset_list_is_the_declared_manifest(self):
        """Never a live catalog listing: indexing semantics for an undeclared
        table lets the agent offer something it has no grant to read."""

        workspace = FakeWorkspace(
            tables={"c.s.declared": table("c.s.declared"), "c.s.hidden": table("c.s.hidden")},
            effective={
                "c.s.declared": grants(("account users", "SELECT")),
                "c.s.hidden": grants(("account users", "SELECT")),
            },
            spaces={},
        )
        result = build.build(settings_for("c.s.declared"), workspace)
        assets = {entry.asset for entry in result.entries if entry.asset}
        assert assets == {"c.s.declared"}

    def test_colliding_ids_refuse_the_build(self, tmp_path):
        path = tmp_path / "d.json"
        path.write_text(
            json.dumps(
                [
                    {"kind": "term", "name": "same", "definition": "one"},
                    {"kind": "term", "name": "same", "definition": "two"},
                ]
            )
        )
        workspace = FakeWorkspace(
            tables={"c.s.t": table("c.s.t")},
            effective={"c.s.t": grants(("account users", "SELECT"))},
        )
        with pytest.raises(build.BuildError, match="one would overwrite the other"):
            build.build(settings_for("c.s.t"), workspace, curated=path)

    def test_the_summary_reports_entries_nobody_can_retrieve(self):
        workspace = FakeWorkspace(tables={"c.s.t": table("c.s.t")}, effective={})
        result = build.build(settings_for("c.s.t"), workspace)
        assert any("no authorized_scope" in line for line in result.summary())


class TestStatements:
    def entries(self):
        return [
            sl.definition_entry(
                sl.KIND_TERM,
                "churn",
                "A player who stopped playing.",
                authorized_scope=(sl.PUBLIC_SCOPE,),
                generated_at=STAMP,
            )
        ]

    def test_a_build_creates_merges_and_prunes(self):
        produced = build.statements("c.s.semantic_layer_entries", self.entries())
        assert produced[0].startswith("CREATE TABLE IF NOT EXISTS")
        assert any(statement.startswith("MERGE INTO") for statement in produced)
        assert produced[-1].startswith("DELETE FROM")

    def test_build_writes_carry_semantic_build_query_tags(self):
        workspace = FakeWorkspace()

        build.execute(workspace, "warehouse", "CREATE TABLE c.s.t (id STRING)")

        assert {tag.key: tag.value for tag in workspace.query_tag_calls[0]} == {
            "application": "Astrolabe",
            "surface": "build",
            "tool": "semantic_write",
        }

    def test_the_merge_source_carries_no_column_alias_list(self):
        """Databricks SQL refuses one with COLUMN_ALIASES_NOT_ALLOWED, and the
        statement reads fine until the warehouse rejects it. The names go on an
        inner alias instead."""

        statement = build.merge_statements("t", self.entries())[0]
        assert ") AS source\n" in statement
        assert "AS entries (entry_id, " in statement

    def test_merge_is_keyed_on_the_entry_id(self):
        """Rebuilds must update in place. An append leaves every edited
        definition competing with its own previous wording in every search."""

        statement = build.merge_statements("t", self.entries())[0]
        assert "ON target.entry_id = source.entry_id" in statement
        assert "WHEN MATCHED THEN UPDATE SET *" in statement

    def test_a_quote_in_a_comment_is_escaped(self):
        entry = sl.definition_entry(
            sl.KIND_TERM, "x", "it's a player's session", generated_at=STAMP
        )
        statement = build.merge_statements("t", [entry])[0]
        assert "it''s a player''s session" in statement

    def test_an_empty_scope_is_a_typed_empty_array(self):
        """Empty means nobody and the column is NOT NULL, so the table has to be
        able to hold it. An untyped ARRAY() has no element type to infer."""

        entry = sl.definition_entry(sl.KIND_TERM, "x", "y", generated_at=STAMP)
        statement = build.merge_statements("t", [entry])[0]
        assert "CAST(ARRAY() AS ARRAY<STRING>)" in statement

    def test_merges_are_batched(self):
        many = [
            sl.definition_entry(sl.KIND_TERM, f"term-{n}", "y", generated_at=STAMP)
            for n in range(build.MERGE_BATCH * 2 + 1)
        ]
        assert len(build.merge_statements("t", many)) == 3

    def test_pruning_refuses_to_empty_the_table(self):
        """A build that produced nothing is a failed build. Trusting it would
        take the whole semantic layer out of the index while every check
        downstream still reported a healthy sync."""

        with pytest.raises(build.BuildError, match="would empty the semantic layer"):
            build.prune_statement("t", [])

    def test_a_failed_sync_is_reported_rather_than_fatal(self):
        """The write succeeded. Raising here would make a successful build look
        like a failed one, and the remedy is a single CLI call."""

        class Failing:
            vector_search_indexes = SimpleNamespace(
                sync_index=lambda index_name: (_ for _ in ()).throw(RuntimeError("no index"))
            )

        note = build.sync_index(Failing(), "c.s.semantic_layer_index")
        assert "was not synced" in note
        assert "sync-index c.s.semantic_layer_index" in note

    def test_a_successful_sync_is_requested_by_name(self):
        """A TRIGGERED index that is never synced serves the previous corpus
        while both the table and the index report healthy."""

        asked: list[str] = []
        workspace = SimpleNamespace(
            vector_search_indexes=SimpleNamespace(
                sync_index=lambda index_name: asked.append(index_name)
            )
        )
        build.sync_index(workspace, "c.s.semantic_layer_index")
        assert asked == ["c.s.semantic_layer_index"]

    def test_pruning_keeps_exactly_what_was_built(self):
        entries = self.entries()
        statement = build.prune_statement("t", entries)
        assert entries[0].entry_id in statement
        assert statement.startswith("DELETE FROM t WHERE entry_id NOT IN")


class TestConfiguration:
    """How a scheduled rebuild says which deployment it is rebuilding.

    Serverless job tasks cannot set environment variables, and everything in
    agent/ resolves configuration from the environment, so the job passes
    parameters and these are the only route from one to the other.
    """

    ENV = {
        "PLAYER_INSIGHTS_CATALOG": "envcat",
        "PLAYER_INSIGHTS_SCHEMA": "envsch",
        "PLAYER_INSIGHTS_WAREHOUSE_ID": "envwh",
        "PLAYER_INSIGHTS_DATA_GENIE_ID": "envdata",
        "PLAYER_INSIGHTS_DICTIONARY_GENIE_ID": "envdict",
    }

    def parsed(self, *argv: str):
        import argparse

        parser = argparse.ArgumentParser()
        for key in build.REQUIRED_KEYS:
            parser.add_argument("--" + key.replace("_", "-"), dest=key, default="")
        return parser.parse_args(list(argv))

    def test_the_environment_alone_still_configures_a_build(self):
        """The way a person runs this from a laptop, and it must keep working."""

        settings = build.settings_from(self.parsed(), env=self.ENV)
        assert (settings.catalog, settings.schema) == ("envcat", "envsch")

    def test_a_parameter_beats_the_environment(self):
        settings = build.settings_from(
            self.parsed("--catalog", "jobcat", "--warehouse-id", "jobwh"), env=self.ENV
        )
        assert settings.catalog == "jobcat"
        assert settings.warehouse_id == "jobwh"
        assert settings.schema == "envsch"

    def test_every_value_that_names_a_workspace_can_be_passed(self):
        """Five, and a missing one raises rather than defaulting, so a job that
        passes four rebuilds nothing rather than rebuilding somewhere else."""

        given = [
            argument
            for key in build.REQUIRED_KEYS
            for argument in ("--" + key.replace("_", "-"), "given-" + key)
        ]
        settings = build.settings_from(self.parsed(*given), env={})
        assert settings.catalog == "given-catalog"
        assert settings.dictionary_genie_space_id == "given-dictionary_genie_space_id"

    def test_nothing_anywhere_is_refused(self):
        from config import MissingConfiguration

        with pytest.raises(MissingConfiguration):
            build.settings_from(self.parsed(), env={})


class TestTheEntryPointExitsByReturning:
    """A GOOD BUILD MUST NOT LOOK LIKE A FAILED ONE.

    A serverless `spark_python_task` execs this file inside an IPython kernel,
    and IPython reports the `SystemExit` that `sys.exit(0)` raises as the task's
    error. `sys.exit(main())` therefore failed the job on a completely
    successful build: the run of 2026-08-16 wrote all 16 entries, requested the
    index sync, and still reported `INTERNAL_ERROR / FAILED` with `SystemExit:
    0` as its only error. The job had never once reported success.

    A red run on a good build is the same class of defect as a green run on a
    bad one, and worse in one way: it fires the nightly on-failure email that is
    meant to be the signal, until whoever gets it stops reading it.
    """

    SOURCE = Path(build.__file__).read_text()

    @classmethod
    def code(cls) -> str:
        """The source with comments dropped.

        The comment explaining this fix necessarily QUOTES the call it replaced,
        so a naive substring search over the whole file matches the explanation
        and reports the bug it is documenting. Stripping comments is the
        difference between asserting on what runs and asserting on prose.
        """

        return "\n".join(
            line for line in cls.SOURCE.splitlines() if not line.lstrip().startswith("#")
        )

    def test_a_zero_return_is_not_raised(self):
        """Asserted against the source because the guard lives under
        `if __name__ == "__main__"`, which pytest never executes."""

        assert "sys.exit(main())" not in self.code(), (
            "sys.exit(0) surfaces as SystemExit and fails the serverless task on a "
            "successful build; return instead and only exit on a non-zero code"
        )

    def test_a_non_zero_return_still_exits_non_zero(self):
        """The other half. A build that failed must still fail the task, or the
        job goes green while the index serves the previous corpus."""

        code = self.code()
        assert "if _code:" in code and "sys.exit(_code)" in code

    def test_the_entry_point_is_reached_by_calling_main(self):
        assert "_code = main()" in self.code()
