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
    assert (
        _code("SELECT crm_customer_ref FROM cat.sch.players") == failures.COLUMN_POLICY_VIOLATION
    )
    assert _code("SELECT email FROM cat.sch.players") == failures.COLUMN_POLICY_VIOLATION
    assert (
        _code("SELECT count(*) FROM cat.sch.orders NATURAL JOIN cat.sch.players")
        == failures.COLUMN_POLICY_VIOLATION
    )


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
    ):
        assert not failures.may_request_another_route(_code(sql))
