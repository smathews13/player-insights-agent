"""The SQL guard: one parse, one column policy, one manifest check.

MOVED HERE WHOLE from tools.py rather than reimplemented. This module is what
the evidence gateway is built on, and a gateway that held Genie to a SECOND
policy written to resemble this one is the defect it exists to prevent: two
checks meant to agree drift, and the one that drifts is the one nobody reads.
tools.py re-exports every name below, so the move changed no caller and no
behaviour, which is what the existing suite proves.

The only addition is a `code` on each refusal, from `failures`. It is set at the
raise site because the alternative is reading the message back to find out which
control fired, and matching English to classify a governance decision is how a
case-sensitivity bug once made a rule match nothing while exiting 0.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlglot
from sqlglot import exp

from failures import (
    ASSET_NOT_IN_MANIFEST,
    ASSET_UNRESOLVED,
    COLUMN_POLICY_VIOLATION,
    SQL_NOT_READ_ONLY,
    SQL_UNPARSEABLE,
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
# root that is not a SELECT, a named table that is not three parts, a table
# expression that resolves to no name. A statement that names no table at all
# (constants, arithmetic) is allowed: there is nothing to index. There is no
# fall-back path, because falling back to weaker checking is how the previous
# version passed all of the above.
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

    `code` says WHICH control fired, from the stable taxonomy in `failures`. It
    is optional so that a refusal raised outside this module (or by an older
    caller) still constructs, and an empty code is treated as unknown by
    `failures.spec`, which fails closed rather than reading as benign.

    `remedy` says whether a DIFFERENT QUERY SHAPE would be accepted, and what to
    change. Most refusals have none: a cross-label bridge is a restriction on the
    answer, so every route to it is closed and re-asking is circumvention. A few
    are about how the statement is written, and for those the loop has to say
    something different, because telling a model not to re-ask while the refusal
    it just read recommends counting is two instructions it will pick between at
    random. Empty by default, so a refusal is unremediable unless someone decided
    it was not.
    """

    def __init__(self, message: str, code: str = "", remedy: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.remedy = remedy


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
            "Rewrite it as one simple read-only statement.",
            SQL_UNPARSEABLE,
        ) from error
    statements = [statement for statement in statements if statement is not None]
    if not statements:
        raise SqlRefused("No SQL statement was supplied.", SQL_UNPARSEABLE)
    if len(statements) > 1:
        raise SqlRefused(
            f"Only one statement is allowed; {len(statements)} were supplied. "
            "Send a single read-only SELECT.",
            SQL_NOT_READ_ONLY,
        )
    tree = statements[0]
    if not isinstance(tree, _READ_ONLY_ROOTS):
        raise SqlRefused(
            f"Only one read-only SELECT/WITH statement is allowed; this is a "
            f"{type(tree).__name__.upper()} statement.",
            SQL_NOT_READ_ONLY,
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
                "unnamed sources are not allowed. Name the table.",
                ASSET_UNRESOLVED,
            )
        if not catalog and not database:
            if name.lower() in cte_names:
                continue
            raise SqlRefused(
                f"'{name}' is not a fully-qualified table. Every table must be named as "
                "catalog.schema.table so the guard can check it against what this model "
                "was granted.",
                ASSET_UNRESOLVED,
            )
        if not catalog or not database:
            raise SqlRefused(
                f"'{table.sql(dialect=SQL_DIALECT)}' is only partly qualified. Name it as "
                "catalog.schema.table.",
                ASSET_UNRESOLVED,
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


#: What one query's output columns carry: output name (lower-cased) mapped to the
#: restricted columns whose real values would arrive under it.
_Carried = dict[str, frozenset[str]]


def _child_of_type(node: exp.Expression, wanted: type[exp.Expression]) -> exp.Expression | None:
    """One direct clause of a SELECT, found by NODE TYPE rather than by arg name.

    `sqlglot` renamed these keys between majors (`from` became `from_`, `with`
    became `with_`), and a policy that reads them by name goes quiet on the
    upgrade instead of failing: it finds nothing, follows nothing, and refuses
    nothing, while every test that asserts a refusal for a column NAME still
    passes. Types are the part of that API that has not moved.
    """

    for value in node.args.values():
        if isinstance(value, wanted):
            return value
    return None


def _source_expressions(select: exp.Select) -> list[exp.Expression]:
    """The things this SELECT reads FROM, one node each, joins included."""

    nodes: list[exp.Expression] = []
    from_clause = _child_of_type(select, exp.From)
    if from_clause is not None:
        nodes.append(from_clause.this)
    for value in select.args.values():
        if isinstance(value, list):
            nodes.extend(item.this for item in value if isinstance(item, exp.Join))
    return nodes


def _query_carries(query: exp.Expression, ctes: dict[str, _Carried]) -> _Carried:
    """What a query's own output columns would hand back, by output name.

    Recursive, so a CTE or a derived table is answered before whatever reads it,
    and `ctes` is threaded down so a subquery can see the CTEs above it.

    Anything this function does not model returns nothing, which is safe only
    because the by-name check in `_exposed_columns` is independent of it: a
    projection that names `email` is caught whether or not the source it came
    from was understood.
    """

    if isinstance(query, exp.Subquery):
        return _query_carries(query.this, ctes)

    # Read BEFORE the branch below, because a WITH in front of a set operation
    # hangs off the set operation and not off either branch, so resolving the
    # CTEs per-branch leaves both branches unable to see them.
    scope = dict(ctes)
    with_clause = _child_of_type(query, exp.With)
    if with_clause is not None:
        # In order, because a later CTE may read an earlier one.
        for cte in with_clause.expressions:
            scope[cte.alias_or_name.lower()] = _query_carries(cte.this, scope)

    if isinstance(query, exp.Union):
        # `Except` and `Intersect` are `Union` subclasses. A set operation returns
        # whichever branch's values, so a branch that carries an identifier makes
        # the whole operation carry it. Merged by name rather than by position:
        # names that do not line up union into a bigger map, which refuses more
        # rather than less.
        merged: dict[str, frozenset[str]] = {}
        for branch in (query.this, query.expression):
            for name, carried in _query_carries(branch, scope).items():
                merged[name] = merged.get(name, frozenset()) | carried
        return merged

    if not isinstance(query, exp.Select):
        return {}

    sources: dict[str, _Carried] = {}
    for node in _source_expressions(query):
        if isinstance(node, exp.Subquery):
            sources[node.alias_or_name.lower()] = _query_carries(node.this, scope)
        elif isinstance(node, exp.Table) and not node.catalog and not node.db:
            # A bare name is a CTE reference; a real table's columns are caught
            # by name instead, which is why an unknown one contributes nothing.
            sources[node.alias_or_name.lower()] = scope.get(node.name.lower(), {})

    def carried_by(column: exp.Column) -> frozenset[str]:
        name = column.name.lower()
        if name in UNRETURNABLE_COLUMNS:
            return frozenset({name})
        if column.table:
            return sources.get(column.table.lower(), {}).get(name, frozenset())
        found: frozenset[str] = frozenset()
        for source in sources.values():
            found |= source.get(name, frozenset())
        return found

    carries: dict[str, frozenset[str]] = {}

    def carry(name: str, restricted: frozenset[str]) -> None:
        if restricted:
            carries[name] = carries.get(name, frozenset()) | restricted

    for position, projection in enumerate(query.expressions):
        if isinstance(projection, exp.Star):
            # `*` republishes every column of every source under its own name.
            for source in sources.values():
                for name, restricted in source.items():
                    carry(name, restricted)
            continue
        if isinstance(projection, exp.Column) and isinstance(projection.this, exp.Star):
            for name, restricted in sources.get(projection.table.lower(), {}).items():
                carry(name, restricted)
            continue
        restricted = frozenset()
        for column in projection.find_all(exp.Column):
            if _within_aggregate(column, projection):
                continue
            restricted |= carried_by(column)
        carry(projection.alias_or_name.lower() or f"_{position}", restricted)

    return carries


def _exposed_columns(tree: exp.Expression) -> list[str]:
    """Restricted columns this statement would RETURN in a row of its RESULT.

    THE QUESTION IS WHAT LEAVES, NOT WHERE THE COLUMN IS WRITTEN. Checking every
    SELECT in the tree answered a different question, and refused the analysis the
    product is for: week-over-week retention is a self-join over the set of
    players active in each week, so `platformid_accountid` must be projected by a
    CTE for the counts above it to intersect. Nothing individual reaches the
    result — the outer SELECT returns `count(DISTINCT ...)` and a ratio — and the
    refusal even advised counting, which is what the query was already doing one
    level up. There was no way to write the question that the guard would accept.

    So the values are FOLLOWED instead. `_query_carries` answers, for one query,
    which of its output columns would hand back a restricted value; a column
    read from a CTE or a derived table inherits that, an alias carries it, `*`
    republishes it, and a counting aggregate ends it. A restricted column is
    exposed only if it still carries at the top.

    That keeps every leak refused. `SELECT x FROM (SELECT email AS x FROM p) s`
    is refused because `x` carries `email` out; `SELECT c FROM (SELECT max(email)
    AS c FROM p) x` because `max` is not a reduction; `SELECT * FROM (SELECT
    platformid_accountid FROM p) s` because the star republishes it. What is no
    longer refused is the case where the value provably stops inside the
    statement: a CTE that isolates ids per week, a join key, an `IN` predicate.

    Projections are not the only way out, which is why two scans below are
    unconditional. A `LATERAL VIEW explode(array(email))` names `email` in the
    FROM clause and projects the alias, so the restricted column is in no
    `select.expressions` anywhere and the alias is what the warehouse reports as
    the result column, invisible to both halves of the defence, and it emits a
    different real value on every row. `UNPIVOT (val FOR col IN (email,
    display_name))` is the same shape in ANSI clothing: the identifiers hang off
    the table's `pivots`, and the result column is called `val`. Neither is
    followed through the value graph — they are refused wherever they appear,
    because the mapping from one to a result column is exactly what is opaque
    about them. A `LATERAL` wrapping a subquery is skipped, because that
    subquery is a source like any other and is followed as one.
    """

    exposed: list[str] = []

    def expose(name: str) -> None:
        if name in UNRETURNABLE_COLUMNS and name not in exposed:
            exposed.append(name)

    for restricted in _query_carries(tree, {}).values():
        for name in sorted(restricted):
            expose(name)

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
            "keys out explicitly with ON.",
            COLUMN_POLICY_VIOLATION,
            remedy="write the join keys out explicitly with ON instead of NATURAL",
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
            "refusal.",
            COLUMN_POLICY_VIOLATION,
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
            "returned and give the counts instead.",
            COLUMN_POLICY_VIOLATION,
            remedy=(
                "keep the identifier inside a CTE, a subquery or a join key, and make every "
                "column of the OUTERMOST select a count, a ratio, or a column that identifies "
                "nobody"
            ),
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

    A parse failure. Returning no tables leaves the caller to decide, and the
    evidence gateway is where that decision now lives: an unattributable result
    contributes nothing rather than arriving with a caveat attached. This
    function stays deliberately silent about it, because it is also used for
    plain attribution.

    RESIDUAL RISK, stated plainly rather than implied by the absence of a check:
    an unparseable statement is uninspected here, and so is a `viz` attachment
    that carries no SQL at all. `SELECT *` is the sharper one: a static parse
    cannot expand a star without the table's schema.

    That last one is closed elsewhere, twice over. `_genie_rows` fetches the
    result set and runs `restricted_output_columns` over the schema the fetch
    returns, which is the same authoritative check the SQL path makes, and the
    gateway will not admit an attachment whose schema it never saw.
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

    A statement that names no table (``SELECT 1``, arithmetic on constants) is
    allowed and returns an empty list. Governance indexes only fully-qualified
    ``catalog.schema.table`` names; no table is not the same as an under-qualified
    one. A named table that is not three parts is still refused.
    """

    tree = parse_sql(sql)
    tables = referenced_tables(tree)
    declared = {name.lower(): name for name in readable}
    rejected = sorted(name for name in tables if name.lower() not in declared)
    if rejected:
        raise SqlRefused(
            f"Not in the declared table set: {', '.join(rejected)}. The serving principal is "
            "granted only the tables declared with the model, so this query would fail at the "
            "warehouse. Use list_data_assets to see what is readable.",
            ASSET_NOT_IN_MANIFEST,
        )

    refuse_restricted_columns(tree)
    # Attributed with the declaration's own spelling, so one table cited two ways
    # in two answers is not read as two tables. Empty when the statement named
    # no table: that is a read of nothing, not an unresolved source.
    return [declared[name.lower()] for name in tables]
