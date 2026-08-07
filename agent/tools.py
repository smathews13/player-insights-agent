"""The agent's tools, and the guard every SQL path goes through.

Each tool returns a `ToolResult`, and the `sources` on it are the tables that
call ACTUALLY read, parsed from the statement that ran or from the SQL Genie
generated. NOTHING HERE INFERS A SOURCE FROM THE QUESTION: a citation a
stakeholder can check has to come from the read.

Results are values rather than accumulated on `self`. One `PlayerInsightTools`
is built per container and Model Serving handles requests concurrently, so a
ledger on the instance would attribute one stakeholder's tables to another's
answer.
"""

from __future__ import annotations

import re
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import mlflow
import sqlglot
from databricks.sdk.service.dashboards import GenieMessage, MessageStatus
from databricks.sdk.service.sql import ExecuteStatementRequestOnWaitTimeout
from sqlglot import exp

from config import Settings

#: Rows always rendered, however wide they are. A FLOOR rather than the whole
#: rule: what a result costs the model is characters, not rows, so the ceiling
#: is a character budget and this is the sample guaranteed underneath it. Fifty
#: wide rows is what "summarize the top spenders" needs and is what it still
#: gets; see `RowBudget`.
MAX_SQL_ROWS = 50


@dataclass(frozen=True)
class RowBudget:
    """How much of a result set may be put in front of the model, and why.

    A ROW COUNT IS THE WRONG UNIT and this is the defect it caused: fifty rows
    of a two-column dictionary listing and fifty rows of a wide fact table are
    the same number and nothing like the same cost, so one constant either
    starves the enumeration or overspends on the sample. A question that asks
    what a table CONTAINS ("which columns exist", "what does this field mean")
    is answered by the list itself, and fifty of one thousand seven hundred is
    not a short answer to it, it is a wrong one wearing a caveat.

    So the ceiling is `max_chars`, which is what actually overflows the model's
    context, and the shape of the result decides how many rows fit inside it.
    Narrow rows get thousands; wide rows get `min_rows` and no more. Two further
    bounds keep it finite: `min_rows` so a very wide result still shows a usable
    sample, and `max_rows` so a degenerate one-character-per-row result cannot
    spend the whole budget on row separators.
    """

    #: Characters of rendered rows, the real constraint being context.
    max_chars: int
    #: Hard row ceiling, however narrow the rows are.
    max_rows: int
    #: Rows rendered even when they have already spent `max_chars`.
    min_rows: int = MAX_SQL_ROWS


#: A result the model is SUMMARIZING. It is reading for a figure, a ranking or a
#: shape, so a sample answers the question and the rest is context other steps of
#: the loop need. 40,000 characters is roughly a tenth of the window, spendable
#: several times over across `MAX_TOOL_CALLS` without crowding out the answer.
SAMPLE_BUDGET = RowBudget(max_chars=40_000, max_rows=2_000)

#: A result that IS the answer: a column inventory, a listing of definitions.
#: Much higher rather than unbounded, because "no cap" is how a wide table with
#: a large column count stops the turn rather than truncating it. Rows on this
#: path are metadata and narrow, so this holds a column inventory in the low
#: thousands whole, which is the size the enumeration questions actually are.
ENUMERATION_BUDGET = RowBudget(max_chars=120_000, max_rows=5_000)

#: Columns `DESCRIBE TABLE EXTENDED` returns before its metadata section. The
#: section past it repeats the storage location, provider, and owner, which is
#: not what the model needs to write a query and is a lot of tokens.
DESCRIBE_STOP_MARKERS = ("# Detailed Table Information", "# Partition Information", "")

#: How long one Genie call may take before the turn gives up on it, and how often
#: it is checked. Sized against the turn: `MAX_RUN_SECONDS` is 90 and the endpoint
#: is killed at about 120, so a single call may spend half the turn and no more.
#: The SDK's own default is twenty minutes, which cannot be spent (the request is
#: already dead), so it is not a timeout, only a way to return nothing.
GENIE_TIMEOUT_SECONDS = 45.0
GENIE_POLL_SECONDS = 2.0

#: Statuses the SDK's waiter does not treat as terminal, which is why it can poll
#: a finished message until the twenty-minute default expires. Each maps to what
#: to tell the model, because "Genie failed" and "Genie's result expired" call for
#: different next steps.
_GENIE_TERMINAL_FAILURES = {
    MessageStatus.FAILED: "could not answer",
    MessageStatus.CANCELLED: "was cancelled",
    MessageStatus.QUERY_RESULT_EXPIRED: "produced a result that has since expired",
}

#: What a non-terminal status means when the deadline arrives, so the model gets a
#: next step rather than a stopwatch reading.
_GENIE_STALL_HINTS = {
    MessageStatus.PENDING_WAREHOUSE: (
        "The SQL warehouse was still starting. Retrying once usually finds it warm, "
        "or use run_sql against the declared tables."
    ),
    MessageStatus.EXECUTING_QUERY: (
        "Its query was still running. Ask for a narrower slice: fewer dimensions or "
        "a shorter window."
    ),
}

# ---------------------------------------------------------------------------
# What the dictionary space is asked
#
# A dictionary space answers about a FIELD. Naming a table in the question
# invites its context step to pull that table in alongside the dictionary, and
# on a wide master table that is enough on its own to turn a 13.7 second answer
# into a call still in its LLM planning phase when the 45 second deadline
# arrives. The deadline is not the thing to move: it is sized against the 90
# second turn budget, so buying seconds there spends them somewhere else.
#
# So the table is dropped, and ONLY where it was scoping something else. A
# question whose SUBJECT is the table ("what is the grain of X", "what does X
# hold") has nothing left if X goes, and it is a question the dictionary space
# is supposed to be slow-ish about, because answering it does need the table.
# That is the whole of the distinction: a preposition in front of the name means
# the name is context, and context is what costs the time here.
#
# Dropping it is not free. Where the same column name lives in several tables,
# the table was load-bearing and the answer can now be confidently about the
# wrong column. That is mitigated rather than eliminated, in two places: Genie
# is asked to name the table each definition belongs to, and the caller is told
# in the result that the question was not scoped, so a mismatch is visible
# rather than silent. A caveat the model can act on beats a timeout it cannot.
# ---------------------------------------------------------------------------

#: Words that put a table in a question as SCOPE rather than as subject.
#: Deliberately not "of" or "for": "the grain of X" and "the key for X" are
#: questions about X, and stripping the name leaves them asking about nothing.
_SCOPING_PREPOSITIONS = ("in", "inside", "within", "from", "on")

#: Rewritten questions are never shorter than this, in words. A question that is
#: only a table reference has no field in it to ask about, so it is sent as the
#: model wrote it and allowed to be slow rather than turned into nonsense.
_MIN_UNSCOPED_WORDS = 3

#: Appended when a table was dropped. Short on purpose: every clause here is
#: more for the space's planning step to read, which is the cost being cut. It
#: earns its length by making a wrong-column answer detectable.
DICTIONARY_SCOPE_INSTRUCTION = "Name the table each definition belongs to."


def _table_aliases(table: str) -> list[str]:
    """The ways one declared table can be written, longest first.

    Longest first because `a.b.c` has to be tried before the bare `c`: matching
    the bare name first eats the tail of the qualified one and leaves `a.b.`
    sitting in the question.
    """

    parts = table.split(".")
    aliases = [table]
    if len(parts) == 3:
        aliases.append(".".join(parts[1:]))
        aliases.append(parts[2])
    return sorted({alias for alias in aliases if alias}, key=len, reverse=True)


def _scope_clause(alias: str) -> re.Pattern[str]:
    return re.compile(
        r"\s*\b(?:"
        + "|".join(_SCOPING_PREPOSITIONS)
        + r")\s+(?:the\s+)?(?:table\s+)?`?"
        + re.escape(alias)
        # A right boundary the alias itself cannot supply. Without it a bare
        # `orders` eats the head of `orders_enriched` and leaves the question
        # asking about a table nobody named.
        + r"(?![\w.])`?(?:\s+table\b)?",
        re.IGNORECASE,
    )


def unscope_dictionary_question(
    question: str, declared: Sequence[str]
) -> tuple[str, list[str]]:
    """The question with any DECLARED table dropped from a scoping clause.

    Returns the question to ask and the tables that were dropped, because the
    caller has to disclose the second: a definition the model believes was
    scoped to a table, and was not, is the failure mode this rewrite trades for
    the timeout it prevents.

    Only declared tables are touched. A name this deployment does not hold is
    not ours to reinterpret, and a bare English word that happens to sit after
    "in" is not a table.
    """

    text = question
    dropped: list[str] = []
    # Longest declared name first, for `_table_aliases`' reason one level up: a
    # short table name that is a substring of a longer one must not match first.
    for table in sorted(declared, key=len, reverse=True):
        removed = False
        for alias in _table_aliases(table):
            text, count = _scope_clause(alias).subn(" ", text)
            removed = removed or bool(count)
        if removed:
            dropped.append(table)
    if not dropped:
        return question, []

    text = re.sub(r"\s+", " ", text).strip()
    # The stripped clause takes its leading space with it, so punctuation that
    # followed the table name would otherwise be left adrift: "mean ?".
    text = re.sub(r"\s+([?.,;:])", r"\1", text)
    if len(text.split()) < _MIN_UNSCOPED_WORDS:
        return question, []
    return text, dropped


def dictionary_scope_note(dropped: Sequence[str]) -> str:
    """What the model is owed when its question was narrowed on the way out."""

    if not dropped:
        return ""
    names = ", ".join(dropped)
    return (
        f"Scope note: the dictionary space was asked about the field alone, without "
        f"naming {names}. Naming a wide table there makes it read that table alongside "
        "the dictionary, and the call then runs past the turn's deadline and returns "
        "nothing at all. So what follows is the governed definition of the field, not a "
        f"statement about that column as it appears in {names}. If the definition names a "
        "different table, or the field is defined more than once, say which one you used "
        "and that it was not scoped to the table you asked about."
    )


#: How long the warehouse may hold one statement before it is cancelled. Paired
#: with `on_wait_timeout=CANCEL` so that reaching it means "too slow", which the
#: model can act on, rather than leaving a statement running whose response says
#: RUNNING and used to be reported as a failure.
SQL_WAIT_TIMEOUT = "30s"

#: What each non-success state means for the model's next move.
_SQL_STATE_MEANINGS = {
    "CANCELED": (
        f"the statement was still running after {SQL_WAIT_TIMEOUT} and was cancelled, so it "
        "did not fail: narrow it (fewer rows, fewer joins, a shorter window) and try again"
    ),
    "PENDING": "the warehouse had not started the statement yet; try again in a moment",
    "RUNNING": "the statement is still running rather than failed; narrow it and try again",
    "FAILED": "the warehouse rejected the statement",
    "CLOSED": "the result was closed before it could be read",
}

#: Appended to the table listing when the run executes as the endpoint's invoker.
#:
#: The manifest records what the DEPLOYMENT declared, not what this caller may
#: read, and under user authorization those differ invisibly from in here. So the
#: model is told to treat a refusal as an answer about access rather than as a
#: hint to find a table that works.
GRANTS_DECIDE_NOTE = (
    "Access note: these are the tables this deployment declares, not a promise that you "
    "can read them. This run executes as the caller, so their Unity Catalog grants decide "
    "which of these return rows. If one is refused, say that the caller lacks access to it "
    "and name it. Do NOT substitute a different table and present the result as the answer "
    "to the question that was asked."
)


# ---------------------------------------------------------------------------
# The SQL guard
#
# THIS IS A PARSE, AND MUST NOT GO BACK TO REGULAR EXPRESSIONS. The version that
# was accepted a comma join, a `--` inside a string literal, a `/* */` pair
# spanning a UNION, and a restricted-column projection, because the table pattern
# only matched after FROM and JOIN and comments were stripped without any notion
# of a string literal, so the text being CHECKED was not the text that RAN. It
# also returned the wrong `sources`, so the Sources block named one table while
# the query read another.
#
# `sqlglot` builds an AST for the exact string that will be executed: one parse,
# no rewriting, no second version of the text. It is declared in log_model.py's
# pip_requirements. `sqlparse`, which arrives with mlflow, is a non-validating
# tokenizer and would leave comma joins, CTEs and set operations hand-rolled.
#
# EVERYTHING UNRESOLVABLE IS REFUSED: a parse failure, more than one statement, a
# root that is not a SELECT, a name that is not three parts, a table expression
# that resolves to no name. There is no fall-back path, because falling back to
# weaker checking is how the previous version passed all of the above.
# ---------------------------------------------------------------------------

#: Parsed with the dialect the warehouse actually speaks, so that syntax
#: Databricks accepts is not silently reinterpreted as some other engine's.
SQL_DIALECT = "databricks"

#: The roots a read-only statement can have. A whitelist rather than a list of
#: forbidden verbs: an unknown statement type is refused instead of allowed.
_READ_ONLY_ROOTS = (exp.Select, exp.Subquery, exp.Union, exp.Except, exp.Intersect)

#: Columns refused ANYWHERE in a statement: projection, join condition,
#: predicate, subquery, any of it.
#:
#: `crm_customer_ref` is the only key that spans the two labels. A self-join on it
#: needs no second table, so NO TABLE-LEVEL CHECK CAN SEE IT and this is the only
#: thing standing between a prompt sentence and a bridged identity.
BLOCKED_COLUMNS = frozenset({"crm_customer_ref"})

#: Columns that may be counted, filtered on, or grouped by, but never RETURNED.
#: display_name and email are never returned, and the player-level keys identify
#: a person. An aggregate over them is the whole point of the product ("count
#: distinct platformid_accountid"), so the rule is about exposure rather than
#: reference.
UNRETURNABLE_COLUMNS = frozenset(
    {
        "crm_customer_ref",
        "email",
        "display_name",
        "player_id",
        "platformid_accountid",
        "partner_player_ref",
    }
)


class SqlRefused(ValueError):
    """A statement the guard will not pass, with the reason the model reads.

    A `ValueError` so that every existing caller and test still catches it, and a
    named type so a refusal is distinguishable from an argument mistake.
    """


def parse_sql(sql: str) -> exp.Expression:
    """The AST of exactly one read-only statement, or a refusal.

    Fails closed at every step. `sqlglot` returns a `Command` node for syntax it
    does not model, which would otherwise be an opaque way for something
    unparsed to be treated as a query.
    """

    try:
        statements = sqlglot.parse(sql, dialect=SQL_DIALECT)
    except Exception as error:  # noqa: BLE001 - ParseError and tokenizer errors both
        raise SqlRefused(
            f"This SQL could not be parsed, so it cannot be checked: {error}. "
            "Rewrite it as one simple read-only statement."
        ) from error
    statements = [statement for statement in statements if statement is not None]
    if not statements:
        raise SqlRefused("No SQL statement was supplied.")
    if len(statements) > 1:
        raise SqlRefused(
            f"Only one statement is allowed; {len(statements)} were supplied. "
            "Send a single read-only SELECT."
        )
    tree = statements[0]
    if not isinstance(tree, _READ_ONLY_ROOTS):
        raise SqlRefused(
            f"Only one read-only SELECT/WITH statement is allowed; this is a "
            f"{type(tree).__name__.upper()} statement."
        )
    return tree


def referenced_tables(tree: exp.Expression) -> list[str]:
    """Every physical table the statement reads, fully qualified, in first-seen order.

    CTE names are excluded because they are not tables. Anything that cannot be
    resolved to a three-part name is refused rather than skipped: skipping is
    precisely how the previous version came to under-report its sources.
    """

    cte_names = {cte.alias_or_name.lower() for cte in tree.find_all(exp.CTE)}
    names: list[str] = []
    for table in tree.find_all(exp.Table):
        catalog, database, name = table.catalog, table.db, table.name
        if not name:
            raise SqlRefused(
                "This statement reads something the guard cannot resolve to a table "
                f"({table.sql(dialect=SQL_DIALECT)!r}). Table-valued functions and "
                "unnamed sources are not allowed. Name the table."
            )
        if not catalog and not database:
            if name.lower() in cte_names:
                continue
            raise SqlRefused(
                f"'{name}' is not a fully-qualified table. Every table must be named as "
                "catalog.schema.table so the guard can check it against what this model "
                "was granted."
            )
        if not catalog or not database:
            raise SqlRefused(
                f"'{table.sql(dialect=SQL_DIALECT)}' is only partly qualified. Name it as "
                "catalog.schema.table."
            )
        full_name = f"{catalog}.{database}.{name}"
        if full_name not in names:
            names.append(full_name)
    return names


def fully_qualified_tables(sql: str) -> list[str]:
    """The tables one statement reads. Raises `SqlRefused` if that is not knowable.

    Used for attribution as well as validation, including for SQL the agent did
    not write: a Genie space's generated query goes through here so that the
    Sources block a customer reads is the parse of the query that ran, not a
    pattern match over its text. The old pattern also invented sources (a
    literal like `'from cat.sch.fake'` produced a table nobody read), which the
    Genie path had no validation step to catch.
    """

    return referenced_tables(parse_sql(sql))


def is_read_only_sql(sql: str) -> bool:
    try:
        parse_sql(sql)
    except SqlRefused:
        return False
    return True


def _quoted(full_name: str) -> str:
    return ".".join("`" + part.replace("`", "``") + "`" for part in full_name.split("."))


#: Aggregates that provably reduce a restricted column to a CARDINALITY: a number
#: that says how many, never which. AN ALLOWLIST, because `max`, `first`,
#: `any_value`, `collect_list` and the rest are all `AggFunc` and all return the
#: column's real values. An aggregate is not a summary; counting is.
#:
#: Named types rather than function-name strings, so a dialect spelling
#: (`array_agg` for `collect_list`) cannot walk past a name check. Anything
#: sqlglot does not model becomes `exp.Anonymous` and is refused by default.
_COUNTING_AGGREGATES = (exp.Count, exp.CountIf, exp.ApproxDistinct)

#: Nodes that turn a restricted column into a boolean before anything above them
#: can see its value. `sum(CASE WHEN email IS NULL THEN 1 ELSE 0 END)` is a null
#: count, not an email, so the aggregate above a predicate need not be a counting
#: one. `RegexpLike` is the one common boolean sqlglot does not model as a
#: `Predicate`.
_BOOLEAN_REDUCERS = (exp.Predicate, exp.RegexpLike)


def _within_aggregate(column: exp.Column, projection: exp.Expression) -> bool:
    """Is this column reduced to something non-identifying, rather than returned?

    Two ways it can be. Either a counting aggregate consumes it (a cardinality
    says how many players, never which), or a predicate has already collapsed it
    to a boolean, after which the aggregate above is counting bits rather than
    handing over values.

    Everything else is a return, including things that look like summaries.
    `max(email)` is an aggregate and yields a real address; so do `min`, `first`,
    `any_value`, `mode`, `max_by` and the `collect_*` family, which pull every
    value in the table into one cell. The previous rule (any `AggFunc` between
    the column and the projection) accepted all of them.

    A window is refused whatever function sits in it. `first_value(email) OVER
    (…)` is an `AggFunc` returning one real address per row, and a window does
    not reduce rows at all, so no per-row function of a restricted column is a
    summary of it. That includes `count(email) OVER (…)`: counting is only a
    reduction when it reduces.
    """

    aggregate: exp.Expression | None = None
    collapsed = False
    windowed = False
    node = column.parent
    while node is not None:
        if isinstance(node, exp.Window):
            windowed = True
        elif isinstance(node, exp.AggFunc):
            if aggregate is None:
                aggregate = node
        elif isinstance(node, _BOOLEAN_REDUCERS) and aggregate is None:
            # Below the nearest aggregate, so the aggregate sees a bit, not a value.
            collapsed = True
        # Inspected before the walk stops: the projection is often the aggregate
        # itself, and stopping at it first would refuse
        # `count(DISTINCT platformid_accountid)`.
        if node is projection:
            break
        node = node.parent
    if aggregate is None or windowed:
        return False
    return isinstance(aggregate, _COUNTING_AGGREGATES) or collapsed


def _exposed_columns(tree: exp.Expression) -> list[str]:
    """Restricted columns this statement would RETURN, at any nesting depth.

    Every SELECT is checked, not only the outermost one, because a subquery's
    projection is what an outer `SELECT *` selects from. Aliases do not help:
    the column node is still there under the alias.

    Projections are not the only way out, which is the part this missed. A
    `LATERAL VIEW explode(array(email))` names `email` in the FROM clause and
    projects the alias, so the restricted column is in no `select.expressions`
    anywhere and the alias is what the warehouse reports as the result column,
    invisible to both halves of the defence, and it emits a different real value
    on every row. `UNPIVOT (val FOR col IN (email, display_name))` is the same
    shape in ANSI clothing: the identifiers hang off the table's `pivots`, and
    the result column is called `val`.

    So both are read as what they are (a projection written somewhere other
    than the projection list), and any restricted column under one is exposed.
    A `LATERAL` wrapping a subquery is skipped, because that subquery's own
    SELECT is checked above and its correlated predicates are filters.
    """

    exposed: list[str] = []

    def expose(name: str) -> None:
        if name in UNRETURNABLE_COLUMNS and name not in exposed:
            exposed.append(name)

    for select in tree.find_all(exp.Select):
        for projection in select.expressions:
            for column in projection.find_all(exp.Column):
                if column.name.lower() not in UNRETURNABLE_COLUMNS:
                    continue
                if _within_aggregate(column, projection):
                    continue
                expose(column.name.lower())

    for lateral in tree.find_all(exp.Lateral):
        if isinstance(lateral.this, exp.Subquery):
            continue
        for column in lateral.find_all(exp.Column):
            expose(column.name.lower())

    for pivot in tree.find_all(exp.Pivot):
        for column in pivot.find_all(exp.Column):
            expose(column.name.lower())

    return exposed


def restricted_output_columns(columns: Sequence[str]) -> list[str]:
    """Restricted columns among the names a statement actually returned.

    The second half of the column defence, and the half that closes `SELECT *`.
    A static parse cannot expand a star without the table's schema, so the
    warehouse's own result schema is used instead: it is the authoritative
    answer to what this query returns, and it arrives before any row is rendered
    into text that would reach the model, the trace, and Lakebase.
    """

    restricted = UNRETURNABLE_COLUMNS | BLOCKED_COLUMNS
    return [name for name in columns if str(name).strip().strip("`").lower() in restricted]


def refuse_restricted_columns(tree: exp.Expression) -> None:
    """Refuse a statement that would expose a restricted identifying column.

    The column half of `validate_sql`, lifted out whole so that a second path can
    run the SAME policy instead of a second one written to resemble it. It is
    shared rather than copied for the reason the six defects above were all one
    defect: two checks that are meant to agree drift, and the one that drifts is
    the one nobody is reading.

    The caller supplies the tree, so a path that has already parsed does not parse
    again and, more to the point, cannot end up checking a different string from
    the one it attributed.
    """

    # A NATURAL join names no key: it joins on whatever columns the tables share,
    # so nothing in the parse can tell whether `crm_customer_ref` is among them and
    # a cross-label bridge can be written without naming it. Refused as
    # unanalysable rather than passed as unremarkable.
    if any(join.args.get("method") == "NATURAL" for join in tree.find_all(exp.Join)):
        raise SqlRefused(
            "Refused: NATURAL joins are not allowed. A NATURAL join takes its keys from "
            "whatever columns the two tables share, so the guard cannot tell which keys "
            "it would join on, including the restricted cross-label key. Write the join "
            "keys out explicitly with ON."
        )

    blocked = sorted(
        {
            column.name.lower()
            for column in tree.find_all(exp.Column)
            if column.name.lower() in BLOCKED_COLUMNS
        }
        # `USING (crm_customer_ref)` produces no `exp.Column`: sqlglot keeps the
        # key as a bare `exp.Identifier` on the join, so a column scan alone walks
        # straight past the same bridge that `ON a.k = b.k` would be refused for.
        | {
            identifier.name.lower()
            for join in tree.find_all(exp.Join)
            for identifier in join.args.get("using") or []
            if identifier.name.lower() in BLOCKED_COLUMNS
        }
    )
    if blocked:
        raise SqlRefused(
            f"Refused: {', '.join(blocked)} may not be referenced at all: not selected, not "
            "joined on, not filtered on. It is the only key that spans the two labels, so "
            "using it associates a player under one label with a player under the other. "
            "Answer within a single label, and cite identity_use_scope when explaining the "
            "refusal."
        )

    exposed = _exposed_columns(tree)
    if exposed:
        # Says COUNT, not "aggregate": `max(email)` is an aggregate, so a refusal
        # that recommends aggregating hands over the bypass.
        raise SqlRefused(
            f"Refused: this would return {', '.join(exposed)}, which identifies individual "
            "players. COUNT them instead: count(DISTINCT platformid_accountid) is allowed, "
            "as are count, count_if and approx_count_distinct, and these columns may be "
            "filtered on, joined on, or grouped by. No other aggregate is a summary of "
            "them: max, min, first, any_value, mode, max_by, collect_list, collect_set and "
            "array_agg all return the real values, a window function returns one per row, "
            "and LATERAL VIEW or UNPIVOT returns them under a different name. None of "
            "those is a way to answer this: report that the identifiers cannot be "
            "returned and give the counts instead."
        )


def inspect_generated_sql(sql: str) -> list[str]:
    """Check SQL the agent did not write, and say what it reads.

    For Genie. The agent's own SQL is checked BEFORE it runs and anything
    unresolvable is refused; Genie's SQL arrives having ALREADY RUN, which
    changes what each answer is worth and so changes where the line goes.

    The column policy is applied in full and identically: `refuse_restricted_columns`
    is the same object `validate_sql` calls, so a statement refused one way is
    refused the other. Two things are deliberately NOT applied:

    The declared table set. `readable_tables` is the manifest baked in at log
    time, what passthrough granted the serving PRINCIPAL. A Genie space's tables
    are configured in Genie and are a different set that nothing here can see, so
    holding Genie to the manifest would refuse ordinary questions over any table
    the space can read and the manifest does not happen to list. That is a live
    refusal of a legitimate question in exchange for no confidentiality the
    warehouse is not already enforcing against Genie's own credentials.

    A parse failure. Refusing it would look like the strict choice and is a poor
    trade here: it refuses legitimate Databricks syntax `sqlglot` does not model,
    on a statement that has already run, and buys nothing against a caller who
    does not get to choose what SQL Genie writes. Returning no tables keeps the
    existing disclosure: the answer is marked unattributed and says its sources
    are incomplete.

    RESIDUAL RISK, stated plainly rather than implied by the absence of a check:
    an unparseable statement is uninspected, and so is a `viz` attachment that
    carries no SQL at all. `SELECT *` is the sharper one: a static parse cannot
    expand a star without the table's schema.

    That last one is now MOSTLY closed, and only mostly. `_genie_rows` fetches
    the result set and runs `restricted_output_columns` over the schema the
    fetch returns, which is the same authoritative check the SQL path makes and
    the thing this docstring used to say the Genie path could not have. It
    closes the star whenever the rows are read.

    What it does not close: an attachment whose row fetch FAILS, and a `viz`
    attachment that ran no SQL. In both, Genie's prose is still returned having
    been checked only by whatever the parse above managed, and the prose is
    where the values are, stated inline in a sentence. So an unparseable
    `SELECT *` whose rows also fail to fetch remains uninspected. Narrower than
    before, not gone.
    """

    try:
        tree = parse_sql(sql)
    except SqlRefused:
        return []
    refuse_restricted_columns(tree)
    try:
        return referenced_tables(tree)
    except SqlRefused:
        return []


def validate_sql(sql: str, readable: Sequence[str]) -> list[str]:
    """Check one statement against the declared table set, and say what it reads.

    `readable` is `Settings.readable_tables`, the manifest baked in at log time,
    which is exactly what automatic authentication passthrough granted the serving
    principal. The check used to be catalog-level, which was looser than the real
    boundary in both directions: it accepted tables the endpoint could not read
    (they failed at the warehouse with an opaque error) and it could not tell the
    model which tables it could.

    Returns the tables the statement reads, because the caller needs them for
    attribution and this function has already found them. Deriving sources twice
    is how the two answers drift, and getting them from a pattern rather than a
    parse is how they drifted from the truth.
    """

    tree = parse_sql(sql)
    tables = referenced_tables(tree)
    if not tables:
        raise SqlRefused("SQL must reference a fully-qualified catalog.schema.table.")

    declared = {name.lower(): name for name in readable}
    rejected = sorted(name for name in tables if name.lower() not in declared)
    if rejected:
        raise SqlRefused(
            f"Not in the declared table set: {', '.join(rejected)}. The serving principal is "
            "granted only the tables declared with the model, so this query would fail at the "
            "warehouse. Use list_data_assets to see what is readable."
        )

    refuse_restricted_columns(tree)
    # Attributed with the declaration's own spelling, so one table cited two ways
    # in two answers is not read as two tables.
    return [declared[name.lower()] for name in tables]


def statement_failure(response: Any) -> str:
    """Why this statement's rows cannot be read, or "" when they can.

    One reading of the state for the statement the agent runs AND the one Genie
    ran, because the states are not interchangeable and this has already been
    got wrong once: with the SDK's default `on_wait_timeout` a statement still
    RUNNING came back and was reported as `statement failed`, and the model is
    instructed to relay a failure rather than work around it, so a slow query
    became a wrong answer about the data. A second reading of the same states,
    written separately for Genie, would be free to drift back into that.
    """

    status = getattr(response, "status", None)
    state = getattr(getattr(status, "state", None), "value", None) or "UNKNOWN"
    if state == "SUCCEEDED":
        return ""
    detail = getattr(getattr(status, "error", None), "message", "") or ""
    meaning = _SQL_STATE_MEANINGS.get(state, "the statement did not run")
    return f"SQL {state}: {meaning}" + (f" ({detail})" if detail else "")


def _row_text(row: Sequence[Any]) -> str:
    """One row as the model will read it. NULL is a blank, never the word None."""

    return " | ".join("" if value is None else str(value) for value in row)


def fits_budget(rows: Sequence[Sequence[Any]], budget: RowBudget = SAMPLE_BUDGET) -> bool:
    """Whether these rows already fill what `render_rows` would render.

    Paging consults this rather than draining the result: the true total comes
    from the manifest, so stopping early costs nothing but the rows nobody was
    going to be shown.
    """

    if len(rows) >= budget.max_rows:
        return True
    if len(rows) <= budget.min_rows:
        return False
    return sum(len(_row_text(row)) + 1 for row in rows) >= budget.max_chars


def truncation_note(shown: int, total: int) -> str:
    """What the model is owed when it has been handed part of a result.

    Both numbers, and the total first, because the model has to be able to say
    "1,753 columns, here are 50" rather than doing arithmetic on a remainder to
    discover the population was ever larger.

    IT SAYS "LIST" AS WELL AS "TOTAL", and that is the fix rather than a
    rewording. The disclosure used to speak only of a total, a ranking or a
    maximum, so a model asked what a table CONTAINS read it as a caveat about
    arithmetic it was not doing, and presented fifty of one thousand seven
    hundred and fifty three columns as the inventory. An incomplete list is the
    other way a subset is reported as the whole thing, and it has to be named.
    """

    return (
        f"(This result has {total} row(s) and {shown} of them are shown; {total - shown} "
        "are not. These rows are a SAMPLE, not the result: a list or an inventory built "
        "from them is INCOMPLETE, and a total, a ranking, or a maximum taken from them is "
        f"partial. Report {total} as the number found, say how many of them you saw, and "
        "do not present what is shown as the full set.)"
    )


def render_rows(
    columns: Sequence[str],
    rows: Sequence[Sequence[Any]],
    total: int,
    budget: RowBudget = SAMPLE_BUDGET,
) -> str:
    """A result set as text, bounded by `budget` and saying what it left out.

    Shared by the SQL path and the Genie path so that one cap and one disclosure
    serve both, rather than the Genie path arriving with a limit of its own.
    Genie's OWN truncation is a separate fact and is disclosed separately by its
    caller: "50 of 800" and "800 was already trimmed" are different things and a
    reader told only the first believes 800 was the population.
    """

    rendered = [" | ".join(str(name) for name in columns)]
    spent = len(rendered[0]) + 1
    shown = 0
    for row in rows:
        if shown >= budget.max_rows:
            break
        line = _row_text(row)
        if shown >= budget.min_rows and spent + len(line) + 1 > budget.max_chars:
            break
        rendered.append(line)
        spent += len(line) + 1
        shown += 1
    # Against what was SHOWN, not against a constant. A result that fitted whole
    # is disclosed as nothing missing, which is the property the enumeration
    # questions needed and the old comparison against the row cap could not
    # express.
    if total > shown:
        rendered.append(truncation_note(shown, total))
    return "\n".join(rendered)


@dataclass
class ToolResult:
    """What one tool call produced, and which tables it read to produce it.

    `sources` is evidence, not a guess: it is parsed from the statement that ran.
    An empty list means the call read no table, and is left empty rather than
    filled in with something plausible.
    """

    text: str
    sql: str = ""
    sources: list[str] = field(default_factory=list)
    #: False when the call ran SQL whose tables could not be determined, so
    #: `sources` is known to be incomplete. Only the Genie paths can set this: the
    #: agent writes its own SQL through a guard that refuses what it cannot parse,
    #: while Genie's SQL arrives already executed and is attributed after the fact.
    #: The caller discloses it rather than presenting a short list as a full one.
    attributed: bool = True


class PlayerInsightTools:
    def __init__(
        self,
        settings: Settings,
        workspace_client: Any | None = None,
        user_authorized: bool = False,
    ):
        self.settings = settings
        if workspace_client is None:
            from databricks.sdk import WorkspaceClient

            workspace_client = WorkspaceClient()
        self.workspace = workspace_client
        #: True when `workspace_client` carries the endpoint invoker's downscoped
        #: token rather than the model version's passthrough credentials. Changes
        #: nothing about how a call is made: it changes what the DECLARED
        #: manifest means, which `list_data_assets` has to say out loud.
        self.user_authorized = user_authorized

    def _await_genie(self, space_id: str, question: str) -> GenieMessage:
        """Ask one Genie space and wait, on this turn's budget rather than the SDK's.

        `start_conversation_and_wait` defaults to a TWENTY MINUTE timeout, and its
        waiter treats only COMPLETED as success and only FAILED as failure, so a
        CANCELLED message, an expired result, or a warehouse still starting in
        PENDING_WAREHOUSE is polled for the full twenty minutes before it raises.
        Model Serving kills the request long before that and the stakeholder gets
        nothing back at all. `MAX_RUN_SECONDS` could not prevent it: the loop only
        consults its budget BETWEEN tool calls, and nothing interrupts one already
        in flight.

        So the wait is ours: a deadline this turn can afford, every terminal
        status treated as terminal, and a message that says which one it was:
        "the warehouse was still starting" is actionable, "timed out" is not.
        """

        started = time.perf_counter()
        wait = self.workspace.genie.start_conversation(space_id, question)
        status: Any = None
        while True:
            message = self.workspace.genie.get_message(
                space_id, wait.conversation_id, wait.message_id
            )
            status = getattr(message, "status", None)
            if status == MessageStatus.COMPLETED:
                return message
            if status in _GENIE_TERMINAL_FAILURES:
                raise RuntimeError(
                    f"Genie {_GENIE_TERMINAL_FAILURES[status]} after "
                    f"{time.perf_counter() - started:.0f}s: "
                    f"{getattr(message, 'error', None) or 'no detail was returned'}."
                )
            if time.perf_counter() - started >= GENIE_TIMEOUT_SECONDS:
                name = getattr(status, "value", status)
                raise TimeoutError(
                    f"Genie did not answer within {GENIE_TIMEOUT_SECONDS:.0f}s; it was still "
                    f"{name or 'working'}. "
                    + _GENIE_STALL_HINTS.get(status, "Try a narrower question or run SQL.")
                )
            time.sleep(GENIE_POLL_SECONDS)

    def _genie_rows(
        self,
        space_id: str,
        message: Any,
        attachment: Any,
        budget: RowBudget = SAMPLE_BUDGET,
    ) -> str:
        """The result set behind ONE Genie query attachment, as text.

        Genie states its findings in prose, and prose is not a result set. A "top
        10 titles by spend" answer comes back as a sentence that may list some
        rows and round others, and the model then charts and totals figures it
        never saw: a less grounded answer with no error anywhere to reveal why,
        which is why nobody notices until the numbers are questioned. This is the
        same table the notebook puts in front of its finder (206-222).

        Called only AFTER `inspect_generated_sql` has passed on this attachment,
        so a refused statement never reaches here: `SqlRefused` propagates out of
        the whole Genie call and there are no rows to read. Fetching rows must not
        become the way around a policy the SQL was already held to.

        Never returns silence when a query ran. Either the rows, or a note saying
        they could not be read and why: a quietly less grounded answer is the
        defect being fixed, and it would be reintroduced by a bare `except` here.

        Costs one API call per query attachment, after the polling budget rather
        than inside it.
        """

        fetch = getattr(self.workspace.genie, "get_message_attachment_query_result", None)
        attachment_id = getattr(attachment, "attachment_id", None)
        conversation_id = getattr(message, "conversation_id", None)
        # `id` is the legacy spelling of `message_id` and is still what some SDK
        # builds populate. Both are read because the fetch needs one of them and
        # falling back to no rows would be the silent degradation again.
        message_id = getattr(message, "message_id", None) or getattr(message, "id", None)
        if not fetch:
            return (
                "(Genie ran a query and this SDK build cannot fetch its rows, so the figures "
                "above are Genie's prose rather than a result set.)"
            )
        if not (attachment_id and conversation_id and message_id):
            return (
                "(Genie ran a query and did not identify it well enough to fetch its rows, so "
                "the figures above are Genie's prose rather than a result set.)"
            )

        try:
            response = fetch(space_id, conversation_id, message_id, attachment_id)
            statement = getattr(response, "statement_response", None)
            manifest = getattr(statement, "manifest", None)
            if statement is None or manifest is None:
                return "(Genie ran a query and exposed no result set for it.)"
            failure = statement_failure(statement)
            if failure:
                return f"(Genie ran a query and its rows were not read: {failure}.)"

            columns = [column.name for column in manifest.schema.columns]
            # The same check the SQL path makes, against the warehouse's result
            # schema BEFORE any row becomes text. This closes the `SELECT *` hole
            # a static parse cannot: it is the first thing in the Genie path with
            # a result schema.
            leaked = restricted_output_columns(columns)
            if leaked:
                raise SqlRefused(
                    f"Refused after running: Genie's query returns {', '.join(leaked)}, which "
                    "identifies individual players, so no rows were read back. Ask for the "
                    "question in aggregate: counts of players rather than the players."
                )

            rows = self._collect_rows(statement, budget)
            # The manifest's count, not the rows in hand, for the reason the SQL
            # path uses it: `data_array` is the FIRST CHUNK, and a paged result
            # read as a complete one under-reports how much was found.
            total = getattr(manifest, "total_row_count", None)
            total = int(total) if isinstance(total, int) else len(rows)
        except SqlRefused:
            raise
        except Exception as error:  # noqa: BLE001
            return f"(Genie ran a query and its rows could not be read: {error}.)"

        text = render_rows(columns, rows, max(total, len(rows)), budget)
        # A SECOND and independent cap, applied before we see the statement, so
        # the count above can itself be short. Disclosed separately: "50 of 800"
        # and "800 was already trimmed" are different facts.
        metadata = getattr(getattr(attachment, "query", None), "query_result_metadata", None)
        if getattr(metadata, "is_truncated", False):
            text += (
                "\n(Genie truncated this result set before returning it, so the row count above "
                "is not the full population either.)"
            )
        return text

    def _genie(
        self,
        space_id: str,
        question: str,
        name: str,
        budget: RowBudget = SAMPLE_BUDGET,
        preamble: str = "",
    ) -> ToolResult:
        with mlflow.start_span(name=name, span_type="TOOL") as span:
            span.set_inputs({"question": question, "space_id": space_id})
            message = self._await_genie(space_id, question)
            text_parts: list[str] = []
            sql_parts: list[str] = []
            sources: list[str] = []
            #: Attachments that ran something and yielded no table. Counted for
            #: every way attribution comes back short, not just a parse failure:
            #: an attachment with absent SQL, or SQL that parses to no table,
            #: otherwise leaves a Sources block that reads as complete while
            #: being a strict subset of what was touched.
            unattributed = 0
            #: Whether this answer came from running something. A `query`
            #: attachment ran a statement; a `viz` attachment is a chart of a
            #: result. Either means figures, and figures with no source behind
            #: them are the thing that must not pass as attributed.
            produced_figures = False
            for attachment in message.attachments or []:
                text = getattr(getattr(attachment, "text", None), "content", None)
                if text:
                    text_parts.append(text)
                if getattr(attachment, "viz", None):
                    produced_figures = True
                query = getattr(attachment, "query", None)
                if query:
                    produced_figures = True
                    generated = getattr(query, "query", None)
                    resolved: list[str] = []
                    if generated:
                        sql_parts.append(generated)
                        # Genie writes this SQL and it has already run, so this
                        # is attribution AND the column check off one parse.
                        #
                        # The check is not optional just because the query ran:
                        # Genie hands back a sentence with the values IN it, so
                        # refusing before that text is returned is what keeps an
                        # address out of the evidence log, the synthesis prompt, a
                        # persisted trace stage and a stakeholder's screen.
                        # `SqlRefused` drops every attachment of the message,
                        # including the ones that were fine.
                        resolved = inspect_generated_sql(generated)
                    if resolved:
                        sources.extend(resolved)
                    else:
                        unattributed += 1
                    description = getattr(query, "description", None)
                    if description:
                        text_parts.append(f"Query interpretation: {description}")
                    # After the column policy above, never before: otherwise
                    # this is a second route to the values the SQL was just
                    # refused for returning.
                    rows = self._genie_rows(space_id, message, attachment, budget)
                    if rows:
                        text_parts.append("Query result:\n" + rows)
            if produced_figures and not sources:
                # Not redundant with the counter above: a `viz` attachment
                # carries no SQL, so a charted answer with no query attachment
                # would report nothing and look fully attributed.
                unattributed = max(unattributed, 1)
            if unattributed:
                # Said in the evidence as well as on the flag, because the flag
                # needs a caller to act on it and this reaches the model that is
                # about to describe where the figures came from.
                text_parts.append(
                    "Attribution note: the tables behind "
                    + ("this answer" if not sources else "part of this answer")
                    + " could not be determined, so the sources are incomplete. Say they are "
                    "incomplete rather than listing what happened to resolve."
                )
            body = "\n\n".join(text_parts) or "(Genie returned no text.)"
            result = ToolResult(
                # The preamble says what was ASKED, so it belongs above the
                # answer and outside the "did Genie say anything" test: a call
                # whose question was rewritten has to disclose that even when
                # the space came back with nothing.
                text=f"{preamble}\n\n{body}" if preamble else body,
                sql="\n\n".join(sql_parts),
                sources=list(dict.fromkeys(sources)),
                # Silence here would be the under-reporting failure again, one
                # layer along: an answer whose Sources block looks complete
                # because the parse quietly returned nothing.
                attributed=not unattributed,
            )
            span.set_outputs(
                {
                    "text": result.text[:4000],
                    "sql": result.sql[:4000],
                    "sources": result.sources,
                    "attributed": result.attributed,
                }
            )
            return result

    def data_genie(self, question: str) -> ToolResult:
        return self._genie(
            self.settings.data_genie_space_id, question, "data_source_finder.data_genie"
        )

    def dictionary_genie(self, question: str) -> ToolResult:
        """Ask the dictionary space about the FIELD, not about a table's copy of it.

        The rewrite is here rather than in the prompt because a prompt is a
        request and this is a deadline. The model composes the question, and the
        same underlying question asked two ways behaves completely differently:
        the notebook asked this space about a column and had an answer in 13.7
        seconds, while the app asked it about the field in a named wide master
        table and was still in the LLM planning phase when the 45 second timeout
        fired. Naming a wide table in a dictionary space invites its context step
        to pull that table in beside the dictionary, which accounts for the whole
        difference on its own.

        On the ENUMERATION budget for the same reason `describe_table` is: this
        space answers with lists of definitions, and the list is the answer.
        """

        asked, dropped = unscope_dictionary_question(question, self.settings.readable_tables)
        if dropped:
            asked = f"{asked} {DICTIONARY_SCOPE_INSTRUCTION}"
        return self._genie(
            self.settings.dictionary_genie_space_id,
            asked,
            "data_source_finder.dictionary_genie",
            ENUMERATION_BUDGET,
            dictionary_scope_note(dropped),
        )

    # -----------------------------------------------------------------------
    # SQL
    # -----------------------------------------------------------------------

    def _execute(
        self, sql: str, span_name: str, budget: RowBudget = SAMPLE_BUDGET
    ) -> tuple[list[str], list[list[Any]], int]:
        """Run one statement on the declared warehouse. Columns, rows, and the true total.

        A non-SUCCEEDED response is reported rather than assumed away: treating it
        as a success is how a query that ran nothing produced an answer that looked
        queried. But the states are not interchangeable, and calling all of them
        "failed" was its own bug: with the SDK's default `on_wait_timeout`, a
        statement still running at the wait timeout came back RUNNING and was
        reported to the model as `SQL RUNNING: statement failed`. It had not
        failed, and the model is instructed to report failures rather than work
        around them, so a slow query became a wrong answer about the data.

        `CANCEL` makes the timeout mean what it says: the statement is stopped and
        the model is told it was too slow, which it can act on by narrowing.
        """

        with mlflow.start_span(name=span_name, span_type="TOOL") as span:
            span.set_inputs({"sql": sql})
            response = self.workspace.statement_execution.execute_statement(
                warehouse_id=self.settings.warehouse_id,
                statement=sql,
                wait_timeout=SQL_WAIT_TIMEOUT,
                on_wait_timeout=ExecuteStatementRequestOnWaitTimeout.CANCEL,
            )
            failure = statement_failure(response)
            if failure:
                raise RuntimeError(failure)
            columns = [column.name for column in response.manifest.schema.columns]
            rows = self._collect_rows(response, budget)
            # The manifest's own count: `result.data_array` is the FIRST CHUNK,
            # and a paged result read as a complete one under-reports.
            total = getattr(response.manifest, "total_row_count", None)
            total = int(total) if isinstance(total, int) else len(rows)
            span.set_outputs({"row_count": len(rows), "total_row_count": total})
            return columns, rows, max(total, len(rows))

    def _collect_rows(
        self, response: Any, budget: RowBudget = SAMPLE_BUDGET
    ) -> list[list[Any]]:
        """The first chunk, then following chunks until enough rows are in hand.

        Stops at the rendering budget rather than draining the result: rows
        nobody will be shown cost a round trip each and buy nothing. The true
        total comes from the manifest, so stopping early does not make the count
        wrong.

        The budget is passed in because it is the SAME question as rendering. A
        paging loop with a bound of its own is how an enumeration path could be
        given a larger budget and still be handed fifty rows to spend it on.
        """

        result = getattr(response, "result", None)
        rows = list(getattr(result, "data_array", None) or [])
        statement_id = getattr(response, "statement_id", None)
        next_chunk = getattr(result, "next_chunk_index", None)
        while next_chunk is not None and statement_id and not fits_budget(rows, budget):
            chunk = self.workspace.statement_execution.get_statement_result_chunk_n(
                statement_id, next_chunk
            )
            rows.extend(list(getattr(chunk, "data_array", None) or []))
            next_chunk = getattr(chunk, "next_chunk_index", None)
        return rows

    def _read(self, sql: str, span_name: str) -> ToolResult:
        tables = validate_sql(sql, self.settings.readable_tables)
        columns, rows, total = self._execute(sql, span_name)

        # The static parse cannot expand `SELECT *` without the table's schema, so
        # the warehouse's result schema closes it, BEFORE any row becomes text:
        # from here rows reach the evidence log, the synthesis prompt, a trace
        # stage persisted to Lakebase, and a stakeholder's screen.
        leaked = restricted_output_columns(columns)
        if leaked:
            raise SqlRefused(
                f"Refused after running: this query returns {', '.join(leaked)}, which "
                "identifies individual players, so no rows were read back. Name the columns "
                "you need instead of selecting every column, and aggregate the identifiers."
            )

        return ToolResult(text=render_rows(columns, rows, total), sql=sql, sources=tables)

    def run_sql(self, sql: str) -> ToolResult:
        return self._read(sql, "data_source_finder.run_sql")

    def query_named_table(self, sql: str) -> ToolResult:
        """The fast path: query a table the USER named, without going via Genie.

        Shares `run_sql`'s guard and differs only in what a rejection MEANS, which
        is the point of having both. Here a missing three-part name is a question
        for the user rather than a reason to go hunting: the notebook's third
        routing path exists because crawling Unity Catalog for a half-named table
        is slow, guesses, and usually guesses wrong.
        """

        return self._read(sql, "orchestrator.query_named_table")

    # -----------------------------------------------------------------------
    # Discovery
    # -----------------------------------------------------------------------

    def list_data_assets(self, catalog: str = "", schema: str = "") -> ToolResult:
        """Drill down the DECLARED manifest: catalogs -> schemas -> tables.

        Reads the manifest baked into the model rather than Unity Catalog live, for
        two measured reasons. Listing UC from inside the endpoint means reading
        `information_schema`, which fails even with catalog-level SELECT because it
        is backed by the `system` catalog and needs `USE CATALOG system` granted
        separately. And a live listing would show tables the serving principal was
        never granted, so the agent could offer a table, be asked for it, and fail
        at the warehouse. The manifest is exactly what passthrough granted, so
        everything this returns is readable by construction.

        That last sentence stops being true under user authorization, and this is
        where the model would otherwise never find out. The manifest still bounds
        what may be read (`validate_sql` refuses anything outside it), but the
        caller's own Unity Catalog grants decide which of those tables actually
        answer, and the listing has no way to know which. So it says so, next to
        the names, where the choice is made.
        """

        declared = self.settings.readable_tables
        catalog = catalog.strip().strip("`")
        schema = schema.strip().strip("`")

        if not catalog:
            catalogs = sorted({name.split(".")[0] for name in declared})
            lines = [f"- {name}" for name in catalogs]
            return ToolResult(
                text="Declared catalogs:\n" + "\n".join(lines)
                if lines
                else "(no tables were declared with this model)"
            )

        in_catalog = [name for name in declared if name.split(".")[0] == catalog]
        if not in_catalog:
            return ToolResult(
                text=(
                    f"'{catalog}' has no declared tables. Declared catalogs: "
                    + ", ".join(sorted({name.split('.')[0] for name in declared}))
                )
            )
        if not schema:
            schemas = sorted({name.split(".")[1] for name in in_catalog})
            return ToolResult(
                text=f"Declared schemas in {catalog}:\n"
                + "\n".join(f"- {name}" for name in schemas)
            )

        tables = sorted(
            name for name in in_catalog if name.split(".")[1] == schema
        )
        if not tables:
            return ToolResult(
                text=(
                    f"'{catalog}.{schema}' has no declared tables. Declared schemas in "
                    f"{catalog}: " + ", ".join(sorted({n.split('.')[1] for n in in_catalog}))
                )
            )
        # Listed, not classified. What a table is FOR is a property of the
        # deployment's own schema, so anything asserted here would be a guess
        # about the reader's estate dressed as a fact; describe_table and
        # dictionary_genie establish it from the data instead.
        lines = [f"Declared tables in {catalog}.{schema}:"]
        lines.extend(f"  - {name}" for name in tables)
        lines.append("")
        lines.append("Call describe_table for columns, types, and comments.")
        if self.user_authorized:
            lines.append(GRANTS_DECIDE_NOTE)
        return ToolResult(text="\n".join(lines))

    def describe_table(self, full_name: str) -> ToolResult:
        """Columns, types, and comments for one declared table.

        `DESCRIBE TABLE EXTENDED` on the declared warehouse rather than
        `tables.get`, so the description comes from the same compute that will run
        the query: a table the warehouse cannot see fails here, before the model
        writes SQL against it.

        Read on the ENUMERATION budget, because this is the tool that answers
        "which columns does this table have" and the list is the answer rather
        than evidence for one. On the sampling budget a wide table came back as
        the first fifty of its columns, and unlike the SQL path this one built
        its own text and so did not even carry the disclosure: the model was
        handed a partial inventory with nothing on it to say it was partial.
        """

        name = full_name.strip().strip("`")
        parts = [part for part in name.split(".") if part.strip()]
        if len(parts) != 3:
            return ToolResult(
                text=(
                    "REJECTED: describe_table needs a fully-qualified catalog.schema.table "
                    f"(three dot-separated parts); got '{full_name}'. Ask the USER for the "
                    "full catalog.schema.table with request_clarification rather than "
                    "guessing it or crawling to find it."
                )
            )
        declared = {table.lower() for table in self.settings.readable_tables}
        if name.lower() not in declared:
            return ToolResult(
                text=(
                    f"REJECTED: '{name}' was not declared with this model, so the serving "
                    "principal has no grant on it and cannot read it. Call list_data_assets "
                    "to see what is available, and tell the user this table is out of scope "
                    "rather than trying another way in."
                )
            )
        columns, rows, total = self._execute(
            f"DESCRIBE TABLE EXTENDED {_quoted(name)}",
            "orchestrator.describe_table",
            ENUMERATION_BUDGET,
        )
        # The table's own COMMENT is lifted out of the extended section and put
        # first. It is the only place a deployment says what a table is FOR in
        # its own words, and it is now the ONLY source for that: nothing in this
        # file describes anyone's schema, so a purpose the model does not read
        # here is a purpose it has to ask dictionary_genie about or do without.
        #
        # Read rather than asserted, which is the whole distinction. It is the
        # customer's sentence about the customer's table, so it is right on any
        # estate by construction, and absent rather than wrong where they have
        # not written one.
        described: list[str] = []
        table_comment = ""
        past_columns = False
        for row in rows:
            values = [str(value) if value is not None else "" for value in row]
            field = values[0].strip() if values else ""
            # The extended section starts with a blank-named row; past it the
            # rows are table metadata rather than columns.
            if not past_columns and field in DESCRIBE_STOP_MARKERS:
                past_columns = True
            if past_columns:
                if field == "Comment" and len(values) > 1:
                    table_comment = values[1].strip()
                continue
            data_type = values[1] if len(values) > 1 else ""
            comment = values[2] if len(values) > 2 else ""
            described.append(f"- {field}: {data_type}" + (f" ({comment})" if comment else ""))

        lines = [name]
        if table_comment:
            lines.append(f"Table comment: {table_comment}")
        lines.append("")
        lines.extend(described)
        # Only when the read itself was short. `total` counts the DESCRIBE's own
        # rows, columns and metadata together, so it is compared against the rows
        # that came back rather than against the columns parsed out of them: a
        # table whose extended section was read whole has nothing missing to
        # disclose and must not be told it has.
        if total > len(rows):
            lines.append("")
            lines.append(truncation_note(len(rows), total))
        # A description is a read of the table's metadata, and it is what an answer
        # about the table's shape is grounded in, so it is attributed.
        return ToolResult(text="\n".join(lines), sources=[name])


# ---------------------------------------------------------------------------
# Tool schemas
#
# THE DESCRIPTIONS ARE PART OF THE CONTRACT, not decoration: they are the only
# place the model learns that a half-named table is a question for the user
# rather than a reason to crawl, and that a table outside the declaration is out
# of scope rather than a permission to route around.
# ---------------------------------------------------------------------------


def _one_arg(name: str, description: str, arg: str, arg_description: str) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": {arg: {"type": "string", "description": arg_description}},
                "required": [arg],
            },
        },
    }


DATA_GENIE_TOOL = _one_arg(
    "data_genie",
    "Ask the curated Genie Space that holds the ACTUAL player, gameplay, and purchase "
    "data. Use for figures, aggregations, overviews, and small samples over the governed "
    "tables. Send one self-contained natural-language question: it has no memory of this "
    "conversation, so spell out the tables, columns, and filters you have established.",
    "question",
    "A self-contained natural-language question.",
)

DICTIONARY_GENIE_TOOL = _one_arg(
    "dictionary_genie",
    "Ask the Data Dictionary Genie Space (metadata only, no underlying data) what a "
    "table or column MEANS. Consult it before querying or reporting on any field whose "
    "meaning is unclear or unlabeled. Never guess a field's meaning. Ask about the FIELD "
    "on its own: naming a wide table alongside it makes this space read that table too, "
    "and the call then times out and returns nothing. Name a table here only when the "
    "table itself is what you are asking about.",
    "question",
    "A question about one definition, field, or rule, without a table qualifying it.",
)

RUN_SQL_TOOL = _one_arg(
    "run_sql",
    "Run one READ-ONLY Databricks SQL statement (Spark/ANSI, SELECT or WITH only) against "
    "the declared tables. Use for data-quality work the Genie spaces do not do well: null "
    "ratios, distinct-key counts, small validating samples. Describe a table before "
    "querying it. Only tables declared with this model can be read. Query the curated "
    "silver and gold tables unless the question genuinely needs a raw_ table, and if it "
    "does, report which grain the figure is at.",
    "sql",
    "One read-only Databricks SELECT/WITH statement naming fully-qualified tables.",
)

QUERY_NAMED_TABLE_TOOL = _one_arg(
    "query_named_table",
    "FAST PATH: run ONE read-only Databricks SELECT/WITH against a table the USER has "
    "named as a fully-qualified catalog.schema.table, without going through Genie. Use "
    "when the user's own message already gives the exact table and just wants it queried "
    "or counted; you write the SQL, they should not have to. Call describe_table first to "
    "map their question to the right columns. Do NOT use for discovery or "
    "column-meaning questions: those go to data_genie and dictionary_genie. If the user "
    "named a table but did not fully qualify it, call request_clarification for the full "
    "catalog.schema.table instead of hunting for it.",
    "sql",
    "One read-only Databricks SELECT/WITH that names a fully-qualified catalog.schema.table.",
)

DESCRIBE_TABLE_TOOL = _one_arg(
    "describe_table",
    "Describe one declared table: columns, data types, and comments. Use before writing "
    "SQL against a table, and to answer a bare 'what is in <table>' with no query at all. "
    "Needs the full catalog.schema.table: if the user under-qualified a name, ask them "
    "for it with request_clarification rather than guessing.",
    "full_name",
    "Fully-qualified table name: catalog.schema.table",
)

LIST_DATA_ASSETS_TOOL = {
    "type": "function",
    "function": {
        "name": "list_data_assets",
        "description": (
            "List the tables this agent is permitted to read, drilling down: no arguments "
            "lists catalogs, a catalog lists its schemas, catalog plus schema lists tables. "
            "This is the declared set the serving principal was actually granted, so "
            "anything it returns is readable and anything it omits is out of scope. Say so "
            "rather than looking for another way in. The listing is names only, so read a "
            "table with describe_table to learn what it holds rather than inferring it "
            "from the name."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "catalog": {"type": "string", "description": "Catalog to list schemas for."},
                "schema": {
                    "type": "string",
                    "description": "Schema to list tables for (requires catalog).",
                },
            },
            "required": [],
        },
    },
}
