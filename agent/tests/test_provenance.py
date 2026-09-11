"""That the four provenance facts come from the query, and stop where they should.

Three things are being pinned here, and only the first is about features.

1. The facts are DERIVED. Every assertion below hands in SQL and reads back a
   window or a filter that is in it. None of them go anywhere near the model, and
   the answer-level test at the bottom checks the field survives assembly.

2. IT FAILS CLOSED. A statement that will not parse, a table that cannot be
   resolved, a query with no WHERE clause: each of those produces an EMPTY field
   or no entry at all, never a plausible one. A wrong window is a specific,
   checkable claim about the population behind a number, and a reader cannot tell
   a derived one from an invented one.

3. NO PLAYER KEY IS PUBLISHED. `filter` is the one field built from literals a
   question can put there, so the withholding rule gets its own section, with the
   over-withholding case (`title_name`) pinned in the other direction: a filter
   that says "something was filtered" occupies the space where the fact belongs.
"""

from __future__ import annotations

import provenance
from tests.test_agent import Call, FakeTools, ScriptedLlm, ask, build
from tools import ToolResult

ACTIVITY = "test_catalog.test_schema.gold_player_activity_daily"


def one(sql: str) -> dict[str, str]:
    """The single derivation for one statement, or a fixture-level failure."""

    derived = provenance.derivations([sql])
    assert len(derived) == 1, f"expected one derivation, got {derived}"
    return derived[0]


# ---------------------------------------------------------------------------
# The four facts
# ---------------------------------------------------------------------------


def test_the_source_is_the_table_the_statement_read():
    entry = one(f"SELECT count(*) AS rows_seen FROM {ACTIVITY}")
    assert entry["source"] == ACTIVITY


def test_the_metric_is_the_alias_the_query_gave_it():
    """The query already named its number better than the aggregate does."""

    entry = one(
        f"SELECT count(DISTINCT platformid_accountid) AS active_players FROM {ACTIVITY}"
    )
    assert entry["metric"] == "active_players"


def test_an_unaliased_aggregate_is_named_by_what_it_computes():
    entry = one(f"SELECT count(DISTINCT platformid_accountid) FROM {ACTIVITY}")
    assert entry["metric"] == "count(distinct platformid_accountid)"


def test_plain_columns_are_not_reported_as_metrics():
    """A row listing is not a measure, and labelling it one is a false label."""

    entry = one(f"SELECT title_name, profile_label FROM {ACTIVITY}")
    assert entry["metric"] == ""


def test_several_measures_are_listed_and_the_rest_counted():
    entry = one(
        "SELECT count(*) AS a, sum(sessions) AS b, avg(minutes) AS c, max(day) AS d "
        f"FROM {ACTIVITY}"
    )
    assert entry["metric"] == "a, b, c, +1"


def test_a_two_sided_date_range_reads_as_one_window():
    """Two one-sided comparisons on one column are one fact, not two."""

    entry = one(
        f"SELECT count(*) AS c FROM {ACTIVITY} "
        "WHERE activity_date >= '2025-06-01' AND activity_date < '2025-07-01'"
    )
    assert entry["window"] == "'2025-06-01' → '2025-07-01'"


def test_a_one_sided_bound_says_so_rather_than_inventing_the_other_end():
    entry = one(f"SELECT count(*) AS c FROM {ACTIVITY} WHERE activity_date >= '2025-06-01'")
    assert entry["window"] == "≥ '2025-06-01'"


def test_a_relative_window_is_reported_as_the_expression_that_ran():
    """A rolling window is the common real case and has no literal dates in it."""

    entry = one(
        f"SELECT count(*) AS c FROM {ACTIVITY} "
        "WHERE activity_date >= current_date() - INTERVAL 30 DAYS"
    )
    assert "30" in entry["window"] and "current_date" in entry["window"]


def test_a_between_is_a_window_and_keeps_both_ends():
    entry = one(
        f"SELECT count(*) AS c FROM {ACTIVITY} "
        "WHERE event_day BETWEEN '2025-01-01' AND '2025-03-31'"
    )
    assert entry["window"] == "'2025-01-01' → '2025-03-31'"


def test_a_query_with_no_predicates_has_no_window_and_no_filter():
    """Empty, and not "all time": nothing here checked what the table holds."""

    entry = one(f"SELECT count(*) AS c FROM {ACTIVITY}")
    assert entry["window"] == ""
    assert entry["filter"] == ""


def test_the_filter_is_what_narrowed_the_rows():
    entry = one(f"SELECT count(*) AS c FROM {ACTIVITY} WHERE title_name = 'IFR2'")
    assert entry["filter"] == "title_name = 'rdr2'"


def test_the_window_and_the_filter_are_separated():
    """One WHERE clause, two facts, because they answer different questions."""

    entry = one(
        f"SELECT count(*) AS c FROM {ACTIVITY} "
        "WHERE activity_date >= '2025-06-01' AND platform = 'pc'"
    )
    assert entry["window"] == "≥ '2025-06-01'"
    assert entry["filter"] == "platform = 'pc'"


def test_a_long_in_list_names_a_few_values_and_counts_the_rest():
    entry = one(
        f"SELECT count(*) AS c FROM {ACTIVITY} "
        "WHERE region IN ('emea', 'apac', 'latam', 'na', 'anz')"
    )
    assert entry["filter"] == "region in ('emea', 'apac', 'latam', +2)"


# ---------------------------------------------------------------------------
# Withholding: the column is named, the player is not
# ---------------------------------------------------------------------------


def test_a_player_key_in_a_filter_is_named_without_its_value():
    """The population was narrowed to one player. Which player is not published."""

    entry = one(
        f"SELECT count(*) AS c FROM {ACTIVITY} WHERE platformid_accountid = 'abc-123'"
    )
    assert "abc-123" not in entry["filter"]
    assert entry["filter"] == f"platformid_accountid = {provenance.WITHHELD}"


def test_an_address_in_a_filter_is_withheld_too():
    entry = one(f"SELECT count(*) AS c FROM {ACTIVITY} WHERE email = 'ada@example.test'")
    assert "ada@example.test" not in entry["filter"]
    assert provenance.WITHHELD in entry["filter"]


def test_a_withheld_predicate_is_still_reported_rather_than_dropped():
    """A filter that vanished would report a narrowed population as the whole one."""

    entry = one(
        f"SELECT count(*) AS c FROM {ACTIVITY} "
        "WHERE player_id = 'p-1' AND title_name = 'IFR2'"
    )
    assert entry["filter"].count(provenance.WITHHELD) == 1
    assert "title_name = 'rdr2'" in entry["filter"]


def test_an_identifying_column_may_still_be_counted_by_name():
    """The guardrail is about values. A cardinality is the product working."""

    entry = one(
        f"SELECT count(DISTINCT platformid_accountid) AS players FROM {ACTIVITY}"
    )
    assert entry["metric"] == "players"


def test_an_ordinary_name_column_is_not_withheld():
    """The over-withholding direction, pinned.

    A rule blanketing `_name` or `_id` would blank the single most useful thing a
    filter can say. "A filter was applied" is worse than an empty field: it takes
    up the space where the fact belongs.
    """

    entry = one(f"SELECT count(*) AS c FROM {ACTIVITY} WHERE title_name = 'VLH Online'")
    assert entry["filter"] == "title_name = 'vlh online'"


# ---------------------------------------------------------------------------
# Failing closed
# ---------------------------------------------------------------------------


def test_a_statement_that_will_not_parse_contributes_nothing():
    assert provenance.derivations(["SELCT count(*) FRM nowhere"]) == []


def test_a_statement_that_is_not_a_query_contributes_nothing():
    """A DESCRIBE has no window and no metric, so it has no line to add."""

    assert provenance.derivations([f"DESCRIBE TABLE {ACTIVITY}"]) == []


def test_an_unqualified_table_leaves_the_source_empty_rather_than_guessing():
    """The Genie path can produce one, and citing a table nobody read is the

    failure this whole area of the codebase exists to have stopped making.
    """

    entry = one("SELECT count(*) AS c FROM activity WHERE title_name = 'IFR2'")
    assert entry["source"] == ""
    assert entry["filter"] == "title_name = 'rdr2'"


def test_nothing_is_returned_for_a_statement_with_nothing_to_say():
    """Four blank labels under an answer read as broken rather than as quiet."""

    assert provenance.derivations(["SELECT 1"]) == []


def test_the_same_query_run_twice_is_reported_once():
    sql = f"SELECT count(*) AS c FROM {ACTIVITY} WHERE title_name = 'IFR2'"
    assert len(provenance.derivations([sql, sql])) == 1


def test_a_run_with_many_statements_is_capped():
    statements = [
        f"SELECT count(*) AS c{index} FROM {ACTIVITY} WHERE region = 'r{index}'"
        for index in range(provenance.MAX_DERIVATIONS + 3)
    ]
    assert len(provenance.derivations(statements)) == provenance.MAX_DERIVATIONS


def test_no_field_can_grow_without_bound():
    """A pathological literal must not turn a labelled fact into a paragraph.

    It is also the one field a question's text could reach, and this record is
    bound for a Lakebase row and a trace, neither of which keeps questions.
    """

    entry = one(
        f"SELECT count(*) AS c FROM {ACTIVITY} WHERE note = '{'x' * 4000}'"
    )
    assert len(entry["filter"]) <= provenance.MAX_FIELD_CHARS


# ---------------------------------------------------------------------------
# On the answer, which is where a reader meets it
# ---------------------------------------------------------------------------


QUERY = (
    f"SELECT count(DISTINCT platformid_accountid) AS active_players FROM {ACTIVITY} "
    "WHERE activity_date >= '2025-06-01' AND title_name = 'IFR2'"
)


def answered(**results) -> dict:
    """One turn, and the answer it produced."""

    llm = ScriptedLlm([Call("data_genie", {"question": "how many active players"})])
    response = ask(build(llm, FakeTools(**results)))
    return response.custom_outputs["answer"]


def test_the_answer_carries_the_derivation_of_the_query_that_ran():
    answer = answered(
        data_genie=ToolResult(
            text="8,413 active players.", sql=QUERY, sources=[ACTIVITY]
        )
    )

    assert answer["derivation"] == [
        {
            "source": ACTIVITY,
            "metric": "active_players",
            "window": "≥ '2025-06-01'",
            "filter": "title_name = 'rdr2'",
        }
    ]


def test_a_run_whose_surfaces_all_failed_derives_nothing():
    """There are no figures left to qualify.

    `no_evidence_survived` replaces the takeaway, the narrative and the figures,
    and a window under "no surface responded" would describe a query whose
    numbers are not on the page.
    """

    answer = answered(data_genie=RuntimeError("Genie did not respond"))

    assert answer["derivation"] == []


def test_the_field_is_present_even_when_there_is_nothing_to_say():
    """A reader distinguishes "no provenance" from "a version that cannot say"."""

    answer = answered(data_genie=ToolResult(text="Nothing was queried.", sources=[]))

    assert answer["derivation"] == []
