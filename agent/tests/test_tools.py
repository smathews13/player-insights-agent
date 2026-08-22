"""The three tools the loop discovers data with, and what each refuses.

Every refusal here is a measured constraint rather than caution. The serving
endpoint can read a Unity Catalog table only if it was declared as a
`DatabricksTable` resource at log time, and `information_schema` is unreadable
from inside the endpoint even with catalog-level SELECT. So discovery reads the
baked-in manifest, and anything outside it is refused here, in words the model
can act on, rather than failing at the warehouse two steps later.
"""

import dataclasses
import itertools
from collections.abc import Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from databricks.sdk.service.dashboards import MessageStatus
from databricks.sdk.service.sql import ExecuteStatementRequestOnWaitTimeout

import failures
import tools as tools_module
from config import Settings
from tools import (
    DESCRIBE_TABLE_TOOL,
    LIST_DATA_ASSETS_TOOL,
    MAX_SQL_ROWS,
    QUERY_NAMED_TABLE_TOOL,
    RESOLVE_TABLE_TOOL,
    PlayerInsightTools,
    SqlRefused,
    restricted_output_columns,
    validate_sql,
)

#: Invented names, not the demo workspace's. See the note in conftest.py. They
#: also have to be parseable SQL identifiers, because the statements built from
#: them below are handed to the real `validate_sql` and parsed for attribution.
NAMESPACE = "test_catalog.test_schema"
PROFILES = f"{NAMESPACE}.silver_player_profiles"
ACTIVITY = f"{NAMESPACE}.silver_gameplay_activity"
# In a second schema, so a listing that leaked across schemas would show it.
# Named so it is neither a prefix nor a suffix of `test_schema`: an assertion
# that the curated schema was listed must not be satisfiable by this one.
OTHER_SCHEMA_TABLE = "test_catalog.raw_schema.raw_events"

MANIFEST = (PROFILES, ACTIVITY, OTHER_SCHEMA_TABLE)

#: Read before the fixture below patches it away, so the shipped value is testable.
REAL_POLL_SECONDS = tools_module.GENIE_POLL_SECONDS


class FakeWarehouse:
    """The statement execution API, answering from a scripted table.

    Pages like the real one: `data_array` on the first response is one chunk, and
    the rest arrive through `get_statement_result_chunk_n`. The agent used to read
    the first chunk as the whole result, so a fake that hands over everything at
    once cannot show the difference.
    """

    def __init__(
        self,
        columns: list[str],
        rows: list[list],
        state: str | Sequence[str] = "SUCCEEDED",
        chunk_size: int | None = None,
        total_row_count: int | None = None,
    ):
        self.columns = columns
        self.rows = rows
        #: A sequence when a test is about what the SECOND attempt returns. The
        #: last entry repeats, so one state still means "always this".
        self.states = [state] if isinstance(state, str) else list(state)
        self.chunk_size = chunk_size or max(len(rows), 1)
        self.total_row_count = total_row_count
        self.statements: list[str] = []
        self.wait_timeouts: list[tuple[str, Any]] = []
        self.chunks_fetched: list[int] = []
        self.statement_execution = SimpleNamespace(
            execute_statement=self._execute,
            get_statement_result_chunk_n=self._chunk,
        )

    def _page(self, index: int):
        start = index * self.chunk_size
        page = self.rows[start : start + self.chunk_size]
        has_more = start + self.chunk_size < len(self.rows)
        return SimpleNamespace(
            data_array=page,
            chunk_index=index,
            next_chunk_index=index + 1 if has_more else None,
        )

    def _execute(self, warehouse_id: str, statement: str, wait_timeout: str, on_wait_timeout=None):
        self.statements.append(statement)
        self.wait_timeouts.append((wait_timeout, on_wait_timeout))
        state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
        return SimpleNamespace(
            statement_id="statement-1",
            status=SimpleNamespace(
                state=SimpleNamespace(value=state),
                error=SimpleNamespace(message="TABLE_OR_VIEW_NOT_FOUND"),
            ),
            result=self._page(0),
            manifest=SimpleNamespace(
                total_row_count=(
                    self.total_row_count if self.total_row_count is not None else len(self.rows)
                ),
                schema=SimpleNamespace(
                    columns=[SimpleNamespace(name=name) for name in self.columns]
                ),
            ),
        )

    def _chunk(self, statement_id: str, chunk_index: int):
        self.chunks_fetched.append(chunk_index)
        return self._page(chunk_index)


def build(workspace=None, manifest=MANIFEST) -> PlayerInsightTools:
    settings = Settings(
        llm_endpoint="fake",
        warehouse_id="test-warehouse",
        data_genie_space_id="data",
        dictionary_genie_space_id="dictionary",
        catalog="test_catalog",
        schema="test_schema",
        catalog_allowlist=("test_catalog",),
        max_output_tokens=1000,
        declared_manifest=manifest,
    )
    return PlayerInsightTools(settings, workspace or FakeWarehouse(["a"], [["1"]]))


def wide_rows(count: int) -> list[list[str]]:
    """Rows too wide for the character budget to hold many of.

    The bound is characters rather than rows, so a test about TRUNCATION has to
    supply rows that actually cost something. Sized so the floor decides: these
    spend the budget well before `MAX_SQL_ROWS` of them are rendered, so exactly
    the floor comes back and the count is stable to assert on.
    """

    return [[f"row-{index}", "x" * 900] for index in range(count)]


def narrow_rows(count: int) -> list[list[str]]:
    """Rows shaped like a dictionary listing: a name and a short value."""

    return [[f"column_{index}", "string"] for index in range(count)]


# ---------------------------------------------------------------------------
# list_data_assets
# ---------------------------------------------------------------------------


def test_listing_drills_from_catalogs_to_schemas_to_tables():
    tools = build()

    assert "test_catalog" in tools.list_data_assets().text
    schemas = tools.list_data_assets("test_catalog").text
    assert "test_schema" in schemas
    assert "raw_schema" in schemas
    tables = tools.list_data_assets("test_catalog", "test_schema").text
    assert PROFILES in tables
    assert OTHER_SCHEMA_TABLE not in tables, "a schema listing shows that schema only"


def test_listing_never_touches_unity_catalog_or_the_warehouse():
    """The reason it reads the manifest: the live listing is not available to it.

    `information_schema` fails from inside the endpoint, and the SDK's catalog
    listing would return tables the serving principal has no grant on, which the
    agent would then offer and be unable to read.
    """

    warehouse = FakeWarehouse(["a"], [["1"]])
    tools = build(warehouse)

    tools.list_data_assets()
    tools.list_data_assets("test_catalog")
    tools.list_data_assets("test_catalog", "test_schema")

    assert warehouse.statements == []
    assert not hasattr(warehouse, "catalogs")


def test_listing_advertises_only_what_the_model_was_logged_with():
    tools = build(manifest=(PROFILES,))

    assert tools.list_data_assets("test_catalog", "test_schema").text.count("- ") == 1
    assert ACTIVITY not in tools.list_data_assets("test_catalog", "test_schema").text


def test_an_undeclared_catalog_is_answered_with_the_declared_ones():
    """A dead end has to say where the live ends are, or the model guesses again."""

    tools = build()

    answer = tools.list_data_assets("main").text
    assert "no declared tables" in answer
    assert "test_catalog" in answer

    answer = tools.list_data_assets("test_catalog", "nope").text
    assert "no declared tables" in answer
    assert "test_schema" in answer


def test_listing_reads_nothing_so_it_cites_nothing():
    """It reports what is declared, not what is in any table."""

    result = build().list_data_assets("test_catalog", "test_schema")

    assert result.sources == []
    assert result.sql == ""


def test_backticks_and_whitespace_in_the_models_arguments_are_tolerated():
    tools = build()

    listed = tools.list_data_assets(" `test_catalog` ", "`test_schema`")

    assert PROFILES in listed.text


def test_a_model_with_no_declared_tables_says_so_rather_than_looking_empty():
    """An empty listing reads as "the data is gone" rather than "nothing was declared"."""

    tools = build(manifest=())
    tools.settings = dataclasses.replace(tools.settings, tables=(), declared_manifest=())

    assert "no tables were declared" in tools.list_data_assets().text


# ---------------------------------------------------------------------------
# resolve_table
#
# The lookup that stops a half-named table becoming a question for the user. The
# properties worth holding are the two that decide whether it is safe to have at
# all: it never reaches past the declared set, and it never breaks a tie itself.
# ---------------------------------------------------------------------------


def test_a_bare_table_name_resolves_to_its_full_name_without_asking_the_user():
    tools = build()

    result = tools.resolve_table("silver_player_profiles").text

    assert result.startswith("RESOLVED:")
    assert PROFILES in result


def test_a_half_qualified_name_resolves_from_the_right():
    """`schema.table` is the shape a user actually types, and it is not a rejection."""

    tools = build()

    assert PROFILES in tools.resolve_table("test_schema.silver_player_profiles").text


def test_an_already_qualified_name_is_confirmed_rather_than_refused():
    """The caller does not always know which shape it has; confirming costs nothing."""

    tools = build()

    assert tools.resolve_table(PROFILES).text.startswith("RESOLVED:")


def test_the_same_table_name_in_two_schemas_lists_both_and_picks_neither():
    """The case the whole tool has to get right.

    Two declared schemas holding the same table name are two different tables
    that answer the same question with different figures. Choosing one silently
    is the failure this deployment's "which table to answer from" rule exists to
    prevent, so the candidates are handed over and the choice goes to the user.
    """

    twin = "test_catalog.raw_schema.silver_player_profiles"
    tools = build(manifest=(*MANIFEST, twin))

    result = tools.resolve_table("silver_player_profiles").text

    assert result.startswith("AMBIGUOUS:")
    assert PROFILES in result and twin in result
    assert "request_clarification" in result


def test_an_undeclared_table_is_out_of_scope_rather_than_something_to_hunt_for():
    tools = build()

    result = tools.resolve_table("nonexistent_table").text

    assert result.startswith("NOT FOUND:")
    assert "out of scope" in result


def test_a_near_name_is_offered_as_a_suggestion_and_never_as_the_resolution():
    """`profiles_v2` is not `profiles`. Substituting one for the other silently is
    the exact defect this tool is elsewhere built to avoid."""

    versioned = f"{NAMESPACE}.silver_player_profiles_v2"
    tools = build(manifest=(ACTIVITY, versioned))

    result = tools.resolve_table("silver_player_profiles").text

    assert result.startswith("NOT FOUND:")
    assert versioned in result


def test_resolution_never_reaches_the_warehouse():
    """It answers from the manifest, so it needs no grant and costs no round trip."""

    warehouse = FakeWarehouse(["a"], [["1"]])
    tools = build(workspace=warehouse)

    tools.resolve_table("silver_player_profiles")

    assert warehouse.statements == []


def test_a_name_that_is_not_an_identifier_is_refused_before_it_is_matched():
    tools = build()

    for bad in ("", "a b", "drop'; --", "a.b.c.d"):
        assert tools.resolve_table(bad).text.startswith("REJECTED:")


# ---------------------------------------------------------------------------
# search_tagged_assets
#
# The discovery tool that reads the estate's OWN labels instead of inferring a
# table's purpose from its name. The properties worth holding are the two that
# make it safe to offer at all: the manifest still bounds what it can name, and
# an estate that never granted access to tag metadata degrades to guidance rather
# than to a dead turn.
# ---------------------------------------------------------------------------


TAG_COLUMNS = [
    "level",
    "catalog_name",
    "schema_name",
    "table_name",
    "column_name",
    "tag_name",
    "tag_value",
]


def tag_row(table: str, tag: str, value: str = "", column: str = "") -> list[str]:
    catalog, schema, name = table.split(".")
    level = "column" if column else "table"
    return [level, catalog, schema, name, column, tag, value]


def tagged(rows: list[list[str]], **kwargs) -> tuple[Any, Any]:
    warehouse = FakeWarehouse(TAG_COLUMNS, rows, **kwargs)
    return build(warehouse), warehouse


def test_tag_search_returns_declared_tables_grouped_by_table():
    tools, _ = tagged(
        [
            tag_row(PROFILES, "pii", "true"),
            tag_row(PROFILES, "domain", "player", column="platformid_accountid"),
            tag_row(ACTIVITY, "domain", "gameplay"),
        ]
    )

    text = tools.search_tagged_assets().text

    assert PROFILES in text and ACTIVITY in text
    assert "pii=true" in text
    assert "platformid_accountid (domain=player)" in text


def test_a_tagged_table_outside_the_manifest_is_not_offered():
    """The read path would refuse it, so naming it sends the model nowhere.

    This is the case the intersection exists for: `information_schema` is filtered
    by whoever is asking, and under user authorization the caller can hold SELECT
    on tables this model version was never logged with. `validate_sql` refuses
    those, so a discovery tool that lists them invites a request that cannot be
    served and reads to the model as an access failure.
    """

    tools, _ = tagged(
        [
            tag_row(PROFILES, "pii", "true"),
            tag_row("test_catalog.test_schema.undeclared_table", "pii", "true"),
        ]
    )

    text = tools.search_tagged_assets("pii").text

    assert PROFILES in text
    assert "undeclared_table" not in text


def test_the_query_covers_both_tag_views_and_only_declared_scopes():
    tools, warehouse = tagged([tag_row(PROFILES, "pii", "true")])

    tools.search_tagged_assets()
    statement = warehouse.statements[0]

    assert "information_schema.table_tags" in statement
    assert "information_schema.column_tags" in statement
    assert "'test_schema'" in statement and "'raw_schema'" in statement
    assert "`test_catalog`" in statement


def test_a_tag_is_matched_case_insensitively():
    """A tag is typed by a person, and Unity Catalog keeps the case they used.

    Matching exactly makes `PII` and `pii` different tags and hands the model an
    empty result that reads like an answer about the estate.
    """

    tools, warehouse = tagged([tag_row(PROFILES, "PII", "true")])

    tools.search_tagged_assets("pii")
    statement = warehouse.statements[0]

    assert "lower(tag_name) = lower('pii')" in statement


def test_a_quote_in_the_models_tag_cannot_close_the_literal():
    """The tag comes from the model, so it is untrusted input in a statement."""

    tools, warehouse = tagged([])

    tools.search_tagged_assets("pi'i", "va'lue")
    statement = warehouse.statements[0]

    assert "'pi''i'" in statement
    assert "'va''lue'" in statement


def test_unreadable_tag_views_degrade_to_guidance_rather_than_failing_the_turn():
    """The expected shape of an estate that granted the tables but not the metadata.

    `information_schema` is backed by the `system` catalog and granted separately,
    so this tool can be unavailable where every other tool works. A turn that died
    here would lose a question the older discovery path answers perfectly well.
    """

    tools, _ = tagged([], state="FAILED")

    result = tools.search_tagged_assets("pii")

    assert failures.DEPENDENCY_UNAVAILABLE in result.text
    assert "list_data_assets" in result.text
    # The mistake this sentence prevents: reporting a missing grant on metadata as
    # a finding about the customer's own tagging.
    assert "not tell the user their tables are untagged" in result.text
    assert result.sources == []
    assert result.sql == ""


# ---------------------------------------------------------------------------
# The tag search against a COLD warehouse
#
# The second half of the same customer report. `SQL CANCELED: the statement was
# still running after 30s` on a small `information_schema` scan is not a slow
# query -- it is the first statement of the turn paying for the warehouse to
# start. Our own demo warehouse is already up, so the read costs two seconds and
# nobody ever saw this.
# ---------------------------------------------------------------------------


def budget(monkeypatch, seconds: float) -> None:
    """Pin what the turn has left, which is what gates the retry."""

    monkeypatch.setattr(
        tools_module.runtime_settings, "remaining_seconds", lambda: float(seconds)
    )


def test_the_tag_read_waits_the_apis_full_allowance_rather_than_thirty_seconds():
    """The read is small; the wait is for the warehouse, so buy all of it.

    Fifty seconds is the Statement Execution API's ceiling for a synchronous
    wait, and a discovery result is the one the turn can most afford to lose,
    which is what makes it the right read to spend the whole of it on.
    """

    tools, warehouse = tagged([tag_row(PROFILES, "pii", "true")])

    tools.search_tagged_assets()

    assert warehouse.wait_timeouts == [
        (f"{tools_module.DISCOVERY_WAIT_SECONDS}s", ExecuteStatementRequestOnWaitTimeout.CANCEL)
    ]
    assert tools_module.DISCOVERY_WAIT_SECONDS > tools_module.SQL_WAIT_SECONDS


def test_a_cancelled_tag_read_is_tried_once_more_and_the_second_attempt_can_succeed(monkeypatch):
    """The first statement is what starts the warehouse; the second finds it warm."""

    budget(monkeypatch, 90)
    tools, warehouse = tagged(
        [tag_row(PROFILES, "pii", "true")], state=["CANCELED", "SUCCEEDED"]
    )

    text = tools.search_tagged_assets().text

    assert len(warehouse.statements) == 2, "cancelled for slowness is worth one more try"
    assert PROFILES in text and "pii=true" in text


def test_a_rejected_tag_read_is_not_tried_a_second_time(monkeypatch):
    """A statement the warehouse refused is refused identically on the retry.

    Only slowness is worth repeating. Retrying a rejection spends the turn to
    learn what it already knew.
    """

    budget(monkeypatch, 90)
    tools, warehouse = tagged([], state="FAILED")

    tools.search_tagged_assets()

    assert len(warehouse.statements) == 1


def test_the_retry_is_skipped_when_the_turn_can_no_longer_afford_it(monkeypatch):
    """A second wait that leaves no budget has spent the run on a discovery hint."""

    budget(monkeypatch, tools_module.SQL_RETRY_MIN_REMAINING_SECONDS - 1)
    tools, warehouse = tagged([], state="CANCELED")

    tools.search_tagged_assets()

    assert len(warehouse.statements) == 1


def test_a_tag_read_the_warehouse_never_got_to_reads_as_skippable_not_as_a_failure(monkeypatch):
    """What the customer saw, in words a person can act on.

    The old line was `the tag views could not be read: SQL CANCELED: the
    statement was still running after 30s`, which reads as a fact about their
    tags. It is a fact about their warehouse.
    """

    budget(monkeypatch, 10)
    tools, _ = tagged([], state="CANCELED")

    result = tools.search_tagged_assets("pii")

    assert failures.DEPENDENCY_UNAVAILABLE in result.text
    assert tools_module.reports_dependency_unavailable(result.text)
    assert "still starting" in result.text
    assert "list_data_assets" in result.text
    # Slowness is not a missing grant, so the standing "do not retry it" advice
    # would be advice against the one thing that works once the warehouse is up.
    assert "do not retry it" not in result.text
    assert "one later attempt is reasonable" in result.text
    assert result.sources == [] and result.sql == ""


def test_an_ungranted_tag_read_still_says_not_to_retry():
    """The opposite cause, and the opposite next step. Both must survive."""

    tools, _ = tagged([], state="FAILED")

    text = tools.search_tagged_assets("pii").text

    assert "do not retry it" in text
    assert "one later attempt is reasonable" not in text


def test_a_wait_is_never_asked_for_below_the_apis_own_floor(monkeypatch):
    """`wait_timeout=1s` is an argument error, not a short wait.

    The old clamp was `min(30, remaining)` with a floor of one second, so a turn
    down to its last few seconds sent the warehouse a value it rejects, and the
    caller got an API error where it had arranged for a cancelled statement.
    """

    budget(monkeypatch, 2)
    tools, warehouse = tagged([tag_row(PROFILES, "pii", "true")])

    tools.search_tagged_assets()

    assert warehouse.wait_timeouts[0][0] == f"{tools_module.SQL_WAIT_FLOOR_SECONDS}s"


def test_no_matching_tag_is_not_reported_as_missing_data():
    tools, _ = tagged([])

    text = tools.search_tagged_assets("pii").text

    assert "No declared table carries a tag" in text
    assert "does not mean the tables cannot answer" in text
    assert "list_data_assets" in text


def test_the_result_says_tags_are_neither_data_nor_permission():
    tools, _ = tagged([tag_row(PROFILES, "pii", "true")])

    text = tools.search_tagged_assets().text

    assert "not what it holds or who may read it" in text
    assert "describe_table" in text


def test_tag_search_reads_no_table_so_it_cites_nothing():
    """It read metadata about tables, not the tables, so it is not a source."""

    tools, _ = tagged([tag_row(PROFILES, "pii", "true")])

    result = tools.search_tagged_assets()

    assert result.sources == []
    assert result.sql == ""


def test_a_model_with_no_declared_tables_asks_no_question_of_the_warehouse():
    tools, warehouse = tagged([tag_row(PROFILES, "pii", "true")])
    tools.settings = dataclasses.replace(tools.settings, tables=(), declared_manifest=())

    assert "no tables were declared" in tools.search_tagged_assets().text
    assert warehouse.statements == []


def test_a_partial_read_of_the_tag_views_says_so():
    """A bounded list read as a complete one becomes a claim about the estate."""

    rows = [tag_row(PROFILES, f"tag_{index}", "v") for index in range(3)]
    tools, _ = tagged(rows, total_row_count=900)

    text = tools.search_tagged_assets().text

    assert "may be partial" in text
    assert "900" in text


def test_the_tool_description_tells_the_model_what_tags_are_not():
    description = tools_module.SEARCH_TAGGED_ASSETS_TOOL["function"]["description"]

    assert "not permission to read it" in description
    assert "list_data_assets" in description


# ---------------------------------------------------------------------------
# describe_table
# ---------------------------------------------------------------------------


DESCRIBE_ROWS = [
    ["platformid_accountid", "string", "Stable cross-platform player key"],
    ["profile_label", "string", "Publishing label"],
    ["", "", ""],
    ["# Detailed Table Information", "", ""],
    ["Location", "s3://bucket/path", ""],
    ["Owner", "someone@example.com", ""],
    ["Comment", "Validated player profiles with explicit identity scope", ""],
]


def test_describing_a_declared_table_returns_its_columns_and_comments():
    warehouse = FakeWarehouse(["col_name", "data_type", "comment"], DESCRIBE_ROWS)

    result = build(warehouse).describe_table(PROFILES)

    assert warehouse.statements == [
        "DESCRIBE TABLE EXTENDED `test_catalog`.`test_schema`"
        ".`silver_player_profiles`"
    ]
    assert "- platformid_accountid: string (Stable cross-platform player key)" in result.text
    assert "- profile_label: string (Publishing label)" in result.text


def test_the_storage_metadata_past_the_columns_is_dropped():
    """It is a lot of tokens, and none of it helps write a query."""

    warehouse = FakeWarehouse(["col_name", "data_type", "comment"], DESCRIBE_ROWS)

    text = build(warehouse).describe_table(PROFILES).text

    assert "s3://bucket/path" not in text
    assert "someone@example.com" not in text
    assert "Detailed Table Information" not in text


def test_the_tables_own_comment_is_lifted_out_of_the_metadata_and_put_first():
    """The one thing in the extended section worth the tokens.

    It replaces nothing that was removed: it is the DEPLOYMENT's sentence about
    the deployment's table, so it is right on any estate and simply absent where
    nobody wrote one, which is the difference between reading a purpose and
    asserting one. Without it the model sees columns and types and has no way to
    tell a published rollup from an ingest copy except by guessing from the name.
    """

    warehouse = FakeWarehouse(["col_name", "data_type", "comment"], DESCRIBE_ROWS)

    text = build(warehouse).describe_table(PROFILES).text

    assert "Table comment: Validated player profiles with explicit identity scope" in text
    # Ahead of the columns, because it says what the columns are for.
    assert text.index("Table comment:") < text.index("- platformid_accountid")


def test_a_table_with_no_comment_gets_no_empty_heading():
    """Absent rather than blank: an empty label reads as a table with no purpose."""

    rows = [row for row in DESCRIBE_ROWS if row[0] != "Comment"]
    warehouse = FakeWarehouse(["col_name", "data_type", "comment"], rows)

    text = build(warehouse).describe_table(PROFILES).text

    assert "Table comment" not in text
    assert "- profile_label: string (Publishing label)" in text


def test_describing_a_table_cites_it():
    """An answer about a table's shape is grounded in the description of it."""

    warehouse = FakeWarehouse(["col_name", "data_type", "comment"], DESCRIBE_ROWS)

    assert build(warehouse).describe_table(PROFILES).sources == [PROFILES]


def test_a_half_named_table_is_sent_back_as_a_question_for_the_user():
    """The notebook's third routing path, enforced at the tool.

    Crawling for a table called "the master table" is slow and usually guesses
    wrong, so the refusal names the tool that asks instead.
    """

    warehouse = FakeWarehouse(["col_name"], [])

    result = build(warehouse).describe_table("silver_player_profiles")

    assert result.text.startswith("REJECTED")
    assert "request_clarification" in result.text
    assert warehouse.statements == [], "nothing was run against a name it did not have"


def test_an_undeclared_table_is_refused_as_out_of_scope_not_as_a_thing_to_route_around():
    warehouse = FakeWarehouse(["col_name"], [])

    result = build(warehouse).describe_table(f"{NAMESPACE}.gold_secret_table")

    assert result.text.startswith("REJECTED")
    assert "not declared with this model" in result.text
    assert "list_data_assets" in result.text
    assert warehouse.statements == []
    assert result.sources == [], "a refused call read nothing, so it cites nothing"


def test_a_refusal_is_not_an_exception_because_the_model_has_to_read_it():
    """Raising would end the step; the text is what redirects the next one."""

    assert build().describe_table("nope").text.startswith("REJECTED")


def test_a_warehouse_failure_on_a_declared_table_is_raised_not_swallowed():
    warehouse = FakeWarehouse(["col_name"], [], state="FAILED")

    with pytest.raises(RuntimeError, match="TABLE_OR_VIEW_NOT_FOUND"):
        build(warehouse).describe_table(PROFILES)


# ---------------------------------------------------------------------------
# A column inventory is the answer, not a sample of the answer
#
# "Which columns does this table have" and "summarize the top spenders" are
# both bounded by the same budget and must not be bounded by the same NUMBER.
# The customer asked the first about a wide table, and got fifty of one
# thousand seven hundred and fifty three columns presented as the inventory.
#
# `describe_table` is the sharp end of it: it builds its own text, so it did
# not even carry the row disclosure the SQL path has. A short read there is a
# partial answer with nothing on it to say so.
# ---------------------------------------------------------------------------


def describe_rows(count: int) -> list[list[str]]:
    return [[f"column_{index}", "string", f"Column {index}"] for index in range(count)]


def test_a_wide_tables_whole_column_list_comes_back_rather_than_the_first_fifty():
    """The enumeration the sampling budget used to cut, silently."""

    columns = describe_rows(1_753)
    warehouse = FakeWarehouse(
        ["col_name", "data_type", "comment"], columns, chunk_size=100
    )

    text = build(warehouse).describe_table(PROFILES).text

    assert "- column_0: string (Column 0)" in text
    assert "- column_1752: string (Column 1752)" in text
    assert text.count("\n- ") == 1_753, "every column, not a sample of them"
    assert "SAMPLE" not in text, "nothing was left out, so nothing is disclosed as missing"


def test_a_description_too_large_even_for_the_enumeration_budget_says_so():
    """The bound moved and did not disappear, so the disclosure still has to fire.

    `describe_table` writes its own text, so a short read here was invisible:
    the model was handed part of a column list with nothing to distinguish it
    from all of one.
    """

    columns = describe_rows(tools_module.ENUMERATION_BUDGET.max_rows * 2)
    warehouse = FakeWarehouse(
        ["col_name", "data_type", "comment"], columns, chunk_size=500
    )

    text = build(warehouse).describe_table(PROFILES).text

    assert f"has {len(columns)} row(s) and" in text
    assert "INCOMPLETE" in text
    assert "do not present what is shown as the full set" in text


# ---------------------------------------------------------------------------
# Asking whether a column is there, and being answered
#
# The filter's cheap half is the shorter list. The valuable half is the MISS:
# "0 of 412 columns match that name" is a definitive answer, and it is what
# stops the model querying the table to find out and then guessing from the
# error it gets back.
#
# Which is why the truncated case is the one that has to be right. An absence
# and a list that was cut before the end are not the same fact, and a wide table
# is exactly where both appear.
# ---------------------------------------------------------------------------


def test_a_filter_narrows_the_list_and_says_how_many_of_how_many_matched():
    warehouse = FakeWarehouse(["col_name", "data_type", "comment"], DESCRIBE_ROWS)

    text = build(warehouse).describe_table(PROFILES, "label").text

    assert "1 of 2 columns match `label`" in text
    assert "- profile_label: string (Publishing label)" in text
    assert "platformid_accountid" not in text, "the filter is what makes this cheap"


def test_several_patterns_are_matched_as_substrings_case_insensitively():
    warehouse = FakeWarehouse(["col_name", "data_type", "comment"], DESCRIBE_ROWS)

    text = build(warehouse).describe_table(PROFILES, "ACCOUNTID, Label").text

    assert "2 of 2 columns match" in text


def test_a_column_that_is_not_there_is_answered_definitively_rather_than_left_to_a_query():
    """The half of this that matters. A miss has to END the question."""

    warehouse = FakeWarehouse(["col_name", "data_type", "comment"], DESCRIBE_ROWS)

    text = build(warehouse).describe_table(PROFILES, "crm_customer_ref").text

    assert "0 of 2 columns match `crm_customer_ref`" in text
    assert "no column of that name exists in this table" in text
    assert "definitive" in text
    assert "do NOT query the table to check" in text


def test_a_miss_on_a_description_that_was_cut_short_is_not_reported_as_an_absence():
    """A genuine absence and a truncated list must not read the same.

    On a table wide enough to be cut, the column asked about may be sitting in
    the part that was never read. Saying "no such column exists" there is a
    confident false negative, and the model was told in the same breath not to
    query to check -- so the guess would be all it had left.
    """

    columns = describe_rows(tools_module.ENUMERATION_BUDGET.max_rows * 2)
    warehouse = FakeWarehouse(["col_name", "data_type", "comment"], columns, chunk_size=500)

    text = build(warehouse).describe_table(PROFILES, "crm_customer_ref").text

    assert "not evidence that it does not exist" in text
    assert "CUT before the end" in text
    assert "no column of that name exists" not in text
    assert "definitive" not in text
    # And the read's own disclosure still fires, so both facts are on the page.
    assert "INCOMPLETE" in text


def test_an_unfiltered_description_is_unchanged_by_the_filter_existing():
    """The default path is what the planner and every existing caller use."""

    warehouse = FakeWarehouse(["col_name", "data_type", "comment"], DESCRIBE_ROWS)

    text = build(warehouse).describe_table(PROFILES).text

    assert "columns match" not in text
    assert "- platformid_accountid: string (Stable cross-platform player key)" in text
    assert "- profile_label: string (Publishing label)" in text


def test_describing_a_table_reads_it_on_the_enumeration_budget_not_the_sampling_one():
    """Pinned as a property of the CALL, so the two budgets cannot be swapped back."""

    calls: list[tools_module.RowBudget] = []
    tools = build(FakeWarehouse(["col_name", "data_type", "comment"], DESCRIBE_ROWS))
    original = tools._collect_rows

    def record(response, budget=tools_module.SAMPLE_BUDGET):
        calls.append(budget)
        return original(response, budget)

    tools._collect_rows = record
    tools.describe_table(PROFILES)

    assert calls == [tools_module.ENUMERATION_BUDGET]


# ---------------------------------------------------------------------------
# query_named_table
# ---------------------------------------------------------------------------


def test_querying_a_named_table_returns_rows_and_cites_what_it_read():
    warehouse = FakeWarehouse(["label", "players"], [["Northwind", "8413"], ["Contoso", "5917"]])

    result = build(warehouse).query_named_table(
        f"SELECT profile_label AS label, count(*) AS players FROM {PROFILES} GROUP BY 1"
    )

    assert result.text.splitlines()[0] == "label | players"
    assert "Northwind | 8413" in result.text
    assert result.sources == [PROFILES]
    assert result.sql.startswith("SELECT profile_label")


def test_an_undeclared_table_is_refused_before_it_reaches_the_warehouse():
    """The guard is what makes this survivable: the grant does not exist.

    Without the check the statement reaches the warehouse and fails with an error
    about a table not existing, which reads like missing data rather than a
    missing grant, and the model then goes looking for the table elsewhere.
    """

    warehouse = FakeWarehouse(["a"], [["1"]])

    with pytest.raises(ValueError, match="Not in the declared table set"):
        build(warehouse).query_named_table("SELECT * FROM main.default.customers")

    assert warehouse.statements == []


def test_a_write_is_refused_however_it_is_dressed_up():
    warehouse = FakeWarehouse(["a"], [["1"]])
    tools = build(warehouse)

    with pytest.raises(ValueError, match="read-only"):
        tools.query_named_table(f"DELETE FROM {PROFILES}")
    with pytest.raises(ValueError, match="read-only"):
        tools.query_named_table(f"SELECT 1 FROM {PROFILES}; DROP TABLE {PROFILES}")
    with pytest.raises(ValueError, match="read-only"):
        tools.query_named_table(f"-- SELECT\nUPDATE {PROFILES} SET profile_label = 'x'")

    assert warehouse.statements == []


def test_a_bare_table_name_is_refused_rather_than_resolved_against_a_default_schema():
    """A silently resolved name is a silently wrong table."""

    with pytest.raises(ValueError, match="fully-qualified"):
        build().query_named_table("SELECT * FROM silver_player_profiles")


def test_a_large_result_is_summarized_with_the_count_of_what_is_missing():
    """Both numbers, not a remainder the reader has to add back to get the total.

    A model shown fifty rows and told twenty-five are missing has to do the
    arithmetic to learn the population was seventy-five, and a model that does
    not do it states the fifty-row figure as the total.
    """

    warehouse = FakeWarehouse(["player", "sessions"], wide_rows(MAX_SQL_ROWS + 25))

    text = build(warehouse).query_named_table(f"SELECT * FROM {PROFILES}").text

    assert text.count("\n") == MAX_SQL_ROWS + 1
    assert f"has {MAX_SQL_ROWS + 25} row(s) and {MAX_SQL_ROWS} of them are shown" in text
    assert "25 are not" in text
    assert "partial" in text


def test_what_a_result_costs_decides_how_much_of_it_is_shown_not_how_many_rows_it_has():
    """The same row count, two shapes, two answers. That is the whole fix.

    A row was the unit and a row is not a cost: an enumeration of narrow rows
    and a sample of wide ones were held to one number, so the number was either
    too small for the first or too generous for the second. It was set for the
    second, and the first came back cut.
    """

    count = MAX_SQL_ROWS * 6
    narrow = FakeWarehouse(["column_name", "data_type"], narrow_rows(count))
    wide = FakeWarehouse(["column_name", "data_type"], wide_rows(count))

    enumerated = build(narrow).query_named_table(f"SELECT * FROM {PROFILES}").text
    sampled = build(wide).query_named_table(f"SELECT * FROM {PROFILES}").text

    assert f"column_{count - 1} | string" in enumerated, "the last row of a narrow result"
    assert "SAMPLE" not in enumerated, "nothing was withheld, so nothing is disclosed"
    assert sampled.count("\n") == MAX_SQL_ROWS + 1, "a wide result still gets the sample"
    assert f"has {count} row(s) and {MAX_SQL_ROWS} of them are shown" in sampled


def test_a_partial_result_says_a_list_built_from_it_is_incomplete():
    """The disclosure spoke only of arithmetic, so an enumeration ignored it.

    A model told that "a total, a ranking, or a maximum" would be partial, and
    asked what a table CONTAINS, is doing none of those three. It read the
    caveat as addressed to somebody else and published the sample as the
    inventory. An incomplete LIST is the other way a subset passes for the whole
    thing and it has to be named as one.
    """

    warehouse = FakeWarehouse(["column_name", "data_type"], wide_rows(1_753))

    text = build(warehouse).query_named_table(f"SELECT * FROM {PROFILES}").text

    assert "a list or an inventory built from them is INCOMPLETE" in text
    assert "Report 1753 as the number found" in text
    assert "say how many of them you saw" in text


def test_a_result_that_fitted_whole_is_not_told_it_is_missing_rows():
    """A caveat on a complete answer is the same defect pointing the other way.

    The old note fired on a comparison against the row cap rather than against
    what was actually rendered, so it could only ever mean one thing. Now it
    means what it says.
    """

    warehouse = FakeWarehouse(["column_name", "data_type"], narrow_rows(120))

    text = build(warehouse).query_named_table(f"SELECT * FROM {PROFILES}").text

    assert "SAMPLE" not in text
    assert "row(s) and" not in text


def test_nulls_are_rendered_as_blanks_rather_than_the_word_none():
    warehouse = FakeWarehouse(["label", "players"], [["Northwind", None]])

    assert "Northwind | " in build(warehouse).query_named_table(f"SELECT * FROM {PROFILES}").text


def test_run_sql_and_query_named_table_share_one_guard():
    """Two tools, two meanings, one boundary, so neither can be the loose one."""

    tools = build()

    for call in (tools.run_sql, tools.query_named_table):
        with pytest.raises(ValueError, match="Not in the declared table set"):
            call("SELECT * FROM main.default.customers")


# ---------------------------------------------------------------------------
# Attacks on the SQL guard
#
# Every one is either refused, or accepted with the TRUE set of tables: a bypass
# that reports the wrong sources is the same defect wearing a different coat,
# because the Sources block would name one table while the query read another.
# ---------------------------------------------------------------------------


SECRET = "secret.sch.restricted_identity"


def refused(sql: str, fragment: str) -> str:
    """Assert the guard refuses this, for the stated reason, and return the reason."""

    try:
        validate_sql(sql, MANIFEST)
    except SqlRefused as error:
        assert fragment in str(error), f"refused for the wrong reason: {error}"
        return str(error)
    raise AssertionError(f"ACCEPTED and should not have been: {sql}")


def test_a_second_table_in_a_comma_join_is_seen():
    """Proven bypass 1. The pattern only looked after FROM and JOIN."""

    refused(f"SELECT * FROM {ACTIVITY}, {SECRET}", SECRET)


def test_comment_syntax_inside_a_string_literal_does_not_erase_the_sql():
    """Proven bypasses 2 and 3, and the reason they worked.

    Comments were stripped from a COPY of the statement with no notion of quoting,
    so `'--'` deleted the rest of the line from the text being checked while the
    original (still naming the secret table) was the text that ran. There is now
    one parse of one string, so there is no second version to disagree with.
    """

    refused(
        f"SELECT count(*) FROM {ACTIVITY} WHERE note = '--' AND 1 IN (SELECT 1 FROM {SECRET})",
        SECRET,
    )
    refused(
        f"SELECT a FROM {ACTIVITY} WHERE a = '/*' UNION SELECT * FROM {SECRET} WHERE b = '*/'",
        SECRET,
    )


def test_the_cross_label_key_is_refused_in_a_projection():
    """Proven bypasses 4 and 5.

    Until now the only thing standing between this statement and fifty rows of
    identity keys was a sentence in a prompt.
    """

    reason = refused(
        f"SELECT crm_customer_ref, partner_player_ref, email FROM {PROFILES} LIMIT 50", "crm_customer_ref"
    )
    assert "identity_use_scope" in reason, "the refusal has to cite the governing field"
    refused(
        f"SELECT email, partner_player_ref, crm_customer_ref, platformid_accountid FROM {PROFILES}",
        "crm_customer_ref",
    )


def test_the_identity_bridge_is_refused_on_a_single_declared_table():
    """Proven bypass 6, and the case that proves table-level checking is not enough.

    A self-join on the one key that spans labels needs no second table, so no
    check that looks only at table names can ever see it. This is the behaviour the
    demo is built to show being refused.
    """

    refused(
        f"SELECT p.crm_customer_ref, p.profile_label FROM {PROFILES} p "
        f"JOIN {PROFILES} q ON p.crm_customer_ref = q.crm_customer_ref "
        "WHERE p.profile_label <> q.profile_label",
        "crm_customer_ref",
    )


def test_the_key_is_refused_everywhere_not_only_where_it_is_returned():
    """Filtering on it or counting it still bridges the labels."""

    refused(f"SELECT count(DISTINCT crm_customer_ref) FROM {PROFILES}", "crm_customer_ref")
    refused(f"SELECT count(*) FROM {PROFILES} WHERE crm_customer_ref IS NOT NULL", "not filtered on")


def test_a_table_named_only_inside_a_string_literal_is_not_reported_as_a_source():
    """The mirror image of the comma-join bypass, and the one that reached Genie.

    Through `validate_sql` a phantom table was a false rejection. Through the Genie
    path there is no validation at all (the generated SQL is parsed straight into
    `sources`), so a table nobody read could be shown to a customer as one that
    was. Both paths now use the same parse.
    """

    assert validate_sql(f"SELECT 'from {SECRET}' AS note FROM {ACTIVITY}", MANIFEST) == [ACTIVITY]


def test_a_semicolon_inside_a_literal_is_not_a_second_statement():
    """The same root cause as the bypasses, pointing the other way.

    Text-level checking rejected this legitimate query. Parsing accepts it, and
    still refuses two real statements.
    """

    assert validate_sql(f"SELECT 'a;b' AS note FROM {ACTIVITY}", MANIFEST) == [ACTIVITY]
    refused(f"SELECT 1 FROM {ACTIVITY}; DROP TABLE {PROFILES}", "Only one statement")


def test_a_secret_table_hidden_in_a_cte_or_a_subquery_is_found():
    refused(f"WITH a AS (SELECT * FROM {SECRET}) SELECT * FROM {ACTIVITY}", SECRET)
    refused(f"SELECT (SELECT max(x) FROM {SECRET}) AS x FROM {ACTIVITY}", SECRET)
    refused(f"SELECT 1 FROM {ACTIVITY} EXCEPT SELECT 1 FROM {SECRET}", SECRET)


def test_a_cte_is_not_mistaken_for_a_table_in_either_direction():
    """It is not a table, so it is neither refused as undeclared nor cited as read."""

    cte = f"WITH a AS (SELECT * FROM {ACTIVITY}) SELECT count(*) FROM a"
    assert validate_sql(cte, MANIFEST) == [ACTIVITY]
    # A CTE named after a real table does not smuggle that table in.
    refused("WITH silver_gameplay_activity AS (SELECT 1 AS x) SELECT * FROM x", "fully-qualified")


def test_an_identity_column_cannot_be_smuggled_out_through_an_alias_or_a_function():
    """Renaming or wrapping the column does not change what leaves the endpoint."""

    for projection in (
        "email AS e",
        "cast(email AS string)",
        "substring(email, 1, 3)",
        "md5(email)",
        "concat(email, '')",
        "(email)",
        "p.email",
    ):
        refused(f"SELECT {projection} FROM {PROFILES} p", "identifies individual players")

    refused(f"SELECT x FROM (SELECT email AS x FROM {PROFILES}) s", "identifies individual players")


def test_identity_columns_can_still_be_counted_and_filtered_on():
    """The restriction is on exposure. Counting players is the product."""

    assert validate_sql(f"SELECT count(DISTINCT platformid_accountid) FROM {PROFILES}", MANIFEST)
    assert validate_sql(f"SELECT count(*) FROM {PROFILES} WHERE email IS NOT NULL", MANIFEST)
    assert validate_sql(f"SELECT count(*) FROM {PROFILES} GROUP BY platformid_accountid", MANIFEST)
    assert validate_sql(f"SELECT count(*) AS n FROM {PROFILES} ORDER BY email", MANIFEST)


def test_what_the_guard_refuses_that_it_arguably_need_not():
    """The known false refusals, recorded so the next reviewer finds them here.

    Each returns a value rather than an identifier, so each is arguably safe. They
    are refused because telling them apart from the unsafe form needs type
    analysis the guard does not do: `CASE WHEN 1=1 THEN email END` returns the
    email, and `row_number() OVER (ORDER BY email)` is one edit from ranking
    people. Failing closed costs the model an aggregate it can write another way;
    failing open costs identities. The refusal message says to aggregate, and the
    aggregate form is accepted.
    """

    refused(
        f"SELECT CASE WHEN email IS NULL THEN 1 ELSE 0 END AS missing FROM {PROFILES}",
        "identifies individual players",
    )
    refused(
        f"SELECT row_number() OVER (ORDER BY platformid_accountid) AS r FROM {PROFILES}",
        "identifies individual players",
    )
    refused(f"SELECT * EXCEPT (crm_customer_ref) FROM {PROFILES}", "crm_customer_ref")

    assert validate_sql(
        f"SELECT sum(CASE WHEN email IS NULL THEN 1 ELSE 0 END) AS missing FROM {PROFILES}",
        MANIFEST,
    ) == [PROFILES]


# ---------------------------------------------------------------------------
# Restricted columns in shapes the guard once read as safe.
#
# `max(email)` is an aggregate, and "an aggregate is a summary" made it a summary.
# It returns a real address. Neither half of the column defence caught it: the
# static parse saw an `exp.AggFunc` and stopped looking, and the post-execution
# check compares RESULT COLUMN NAMES, which an alias changes.
# ---------------------------------------------------------------------------


#: Aggregates that are `exp.AggFunc` and return the column's real values. The
#: previous rule exempted every one of them. Live, against silver_player_profiles,
#: each returned a genuine player email.
_LEAKING_AGGREGATES = (
    "max(email)",
    "min(email)",
    "first(email)",
    "any_value(email)",
    "mode(email)",
    "max_by(player_id, 1)",
    "min_by(platformid_accountid, 1)",
    "collect_list(email)",
    "collect_set(display_name)",
    "array_agg(partner_player_ref)",
    # Wrapping the collection does not un-collect it: this one pulled 9,404
    # addresses into a single cell.
    "length(concat_ws(',', collect_list(email)))",
    "transform(collect_list(email), x -> x)",
    "sort_array(collect_list(email))",
    "element_at(collect_list(email), 1)",
    # A FILTER clause is not a reduction either.
    "max(email) FILTER (WHERE 1 = 1)",
)

#: Window functions. Every one returns a real value PER ROW, and `MAX_SQL_ROWS`
#: is 50, so one accepted call is fifty players. `count` is in here too: counting
#: is only a reduction when it reduces, and a window reduces nothing.
_WINDOWED = (
    "first_value(email) OVER (ORDER BY 1)",
    "last_value(partner_player_ref) OVER (ORDER BY 1)",
    "lag(email) OVER (ORDER BY 1)",
    "lead(display_name) OVER (ORDER BY 1)",
    "count(email) OVER ()",
    "max(email) OVER (PARTITION BY profile_label)",
)

#: The worst shape of all: the restricted column is named in the FROM clause, so
#: it appears in no projection anywhere and the alias is what the warehouse
#: reports back. Invisible to both halves of the defence, and it emits a
#: different real value on every row.
_PROJECTED_ELSEWHERE = (
    f"SELECT e FROM {PROFILES} LATERAL VIEW explode(array(email)) t AS e",
    f"SELECT p, e FROM {PROFILES} LATERAL VIEW posexplode(array(email)) t AS p, e",
    f"SELECT e FROM {PROFILES} LATERAL VIEW OUTER explode(array(email)) t AS e",
    f"SELECT k, v FROM {PROFILES} LATERAL VIEW explode(map('a', email)) t AS k, v",
    f"SELECT e FROM {PROFILES} LATERAL VIEW inline(array(struct(email))) t AS e",
    f"SELECT e FROM {PROFILES} LATERAL VIEW explode(split(email, '@')) t AS e",
    # UNPIVOT is the same escape in ANSI clothing, and was not in the audit: the
    # identifiers hang off the table's `pivots` and the result column is `val`.
    f"SELECT val FROM {PROFILES} UNPIVOT (val FOR col IN (email, display_name))",
    f"SELECT v FROM {PROFILES} UNPIVOT (v FOR k IN (email AS a, partner_player_ref AS b))",
)


def test_an_aggregate_is_not_a_summary_unless_it_counts():
    """F1. Every one of these was ACCEPTED, and every one returns real identities.

    The rule was "any `exp.AggFunc` between the column and the projection means
    this column is summarized". It is not the same claim: `max` is an aggregate
    and hands over an address. The rule is now an allowlist of aggregates that
    reduce to a cardinality, which is the property that was actually wanted.
    """

    for projection in _LEAKING_AGGREGATES:
        refused(f"SELECT {projection} FROM {PROFILES}", "identifies individual players")


def test_a_window_function_returns_one_real_value_per_row():
    """F1, the per-row half. Fifty rows is fifty players."""

    for projection in _WINDOWED:
        refused(f"SELECT {projection} AS c FROM {PROFILES}", "identifies individual players")


def test_a_restricted_column_projected_from_the_from_clause_is_still_returned():
    """F1, the case neither half of the defence could see.

    `LATERAL VIEW` and `UNPIVOT` name the column in the FROM clause and project an
    alias, so `select.expressions` never contains it and the result column is
    named something innocuous. The guard now reads them as what they are: a
    projection written somewhere other than the projection list.
    """

    for statement in _PROJECTED_ELSEWHERE:
        refused(statement, "identifies individual players")


def test_the_leaking_shapes_are_refused_wherever_they_are_nested():
    """A subquery, a CTE, or a set operation is not a way to relocate the leak."""

    refused(f"SELECT c FROM (SELECT max(email) AS c FROM {PROFILES}) x", "identifies individual")
    refused(
        f"WITH x AS (SELECT max(email) AS c FROM {PROFILES}) SELECT c FROM x",
        "identifies individual",
    )
    refused(
        f"SELECT count(*) FROM {PROFILES} UNION ALL SELECT max(email) FROM {PROFILES}",
        "identifies individual",
    )
    refused(
        f"SELECT c FROM (SELECT e AS c FROM {PROFILES} "
        "LATERAL VIEW explode(array(email)) t AS e) z",
        "identifies individual",
    )


#: Week-over-week retention, shortened from the query the live data Genie space
#: generates for "week-over-week retention for IFR2 vs VLH Online over the last
#: quarter". It is a self-join over the set of players active in each week, so the
#: identifier HAS to be projected by a CTE for the counts above it to intersect,
#: and every column of the result is a count, a week or a ratio.
_RETENTION = f"""
WITH weekly AS (
  SELECT DISTINCT
    title_name,
    date_trunc('WEEK', event_date) AS week_start,
    platformid_accountid
  FROM {ACTIVITY}
  WHERE integrity_status = 'VALID'
), base AS (
  SELECT title_name, week_start, count(DISTINCT platformid_accountid) AS players
  FROM weekly
  GROUP BY title_name, week_start
), retained AS (
  SELECT
    curr.title_name,
    curr.week_start,
    count(DISTINCT curr.platformid_accountid) AS both_weeks
  FROM weekly curr
  JOIN weekly prev
    ON curr.title_name = prev.title_name
   AND curr.platformid_accountid = prev.platformid_accountid
   AND curr.week_start = date_add(prev.week_start, 7)
  GROUP BY curr.title_name, curr.week_start
)
SELECT
  r.title_name,
  r.week_start,
  r.both_weeks,
  b.players AS previous_week_players,
  try_divide(r.both_weeks, b.players) AS retention
FROM retained r
JOIN base b
  ON r.title_name = b.title_name AND r.week_start = date_add(b.week_start, 7)
"""


def test_an_identifier_may_be_used_inside_a_cte_when_only_counts_come_out():
    """The false refusal that cost a stakeholder his retention question.

    Asked for week-over-week retention, the agent planned this shape, was refused
    because `platformid_accountid` appears in a CTE, retried, was refused
    identically, and reported that no figure could be produced. The refusal
    advised counting, which the query was already doing one level up, so there
    was no rewrite that would have been accepted.

    The rule is about what leaves, so a value that stops inside the statement —
    in a CTE, as a join key, in an `IN` predicate — is not an exposure.
    """

    assert validate_sql(_RETENTION, MANIFEST) == [ACTIVITY]

    for statement in (
        f"WITH ids AS (SELECT platformid_accountid AS pid FROM {PROFILES}) "
        "SELECT count(DISTINCT pid) AS players FROM ids",
        f"SELECT count(*) AS n FROM (SELECT platformid_accountid FROM {PROFILES}) s",
        f"SELECT count(*) AS n FROM {ACTIVITY} WHERE platformid_accountid IN "
        f"(SELECT platformid_accountid FROM {PROFILES})",
        f"SELECT count(DISTINCT a.platformid_accountid) AS n FROM {ACTIVITY} a "
        f"JOIN {PROFILES} p ON a.platformid_accountid = p.platformid_accountid",
    ):
        assert PROFILES in validate_sql(statement, MANIFEST) or ACTIVITY in validate_sql(
            statement, MANIFEST
        ), statement


def test_an_identifier_that_escapes_a_cte_is_refused_however_it_is_dressed():
    """The other half, and the reason following values is not the same as allowing them.

    Each of these projects a restricted value out of the statement. The alias is
    the sharp one: the result column is called `pid`, which the post-execution
    check on result column NAMES would not recognise, so if the parse stopped at
    the outermost SELECT this would be the way through.
    """

    for statement in (
        f"WITH ids AS (SELECT platformid_accountid AS pid FROM {PROFILES}) SELECT pid FROM ids",
        f"WITH ids AS (SELECT platformid_accountid AS pid FROM {PROFILES}) SELECT * FROM ids",
        f"WITH ids AS (SELECT platformid_accountid AS pid FROM {PROFILES}) SELECT s.* FROM ids s",
        f"WITH ids AS (SELECT email AS e FROM {PROFILES}) "
        f"SELECT upper(e) AS shouted FROM ids",
        f"WITH ids AS (SELECT max(email) AS e FROM {PROFILES}) SELECT e FROM ids",
        # Two CTEs deep, and renamed at every hop.
        f"WITH a AS (SELECT platformid_accountid AS x FROM {PROFILES}), "
        "b AS (SELECT x AS y FROM a) SELECT y FROM b",
        # One clean branch does not launder the other.
        f"WITH ids AS (SELECT platformid_accountid AS pid FROM {PROFILES}) "
        f"SELECT count(*) AS n FROM {ACTIVITY} UNION ALL SELECT pid FROM ids",
    ):
        refused(statement, "identifies individual players")


def test_the_refusal_does_not_hand_back_the_bypass():
    """F1's second half, and the reason the wording is load-bearing.

    The refusal used to say "Aggregate instead". A model that has just been
    refused `SELECT email` reads that as permission to try `max(email)`, which is
    an aggregate and is the leak. It now names COUNTING, and names the shapes that
    are not counting so the model does not rediscover them one at a time.
    """

    reason = refused(f"SELECT email FROM {PROFILES}", "identifies individual players")

    assert "COUNT them instead" in reason
    assert "count(DISTINCT platformid_accountid) is allowed" in reason
    for named in ("max", "collect_list", "window function", "LATERAL VIEW"):
        assert named in reason, f"the refusal should name {named} as not a way through"
    # The sentence that caused the problem must not survive in any form.
    assert "Aggregate instead" not in reason


def test_counting_and_the_analysis_the_product_exists_for_still_pass():
    """The other direction, which matters exactly as much.

    A guard that refuses `count(DISTINCT platformid_accountid)` has broken the
    demo just as thoroughly as one that returns an email. These are the shapes
    real analysis uses, including the null-ratio work `run_sql` is advertised for.
    """

    for statement in (
        f"SELECT count(DISTINCT platformid_accountid) FROM {PROFILES}",
        f"SELECT count(DISTINCT email) FROM {PROFILES}",
        f"SELECT count(player_id) FROM {PROFILES}",
        f"SELECT approx_count_distinct(platformid_accountid) FROM {PROFILES}",
        f"SELECT count_if(email IS NULL) AS missing FROM {PROFILES}",
        f"SELECT sum(CASE WHEN email IS NULL THEN 1 ELSE 0 END) AS missing FROM {PROFILES}",
        f"SELECT avg(CASE WHEN email IS NULL THEN 1.0 ELSE 0.0 END) AS ratio FROM {PROFILES}",
        f"SELECT count(DISTINCT platformid_accountid) FILTER (WHERE profile_label = 'R') "
        f"FROM {PROFILES}",
        f"SELECT profile_label, count(DISTINCT platformid_accountid) FROM {PROFILES} "
        "GROUP BY profile_label",
        f"SELECT count(*) FROM {PROFILES} WHERE email IS NOT NULL AND email LIKE '%@%'",
        f"SELECT c FROM (SELECT count(DISTINCT platformid_accountid) AS c FROM {PROFILES}) x",
    ):
        assert validate_sql(statement, MANIFEST) == [PROFILES], statement

    # Aggregates over columns that identify nobody are untouched by any of this.
    assert validate_sql(f"SELECT max(session_end) FROM {ACTIVITY}", MANIFEST) == [ACTIVITY]
    assert validate_sql(f"SELECT collect_list(title_name) FROM {ACTIVITY}", MANIFEST) == [ACTIVITY]
    assert validate_sql(
        f"SELECT e FROM {ACTIVITY} LATERAL VIEW explode(array(title_name)) t AS e", MANIFEST
    ) == [ACTIVITY]
    assert validate_sql(
        f"SELECT row_number() OVER (ORDER BY sessions) AS r FROM {ACTIVITY}", MANIFEST
    ) == [ACTIVITY]


def test_the_cross_label_key_is_refused_when_a_join_names_it_without_a_column():
    """F2. `USING (crm_customer_ref)` produces no `exp.Column` in the tree at all.

    sqlglot keeps the key as a bare `exp.Identifier` on the join, so a scan for
    columns walked past it while the join ran. Live, `silver_player_profiles`
    joined to `raw_player_profiles` `USING (crm_customer_ref)` passed validation
    and returned 2,034 cross-label bridged pairs, with an aggregate-only
    projection, so the column check found nothing to look at either.
    """

    refused(
        f"SELECT count(*) FROM {PROFILES} a JOIN {ACTIVITY} b USING (crm_customer_ref)",
        "crm_customer_ref",
    )
    # A self-join needs no second table, exactly as with the ON form.
    refused(
        f"SELECT count(*) FROM {PROFILES} a JOIN {PROFILES} b USING (crm_customer_ref)",
        "crm_customer_ref",
    )
    for shape in (
        f"SELECT count(*) FROM {PROFILES} a LEFT JOIN {ACTIVITY} b USING (crm_customer_ref)",
        f"SELECT count(*) FROM {PROFILES} a JOIN {ACTIVITY} b USING (player_id, crm_customer_ref)",
        f"SELECT * FROM (SELECT count(*) AS c FROM {PROFILES} a JOIN {ACTIVITY} b "
        "USING (crm_customer_ref)) z",
        f"WITH j AS (SELECT count(*) AS c FROM {PROFILES} a JOIN {ACTIVITY} b "
        "USING (crm_customer_ref)) SELECT c FROM j",
    ):
        refused(shape, "crm_customer_ref")

    # The refusal still cites the governing field, because that is what the
    # answer explains the refusal with.
    reason = refused(
        f"SELECT count(*) FROM {PROFILES} a JOIN {ACTIVITY} b USING (crm_customer_ref)",
        "crm_customer_ref",
    )
    assert "identity_use_scope" in reason


def test_a_natural_join_is_refused_because_its_keys_cannot_be_known():
    """F2, the half no column check could ever close.

    A NATURAL join names nothing: it joins on whatever columns the two tables
    share, which is a fact about their schemas rather than about the statement.
    The parser has no schema, so there is no version of this it can check. Live,
    `silver_player_profiles NATURAL JOIN raw_player_profiles` returned 262 rows
    bridged on exactly the key the guard exists to refuse.
    """

    for shape in (
        f"SELECT count(*) FROM {PROFILES} NATURAL JOIN {ACTIVITY}",
        f"SELECT count(*) FROM {PROFILES} NATURAL LEFT JOIN {ACTIVITY}",
        f"SELECT count(*) FROM {PROFILES} NATURAL RIGHT OUTER JOIN {ACTIVITY}",
        f"WITH x AS (SELECT count(*) AS c FROM {PROFILES} NATURAL JOIN {ACTIVITY}) SELECT c FROM x",
    ):
        refused(shape, "NATURAL joins are not allowed")

    # An explicit join on a permitted key is what the model should write instead,
    # and both spellings of it still pass.
    assert validate_sql(
        f"SELECT count(*) FROM {PROFILES} a JOIN {ACTIVITY} b "
        "ON a.platformid_accountid = b.platformid_accountid",
        MANIFEST,
    ) == [PROFILES, ACTIVITY]
    assert validate_sql(
        f"SELECT count(*) FROM {PROFILES} a JOIN {ACTIVITY} b USING (platformid_accountid)",
        MANIFEST,
    ) == [PROFILES, ACTIVITY]


def test_anything_the_guard_cannot_resolve_is_refused_rather_than_passed_through():
    refused("SELECT FROM WHERE )(", "could not be parsed")
    refused("SELECT * FROM range(10)", "cannot resolve to a table")
    refused(f"SELECT * FROM sch.{ACTIVITY.split('.')[-1]}", "only partly qualified")
    refused(f"SELECT * FROM {ACTIVITY.split('.')[-1]}", "not a fully-qualified table")
    refused(f"EXPLAIN SELECT * FROM {ACTIVITY}", "read-only")
    refused(f"INSERT INTO {PROFILES} SELECT * FROM {ACTIVITY}", "INSERT statement")
    refused(f"DELETE FROM {PROFILES}", "read-only")
    refused("", "No SQL statement")


def test_a_table_is_attributed_with_the_spelling_it_was_declared_under():
    """So one table written two ways is not read as two sources."""

    assert validate_sql(f"SELECT count(*) FROM {PROFILES.upper()}", MANIFEST) == [PROFILES]
    assert validate_sql(f"SELECT count(*) FROM `{'`.`'.join(PROFILES.split('.'))}`", MANIFEST) == [
        PROFILES
    ]


def test_the_guard_reads_the_same_text_the_warehouse_runs():
    """The property the six bypasses all violated, stated as a test.

    Nothing is stripped, rewritten, or normalized before checking: the string
    handed to the warehouse is the string that was parsed.
    """

    warehouse = FakeWarehouse(["n"], [["1"]])
    tools = build(warehouse, manifest=MANIFEST)
    sql = f"SELECT count(*) AS n FROM {ACTIVITY} WHERE note = '--' AND label = '/*'"

    tools.run_sql(sql)

    assert warehouse.statements == [sql]


# ---------------------------------------------------------------------------
# The column defence that runs after the query
# ---------------------------------------------------------------------------


def test_a_star_that_returns_identity_columns_is_refused_before_any_row_is_rendered():
    """What closes `SELECT *`, which no static parse can expand without the schema.

    The result schema from the warehouse is authoritative about what the query
    returns, and it arrives before the rows become text. That matters here more
    than usual: rows go into the evidence log, the synthesis prompt, and a trace
    stage that is persisted to Lakebase and re-rendered in the browser, so a leak
    is durable and on screen rather than transient.
    """

    warehouse = FakeWarehouse(
        ["platformid_accountid", "email", "sessions"],
        [["acct-1", "a@example.com", "12"]],
    )
    tools = build(warehouse, manifest=MANIFEST)

    with pytest.raises(SqlRefused) as refusal:
        tools.query_named_table(f"SELECT * FROM {PROFILES}")

    assert "email" in str(refusal.value)
    assert "a@example.com" not in str(refusal.value), "the refusal must not carry the leak"


def test_an_aggregate_result_is_not_mistaken_for_an_identity_column():
    """`count(DISTINCT platformid_accountid)` names the column in its own header."""

    warehouse = FakeWarehouse(["count(DISTINCT platformid_accountid)"], [["8413"]])
    tools = build(warehouse, manifest=MANIFEST)

    result = tools.query_named_table(f"SELECT count(DISTINCT platformid_accountid) FROM {PROFILES}")

    assert "8413" in result.text


def test_the_output_check_is_exact_about_names():
    assert restricted_output_columns(["label", "players", "sessions_180d"]) == []
    assert restricted_output_columns(["email", "label"]) == ["email"]
    assert restricted_output_columns(["`crm_customer_ref`", "Email"]) == [
        "`crm_customer_ref`",
        "Email",
    ]


def test_the_parser_is_declared_for_the_serving_container():
    """The guard imports sqlglot at load time, so serving must install it.

    A version logged without this requirement fails to load rather than serving
    unvalidated SQL, which is the right failure, but it is a failure, and this is
    cheaper than discovering it from an endpoint that will not start.
    """

    source = (Path(__file__).resolve().parents[1] / "log_model.py").read_text()

    assert "sqlglot" in source, "log_model.py must declare sqlglot in pip_requirements"
    assert "sqlglot" in (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text()


# ---------------------------------------------------------------------------
# Waiting for Genie on this turn's budget
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _no_real_waiting(monkeypatch):
    """Poll instantly. The interval is a live-latency trade-off, not behaviour."""

    monkeypatch.setattr(tools_module, "GENIE_POLL_SECONDS", 0.0)


def test_the_poll_interval_is_short_enough_to_notice_the_answer_arriving():
    assert 0 < REAL_POLL_SECONDS <= tools_module.GENIE_TIMEOUT_SECONDS / 10


class FakeGenie:
    """A Genie space that walks through a scripted sequence of statuses.

    Serves the query-result API too, because the rows behind a query attachment
    are fetched through a SECOND call and a fake that cannot answer it would
    make every Genie test pass while proving nothing about the path that reads
    them. The result set is a `FakeWarehouse`, so the Genie path is exercised
    against the same paging behaviour as the SQL path rather than a flat list
    handed over in one piece.
    """

    def __init__(
        self,
        *statuses,
        sql: str = "",
        text: str = "8,413 active players.",
        attachments: list | None = None,
        columns: list[str] | None = None,
        rows: list[list] | None = None,
        chunk_size: int | None = None,
        total_row_count: int | None = None,
        result_state: str = "SUCCEEDED",
        #: An SDK build without the query-result method, and the fetch itself
        #: raising, are different degradations and both have to be disclosed.
        has_result_api: bool = True,
        result_error: Exception | None = None,
        #: Genie's own cap, applied before we ever see the statement.
        is_truncated: bool = False,
    ):
        self.statuses = list(statuses)
        self.sql = sql
        self.text = text
        #: Supplied directly when a test is about how SEVERAL attachments combine.
        #: One answer can carry more than one, and only some of them expose SQL.
        self.attachments = attachments
        self.is_truncated = is_truncated
        self.result_error = result_error
        self.polls = 0
        self.result_fetches: list[tuple[str, str, str, str]] = []
        self.result = FakeWarehouse(
            columns or ["metric", "value"],
            rows if rows is not None else [["active_players", "8413"]],
            state=result_state,
            chunk_size=chunk_size,
            total_row_count=total_row_count,
        )
        # `_collect_rows` pages through the workspace's statement execution API,
        # and a Genie statement id is an ordinary Statement Execution id.
        self.statement_execution = self.result.statement_execution
        api = {
            "start_conversation": self._start,
            "get_message": self._get,
            # Present so a test can prove it is NOT what gets called: its default
            # timeout is twenty minutes, which the request cannot survive.
            "start_conversation_and_wait": self._forbidden,
        }
        if has_result_api:
            api["get_message_attachment_query_result"] = self._query_result
        self.genie = SimpleNamespace(**api)

    def _forbidden(self, *args, **kwargs):
        raise AssertionError("start_conversation_and_wait carries the SDK's 20-minute default")

    def _start(self, space_id: str, question: str):
        self.asked = (space_id, question)
        return SimpleNamespace(conversation_id="c1", message_id="m1")

    def _query_result(
        self, space_id: str, conversation_id: str, message_id: str, attachment_id: str
    ):
        self.result_fetches.append((space_id, conversation_id, message_id, attachment_id))
        if self.result_error is not None:
            raise self.result_error
        return SimpleNamespace(
            statement_response=self.result._execute(
                warehouse_id="genie", statement=self.sql or "SELECT 1", wait_timeout="30s"
            )
        )

    def _get(self, space_id: str, conversation_id: str, message_id: str):
        self.polls += 1
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        attachments = []
        if status == MessageStatus.COMPLETED:
            attachments = (
                self.attachments
                if self.attachments is not None
                else [
                    attachment(
                        sql=self.sql if self.sql else _NO_QUERY,
                        text=self.text,
                        is_truncated=self.is_truncated,
                    )
                ]
            )
        return SimpleNamespace(
            status=status,
            attachments=attachments,
            error=None,
            conversation_id="c1",
            message_id="m1",
        )


#: Distinguishes "no query attachment at all" from "a query attachment that
#: exposed no SQL". They are different answers and only one of them is a gap.
_NO_QUERY = object()

_attachment_ids = itertools.count(1)


def attachment(
    sql: Any = _NO_QUERY,
    text: str = "",
    viz: object = None,
    is_truncated: bool = False,
    attachment_id: str | None = None,
) -> SimpleNamespace:
    """One Genie attachment.

    `sql` omitted is a text-only answer that ran nothing. `sql=""` or `sql=None`
    is a query attachment that ran something and did not show what.

    Carries an `attachment_id` because the row fetch is addressed by one, and an
    attachment without it is a real degradation rather than the normal case.
    """

    return SimpleNamespace(
        attachment_id=attachment_id or f"a{next(_attachment_ids)}",
        text=SimpleNamespace(content=text) if text else None,
        query=None
        if sql is _NO_QUERY
        else SimpleNamespace(
            query=sql,
            description="",
            query_result_metadata=SimpleNamespace(is_truncated=is_truncated, row_count=None),
        ),
        viz=viz,
    )


def test_genie_is_polled_to_completion_rather_than_waited_on_for_twenty_minutes():
    genie = FakeGenie(
        MessageStatus.SUBMITTED,
        MessageStatus.EXECUTING_QUERY,
        MessageStatus.COMPLETED,
        sql=f"SELECT count(*) FROM {ACTIVITY}",
    )

    result = build(genie).data_genie("how many active players")

    assert "8,413" in result.text
    assert result.sources == [ACTIVITY]
    assert genie.polls == 3


def test_a_cancelled_message_ends_the_wait_instead_of_being_polled_until_the_timeout():
    """The SDK's waiter treats only COMPLETED and FAILED as terminal.

    Everything else (a cancelled message, an expired result) is polled until its
    twenty-minute default expires, long after Model Serving has killed the request
    and the stakeholder has been handed nothing.
    """

    for status, expected in (
        (MessageStatus.CANCELLED, "was cancelled"),
        (MessageStatus.QUERY_RESULT_EXPIRED, "since expired"),
        (MessageStatus.FAILED, "could not answer"),
    ):
        genie = FakeGenie(status)
        with pytest.raises(RuntimeError, match=expected):
            build(genie).data_genie("q")
        assert genie.polls == 1, f"{status} should be terminal on the first poll"


def test_the_genie_budget_fits_inside_the_turn():
    """Two Genie calls at the ceiling must still leave the turn answerable."""

    assert tools_module.GENIE_TIMEOUT_SECONDS * 2 <= 90.0


# ---------------------------------------------------------------------------
# A warehouse that is STARTING is not a Genie space that FAILED
#
# The customer report these cover. Our demo warehouse is warm before anybody
# asks it anything, so the dictionary space answers in a couple of seconds and
# the 45 second deadline is never approached. A customer workspace starts its
# warehouse on the first question of the day, sat in PENDING_WAREHOUSE past 45
# seconds, and the step was reported as `dictionary_genie failed: TimeoutError`
# -- an outage that was not one, on a run that then had nothing to say.
#
# So there are two waits with two deadlines, and the properties below are the
# ones that make the difference real: a starting warehouse gets much longer, the
# answer allowance survives the warmup rather than being eaten by it, the turn
# still stops the wait with budget left for other tools, and running out that
# way is a skippable result rather than a failed step.
# ---------------------------------------------------------------------------


class Clock:
    """A monotonic clock the test drives, so a deadline can be reached in 0ms.

    `_await_genie` reads `time.perf_counter` and `time.sleep` off the module, so
    patching `tools.time` with this gives the test the whole of the timeline
    without the suite sleeping through any of it.
    """

    def __init__(self, start: float = 1_000.0):
        self.now = start

    def perf_counter(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += max(0.0, seconds)


def on_the_clock(monkeypatch, per_poll: float, *statuses, **kwargs) -> tuple[Clock, "FakeGenie"]:
    """A Genie space where every status check costs `per_poll` seconds."""

    clock = Clock()
    monkeypatch.setattr(tools_module, "time", clock)
    genie = FakeGenie(*statuses, **kwargs)
    checked = genie.genie.get_message

    def get_message(*args):
        clock.now += per_poll
        return checked(*args)

    genie.genie.get_message = get_message
    return clock, genie


#: What the wait allows on the default 90 second turn, which is what these run
#: on: `remaining_seconds()` with no request deadline set returns `max_run_seconds`.
WARMUP_ALLOWED = 90.0 - tools_module.GENIE_BUDGET_RESERVE_SECONDS


def test_a_starting_warehouse_is_waited_out_well_past_the_answer_deadline(monkeypatch):
    """The 45 second answer budget must not be the bound on warehouse warmup.

    This is the customer's failure exactly: PENDING_WAREHOUSE at 50 seconds, warm
    at 55, and an answer a few seconds later. The old single deadline threw it
    away five seconds before the warehouse came up.
    """

    clock, genie = on_the_clock(
        monkeypatch,
        10.0,
        *[MessageStatus.PENDING_WAREHOUSE] * 5,
        MessageStatus.EXECUTING_QUERY,
        MessageStatus.COMPLETED,
        sql=f"SELECT count(*) FROM {ACTIVITY}",
    )

    result = build(genie).data_genie("how many active players")

    assert "8,413" in result.text
    assert clock.now - 1_000.0 > tools_module.GENIE_TIMEOUT_SECONDS, (
        "the wait has to outlast the answer budget for this test to mean anything"
    )


def test_the_answer_allowance_survives_the_warmup_rather_than_being_spent_by_it(monkeypatch):
    """A warehouse that took 40 seconds must not leave 5 seconds to answer in.

    Warmup and answering are different waits. Charging the warmup to the answer
    budget makes a space that came up late look like a space that answers slowly,
    and fails the call for the wrong reason.
    """

    clock, genie = on_the_clock(
        monkeypatch,
        10.0,
        *[MessageStatus.PENDING_WAREHOUSE] * 4,
        *[MessageStatus.EXECUTING_QUERY] * 3,
        MessageStatus.COMPLETED,
        sql=f"SELECT count(*) FROM {ACTIVITY}",
    )

    result = build(genie).data_genie("q")

    assert "8,413" in result.text
    assert clock.now - 1_000.0 == 80.0, "40s warming then 40s answering, and both were allowed"


def test_a_warehouse_that_never_starts_stops_with_budget_left_for_the_other_tools(monkeypatch):
    """The wait ends early enough that the finder can still do something else.

    Waiting until the turn is gone is worse than not waiting: `search_tagged_assets`
    and `list_data_assets` do not need this warehouse, and a run that spent all of
    itself on one Genie call cannot reach them.
    """

    clock, genie = on_the_clock(monkeypatch, 5.0, MessageStatus.PENDING_WAREHOUSE)

    with pytest.raises(tools_module.WarehouseStarting) as starting:
        build(genie)._await_genie("space", "q")

    waited = clock.now - 1_000.0
    assert waited >= tools_module.GENIE_TIMEOUT_SECONDS, "it waited far longer than 45s"
    assert waited <= WARMUP_ALLOWED + 5.0, "and it stopped with the reserve intact"
    assert "warehouse" in str(starting.value) and "still starting" in str(starting.value)


def test_a_starting_warehouse_returns_a_skippable_result_instead_of_failing_the_step(monkeypatch):
    """The fix the finder actually needs: not raising.

    Raising puts the step on the loop's failure path -- red in the trace, counted
    against the repeat brake, reported to the model as an outage to relay. A
    warehouse coming up is none of those, and the run has other tools.
    """

    _, genie = on_the_clock(monkeypatch, 5.0, MessageStatus.PENDING_WAREHOUSE)

    result = build(genie).dictionary_genie("what does active player mean")

    assert tools_module.reports_dependency_unavailable(result.text)
    assert "still starting" in result.text
    assert "search_tagged_assets" in result.text and "list_data_assets" in result.text
    assert result.sources == [] and result.sql == ""


def test_a_slow_answer_is_still_a_hard_timeout_at_the_answer_deadline(monkeypatch):
    """Only the WAREHOUSE is forgiven. A query that will not finish is a failure.

    The longer allowance is for infrastructure coming up, not for a question too
    big for the turn, and blurring the two would let one Genie call quietly spend
    two thirds of every run.
    """

    clock, genie = on_the_clock(monkeypatch, 5.0, MessageStatus.EXECUTING_QUERY)

    with pytest.raises(TimeoutError) as timeout:
        build(genie).data_genie("q")

    assert not isinstance(timeout.value, tools_module.WarehouseStarting)
    assert clock.now - 1_000.0 <= tools_module.GENIE_TIMEOUT_SECONDS + 5.0
    # The plain reason first: this string is read in the trace, usually clipped.
    assert str(timeout.value).startswith("Its query was still running.")


def test_the_warehouse_allowance_is_generous_but_cannot_swallow_the_turn():
    assert tools_module.GENIE_WAREHOUSE_START_SECONDS >= 120.0, "cold starts take minutes"
    assert tools_module.GENIE_BUDGET_RESERVE_SECONDS >= 20.0, (
        "a wait that leaves nothing behind has failed the finder either way"
    )


# ---------------------------------------------------------------------------
# What the dictionary space is actually asked
#
# The same underlying question, asked two ways, behaves completely differently.
# Asked about a column, the dictionary space answered in 13.7 seconds. Asked
# about the same field IN A NAMED WIDE MASTER TABLE, it was still in its LLM
# planning phase when the 45 second deadline arrived and the turn got nothing:
# naming the table invites its context step to pull that table in beside the
# dictionary.
#
# These pin the SHAPE of the outgoing question, because the deadline cannot
# move. It is sized against the 90 second turn, so seconds bought there are
# spent somewhere else in the same turn.
# ---------------------------------------------------------------------------


def asked_of(genie: "FakeGenie") -> str:
    return genie.asked[1]


def dictionary(question: str) -> tuple[str, str]:
    """The question the space received, and the text the model reads back."""

    genie = FakeGenie(MessageStatus.COMPLETED)
    result = build(genie).dictionary_genie(question)
    return asked_of(genie), result.text


def test_a_table_that_only_scoped_the_field_is_dropped_before_the_space_is_asked():
    """The rewrite is here rather than in the prompt because this is a deadline.

    A prompt is a request. The model composes the question, and one phrasing
    answers inside the budget while the other does not return at all.
    """

    for question in (
        f"What does partner_player_ref mean in {PROFILES}?",
        f"What does partner_player_ref mean in the table {PROFILES}?",
        f"What does partner_player_ref mean in the {PROFILES} table?",
        f"What does partner_player_ref mean in `{PROFILES}`?",
        "What does partner_player_ref mean in test_schema.silver_player_profiles?",
        "What does partner_player_ref mean in silver_player_profiles?",
    ):
        asked, _ = dictionary(question)

        assert "silver_player_profiles" not in asked, question
        assert "partner_player_ref" in asked, "the field is what the question was always about"
        assert asked.startswith("What does partner_player_ref mean?"), asked


def test_a_question_whose_subject_is_the_table_keeps_the_table():
    """Dropping a name is only safe where something else was being asked about.

    "What is the grain of X" has nothing left when X goes. It is also a question
    that genuinely needs the table read, so it is allowed to be slow rather than
    turned into a question about nothing.
    """

    for question in (
        f"What is the grain of {PROFILES}?",
        f"What does {PROFILES} hold?",
    ):
        asked, text = dictionary(question)

        assert asked == question
        assert "Scope note" not in text, "nothing was dropped, so nothing is disclosed"


def test_dropping_the_table_is_disclosed_to_the_model_that_reads_the_answer():
    """The risk traded for the timeout, said out loud where it can be acted on.

    Where a column name lives in several tables the table was load-bearing, and
    the answer can now be confidently about the wrong column. The model cannot
    notice that unless it is told the scope it asked for was not the scope it
    got.

    ORDER IS ASSERTED AGAINST THE ANSWER, not against the start of the string.
    The note used to open the result; it now sits under the line naming which
    space answered, which is provenance the trace needs and which cannot hide a
    caveat that still precedes every figure. What would be a regression is the
    note moving BELOW the number, where it is read after the reader has already
    taken the figure.
    """

    _, text = dictionary(f"What does partner_player_ref mean in {PROFILES}?")

    assert "Scope note:" in text
    assert PROFILES in text, "the table it asked about has to be named in the caveat"
    assert "not scoped to the table you asked about" in text
    answer = "8,413 active players."
    assert answer in text, "the caveat sits above the answer, not instead of it"
    assert text.index("Scope note:") < text.index(answer), (
        "a caveat read after the figure is not a caveat"
    )


def test_the_space_is_asked_to_name_the_table_each_definition_belongs_to():
    """What makes a wrong-column answer detectable rather than silent.

    Short on purpose: every clause is more for the planning step to read, and
    that step is the cost being cut.
    """

    asked, _ = dictionary(f"What does partner_player_ref mean in {PROFILES}?")

    assert asked.endswith(tools_module.DICTIONARY_SCOPE_INSTRUCTION)
    assert len(tools_module.DICTIONARY_SCOPE_INSTRUCTION.split()) <= 10


def test_the_data_space_is_left_alone_because_there_the_table_is_the_point():
    """A figure is asked of a table. Only the dictionary is asked about a field."""

    genie = FakeGenie(MessageStatus.COMPLETED)
    question = f"How many players are in {PROFILES}?"

    result = build(genie).data_genie(question)

    assert asked_of(genie) == question
    assert "Scope note" not in result.text


def test_a_name_this_deployment_does_not_declare_is_not_ours_to_strip():
    """A bare English word after "in" is not a table.

    Guessing is how a question about spend in Europe becomes a question about
    spend, answered confidently for everywhere.
    """

    for question in (
        "What does spend mean in Europe?",
        "What does churn mean in the marketing model?",
        f"What does spend mean in {NAMESPACE}.some_undeclared_table?",
    ):
        asked, _ = dictionary(question)

        assert asked == question, question


def test_a_declared_name_that_is_the_head_of_a_longer_one_is_not_half_stripped():
    """A partial rewrite is worse than none: it leaves a name nobody wrote."""

    asked, _ = dictionary("What does partner_player_ref mean in silver_player_profiles_v2?")

    assert asked == "What does partner_player_ref mean in silver_player_profiles_v2?"


def test_a_question_that_is_only_a_table_reference_is_sent_as_the_model_wrote_it():
    """There is no field in it to fall back to, so the rewrite would make nonsense."""

    asked, text = dictionary(f"in {PROFILES}")

    assert asked == f"in {PROFILES}"
    assert "Scope note" not in text


def test_the_dictionary_reads_its_result_on_the_enumeration_budget():
    """Its answers are lists of definitions, and the list is the answer."""

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=f"SELECT column_name, data_type FROM {ACTIVITY}",
        columns=["column_name", "data_type"],
        rows=narrow_rows(1_200),
    )

    text = build(genie).dictionary_genie("What columns are defined?").text

    assert "column_1199 | string" in text, "the whole listing, not the first fifty"
    assert "SAMPLE" not in text


def test_genie_sql_is_attributed_by_the_same_parse_and_never_from_a_literal():
    """The Genie path had no validation step, so attribution was its only check."""

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=f"SELECT 'from {SECRET}' AS note, count(*) FROM {ACTIVITY}",
    )

    result = build(genie).data_genie("q")

    assert result.sources == [ACTIVITY]
    assert result.attributed is True


def test_genie_sql_that_cannot_be_parsed_contributes_nothing_at_all():
    """The judgement this reverses, and why.

    It used to come back with an empty source list, `attributed` false, and a
    note saying the sources were incomplete. That was better than silence and it
    was not a control: Genie's prose STATES the figures ("8,413 active players"),
    so a reader told the sources are incomplete still reads the number, and the
    number is not checkable by the person it is shown to.

    So an unparseable statement now admits nothing, including the wording, and
    the refusal is raised rather than returned so it takes the loop's governance
    path rather than its outage path.
    """

    genie = FakeGenie(MessageStatus.COMPLETED, sql="SELECT FROM WHERE )(")

    with pytest.raises(SqlRefused) as refused:
        build(genie).data_genie("q")

    assert getattr(refused.value, "code", "") == failures.GENIE_UNATTRIBUTABLE
    assert "8,413" not in str(refused.value), "the figure must not survive in the refusal"


def test_a_query_attachment_that_exposed_no_sql_is_not_evidence():
    """F3. An attachment can run something and not show what it ran.

    A `query` object whose `query` is empty or absent used to contribute no
    source while leaving `attributed` true, because the code only reached the
    failure branch when there was non-empty SQL to fail on. It is now the same
    finding as an unparseable statement: something ran and nothing says what.
    """

    for exposed in ("", None):
        genie = FakeGenie(
            MessageStatus.COMPLETED,
            attachments=[attachment(sql=exposed, text="8,413 active players.")],
        )

        with pytest.raises(SqlRefused) as refused:
            build(genie).data_genie("q")

        assert getattr(refused.value, "code", "") == failures.GENIE_UNATTRIBUTABLE, (
            f"query attachment with query={exposed!r}"
        )


def test_sql_that_parses_but_names_no_table_is_not_evidence():
    """The third silent path: it parsed, so no failure, and it resolved nothing."""

    genie = FakeGenie(MessageStatus.COMPLETED, sql="SELECT 1")

    with pytest.raises(SqlRefused) as refused:
        build(genie).data_genie("q")

    assert getattr(refused.value, "code", "") == failures.GENIE_UNATTRIBUTABLE


def test_the_proven_case_one_attachment_of_two_exposes_its_sql():
    """F3's dangerous case, and the reason a short list is worse than none.

    Two attachments, one of which shows its SQL. The answer then cites ONE source
    with `attributed` still true, so `sources_complete` stays true, no
    incompleteness caveat fires, and the Sources block a stakeholder reads is a
    complete-looking account of a strict subset of what was touched.
    """

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        attachments=[
            attachment(sql=f"SELECT count(*) FROM {ACTIVITY}", text="8,413 active players."),
            attachment(sql="", text="Of those, 1,204 are email-addressable."),
        ],
    )

    result = build(genie).data_genie("q")

    assert result.sources == [ACTIVITY], "what it could resolve is still reported"
    assert result.attributed is False, "but it must not read as the whole account"
    assert "part of this answer" in result.text
    assert "8,413" in result.text, "the attributed half is evidence and survives"
    assert "1,204" not in result.text, (
        "the unattributed half is withheld, not caveated: its figure is stated in its own "
        "prose, so keeping the sentence keeps the number a reader cannot trace"
    )


def test_figures_with_no_source_behind_them_are_refused_not_flagged():
    """A charted answer carries no SQL of its own, so nothing can attribute it.

    Visualization-only output is the case the plan names outright, and it is the
    clearest illustration of why the caveat was not enough: the chart is a
    picture of a result the guard never saw, and the sentence beside it states
    the figure anyway.
    """

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        attachments=[attachment(text="8,413 active players.", viz=SimpleNamespace(type="bar"))],
    )

    with pytest.raises(SqlRefused) as refused:
        build(genie).data_genie("q")

    assert getattr(refused.value, "code", "") == failures.GENIE_UNATTRIBUTABLE
    assert "8,413" not in str(refused.value)


def test_an_answer_with_no_query_at_all_is_still_attributed():
    """The other direction. The dictionary space answers from metadata and reads
    no table, and a run-level caveat already covers a run that read nothing, so
    flagging this as incomplete would cry wolf on every definitional question.
    """

    genie = FakeGenie(MessageStatus.COMPLETED, attachments=[attachment(text="A definition.")])

    result = build(genie).dictionary_genie("what is an active player")

    assert result.sources == []
    assert result.attributed is True
    assert "incomplete" not in result.text


# ---------------------------------------------------------------------------
# The Genie column guard
#
# Genie's SQL is parsed for ATTRIBUTION, and the column policy `run_sql` and
# `query_named_table` enforce has to apply on this path too. Asking the data
# space in prose for the highest email address composes `SELECT MAX(email)`,
# which returns a real address if nothing here refuses it.
# ---------------------------------------------------------------------------

#: The statement the live data space actually composed and ran, with only its
#: namespace moved onto this file's fictional one. Everything the guard reads (
#: the aggregate, the column, the backquoting, the WHERE) is as Genie wrote it.
LIVE_MAX_EMAIL = (
    "SELECT MAX(`email`) AS max_email FROM "
    "`test_catalog`.`test_schema`.`silver_player_profiles` "
    "WHERE `email` IS NOT NULL"
)


def test_genie_may_not_return_an_identifier_the_sql_path_would_refuse():
    """The hole: prose to the data space reached what `run_sql` refuses.

    Asserted against the SAME guard rather than against a copied expectation, so
    that the two paths cannot drift into two policies: whatever `validate_sql`
    refuses to return, this refuses to return.
    """

    with pytest.raises(SqlRefused):
        tools_module.validate_sql(LIVE_MAX_EMAIL, MANIFEST)

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        attachments=[
            attachment(
                sql=LIVE_MAX_EMAIL,
                text="The maximum email value is **player.00011999@example.test**.",
            )
        ],
    )

    with pytest.raises(SqlRefused) as refusal:
        build(genie).data_genie("give me the highest email address")

    assert "email" in str(refusal.value)


def test_the_refused_genie_answer_never_becomes_text():
    """The refusal has to happen before the address is in a string.

    Genie has already run the query by the time the tool sees it, so the value is
    sitting in the attachment text. Refusing has to mean the tool returns nothing:
    a `ToolResult` carrying the address alongside a refusal note would still
    put it in the evidence log, the synthesis prompt, and a trace stage that is
    persisted.
    """

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        attachments=[
            attachment(
                sql=LIVE_MAX_EMAIL,
                text="The maximum email value is **player.00011999@example.test**.",
            )
        ],
    )

    with pytest.raises(SqlRefused) as refusal:
        build(genie).data_genie("give me the highest email address")

    assert "player.00011999@example.test" not in str(refusal.value)


def test_a_cross_label_bridge_through_genie_is_refused():
    """The signature governed behaviour, asked in prose instead of in SQL."""

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        attachments=[
            attachment(
                sql=(
                    f"SELECT count(*) FROM {PROFILES} p JOIN {ACTIVITY} a "
                    "ON p.crm_customer_ref = a.crm_customer_ref"
                ),
                text="1,204 players appear under both labels.",
            )
        ],
    )

    with pytest.raises(SqlRefused) as refusal:
        build(genie).data_genie("which players appear under both labels")

    assert "crm_customer_ref" in str(refusal.value)


def test_the_data_genie_tool_description_names_the_space_when_titled():
    from tools import data_genie_tool, dictionary_genie_tool

    data = data_genie_tool("Player Insights Data")["function"]["description"]
    assert '"Player Insights Data"' in data
    assert "ASK FOR A TABLE" in data

    dictionary = dictionary_genie_tool("Player Insights Dictionary")["function"]["description"]
    assert '"Player Insights Dictionary"' in dictionary
    assert "metadata only" in dictionary

    untitled = data_genie_tool()["function"]["description"]
    assert 'Ask the curated Genie Space that holds' in untitled


def test_a_genie_result_preamble_names_the_space():
    """The tool result opens with which space answered, so a trace can say so."""

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=f"SELECT title_name FROM {ACTIVITY}",
        text="VLHO leads.",
    )
    tools = build(genie)
    tools.settings = dataclasses.replace(
        tools.settings, data_genie_space_title="Player Insights Data"
    )

    result = tools.data_genie("active players by title")

    assert result.text.startswith('Asking Genie space Player Insights Data (data).')
    assert "VLHO leads." in result.text


def test_an_ordinary_analytical_question_still_returns_results():
    """The regression that would matter tomorrow, in both Genie shapes."""

    for sql in (
        f"SELECT title_name, count(DISTINCT platformid_accountid) FROM {ACTIVITY} "
        "GROUP BY title_name",
        f"SELECT sum(net_bookings_usd) FROM {PROFILES}",
    ):
        genie = FakeGenie(MessageStatus.COMPLETED, sql=sql)

        result = build(genie).data_genie("active players by title")

        assert "8,413" in result.text
        assert result.attributed is True


def test_counting_a_restricted_column_through_genie_is_still_allowed():
    """`count(DISTINCT platformid_accountid)` is what the product is FOR.

    A guard that refused the aggregate this agent exists to run would be worse
    than the hole it closes.
    """

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=f"SELECT count(DISTINCT platformid_accountid) AS players FROM {ACTIVITY}",
    )

    result = build(genie).data_genie("how many distinct players")

    assert result.sources == [ACTIVITY]
    assert result.attributed is True


def test_a_null_ratio_through_genie_is_still_allowed():
    """The load-bearing second path: a restricted column collapsed to a boolean."""

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=(
            f"SELECT sum(CASE WHEN email IS NULL THEN 1 ELSE 0 END) AS missing FROM {PROFILES}"
        ),
    )

    result = build(genie).data_genie("how many players have no email")

    assert result.sources == [PROFILES]
    assert result.attributed is True


def test_the_dictionary_space_is_not_caught_by_a_control_meant_for_tables():
    """It reads no table by design, so there is no SQL to check and nothing to refuse.

    A definitional answer that mentions a restricted column BY NAME is the case
    that would break: "email is the player's contact address" names `email` and
    returns no value of it.
    """

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        attachments=[
            attachment(
                text=(
                    "email is the player's contact address. crm_customer_ref is the "
                    "cross-label key and its permitted use is identity_use_scope."
                )
            )
        ],
    )

    result = build(genie).dictionary_genie("what do email and crm_customer_ref mean")

    assert "contact address" in result.text
    assert result.attributed is True


def test_a_charted_answer_no_longer_passes_just_because_a_chart_is_useful():
    """The judgement call this reverses, stated so the cost is on the record.

    The previous rule allowed it: refusing every absent or unparseable statement
    is a demo-visible regression, because it takes out every charted answer, and
    the exposure was disclosed rather than hidden. What that reasoning missed is
    that a caveat is not a control. The chart is a picture of a result no guard
    saw, the sentence beside it states the figure, and the reader cannot check
    either one.

    So the cost is accepted knowingly: a data space that answers with a chart
    and no query attachment now returns nothing, and the model is told to ask
    for a table instead. If that proves too blunt in the demo, the fix is a
    governed metric that can attribute the chart, NOT restoring the caveat.
    """

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        attachments=[attachment(text="8,413 active players.", viz=SimpleNamespace(type="bar"))],
    )

    with pytest.raises(SqlRefused) as refused:
        build(genie).data_genie("chart active players by title")

    assert "FOR A TABLE" in str(refused.value), "the model needs the next step, not just a no"


def test_sql_the_guard_cannot_parse_is_refused_rather_than_declared_incomplete():
    """The second half of the same reversal.

    The old reasoning: refusing would reject legitimate Databricks syntax
    `sqlglot` does not model, on a path where the query has ALREADY RUN, and buy
    nothing against an attacker who cannot choose Genie's SQL anyway.

    Two of those three still hold. The one that does not is the conclusion: the
    threat was never only an attacker. An unparseable statement is an
    UNINSPECTED statement, so the column policy did not run on it either, which
    is how `SELECT MAX(email)` reaches a screen without anyone choosing it. The
    figures were the disclosure risk all along.
    """

    genie = FakeGenie(MessageStatus.COMPLETED, sql="SELECT FROM WHERE )(")

    with pytest.raises(SqlRefused) as refused:
        build(genie).data_genie("q")

    assert getattr(refused.value, "code", "") == failures.GENIE_UNATTRIBUTABLE


def test_select_star_through_genie_is_now_closed_by_the_fetched_result_schema():
    """The hole the previous version of this test was written to outlive.

    The static parse still cannot expand a star: that half is unchanged and is
    asserted below so nobody reads the closure as coming from the parse. What
    changed is that the rows are now fetched, and the fetch carries the result
    schema the Genie message never had, so `restricted_output_columns` gets the
    same authoritative answer it gets on the SQL path.
    """

    starred = tools_module.inspect_generated_sql(f"SELECT * FROM {PROFILES} LIMIT 10")
    assert starred == [PROFILES], (
        "unchanged: a star is not expandable without the schema, so the parse lets it by"
    )

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=f"SELECT * FROM {PROFILES} LIMIT 10",
        columns=["player_id", "email", "country"],
        rows=[["p1", "player.00011999@example.test", "US"]],
    )

    with pytest.raises(SqlRefused, match="email"):
        build(genie).data_genie("show me the player table")


def test_the_unfetchable_star_gap_is_closed_by_refusing_the_parse_failure():
    """The gap this test used to pin, and no longer can.

    It recorded a real hole: when the row fetch failed there was no result schema,
    so an unparseable or starred statement was inspected by nothing, and Genie's
    prose came back with a live address stated inline in it. The address was in
    the return value of a governed tool, and the only thing standing between it
    and a screen was the model's willingness to repeat what it was handed.

    Refusing unparseable SQL closes it, and closes it EARLIER than the fetch: the
    refusal happens before the rows are requested, so the fetch outcome cannot
    matter. Kept as a regression test rather than deleted, because "the fetch
    failed" is exactly the path a future change is most likely to reopen while
    looking like an error-handling improvement.
    """

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql="SELECT * FROM WHERE )(",
        text="the maximum email value is player.00011999@example.test",
        result_error=RuntimeError("result expired"),
    )

    with pytest.raises(SqlRefused) as refused:
        build(genie).data_genie("give me the highest email address")

    assert "player.00011999@example.test" not in str(refused.value), "the gap, now closed"
    assert getattr(refused.value, "code", "") == failures.GENIE_UNATTRIBUTABLE


# ---------------------------------------------------------------------------
# Reading Genie's result ROWS
#
# Genie states its findings in prose, and prose is not a result set. The failure
# has no error in it: the model charts figures it never saw.
# ---------------------------------------------------------------------------


def test_genie_result_rows_are_put_in_front_of_the_model():
    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=f"SELECT title_name, count(*) AS players FROM {ACTIVITY} GROUP BY title_name",
        columns=["title_name", "players"],
        rows=[["VLHO", "5120"], ["HOOPS26", "3293"]],
        attachments=[
            attachment(
                sql=f"SELECT title_name, count(*) AS players FROM {ACTIVITY} GROUP BY title_name",
                text="VLHO leads.",
                attachment_id="att-1",
            )
        ],
    )

    result = build(genie).data_genie("players by title")

    assert "title_name | players" in result.text
    assert "VLHO | 5120" in result.text
    assert "HOOPS26 | 3293" in result.text
    assert genie.result_fetches == [("data", "c1", "m1", "att-1")], (
        "the fetch is addressed to this space, conversation, message and attachment"
    )


def test_a_truncated_genie_result_says_how_many_of_how_many_it_showed():
    """The disclosure that stops a partial figure being reported as a total."""

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=f"SELECT title_name, spend FROM {ACTIVITY}",
        columns=["title_name", "spend"],
        rows=wide_rows(800),
        chunk_size=100,
    )

    text = build(genie).data_genie("spend by title").text

    assert f"has 800 row(s) and {MAX_SQL_ROWS} of them are shown" in text
    assert f"{800 - MAX_SQL_ROWS} are not" in text
    assert "partial" in text


def test_genies_own_truncation_is_disclosed_separately_from_ours():
    """Two independent caps. Saying only ours presents a trimmed set as the whole."""

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=f"SELECT title_name FROM {ACTIVITY}",
        columns=["title_name"],
        rows=[["VLHO"]],
        is_truncated=True,
    )

    text = build(genie).data_genie("every title").text

    assert "Genie truncated this result set" in text
    assert "not the full population" in text


def test_both_truncations_are_disclosed_when_both_happened():
    """Two independent facts, and neither one implies the other.

    "50 of 800" says our cap cut what Genie returned. "800 was already trimmed"
    says 800 was never the population. A reader given only the first believes
    the second number is the whole, which is the failure the separate note
    exists to prevent, so widening our own bound must not collapse them into
    one sentence.
    """

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=f"SELECT title_name, spend FROM {ACTIVITY}",
        columns=["title_name", "spend"],
        rows=wide_rows(800),
        chunk_size=100,
        is_truncated=True,
    )

    text = build(genie).data_genie("spend by title").text

    assert f"has 800 row(s) and {MAX_SQL_ROWS} of them are shown" in text
    assert "Genie truncated this result set" in text
    assert text.index("of them are shown") < text.index("Genie truncated"), (
        "ours describes the rows above it; Genie's qualifies the count in ours"
    )


def test_a_paged_genie_result_is_not_read_as_a_complete_one():
    """The same paging the SQL path does, through the same helper.

    A Genie statement id is an ordinary Statement Execution id, so the following
    chunks arrive the same way. Reading only `data_array` would under-report the
    result exactly as it did on the SQL path.
    """

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=f"SELECT label, n FROM {ACTIVITY}",
        columns=["label", "n"],
        rows=wide_rows(MAX_SQL_ROWS + 25),
        chunk_size=10,
    )

    text = build(genie).data_genie("q").text

    assert genie.result.chunks_fetched, "the following chunks have to be fetched"
    assert f"has {MAX_SQL_ROWS + 25} row(s)" in text


def test_a_running_genie_statement_is_reported_as_running_rather_than_failed():
    """The mistake the SQL path already made once, kept out of the second path.

    RUNNING is not FAILED, and the model is instructed to relay a failure rather
    than work around it, so calling a slow statement failed turns it into a
    wrong answer about the data.
    """

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=f"SELECT count(*) FROM {ACTIVITY}",
        result_state="RUNNING",
    )

    text = build(genie).data_genie("q").text

    assert "still running rather than failed" in text
    assert "rows were not read" in text


def test_a_refused_statement_never_has_its_rows_fetched():
    """Fetching rows must not become the way around the policy the SQL failed.

    The refusal raises out of the whole Genie call, so there is nothing left to
    read, asserted on the fetch itself rather than on the text, because a text
    assertion would pass just as well if the rows were fetched and then dropped.
    """

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=f"SELECT email FROM {PROFILES}",
    )

    with pytest.raises(SqlRefused):
        build(genie).data_genie("give me the email addresses")

    assert genie.result_fetches == [], "the rows of a refused statement are never read"


def test_a_failed_row_fetch_is_disclosed_rather_than_falling_back_to_prose():
    """Silence here is the original defect: a less grounded answer, no error."""

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=f"SELECT count(*) FROM {ACTIVITY}",
        result_error=RuntimeError("the result has expired"),
    )

    text = build(genie).data_genie("q").text

    assert "8,413" in text, "Genie's prose is still worth returning"
    assert "rows could not be read" in text
    assert "the result has expired" in text


def test_an_sdk_without_the_query_result_method_says_so():
    """Degrading quietly on an older SDK build would hide the whole feature."""

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        sql=f"SELECT count(*) FROM {ACTIVITY}",
        has_result_api=False,
    )

    text = build(genie).data_genie("q").text

    assert "cannot fetch its rows" in text
    assert "Genie's prose rather than a result set" in text


def test_a_text_only_answer_fetches_no_rows():
    """No query attachment, nothing to fetch, and no note about it either."""

    genie = FakeGenie(
        MessageStatus.COMPLETED,
        attachments=[attachment(text="An active player is one with a session in 30 days.")],
    )

    result = build(genie).dictionary_genie("what is an active player")

    assert genie.result_fetches == []
    assert "Query result" not in result.text


def test_ranking_players_is_refused_through_genie_exactly_as_it_is_through_sql():
    """The behaviour CHANGE a reviewer has to sign off, not a bug.

    "Top spenders" is a plausible thing to ask a player-insights agent, and the
    SQL Genie writes for it projects `platformid_accountid`, an identifier. The
    SQL path already refuses that and has since the column work landed; the Genie
    path did not, so this question is answerable through Genie today and is not
    answerable after this change.

    Both paths are asserted together deliberately. The risk being managed is not
    that the guard is wrong: it is that it is RIGHT and nobody realised the
    product's behaviour moves with it.
    """

    ranking = (
        f"SELECT platformid_accountid, sum(net_bookings_usd) AS spend FROM {PROFILES} "
        "GROUP BY platformid_accountid ORDER BY spend DESC LIMIT 10"
    )

    with pytest.raises(SqlRefused):
        validate_sql(ranking, MANIFEST)
    with pytest.raises(SqlRefused):
        tools_module.inspect_generated_sql(ranking)


def test_genie_cannot_widen_the_logged_manifest_after_release():
    """A live space edit cannot silently widen a released model.

    `readable_tables` is the reviewed manifest baked at LOG time. Genie spaces
    remain editable after that moment, so an attachment over a newly added table
    must contribute no prose, rows, SQL, or source until a new model version
    declares it.
    """

    outside = FakeGenie(
        MessageStatus.COMPLETED, sql=f"SELECT count(*) FROM {SECRET}"
    )

    with pytest.raises(tools_module.EvidenceRefused) as refusal:
        build(outside).data_genie("q")

    assert refusal.value.verdicts[0].code == tools_module.failures.ASSET_NOT_IN_MANIFEST
    assert outside.result_fetches == [], "an off-manifest attachment must never fetch rows"
    with pytest.raises(SqlRefused):
        tools_module.validate_sql(f"SELECT count(*) FROM {SECRET}", MANIFEST)


# ---------------------------------------------------------------------------
# A statement that is still running has not failed
# ---------------------------------------------------------------------------


def test_a_slow_statement_is_cancelled_and_reported_as_slow_rather_than_failed():
    """`SQL RUNNING: statement failed` was a lie the model was told to act on.

    The model is instructed to report a failure rather than route around it, so a
    query that was merely slow became an answer about the data being unavailable.
    """

    warehouse = FakeWarehouse(["n"], [], state="CANCELED")

    with pytest.raises(RuntimeError) as failure:
        build(warehouse).query_named_table(f"SELECT count(*) AS n FROM {ACTIVITY}")

    assert "did not fail" in str(failure.value)
    assert "narrow it" in str(failure.value)


def test_the_statement_is_cancelled_at_the_wait_timeout_rather_than_left_running():
    warehouse = FakeWarehouse(["n"], [["1"]])

    build(warehouse).query_named_table(f"SELECT count(*) AS n FROM {ACTIVITY}")

    assert warehouse.wait_timeouts == [
        (tools_module.SQL_WAIT_TIMEOUT, ExecuteStatementRequestOnWaitTimeout.CANCEL)
    ]


def test_a_paged_result_is_not_read_as_a_complete_one():
    """`result.data_array` is the first chunk. The row count came from it.

    Same shape as the bug where the first page of anything is treated as all of
    it: the summary under-reports how much was found.
    """

    warehouse = FakeWarehouse(["label", "n"], wide_rows(MAX_SQL_ROWS + 25), chunk_size=10)

    text = build(warehouse).query_named_table(f"SELECT * FROM {ACTIVITY}").text

    assert f"has {MAX_SQL_ROWS + 25} row(s) and {MAX_SQL_ROWS} of them are shown" in text
    assert warehouse.chunks_fetched, "the following chunks have to be fetched"


def test_paging_stops_at_the_rendering_ceiling_rather_than_draining_the_result():
    """The count comes from the manifest, so stopping early keeps it honest.

    Narrow rows, so it is the ROW ceiling doing the stopping rather than the
    character budget: both bounds have to hold paging back, or a result made of
    very short rows walks a warehouse result set nobody will be shown.
    """

    available = tools_module.SAMPLE_BUDGET.max_rows * 4
    warehouse = FakeWarehouse(
        ["label", "n"], narrow_rows(available), chunk_size=100, total_row_count=100_000
    )

    text = build(warehouse).query_named_table(f"SELECT * FROM {ACTIVITY}").text

    assert "has 100000 row(s) and" in text, "the manifest's total, not the rows in hand"
    fetched = (len(warehouse.chunks_fetched) + 1) * 100
    assert fetched < available, "it should not walk a result nobody will be shown"


def test_a_result_of_tiny_rows_is_bounded_by_the_row_ceiling_not_only_the_characters():
    """The second bound, and why there are two.

    A character budget on its own is spent on separators when the rows are one
    value wide, so a degenerate result could put tens of thousands of lines in
    front of the model and still be inside its budget.
    """

    ceiling = tools_module.SAMPLE_BUDGET.max_rows
    rows = [["x"] for _ in range(ceiling * 3)]

    text = tools_module.render_rows(["v"], rows, len(rows))

    assert len(text.splitlines()) == ceiling + 2, "header, the ceiling in rows, the note"
    assert f"has {ceiling * 3} row(s) and {ceiling} of them are shown" in text


# ---------------------------------------------------------------------------
# What the tools say a table is FOR
#
# Nothing, now, and that is the property under test. The agent used to carry a
# medallion classifier (gold_/silver_/raw_ prefixes, plus the literal names
# data_dictionary and validation_results) and a set of per-source disclosures
# keyed on two of our gold table names. Both described OUR synthetic demo
# schema, and both fired on any deployment whose table names happened to look
# similar: a customer table called `purchase_orders` drew a caveat about a
# 180-day rollup and a `brand_scope_status` column its schema has not got.
#
# These tests pin the absence, because the failure they guard is someone
# reintroducing a helpful-sounding default. What a table is for is a property of
# the deployment's own schema, so it has to be established from describe_table
# and dictionary_genie at runtime rather than asserted from a name.
# ---------------------------------------------------------------------------


STACK = (
    f"{NAMESPACE}.gold_player_180d_summary",
    f"{NAMESPACE}.silver_purchases",
    f"{NAMESPACE}.raw_purchases",
    f"{NAMESPACE}.raw_player_profiles",
    f"{NAMESPACE}.data_dictionary",
    f"{NAMESPACE}.validation_results",
)

#: Phrasing from the removed classifier and disclosures. Asserted as absent by
#: substring rather than by symbol, so that reintroducing the guidance under a
#: new name still fails.
REMOVED_GUIDANCE = (
    "PUBLISHED ROLLUPS",
    "CURATED DETAIL",
    "RAW INGEST",
    "OPERATIONAL",
    "prefer for totals and rankings",
    "cite the curated one",
    "NEVER a source for a question about players",
    "trailing 180 days",
    "refunds are netted",
    "brand_scope_status",
    "CROSS_LABEL_BLOCK",
)


def test_the_listing_names_the_declared_tables_and_says_nothing_about_their_use():
    """Every declared name, in one flat list, with no claim about any of them."""

    tools = build(manifest=STACK)

    listed = tools.list_data_assets("test_catalog", "test_schema").text

    for table in STACK:
        assert table in listed, f"{table} is declared and must be offered"
    for phrase in REMOVED_GUIDANCE:
        assert phrase not in listed, f"the listing still asserts {phrase!r}"
    assert "Call describe_table" in listed, "discovery is how the model establishes use"


def test_describing_a_table_returns_its_columns_and_asserts_no_role():
    """A description is what the deployment's own metadata says, and no more."""

    warehouse = FakeWarehouse(["col_name", "data_type", "comment"], DESCRIBE_ROWS)
    tools = build(warehouse, manifest=STACK)

    for table in (
        f"{NAMESPACE}.raw_purchases",
        f"{NAMESPACE}.gold_player_180d_summary",
        f"{NAMESPACE}.silver_purchases",
        f"{NAMESPACE}.validation_results",
    ):
        described = tools.describe_table(table).text
        assert described.splitlines()[0] == table
        for phrase in REMOVED_GUIDANCE:
            assert phrase not in described, f"describing {table} still asserts {phrase!r}"


def test_a_customer_table_whose_name_resembles_ours_draws_no_inherited_claim():
    """The failure that condemned the disclosures, pinned from the customer side.

    `purchase_orders` and `gold_standard_suppliers` share a substring with our
    demo tables and nothing else. Under the old markers they collected a caveat
    about refund treatment, a 180-day window, and a column their schema does not
    have, asserted with the same confidence as the figure beside it.
    """

    theirs = (
        "their_catalog.their_schema.purchase_orders",
        "their_catalog.their_schema.gold_standard_suppliers",
        "their_catalog.their_schema.activity_log",
    )
    tools = build(manifest=theirs)

    listed = tools.list_data_assets("their_catalog", "their_schema").text

    for table in theirs:
        assert table in listed
    for phrase in REMOVED_GUIDANCE:
        assert phrase not in listed, f"a customer listing still asserts {phrase!r}"


# ---------------------------------------------------------------------------
# The schemas the model reads
# ---------------------------------------------------------------------------


def test_the_tool_schemas_are_shaped_the_way_the_endpoint_expects():
    for tool in (
        LIST_DATA_ASSETS_TOOL,
        RESOLVE_TABLE_TOOL,
        DESCRIBE_TABLE_TOOL,
        QUERY_NAMED_TABLE_TOOL,
    ):
        assert tool["type"] == "function"
        function = tool["function"]
        assert function["name"] and function["description"]
        assert function["parameters"]["type"] == "object"
        for name, spec in function["parameters"]["properties"].items():
            assert spec["description"], f"{function['name']}.{name} needs a description"


def test_the_descriptions_teach_the_routing_the_tools_enforce():
    """The model learns the three paths here or not at all.

    Each of these phrases corresponds to a refusal above. If a description stops
    saying it, the tool still refuses but the model has no way to know why.
    """

    describe = DESCRIBE_TABLE_TOOL["function"]["description"]
    # A half-named table is a LOOKUP now, not a question for the user, so this is
    # where the model learns to reach for the resolver before the clarification.
    assert "resolve_table" in describe
    # And the filter is only worth having if the model knows a zero is an answer.
    assert "definitive" in describe
    assert "columns" in DESCRIBE_TABLE_TOOL["function"]["parameters"]["properties"]
    resolve = RESOLVE_TABLE_TOOL["function"]["description"]
    assert "AMBIGUOUS" in resolve and "request_clarification" in resolve
    assert "declared" in LIST_DATA_ASSETS_TOOL["function"]["description"]
    query = QUERY_NAMED_TABLE_TOOL["function"]["description"]
    assert "catalog.schema.table" in query
    assert "read-only" in query.lower()


def test_listing_takes_optional_arguments_so_the_first_call_needs_nothing():
    """The schema permits a no-argument call, and the tool answers one.

    The schema half alone was not worth much: it says the model is allowed to
    emit `"{}"` here, and said nothing about what happens when it does. What
    happened was that the empty argument object was indistinguishable from
    unparseable JSON, so the call ran and was then reported to the model as
    having failed to parse. That is asserted at the loop, in
    `test_a_tool_that_takes_no_arguments_is_not_reported_as_having_failed_to_parse`;
    this end pins that the tool itself needs nothing.
    """

    assert LIST_DATA_ASSETS_TOOL["function"]["parameters"].get("required", []) == []
    assert set(LIST_DATA_ASSETS_TOOL["function"]["parameters"]["properties"]) == {
        "catalog",
        "schema",
    }

    listed = build().list_data_assets()
    assert listed.text.strip()
    assert "test_catalog" in listed.text
