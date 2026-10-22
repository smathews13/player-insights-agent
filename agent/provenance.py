"""What an answer's figures are figures OF, read off the statements that ran.

Four facts, per statement: the table it read, what it measured, the time range it
covered, and which rows it kept. An answer already says which tables it read and
carries the SQL, and neither closes the gap this module exists for: "8,413 active
players" is a different claim depending on whether the window was thirty days or
a year, and on whether one title was filtered out. A reader who has to open the
SQL to find out is a reader who does not find out.

DERIVED FROM THE PARSE, NEVER FROM THE MODEL'S PROSE. The synthesiser could be
asked to state its window and filter, and it would: fluently, and from whatever
it remembered of a result set rather than from the query. That is the failure this
codebase has already had in every other place a claim about a run was left to the
model. Every field below comes from `sqlglot`'s tree for the exact string that was
executed, which is the same parse the SQL guard admits the statement on.

IT FAILS CLOSED, AND SILENCE IS THE FAILURE MODE. A statement that will not parse
contributes nothing; a table that cannot be resolved leaves the source empty; a
window nothing in the WHERE clause describes stays empty. Empty renders as
nothing at all in the app rather than as "unknown" or as a guess. The reason is
that a wrong window is worse than no window: it is a specific, checkable claim
about the population behind a number, and a reader has no way to tell a derived
one from an invented one.

NO VALUE OF AN IDENTIFYING COLUMN IS PUBLISHED. A filter is the one field here
built from literals a question can put there, so `player_id = 'abc'` would carry
a player's key into an answer, a Lakebase row and a trace -- the three places the
column policy exists to keep it out of. The column is named and the value is
withheld, so the reader still learns that the population was narrowed to one
player without being handed which. Column NAMES are published: `count(DISTINCT
platformid_accountid)` is the product working, and a name is not a person.
"""

from __future__ import annotations

from sqlglot import exp

from sql_policy import (
    BLOCKED_COLUMNS,
    SQL_DIALECT,
    UNRETURNABLE_COLUMNS,
    SqlRefused,
    parse_sql,
    referenced_tables,
)

#: Statements described per answer. A run that queried four tables has four
#: things to say; a run that queried forty has a wall of text where its answer
#: used to be, and the app shows this block above the caveats.
MAX_DERIVATIONS = 4

#: Measures named in one line before the rest are summarised as a count.
MAX_METRICS = 3

#: Predicates named in one filter before the rest are summarised as a count.
MAX_PREDICATES = 3

#: Ceiling on any one rendered field. Generous enough for a real predicate and
#: mean enough that a pathological literal cannot turn a labelled fact into a
#: paragraph -- or carry a question's text into a record that does not keep
#: questions.
MAX_FIELD_CHARS = 120

#: What a withheld literal reads as. Not the value, and not silence: a filter
#: that vanished would report a narrower population as the whole one.
WITHHELD = "(withheld)"

#: Columns whose VALUES are never published here. The SQL guard's own two lists
#: name every identifying column in the model this was built against, and the
#: fragments below catch the equivalent column in a catalog it was not: these
#: lists are specific to one data model, and the app runs against whatever
#: catalog an operator configured.
_IDENTIFYING_COLUMNS = BLOCKED_COLUMNS | UNRETURNABLE_COLUMNS

#: Name fragments that mean a column identifies a PERSON. Deliberately not a
#: blanket rule on `_id` or `_name`: `title_name = 'IFR2'` is the single most
#: useful thing a filter can say, and withholding it to be safe would leave the
#: field saying "a filter was applied" -- which is worse than saying nothing,
#: because it takes up the space where the fact belongs.
_IDENTIFYING_FRAGMENTS = (
    "email",
    "gamertag",
    "username",
    "user_id",
    "userid",
    "player",
    "account",
    "customer",
    "subscriber",
    "phone",
    "address",
)

#: Column-name fragments that mean a predicate is about TIME rather than about
#: which rows. Matched on the name because the type is not in the statement: a
#: parse cannot tell a `DATE` column from a `STRING` one, and the answer to
#: "what window did this cover" has to come from somewhere.
_TIME_FRAGMENTS = (
    "date",
    "day",
    "week",
    "month",
    "quarter",
    "year",
    "timestamp",
    "_ts",
    "ts_",
    "time",
    "period",
)

#: Functions whose presence in a predicate makes it about time whatever the
#: column is called. `activity >= current_date() - INTERVAL 30 DAYS` is a window.
_TIME_FUNCTIONS = (
    exp.CurrentDate,
    exp.CurrentTimestamp,
    exp.DateAdd,
    exp.DateSub,
    exp.DateTrunc,
    exp.Interval,
)


def derivations(statements: list[str]) -> list[dict[str, str]]:
    """Source, metric, window and filter for each statement that ran.

    Returns plain dicts rather than the contract model, so this module can be
    read and tested without the answer schema, and so `agent.py` keeps the one
    place that decides what an answer carries.

    A statement contributes nothing when it will not parse, and no entry is
    returned at all when every field of it came out empty: four blank labels
    under an answer is a block that reads as broken rather than as quiet.
    """

    derived: list[dict[str, str]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for statement in statements:
        if len(derived) >= MAX_DERIVATIONS:
            break
        entry = _derive(statement)
        if entry is None:
            continue
        key = (entry["source"], entry["metric"], entry["window"], entry["filter"])
        # A run that asked the same question twice, or that described a table and
        # then queried it the same way, says it once.
        if key in seen:
            continue
        seen.add(key)
        derived.append(entry)
    return derived


def _derive(statement: str) -> dict[str, str] | None:
    try:
        tree = parse_sql(statement)
    except SqlRefused:
        # Not an error worth reporting anywhere: the statement either never ran
        # (the guard refused it) or is not a SELECT at all (a DESCRIBE, which has
        # no window and no metric). Either way there is nothing to say about it.
        return None

    select = tree.find(exp.Select)
    if select is None:
        return None

    entry = {
        "source": _source(tree),
        "metric": _metric(select),
        "window": "",
        "filter": "",
    }
    entry["window"], entry["filter"] = _conditions(select)
    if not any(entry.values()):
        return None
    return entry


def _source(tree: exp.Expression) -> str:
    """The table this statement read, or the first of several.

    One name rather than a list, because this is the source OF the metric beside
    it and a join's second table is not usually where the measure came from. The
    answer's own `sources` block is the complete list and stays authoritative.
    """

    try:
        tables = referenced_tables(tree)
    except SqlRefused:
        # A statement the guard could not attribute. It happens on the Genie
        # path, which admits a message whose tables were resolvable and discloses
        # when they were not; the source is left empty rather than guessed from
        # the text, which is how an earlier version of the sources block came to
        # cite a table nobody read.
        return ""
    return tables[0] if tables else ""


#: Counting units: the identifier columns a distinct count runs over, each with
#: what one value of it IS. Written for this catalog's own keys and extended by
#: fragment below for a catalog it was not written against. A unit is only ever
#: reported from a parse of `COUNT(DISTINCT <column>)`, never from what the
#: model said it counted.
UNIT_DEFINITIONS: dict[str, str] = {
    "platformid_accountid": "one row per account",
    "player_id": "one row per player",
    "account_id": "one row per account",
    "user_id": "one row per user",
    "profile_id": "one row per profile",
    "platform_id": "one row per platform account",
    "device_id": "one row per device",
    "session_id": "one row per session",
}

#: The units that are a PERSON, so that a count by one and a count by another are
#: the same quantity as far as drift detection is concerned.
PERSON_UNITS = frozenset(
    {"platformid_accountid", "player_id", "account_id", "user_id", "profile_id", "platform_id"}
)

_UNIT_FRAGMENTS = (
    ("player", "one row per player"),
    ("account", "one row per account"),
    ("user", "one row per user"),
    ("profile", "one row per profile"),
    ("session", "one row per session"),
    ("device", "one row per device"),
)


def unit_definition(column: str) -> str:
    """What one value of an identifier column is, or "" when it is not a known unit."""

    name = column.lower()
    if name in UNIT_DEFINITIONS:
        return UNIT_DEFINITIONS[name]
    if not name.endswith("id") and not name.endswith("key"):
        return ""
    for fragment, definition in _UNIT_FRAGMENTS:
        if fragment in name:
            return definition
    return ""


def counted_unit(projection: exp.Expression) -> str:
    """The column of a `COUNT(DISTINCT <column>)` in this projection, or "".

    Only a distinct count over ONE plain column counts as counting units:
    `COUNT(*)` counts rows, `SUM(x)` adds a measure, and neither says what the
    rows are.
    """

    for count in projection.find_all(exp.Count):
        inner = count.this
        if not isinstance(inner, exp.Distinct) or len(inner.expressions) != 1:
            continue
        column = inner.expressions[0]
        if isinstance(column, exp.Column) and unit_definition(column.name):
            return column.name.lower()
    return ""


def _metric(select: exp.Select) -> str:
    """What the statement measured, named as the query named it.

    The alias wins where there is one: a query that wrote `AS active_players`
    has already said what its number means, better than `count(DISTINCT …)` says
    it. Aggregates only -- a projection of plain columns is a row listing rather
    than a measure, and calling it a metric would put a label on something that
    is not one.
    """

    measures: list[str] = []
    for projection in select.expressions:
        if not list(projection.find_all(exp.AggFunc)):
            continue
        alias = projection.alias if isinstance(projection, exp.Alias) else ""
        measure = alias or _compact(projection)
        unit = counted_unit(projection)
        if measure and unit:
            measure = f"{measure} \u00b7 counted by {unit} ({unit_definition(unit)})"
        if measure and measure not in measures:
            measures.append(measure)
    return _joined(measures, MAX_METRICS)


def _conditions(select: exp.Select) -> tuple[str, str]:
    """The WHERE clause, split into the window and the row filter.

    One pass over the top-level conjuncts. Anything that is not a plain AND of
    conditions -- an OR, a subquery predicate -- is rendered as it stands rather
    than taken apart, because half of an OR is a filter the query did not apply.
    """

    where = select.args.get("where")
    if where is None:
        return "", ""

    windows: list[str] = []
    filters: list[str] = []
    lower_bound: dict[str, str] = {}
    upper_bound: dict[str, str] = {}
    for condition in _conjuncts(where.this):
        rendered = _condition(condition)
        if not rendered:
            continue
        if not _is_time(condition):
            filters.append(rendered)
            continue
        # The column is dropped from a window and kept in a filter, because the
        # two fields are asking different things. "Window" already says the range
        # is a range of time, so which date column carried it is plumbing; "which
        # rows" is unreadable without the column that narrowed them.
        if isinstance(condition, exp.Between):
            windows.append(
                _clip(f"{_compact(condition.args['low'])} → {_compact(condition.args['high'])}")
            )
            continue
        # A pair of one-sided comparisons on one column is one window, and
        # `>= 2025-06-01` beside `< 2025-07-01` reads as two unrelated facts.
        column, bound, value = _bound(condition)
        if column and bound == "lower":
            lower_bound[column] = value
        elif column and bound == "upper":
            upper_bound[column] = value
        else:
            windows.append(rendered)
    for column, low in lower_bound.items():
        high = upper_bound.pop(column, "")
        windows.insert(0, f"{low} → {high}" if high else f"≥ {low}")
    for _, high in upper_bound.items():
        windows.append(f"≤ {high}")
    return _joined(windows, MAX_PREDICATES), _joined(filters, MAX_PREDICATES)


def _conjuncts(condition: exp.Expression) -> list[exp.Expression]:
    """The top-level ANDed conditions, flattened. Everything else stands alone."""

    if isinstance(condition, exp.And):
        return _conjuncts(condition.left) + _conjuncts(condition.right)
    if isinstance(condition, exp.Paren):
        return _conjuncts(condition.this)
    return [condition]


def _is_time(condition: exp.Expression) -> bool:
    if any(isinstance(node, _TIME_FUNCTIONS) for node in condition.walk()):
        return True
    return any(_time_named(column.name) for column in condition.find_all(exp.Column))


def _time_named(name: str) -> bool:
    lowered = name.lower()
    return any(fragment in lowered for fragment in _TIME_FRAGMENTS)


def _bound(condition: exp.Expression) -> tuple[str, str, str]:
    """A one-sided comparison as (column, which side, the value), or empties."""

    if not isinstance(condition, (exp.GT, exp.GTE, exp.LT, exp.LTE)):
        return "", "", ""
    left, right = condition.left, condition.right
    if not isinstance(left, exp.Column):
        return "", "", ""
    side = "lower" if isinstance(condition, (exp.GT, exp.GTE)) else "upper"
    return left.name.lower(), side, _compact(right)


def _condition(condition: exp.Expression) -> str:
    """One predicate, rendered short, with any identifying literal withheld.

    Rendered from the tree rather than sliced out of the statement's text, so
    what appears is what was executed and not whatever the original string had
    around it.
    """

    if _identifying(condition):
        columns = sorted({column.name.lower() for column in condition.find_all(exp.Column)})
        if not columns:
            return ""
        return f"{', '.join(columns)} = {WITHHELD}"

    if isinstance(condition, exp.In):
        column = _compact(condition.this)
        values = condition.expressions
        shown = ", ".join(_compact(value) for value in values[:MAX_PREDICATES])
        extra = len(values) - MAX_PREDICATES
        if extra > 0:
            shown = f"{shown}, +{extra}"
        return _clip(f"{column} in ({shown})")
    if isinstance(condition, exp.Between):
        return _clip(
            f"{_compact(condition.this)} "
            f"{_compact(condition.args['low'])} → {_compact(condition.args['high'])}"
        )
    return _clip(_compact(condition))


def _identifying(condition: exp.Expression) -> bool:
    """Whether any column in this predicate identifies a person.

    ANY column, not the one being compared: a predicate mentioning a player key
    anywhere is rendered without its literals, because which literal belongs to
    which column is not a distinction worth getting wrong here.
    """

    for column in condition.find_all(exp.Column):
        name = column.name.lower()
        if name in _IDENTIFYING_COLUMNS:
            return True
        if any(fragment in name for fragment in _IDENTIFYING_FRAGMENTS):
            return True
    return False


def _compact(node: exp.Expression) -> str:
    """A node as one line of lower-cased SQL, whitespace collapsed."""

    try:
        rendered = node.sql(dialect=SQL_DIALECT)
    except Exception:  # noqa: BLE001 - a generator failure must not lose the answer
        return ""
    return " ".join(rendered.split()).lower()


def _joined(parts: list[str], limit: int) -> str:
    if not parts:
        return ""
    shown = ", ".join(parts[:limit])
    extra = len(parts) - limit
    if extra > 0:
        shown = f"{shown}, +{extra}"
    return _clip(shown)


def _clip(text: str) -> str:
    if len(text) <= MAX_FIELD_CHARS:
        return text
    return f"{text[: MAX_FIELD_CHARS - 1]}…"
