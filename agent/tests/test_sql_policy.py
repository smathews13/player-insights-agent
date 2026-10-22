"""The guard's move out of tools.py, and the code each refusal now carries.

Two jobs. The first is that the move changed nothing: `tools` re-exports the SAME
objects, so the whole existing suite in test_tools.py and test_agent.py is still
testing the guard rather than a copy of it that happens to agree today.

The second is the code on each refusal. It is set at the raise site rather than
read back out of the message, and this file is what stops that from rotting:
a control whose code is wrong is worse than one with no code, because an operator
counting COLUMN_POLICY_VIOLATION would see a manifest rejection and conclude the
column policy is firing on traffic it never saw.
"""

from __future__ import annotations

import pytest

import failures
import sql_policy
import tools

READABLE = ("cat.sch.orders", "cat.sch.players")


def _code(sql: str, readable=READABLE) -> str:
    with pytest.raises(sql_policy.SqlRefused) as refused:
        sql_policy.validate_sql(sql, readable)
    return refused.value.code


def test_tools_re_exports_the_same_objects_rather_than_copies():
    # `is`, not `==`. A copy would pass an equality check and then drift, which
    # is the whole reason the guard was moved to one module instead of two.
    for name in (
        "SqlRefused",
        "parse_sql",
        "referenced_tables",
        "fully_qualified_tables",
        "is_read_only_sql",
        "restricted_output_columns",
        "refuse_restricted_columns",
        "refuse_degenerate_joins",
        "inspect_generated_sql",
        "validate_sql",
        "BLOCKED_COLUMNS",
        "UNRETURNABLE_COLUMNS",
        "SQL_DIALECT",
    ):
        assert getattr(tools, name) is getattr(sql_policy, name), name


def test_a_statement_nobody_can_parse_says_that_rather_than_naming_a_control():
    # The distinction an operator triages on: a rule that fired means the product
    # is working, a statement nobody could parse means the guard is guessing
    # about its own coverage.
    assert _code("SELECT FROM WHERE ((") == failures.SQL_UNPARSEABLE
    assert _code("") == failures.SQL_UNPARSEABLE


def test_a_write_and_a_second_statement_are_the_same_finding():
    assert _code("DELETE FROM cat.sch.orders") == failures.SQL_NOT_READ_ONLY
    assert _code("SELECT 1; SELECT 2") == failures.SQL_NOT_READ_ONLY


def test_something_that_cannot_be_tied_to_a_table_is_not_a_manifest_rejection():
    # Two different findings that used to read alike. "Not in the manifest" is a
    # governance decision about a named table; this is a table nobody can name as
    # catalog.schema.table, and counting them together hides the second. A
    # statement that names no table at all is not this finding: it reads nothing.
    assert _code("SELECT * FROM orders") == failures.ASSET_UNRESOLVED
    assert _code("SELECT * FROM sch.orders") == failures.ASSET_UNRESOLVED


def test_math_only_sql_is_allowed_and_a_named_table_must_be_fully_qualified():
    """Index tables by catalog.schema.table. No table is not a reason to refuse."""

    math = "SELECT ROUND(452724 / 330477825.0 * 100, 4) AS null_pct"
    assert sql_policy.validate_sql(math, READABLE) == []
    assert sql_policy.validate_sql("SELECT 1", READABLE) == []
    assert _code("SELECT * FROM sch.orders") == failures.ASSET_UNRESOLVED
    assert sql_policy.validate_sql("SELECT * FROM cat.sch.orders", READABLE) == ["cat.sch.orders"]


def test_a_table_outside_the_declaration_is_a_manifest_rejection():
    assert _code("SELECT * FROM other.sch.secrets") == failures.ASSET_NOT_IN_MANIFEST


def test_the_column_policy_names_itself_however_the_column_was_reached():
    assert _code("SELECT crm_customer_ref FROM cat.sch.players") == failures.COLUMN_POLICY_VIOLATION
    assert _code("SELECT email FROM cat.sch.players") == failures.COLUMN_POLICY_VIOLATION
    assert (
        _code("SELECT count(*) FROM cat.sch.orders NATURAL JOIN cat.sch.players")
        == failures.COLUMN_POLICY_VIOLATION
    )


def test_a_join_that_relates_no_two_sources_is_refused_before_running():
    # A predicate that names one alias is a constant: there is no key to hash on,
    # so the warehouse plans a broadcast nested loop over the cartesian product
    # and dies after spending the turn's wait budget on it. Statically provable,
    # so it is refused here rather than left to a memory error that reads as
    # anything but the cartesian product it is.
    self_alias = "SELECT count(*) FROM cat.sch.orders o JOIN cat.sch.orders o2 ON o2.pid = o2.pid"
    on_true = "SELECT count(*) FROM cat.sch.orders o JOIN cat.sch.players p ON TRUE"
    on_const = "SELECT count(*) FROM cat.sch.orders o JOIN cat.sch.players p ON 1 = 1"
    assert _code(self_alias) == failures.SQL_CARTESIAN_JOIN
    assert _code(on_true) == failures.SQL_CARTESIAN_JOIN
    assert _code(on_const) == failures.SQL_CARTESIAN_JOIN


def test_the_cartesian_refusal_invites_a_rewrite_rather_than_closing_the_answer():
    # Unlike a governance refusal, this one is about the SHAPE of the statement,
    # so it carries a remedy: the loop tells the model to rewrite the same query
    # once, not to give up and not to ask another surface.
    with pytest.raises(sql_policy.SqlRefused) as refused:
        sql_policy.validate_sql(
            "SELECT count(*) FROM cat.sch.orders o JOIN cat.sch.orders o2 ON o2.pid = o2.pid",
            READABLE,
        )
    assert refused.value.remedy
    assert "INNER JOIN" in refused.value.remedy


def test_a_real_two_sided_join_and_an_ambiguous_one_are_left_alone():
    # A join whose ON names BOTH aliases is a real equi-join and passes.
    real = "SELECT count(*) FROM cat.sch.orders o JOIN cat.sch.players p ON o.pid = p.pid"
    assert sql_policy.validate_sql(real, READABLE) == ["cat.sch.orders", "cat.sch.players"]

    # An unqualified column (`= pid`) could resolve against the other side, and
    # the parse cannot tell that from here without a schema, so it is NOT refused:
    # the guard refuses only what it can prove is degenerate.
    bare = "SELECT count(*) FROM cat.sch.orders o JOIN cat.sch.players p ON o.pid = pid"
    assert sql_policy.validate_sql(bare, READABLE) == ["cat.sch.orders", "cat.sch.players"]

    # A join with no ON at all is not this control's business: USING names its key
    # and is a real equi-join, and an explicit CROSS JOIN is how a scalar is
    # legitimately attached to a result set.
    using = "SELECT count(*) FROM cat.sch.orders o JOIN cat.sch.players p USING (pid)"
    cross = "SELECT count(*) FROM cat.sch.orders o CROSS JOIN cat.sch.players p"
    assert sql_policy.validate_sql(using, READABLE) == ["cat.sch.orders", "cat.sch.players"]
    assert sql_policy.validate_sql(cross, READABLE) == ["cat.sch.orders", "cat.sch.players"]


def test_a_refusal_raised_without_a_code_still_constructs():
    # Callers outside this module raise `SqlRefused` too, and a required argument
    # would turn a refusal at one of those sites into a TypeError, which reads to
    # the loop as an ordinary failure rather than as a control firing.
    refusal = sql_policy.SqlRefused("no")
    assert refusal.code == ""
    assert str(refusal) == "no"


def test_every_code_the_guard_raises_is_one_the_taxonomy_knows():
    for sql in (
        "SELECT FROM WHERE ((",
        "DELETE FROM cat.sch.orders",
        "SELECT * FROM orders",
        "SELECT * FROM other.sch.secrets",
        "SELECT email FROM cat.sch.players",
        "SELECT count(*) FROM cat.sch.orders o JOIN cat.sch.orders o2 ON o2.pid = o2.pid",
    ):
        assert _code(sql) in failures.AGENT_CODES


def test_no_code_the_guard_raises_permits_a_later_route_attempt():
    # A statement the guard refused must not become the same question asked of a
    # Genie space in prose, which is where the guard is not.
    for sql in (
        "SELECT FROM WHERE ((",
        "DELETE FROM cat.sch.orders",
        "SELECT * FROM orders",
        "SELECT * FROM other.sch.secrets",
        "SELECT email FROM cat.sch.players",
        "SELECT count(*) FROM cat.sch.orders o JOIN cat.sch.orders o2 ON o2.pid = o2.pid",
    ):
        assert not failures.may_request_another_route(_code(sql))


class TestDistinctBesidePercentile:
    BAD = [
        "SELECT COUNT(DISTINCT player_id), approx_percentile(x, 0.5) FROM cat.sch.players",
        "SELECT COUNT(DISTINCT player_id), percentile(x, 0.5) FROM cat.sch.players",
        "SELECT COUNT(DISTINCT player_id), median(x) FROM cat.sch.players",
        "SELECT SUM(DISTINCT x), median(x) FROM cat.sch.players",
        "SELECT g, COUNT(DISTINCT player_id), median(x) FROM cat.sch.players GROUP BY g",
    ]
    OK = [
        "SELECT COUNT(DISTINCT player_id) FROM cat.sch.players",
        "SELECT median(x) FROM cat.sch.players",
        "SELECT COUNT(DISTINCT a), COUNT(DISTINCT b) FROM cat.sch.players",
        "SELECT approx_count_distinct(player_id), median(x) FROM cat.sch.players",
        "WITH c AS (SELECT COUNT(DISTINCT player_id) n FROM cat.sch.players), "
        "m AS (SELECT median(x) v FROM cat.sch.players) SELECT * FROM c, m",
        "SELECT COUNT(DISTINCT a), MAX(median(x) OVER (PARTITION BY a)) FROM cat.sch.players",
    ]

    @pytest.mark.parametrize("sql", BAD)
    def test_refused_with_remedy_and_not_disclosed(self, sql):
        with pytest.raises(sql_policy.SqlRefused) as refused:
            sql_policy.validate_sql(sql, READABLE)
        assert refused.value.code == failures.SQL_AGGREGATE_SHAPE
        assert refused.value.remedy
        assert refused.value.disclosed is False

    @pytest.mark.parametrize("sql", OK)
    def test_allowed_shapes(self, sql):
        sql_policy.validate_sql(sql, READABLE)


T = "test_catalog.test_schema.silver_gameplay_activity"
KNOWN = {T.lower(): ("label", "platform_id", "event_day", "profile")}


def _unknown(sql, known=KNOWN):
    from sql_policy import parse_sql, refuse_unknown_columns

    refuse_unknown_columns(parse_sql(sql), known)


def test_an_unknown_column_is_refused_with_the_closest_real_ones():
    import pytest

    from failures import SQL_UNKNOWN_COLUMN
    from sql_policy import SqlRefused

    with pytest.raises(SqlRefused) as caught:
        _unknown(f"SELECT labl FROM {T}")
    assert caught.value.code == SQL_UNKNOWN_COLUMN
    assert "label" in caught.value.disclosure
    assert "did you mean" not in caught.value.disclosure.lower()
    assert "describe_table" in str(caught.value)


def test_unknown_column_check_allows_aliases_and_fails_open():
    _unknown(f"SELECT label, count(*) AS n FROM {T} GROUP BY label ORDER BY n")
    _unknown(f"SELECT t.* FROM {T} t")
    _unknown(f"SELECT profile.address.city FROM {T}")
    _unknown(f"WITH c AS (SELECT label FROM {T}) SELECT nope FROM c")
    _unknown(f"SELECT exploded FROM {T} LATERAL VIEW explode(arr) x AS exploded")
    _unknown(f"SELECT nope FROM {T}", known={})  # a table never described is not checked
    _unknown(f"SELECT nope FROM {T} a JOIN {T} b ON a.label = b.label")
