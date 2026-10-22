"""Drift: a figure this turn that is the same quantity as an earlier turn's, counted differently.

"Weekly players" on turn one counted accounts that played in the last seven days. On
turn four the same words counted accounts that played in the last thirty, and the
reader holds two numbers that look comparable and are not. This module finds that
case and decides what to do about it. It does everything that can be done without a
model: the definitions, the candidate pairs and the decision. The model is asked ONE
question, whether two definitions are the same quantity, and its answer is checked
by code before it is believed.

Everything here is pure, so each rule can be tested to the byte. `agent.py` owns the
model call and the span.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel
from sqlglot import exp

from provenance import PERSON_UNITS, unit_definition
from sql_policy import SQL_DIALECT, parse_sql, referenced_tables

MAX_DEFINITIONS = 12
MAX_EARLIER_TURNS = 6
MAX_FILTER_CHARS = 160
MAX_CAVEATS = 2
BIG_MOVE = 1.5
JUDGEMENT_TIMEOUT = 12.0
JUDGEMENT_MIN_REMAINING = 5.0
JUDGEMENT_MAX_TOKENS = 700

LEDGER_TYPES = frozenset({"answer", "report", "dashboard", ""})
SQL_TOOLS = ("run_sql", "query_named_table")
_FAILED = re.compile(r"^\s*(ERROR|REFUSED)", re.IGNORECASE)
_TIME_NAMES = ("date", "day", "week", "month", "quarter", "year", "time", "period", "_ts")
_TIME_FUNCTIONS = (
    exp.CurrentDate,
    exp.CurrentTimestamp,
    exp.DateAdd,
    exp.DateSub,
    exp.DateTrunc,
    exp.Interval,
)

QUESTION_TEMPLATE = (
    "Earlier in this conversation, {name} was counted as {earlier}. "
    "This time it would be {current}. Which should I use?"
)
_QUESTION_PATTERN = re.compile(
    r"^Earlier in this conversation, .+ was counted as .+\. "
    r"This time it would be .+\. Which should I use\?$",
    re.DOTALL,
)
CHANGED_CAVEAT = (
    "{name} was counted as {earlier} earlier in this conversation and is counted as "
    "{current} here, so the two figures are not directly comparable."
)
BIG_MOVE_CAVEAT = (
    "{name} is {current} here against {earlier} earlier in this conversation, counted the "
    "same way: a move of {ratio:.1f} times."
)


@dataclass(frozen=True)
class Definition:
    """What one statement counted, in the parts that can differ between two of them."""

    ref: str
    turn_id: str
    unit: str
    tables: frozenset[str]
    lookups: frozenset[str]
    window: frozenset[str]
    filters: frozenset[str]
    figure: float | None
    sql: str = ""

    def plain(self) -> str:
        parts = [f"{unit_definition(self.unit) or self.unit} ({self.unit})"]
        if self.tables:
            parts.append("from " + ", ".join(sorted(self.tables)))
        if self.window:
            parts.append("over " + "; ".join(sorted(self.window)))
        if self.filters:
            parts.append("where " + "; ".join(sorted(self.filters)))
        return ", ".join(parts)

    def same_as(self, other: Definition) -> bool:
        return (
            self.unit == other.unit
            and self.tables == other.tables
            and self.window == other.window
            and self.filters == other.filters
        )


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def _compact(node: exp.Expression) -> str:
    try:
        return " ".join(node.sql(dialect=SQL_DIALECT).split()).lower()
    except Exception:  # noqa: BLE001
        return ""


def _is_time(node: exp.Expression) -> bool:
    if any(isinstance(n, _TIME_FUNCTIONS) for n in node.walk()):
        return True
    return any(
        any(fragment in column.name.lower() for fragment in _TIME_NAMES)
        for column in node.find_all(exp.Column)
    )


def _conjuncts(node: exp.Expression | None) -> list[exp.Expression]:
    if node is None:
        return []
    if isinstance(node, exp.And):
        return _conjuncts(node.left) + _conjuncts(node.right)
    if isinstance(node, exp.Paren):
        return _conjuncts(node.this)
    return [node]


def _bounds(condition: exp.Expression) -> list[str]:
    """A time predicate as one-sided bounds, so BETWEEN equals two comparisons."""

    if isinstance(condition, exp.Between):
        column = _compact(condition.this)
        return [
            f"{column} >= {_compact(condition.args['low'])}",
            f"{column} <= {_compact(condition.args['high'])}",
        ]
    return [_compact(condition)]


def _arg(select: exp.Select, key: str) -> Any:
    """A clause of a select, whichever spelling this sqlglot gives its key."""

    return select.args.get(key) or select.args.get(f"{key}_")


def _scopes(tree: exp.Expression) -> dict[str, exp.Expression]:
    return {cte.alias_or_name.lower(): cte.this for cte in tree.find_all(exp.CTE)}


def _source_select(select: exp.Select, ctes: Mapping[str, exp.Expression]) -> exp.Select | None:
    source = _arg(select, "from")
    if source is None:
        return None
    node = source.this
    if isinstance(node, exp.Subquery) and isinstance(node.this, exp.Select):
        return node.this
    if isinstance(node, exp.Table) and node.name.lower() in ctes:
        target = ctes[node.name.lower()]
        return target if isinstance(target, exp.Select) else None
    return None


def _relation_unit(select: exp.Select, ctes: Mapping[str, exp.Expression], depth: int) -> str:
    """The unit of what COUNT(*) counts: the grain of the relation, when it has one."""

    if depth > 4:
        return ""
    source = _source_select(select, ctes)
    if source is None:
        return ""
    group = _arg(source, "group")
    if group is not None:
        for expression in group.expressions:
            if isinstance(expression, exp.Column) and unit_definition(expression.name):
                return expression.name.lower()
    if source.args.get("distinct"):
        for projection in source.expressions:
            name = projection.alias_or_name.lower()
            if unit_definition(name):
                return name
    return _relation_unit(source, ctes, depth + 1)


def _unit_of(
    projection: exp.Expression,
    select: exp.Select,
    ctes: Mapping[str, exp.Expression],
    depth: int,
) -> str:
    """The counting unit of one projection: a distinct count, or an outer column that is one."""

    for count in projection.find_all(exp.Count):
        inner = count.this
        if isinstance(inner, exp.Distinct) and len(inner.expressions) == 1:
            column = inner.expressions[0]
            if isinstance(column, exp.Column) and unit_definition(column.name):
                return column.name.lower()
        if inner is None or isinstance(inner, exp.Star):
            return _relation_unit(select, ctes, depth)
    inner = projection.this if isinstance(projection, exp.Alias) else projection
    if isinstance(inner, exp.Column) and depth < 4:
        source = _source_select(select, ctes)
        if source is not None:
            for candidate in source.expressions:
                if candidate.alias_or_name.lower() == inner.name.lower():
                    return _unit_of(candidate, source, ctes, depth + 1)
    return ""


def _measure(tree: exp.Expression) -> tuple[exp.Select, exp.Expression, str] | None:
    """The select that counts, its projection and the unit: outermost first."""

    ctes = _scopes(tree)
    outer = tree.find(exp.Select)
    if outer is None:
        return None
    selects = [outer, *[s for s in tree.find_all(exp.Select) if s is not outer]]
    for select in selects:
        for projection in select.expressions:
            unit = _unit_of(projection, select, ctes, 0)
            if unit:
                return select, projection, unit
    return None


def _tables_below(node: exp.Expression, ctes: Mapping[str, exp.Expression]) -> set[str]:
    names: set[str] = set()
    for table in node.find_all(exp.Table):
        if table.name.lower() in ctes and not table.catalog and not table.db:
            names |= _tables_below(ctes[table.name.lower()], ctes)
        elif table.catalog or table.db:
            names.add(".".join(p for p in (table.catalog, table.db, table.name) if p).lower())
    return names


def _numeric_figure(result: str) -> float | None:
    """The one number of an ungrouped single-row result, else None."""

    rows = [line for line in (result or "").splitlines() if line.strip()]
    rows = [line for line in rows if not set(line.strip()) <= set("|-: ")]
    if len(rows) != 2:
        return None
    for cell in re.split(r"\||\t", rows[1]):
        try:
            return float(cell.strip().replace(",", ""))
        except ValueError:
            continue
    return None


def definition_of(block: Mapping[str, Any], ref: str) -> Definition | None:
    """One SQL block as a Definition, or None when it measures nothing comparable."""

    arguments = block.get("arguments") or {}
    sql = str(arguments.get("sql") or "")
    result = str(block.get("result") or "")
    if not sql or _FAILED.search(result):
        return None
    try:
        tree = parse_sql(sql)
        found = _measure(tree)
        if found is None:
            return None
        select, _, unit = found
        ctes = _scopes(tree)
        source = _arg(select, "from")
        tables = _tables_below(source.this, ctes) if source is not None else set()
        lookups: set[str] = set()
        filters: set[str] = set()
        window: set[str] = set()
        for join in _arg(select, "joins") or []:
            on = join.args.get("on")
            using = join.args.get("using")
            joined = _tables_below(join.this, ctes)
            names = {c.name.lower() for c in on.find_all(exp.Column)} if on is not None else set()
            names |= {u.name.lower() for u in using or []}
            if unit in names:
                tables |= joined
            else:
                lookups |= joined
            for condition in _conjuncts(on):
                if _is_time(condition):
                    window.update(_bounds(condition))
                elif isinstance(condition, exp.EQ):
                    left, right = condition.left, condition.right
                    if (
                        isinstance(left, exp.Column)
                        and isinstance(right, exp.Column)
                        and left.name.lower() == right.name.lower() != unit
                    ):
                        filters.add(f"same {left.name.lower()} on both sides"[:MAX_FILTER_CHARS])
        where = _arg(select, "where")
        for condition in _conjuncts(where.this if where is not None else None):
            if _is_time(condition):
                window.update(_bounds(condition))
            elif isinstance(condition, (exp.EQ, exp.In)):
                filters.add(_compact(condition)[:MAX_FILTER_CHARS])
        figure = None if _arg(select, "group") is not None else _numeric_figure(result)
        if not tables:
            tables = set(referenced_tables(tree))
        return Definition(
            ref=ref,
            turn_id=str(block.get("turn_id") or ""),
            unit=unit,
            tables=frozenset(tables),
            lookups=frozenset(lookups),
            window=frozenset(window),
            filters=frozenset(filters),
            figure=figure,
            sql=sql,
        )
    except Exception:  # noqa: BLE001 - extraction must never cost a turn
        return None


def current_definitions(blocks: Sequence[Mapping[str, Any]]) -> list[Definition]:
    """This turn's own measures. The caller leaves out blocks adopted from an earlier turn."""

    out: list[Definition] = []
    for block in blocks:
        if block.get("tool") not in SQL_TOOLS:
            continue
        definition = definition_of(block, f"c{len(out) + 1}")
        if definition is not None:
            out.append(definition)
        if len(out) >= MAX_DEFINITIONS:
            break
    return out


def earlier_definitions(turns: Sequence[Mapping[str, Any]]) -> list[tuple[Definition, str]]:
    """Definitions of the last few answer/report/dashboard turns, newest turn first."""

    ledger = [t for t in turns if t.get("type", "") in LEDGER_TYPES][-MAX_EARLIER_TURNS:]
    out: list[tuple[Definition, str]] = []
    for position in range(len(ledger) - 1, -1, -1):
        turn = ledger[position]
        for number, block in enumerate(turn.get("evidence_blocks") or [], start=1):
            if block.get("tool") not in SQL_TOOLS:
                continue
            definition = definition_of(block, f"e{len(ledger) - position}.{number}")
            if definition is not None:
                out.append((definition, str(turn.get("question") or "")))
            if len(out) >= MAX_DEFINITIONS:
                return out
    return out


def comparable(current: Definition, earlier: Definition) -> bool:
    same_unit = current.unit == earlier.unit or (
        current.unit in PERSON_UNITS and earlier.unit in PERSON_UNITS
    )
    return same_unit and bool(current.tables & earlier.tables)


def candidates(
    current: Sequence[Definition], earlier: Sequence[tuple[Definition, str]]
) -> list[tuple[Definition, Definition, str]]:
    return [(c, e, q) for c in current for e, q in earlier if comparable(c, e)]


# ---------------------------------------------------------------------------
# The judgement call
# ---------------------------------------------------------------------------


class DriftMatch(BaseModel):
    current_ref: str
    earlier_ref: str
    same_quantity: bool
    user_asked: bool
    meaningful: bool
    reason: str
    name: str
    earlier_plain: str
    current_plain: str


class DriftMatches(BaseModel):
    matches: list[DriftMatch]


JUDGEMENT_SYSTEM = (
    "You compare how a measure was counted in two queries from one conversation. For each "
    "pair decide whether both are the SAME quantity a reader would call by one name (for "
    "example 'weekly players'), whether the reader asked for the new way of counting, and "
    "whether the difference is meaningful to a reader. Give a short name for the quantity "
    "and one plain-English phrase for each way of counting it. Use only the refs given."
)


def judgement_prompt(pairs: Sequence[tuple[Definition, Definition, str]], request: str) -> str:
    lines = [f"The reader's request this turn:\n{request}\n", "Pairs:"]
    for current, earlier, question in pairs:
        lines.append(
            json.dumps(
                {
                    "current_ref": current.ref,
                    "current": current.plain(),
                    "earlier_ref": earlier.ref,
                    "earlier": earlier.plain(),
                    "earlier_question": question[:300],
                }
            )
        )
    return "\n".join(lines)


def _one_line(text: Any) -> str:
    return " ".join(str(text or "").split())


@dataclass
class Match:
    current_ref: str
    earlier_ref: str
    same_quantity: bool
    user_asked: bool
    meaningful: bool
    reason: str = ""
    name: str = ""
    earlier_plain: str = ""
    current_plain: str = ""


def parse_matches(
    payload: Any, current: Sequence[Definition], earlier: Sequence[tuple[Definition, str]]
) -> list[Match]:
    """The model's matches, minus any whose refs do not exist or run the wrong way."""

    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            return []
    if not isinstance(payload, dict) or not isinstance(payload.get("matches"), list):
        return []
    current_refs = {d.ref for d in current}
    earlier_refs = {d.ref for d, _ in earlier}
    matches: list[Match] = []
    for raw in payload["matches"]:
        if not isinstance(raw, dict):
            continue
        new, old = raw.get("current_ref"), raw.get("earlier_ref")
        if new not in current_refs or old not in earlier_refs:
            continue
        matches.append(
            Match(
                current_ref=new,
                earlier_ref=old,
                same_quantity=raw.get("same_quantity") is True,
                user_asked=raw.get("user_asked") is True,
                meaningful=raw.get("meaningful") is True,
                reason=_one_line(raw.get("reason")),
                name=_one_line(raw.get("name")),
                earlier_plain=_one_line(raw.get("earlier_plain")),
                current_plain=_one_line(raw.get("current_plain")),
            )
        )
    return matches


# ---------------------------------------------------------------------------
# The decision
# ---------------------------------------------------------------------------


@dataclass
class Outcome:
    action: str = "none"  # none | clarify | caveat
    question: str = ""
    options: list[str] = field(default_factory=list)
    caveats: list[str] = field(default_factory=list)


def replying_to_drift(history: Sequence[Mapping[str, str]], question: str) -> bool:
    """Whether the assistant turn this message follows was a drift question, whole."""

    preceding = list(history)
    for index in range(len(preceding) - 1, -1, -1):
        if preceding[index].get("role") == "user" and preceding[index].get("content") == question:
            del preceding[index]
            break
    if not preceding or preceding[-1].get("role") != "assistant":
        return False
    return bool(_QUESTION_PATTERN.match(_one_line(preceding[-1].get("content") or "")))


def _number(value: float) -> str:
    return f"{value:,.0f}" if float(value).is_integer() else f"{value:,.2f}"


def decide(
    matches: Sequence[Match],
    current: Sequence[Definition],
    earlier: Sequence[tuple[Definition, str]],
    *,
    replying: bool,
) -> Outcome:
    """What to do about the model's matches. All of the judgement about them is here."""

    by_current = {d.ref: d for d in current}
    by_earlier = {d.ref: d for d, _ in earlier}
    newest_first = {d.ref: index for index, (d, _) in enumerate(earlier)}
    seen: set[str] = set()
    outcome = Outcome()
    moves: list[str] = []
    for match in sorted(matches, key=lambda m: newest_first[m.earlier_ref]):
        if match.current_ref in seen or not match.same_quantity:
            continue
        seen.add(match.current_ref)
        new, old = by_current[match.current_ref], by_earlier[match.earlier_ref]
        name = match.name or "This figure"
        if new.same_as(old):
            figures = (new.figure, old.figure)
            if new.figure and old.figure and new.figure > 0 and old.figure > 0:
                high, low = max(figures), min(figures)  # type: ignore[type-var]
                if high / low >= BIG_MOVE and len(moves) < MAX_CAVEATS:
                    moves.append(
                        BIG_MOVE_CAVEAT.format(
                            name=name,
                            current=_number(new.figure),
                            earlier=_number(old.figure),
                            ratio=high / low,
                        )
                    )
            continue
        if match.user_asked:
            continue
        earlier_plain = match.earlier_plain or old.plain()
        current_plain = match.current_plain or new.plain()
        structural = new.unit != old.unit or new.tables != old.tables
        if (structural or match.meaningful) and not replying and outcome.action != "clarify":
            outcome.action = "clarify"
            outcome.question = QUESTION_TEMPLATE.format(
                name=name, earlier=earlier_plain, current=current_plain
            )
            outcome.options = [earlier_plain, current_plain]
        elif len(outcome.caveats) < MAX_CAVEATS:
            outcome.caveats.append(
                CHANGED_CAVEAT.format(name=name, earlier=earlier_plain, current=current_plain)
            )
    if outcome.action == "clarify":
        outcome.caveats = []
        return outcome
    outcome.caveats = [*outcome.caveats, *moves]
    if outcome.caveats:
        outcome.action = "caveat"
    return outcome
