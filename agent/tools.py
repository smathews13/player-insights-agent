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
from databricks.sdk.service.dashboards import GenieMessage, MessageStatus
from databricks.sdk.service.sql import ExecuteStatementRequestOnWaitTimeout

import evidence
import failures
import runtime_settings
import sdk_attribution
from config import Settings, format_genie_space
from evidence import EvidenceGateway, EvidenceRefused, Verdict

# The SQL guard lives in `sql_policy` so the evidence gateway can be built on the
# SAME objects rather than on a second policy that resembles them. Re-exported
# here because this module has been the guard's address since it was written, and
# a move that renamed every caller's import would be a move nobody could review.
from sql_policy import (  # noqa: F401 - re-exported for callers and tests
    BLOCKED_COLUMNS,
    SQL_DIALECT,
    UNRETURNABLE_COLUMNS,
    SqlRefused,
    fully_qualified_tables,
    inspect_generated_sql,
    is_read_only_sql,
    parse_sql,
    referenced_tables,
    refuse_restricted_columns,
    restricted_output_columns,
    validate_sql,
)

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
#: it is checked. Sized against the turn: `MAX_RUN_SECONDS` is 150 and the endpoint
#: is killed at about 240, so a single call may spend a third of the turn and no more.
#: The SDK's own default is twenty minutes, which cannot be spent (the request is
#: already dead), so it is not a timeout, only a way to return nothing.
GENIE_TIMEOUT_SECONDS = 45.0

#: How long a call may wait for a warehouse that HAS NOT STARTED YET, which is a
#: different wait from the one above and is why it has its own number.
#:
#: `GENIE_TIMEOUT_SECONDS` is sized against how long a space takes to ANSWER, and
#: as a bound on that it is right. It was also, until this change, the bound on
#: getting a warehouse up, and as a bound on that it is simply wrong: our own demo
#: warehouse is warm before anybody asks it anything, so the question is answered
#: in a couple of seconds and the deadline is never approached, while a customer
#: workspace starts its warehouse on the first question of the day and routinely
#: needs longer than forty-five seconds to do it. The step was then reported as a
#: Genie failure -- to the model, to the trace, and to the person watching -- for
#: an outage that was not one.
#:
#: WARMING UP IS NOT THE SAME EVENT AS BEING SLOW TO ANSWER, so the two are timed
#: separately: the answer budget above starts when the warehouse is up, and this
#: is what may be spent before that. Generous, because the thing being waited for
#: takes minutes in the worst case and nothing else in the turn can proceed
#: without it either.
GENIE_WAREHOUSE_START_SECONDS = 150.0

#: What one warehouse wait must LEAVE BEHIND for the rest of the turn.
#:
#: Named at the compiled 150s default. The live wait uses
#: `runtime_settings.answer_reserve_seconds()` so a 30s minimum budget is not
#: blocked by a 25s flat hold-back. Tests pin this constant as the default-budget
#: share both tiers agree on.
GENIE_BUDGET_RESERVE_SECONDS = 25.0

#: The LONGEST gap between two checks. The wait starts at
#: `GENIE_FIRST_POLL_SECONDS` and doubles up to this, so a question Genie answers
#: in 1.5s is noticed at 1.5s instead of waiting out a full fixed cycle, while a
#: slow one still settles to one check every couple of seconds rather than
#: hammering the space. Named as it always was because a test that pins the
#: interval to zero to stop the suite really sleeping still wants one knob: a cap
#: of zero makes every gap zero.
GENIE_POLL_SECONDS = 2.0

#: The first gap. Small enough that a fast answer is not made to wait for the
#: poller, large enough not to spend a round trip per 100ms on a question that
#: was always going to take ten seconds.
GENIE_FIRST_POLL_SECONDS = 0.5

#: Statuses the SDK's waiter does not treat as terminal, which is why it can poll
#: a finished message until the twenty-minute default expires. Each maps to what
#: to tell the model, because "Genie failed" and "Genie's result expired" call for
#: different next steps.
_GENIE_TERMINAL_FAILURES = {
    MessageStatus.FAILED: "could not answer",
    MessageStatus.CANCELLED: "was cancelled",
    MessageStatus.QUERY_RESULT_EXPIRED: "produced a result that has since expired",
}

#: Statuses that mean the warehouse behind the space has not started yet. Held as
#: a set rather than tested against the one member, because this is the property
#: the wait branches on and a second status meaning the same thing should join it
#: here rather than add a branch somewhere else.
_GENIE_WAREHOUSE_STARTING = frozenset({MessageStatus.PENDING_WAREHOUSE})

#: What a non-terminal status means when the deadline arrives, so the model gets a
#: next step rather than a stopwatch reading. Written to be read FIRST, before any
#: number: the sentence a person needs is "the warehouse was still starting", and
#: a stopwatch reading in front of it is what turned this into a wall of stack in
#: the trace.
_GENIE_STALL_HINTS = {
    MessageStatus.EXECUTING_QUERY: (
        "Its query was still running. Ask for a narrower slice: fewer dimensions or "
        "a shorter window."
    ),
}

#: Said when the wait ended with the warehouse still starting.
#:
#: NOT AN ERROR SENTENCE, and the difference is the point of this whole path.
#: Nothing failed, nothing was refused, and the question may well be answerable
#: on the next call; what happened is that the turn could not afford to keep
#: waiting. So the model is told what is missing, told it is not a blocker on its
#: own, and pointed at the tools that do not need this warehouse.
GENIE_WAREHOUSE_STARTING_GUIDANCE = (
    "This is a cold warehouse, not an outage and not a refusal, so do not report the "
    "space as broken or the data as unavailable. Carry on with the tools that do not "
    "need it -- search_tagged_assets, list_data_assets and describe_table -- and note "
    "the definition as one this run could not look up rather than guessing at it."
)


class WarehouseStarting(TimeoutError):
    """The warehouse behind a dependency had not started before the turn's limit.

    A distinct type because it takes a distinct path: every other way a Genie
    wait can end is an error the step reports as a failure, and this one is a
    step that produced nothing while nothing went wrong. Subclasses `TimeoutError`
    so a caller that has not been taught the difference still treats it as the
    wait running out rather than as something unrecognised.

    Carries the seconds waited rather than baking them into a sentence, because
    the caller knows which space was asked and this does not.
    """

    def __init__(self, waited: float):
        self.waited = waited
        super().__init__(f"the SQL warehouse behind it was still starting after {waited:.0f}s")


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


def unscope_dictionary_question(question: str, declared: Sequence[str]) -> tuple[str, list[str]]:
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


#: Said when the dictionary space answered without reading the dictionary.
#:
#: Worth one sentence because the product's claim about a definition is that it is
#: GOVERNED: looked up in the dictionary table rather than composed by the space.
#: Asked about a field nothing documents, Genie answers by selecting a literal,
#: which is true, useful, and not a read of anything. Admitting that as evidence
#: is right; letting it be reported as the documented definition is not.
#:
#: Only for a query attachment that named no table. A text-only reply is the
#: ordinary shape of a definitional answer, and noting it there would put a
#: warning on every question the space answers well.
DEFINITION_NOT_READ_NOTE = (
    "Definition note: the dictionary space answered this without reading the dictionary "
    "table, so what it says is that space's own account of the field rather than a governed "
    "entry it looked up. Use it, and do not call it the documented definition. If it says the "
    "field is not documented, say so plainly: that is the answer, not a gap in this run."
)


def normalise_dictionary_question(question: str) -> str:
    """One key for the same definition question asked twice.

    Case, surrounding whitespace and trailing punctuation only. Nothing here
    rewrites the question or tries to decide that two DIFFERENT questions mean
    the same thing: the key decides whether a Genie round trip is skipped, and a
    key that collapsed "what does spend mean" onto "what does spend_usd mean"
    would answer one question with the other's definition.
    """

    return re.sub(r"\s+", " ", question).strip().rstrip("?.").casefold()


def combine_dictionary_questions(questions: Sequence[str]) -> str:
    """One question that asks a batch of definition questions together.

    WHY THIS EXISTS. The model asks this space one field at a time -- a measured
    run spent eight back-to-back calls and 84 seconds inside a single step
    looking up eight columns, and another asked for a column it had already
    looked up two steps earlier. Each of those is a full Genie round trip, and
    the space's own shape is what makes that avoidable: it is on the enumeration
    budget precisely because it answers with LISTS of definitions, so a question
    naming eight fields costs one round trip rather than eight.

    Removing the work rather than overlapping it, which matters for two reasons
    beyond latency. Eight concurrent questions would still be eight questions
    Genie has to plan and bill. And the repeat brake that keeps a run from
    spending its budget failing the same way twice is keyed on the tool NAME, so
    a step holding several calls to one tool cannot run them together without
    giving that brake up; one call has nothing to brake against.

    The questions are carried VERBATIM and numbered rather than merged into a
    sentence of our own. A rewrite here would be this module deciding what the
    model meant, and the whole reason `unscope_dictionary_question` is narrow is
    that a question the model did not ask gets answered as though it had.
    """

    seen: dict[str, str] = {}
    for question in questions:
        text = str(question).strip()
        if not text:
            continue
        seen.setdefault(normalise_dictionary_question(text), text)
    asked = list(seen.values())
    if len(asked) <= 1:
        return asked[0] if asked else ""
    numbered = " ".join(f"({index}) {text}" for index, text in enumerate(asked, start=1))
    return f"Answer each of these separately, and label each answer: {numbered}"


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


#: The Statement Execution API's own bounds on a synchronous wait. Values outside
#: them are rejected by the platform rather than clamped, so the clamp is ours: a
#: turn with four seconds left used to send `wait_timeout=1s` and get an argument
#: error back where it expected a cancelled statement.
#:
#: 5–50 seconds is the documented range (`Ns`, N in 5..50, or `0s` for async).
#: 50s is the ceiling for this wait style. The platform default is hybrid
#: (`10s` + CONTINUE, then poll); we stay on CANCEL at the ceiling so a still-
#: running statement is stopped and reported as too slow, not left running.
SQL_WAIT_CEILING_SECONDS = 50
SQL_WAIT_FLOOR_SECONDS = 5

#: Total allowance for a statement that ANSWERS the question. 50s is the
#: platform ceiling for a synchronous wait, so 300s is a different call, not a
#: larger synchronous wait: wait 50s with CONTINUE, then poll. `_sql_allowance`
#: keeps both the remaining-turn bound and the answer reserve above this value,
#: so 300s is an allowance rather than a promise to wait that long.
ANSWER_SQL_WAIT_SECONDS = 300
SQL_WAIT_SECONDS = ANSWER_SQL_WAIT_SECONDS
SQL_WAIT_TIMEOUT = f"{SQL_WAIT_CEILING_SECONDS}s"

#: What a DISCOVERY read waits. Stays at the sync ceiling and never polls: a
#: tag listing or DESCRIBE is the result the turn can most afford to lose, and
#: polling it would spend the write-up's share on metadata.
DISCOVERY_WAIT_SECONDS = SQL_WAIT_CEILING_SECONDS

#: Gaps between get_statement checks while an answering read is past the sync
#: ceiling. Same shape as the Genie waiter: start small, double up to this.
SQL_POLL_SECONDS = 2.0
SQL_FIRST_POLL_SECONDS = 0.5
#: A cancel request races statement completion. Read the authoritative state for
#: a short bounded window before deciding that RUNNING was the final outcome.
SQL_CANCEL_SETTLE_SECONDS = 2.0
SQL_CANCEL_SETTLE_POLL_SECONDS = 0.1
SQL_CANCEL_SETTLE_MAX_POLLS = 20

#: A statement cancelled for slowness is retried ONCE, and only while the turn
#: could still do something with the answer. The first attempt is usually what
#: started the warehouse, so the second one often lands on a warm one -- but a
#: retry that leaves no budget for the rest of the run has spent the turn to
#: produce a discovery hint nobody gets to use.
SQL_RETRY_MIN_REMAINING_SECONDS = 40
SQL_RETRY_RESERVE_SECONDS = 20

#: States that mean the statement was too slow or had not begun, as against being
#: REJECTED. Only these are worth running a second time: a rejected statement is
#: rejected identically on the retry, and a denial is about who is asking.
_SQL_TOO_SLOW_STATES = frozenset({"CANCELED", "PENDING", "RUNNING"})
#: After CONTINUE, these mean keep polling. CANCELED is a result, not a wait.
_SQL_STILL_RUNNING = frozenset({"PENDING", "RUNNING"})

#: What each non-success state means for the model's next move.
#:
#: The cancellation text names no number. The wait is clamped by what is left
#: of the turn, so a sentence claiming "after 30s" would be wrong on most of
#: the paths that produce it, and wrong in the direction that matters: it
#: reads as a statement about the query when the cause is often a warehouse
#: that had not finished starting.
_SQL_STATE_MEANINGS = {
    "CANCELED": (
        "the statement was still running when its wait timeout was reached and was "
        "cancelled, so it did not fail: the warehouse may still have been starting, or the "
        "statement may be too broad -- narrow it (fewer rows, fewer joins, a shorter "
        "window) and try again"
    ),
    "PENDING": "the warehouse had not started the statement yet; try again in a moment",
    "RUNNING": "the statement is still running rather than failed; narrow it and try again",
    "FAILED": "the warehouse rejected the statement",
    "CLOSED": "the result was closed before it could be read",
}

#: How `statement_failure` opens every sentence it writes. Read back so a caller
#: holding the message can recover which state produced it without a second
#: channel carrying the same fact alongside it.
_SQL_STATE_PREFIX = re.compile(r"^SQL ([A-Z_]+):")


def _was_too_slow(detail: str) -> bool:
    """Whether this failure text says the statement was SLOW, not rejected."""

    match = _SQL_STATE_PREFIX.match(detail or "")
    return bool(match) and match.group(1) in _SQL_TOO_SLOW_STATES


def reports_dependency_unavailable(text: str) -> bool:
    """Whether a tool result is a dependency being unavailable, not a finding.

    Two tools return one of these instead of raising -- the tag search when the
    tag views cannot be read, and a Genie call when the warehouse behind it is
    still starting -- because in both cases the run can carry on without them.
    The loop still has to tell the two apart from a result it can use: a call
    that returned nothing to learn must not be filed as evidence, memoised as a
    definition, or shown as a step that went fine.

    Keyed on the shared failure code, which both texts carry in parentheses and
    nothing else in a tool result does.
    """

    return f"({failures.DEPENDENCY_UNAVAILABLE})" in (text or "")


#: Appended to the table listing when the run executes as the endpoint's invoker.
#:
#: The manifest records what the DEPLOYMENT declared, not what this caller may
#: read, and under user authorization those differ invisibly from in here. So the
#: model is told to treat a refusal as an answer about access rather than as a
#: hint to find a table that works.
GRANTS_DECIDE_NOTE = (
    "Access note: these are the tables this deployment declares, not a promise that you "
    "can read them. This run executes as the caller, so their Unity Catalog grants decide "
    "which of these return rows. If a table cannot be read, say that the caller lacks "
    "access to it and name it. Do NOT substitute a different table and present the result "
    "as the answer to the question that was asked."
)


#: One Unity Catalog identifier part, for `resolve_table`'s input.
#:
#: Deliberately not "a word starting with a letter": real catalogs here begin
#: with a digit. It doubles as the shape check that keeps a name the model
#: invented out of the comparison, and nothing that passes it carries a quote,
#: a space or a dot into the matching below.
_IDENT_RE = re.compile(r"^[A-Za-z0-9_]+$")


def _quoted(full_name: str) -> str:
    return ".".join("`" + part.replace("`", "``") + "`" for part in full_name.split("."))


def _string_literal(value: str) -> str:
    """One SQL string literal, escaped.

    Local rather than imported from the semantic layer, which is an optional
    component: a deployment with no AI Search index still has tags, and a tool
    that stopped working when that module was absent would be a coupling nobody
    asked for. Backslash first, or the doubled quote gets escaped again.
    """

    return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


#: Where the tag search stops rendering. Tags are short, so this is thousands of
#: them, and a discovery tool that returned more text than the manifest listing
#: would have replaced the problem it exists to solve.
MAX_TAG_RESULT_CHARS = 8_000

#: Rows asked of `information_schema`. A ceiling rather than a page: this is a
#: discovery call, and a caller whose estate has more tagged columns than this
#: needs a narrower tag rather than all of them.
MAX_TAG_ROWS = 2_000

#: Said whenever the tag tables could not be read, with what to do instead.
#:
#: `information_schema` per catalog is NOT guaranteed to the serving principal or
#: to the caller: the views are backed by the `system` catalog, which is granted
#: separately from the tables they describe, so this tool is the one piece of
#: discovery that can be unavailable on an estate where everything else works.
#: That is a reason to degrade, not to fail: the tables are still in the manifest
#: and still readable, and a turn that dies here loses a question that the older
#: discovery path answers perfectly well.
_TAGS_ALTERNATIVES = (
    "This is discovery, not data, so the question can still be answered: use "
    "list_data_assets and describe_table to find the tables, or search_semantics "
    "where this deployment has a semantic layer. Do not tell the user their tables "
    "are untagged on the strength of this."
)

TAGS_UNAVAILABLE_GUIDANCE = (
    _TAGS_ALTERNATIVES + " And do not retry it: reading tags needs a "
    "grant on information_schema that a read of the tables themselves does not."
)

#: The same tool being unavailable for the OPPOSITE reason, and the difference
#: changes what the model should do next. A missing grant will be missing on
#: every attempt, so retrying spends the turn to learn nothing. A warehouse that
#: had not finished starting will very likely be up by the next call, and the
#: attempt that just timed out is usually what started it. Telling the model "do
#: not retry" in that case is advice against the one thing that would work.
TAGS_SLOW_GUIDANCE = (
    _TAGS_ALTERNATIVES + " Nothing was refused here, so the tags may well be "
    "readable once the warehouse is up: one later attempt is reasonable if the turn has "
    "room, but do not spend the run waiting on it."
)


def _unattributable_reason(verdicts: Sequence[Verdict], asked: str = "") -> str:
    """Why a whole Genie answer was withheld, in the model's next-step vocabulary.

    Built from the verdicts rather than written once, because the three ways this
    happens call for different next steps and the old single sentence sent the
    model to do the wrong thing: a space that exposed no SQL may answer the same
    question fine when asked for a table rather than a chart, while a statement
    the guard cannot parse will not.

    IT NAMES THE CALL, because this sentence is not only read by the model. It is
    the `output` of a tool stage, so it appears in the progress list a stakeholder
    watches, next to several other calls, and "Genie ran a query" does not say
    which space was asked or which question was dropped. A reader who cannot tell
    which of two Genie calls was refused cannot tell whether the refusal mattered.
    """

    reasons = list(dict.fromkeys(verdict.reason for verdict in verdicts if verdict.reason))
    detail = (
        " ".join(reasons)
        if reasons
        else "Genie returned figures with nothing behind them that could be traced to a table."
    )
    call = f"the call to Genie space {asked}" if asked else "this call"
    return (
        f"{detail} Nothing from {call} was used, including its wording, because the "
        "figures are stated inside it and a number nobody can trace to a read is a number "
        "the reader cannot check. THE NEXT STEP THAT WORKS IS TO ASK THIS SAME SPACE AGAIN "
        "FOR A TABLE: say you want the rows or the grouping rather than a chart or a summary, "
        "because a table comes back with the query behind it and that query can be attributed. "
        "Do that before considering any other tool, and do not repeat the figures from this "
        "attempt: they were not admitted as evidence."
    )


#: The SQL standard's insufficient-privilege class, which is what a warehouse
#: answers when the executing identity is not granted an object the statement
#: named. It arrives as a FIELD on the statement's status rather than as prose,
#: which is why it is read first: a structured code survives a platform
#: rewording, and the wordings do differ between Unity Catalog and the legacy
#: metastore.
SQL_STATE_INSUFFICIENT_PRIVILEGE = "42501"

#: The object is not there, or the caller may not even know whether it is.
#: Deliberately NOT treated as a denial; see `statement_denied`.
SQL_STATE_UNDEFINED_TABLE = "42P01"

#: The same denial as an identifier in the message, for the paths that carry no
#: `sql_state`.
#:
#: IDENTIFIERS RATHER THAN ENGLISH, on exactly the reasoning `_SQL_ENTITLEMENT_MARKERS`
#: in `agent.py` is built on. The observed refusal also contains "does not have
#: permission SELECT", and matching that phrase is the trap this deliberately
#: avoids: it appears in failures about entirely unrelated objects, and a false
#: positive tells a reader they were denied when something else broke.
_DENIAL_IDENTIFIERS = ("INSUFFICIENT_PERMISSIONS", "PERMISSION_DENIED")


def statement_sql_state(response: Any) -> str:
    """The SQLSTATE the warehouse returned, or "".

    Read off the status and off the error, because the two transports put it in
    different places and neither is guaranteed: the REST body carries
    `status.sql_state`, and some SDK versions hang it on the error instead.
    """

    status = getattr(response, "status", None)
    for holder in (status, getattr(status, "error", None)):
        state = getattr(holder, "sql_state", None)
        if state:
            return str(state)
    return ""


def statement_denied(response: Any) -> bool:
    """Whether this statement was refused on PRIVILEGES, as against anything else.

    Keyed on the SQLSTATE first and the bracketed error identifiers second, never
    on prose.

    A DENIAL BEATS AN ABSENCE when a message carries both, which the platform does
    emit on some paths. `classifyDenial` in `server/routes/access-verification.ts`
    already settled that the same way and for the same reason: the privilege half
    is the more specific claim, whereas not-found is the one that could mean
    either thing. That is why the not-found case is answered LAST rather than
    first, and it is answered explicitly rather than by falling off the end,
    because it is the one this must never swallow.
    """

    sql_state = statement_sql_state(response)
    if sql_state == SQL_STATE_INSUFFICIENT_PRIVILEGE:
        return True
    status = getattr(response, "status", None)
    detail = (getattr(getattr(status, "error", None), "message", "") or "").upper()
    if any(marker in detail for marker in _DENIAL_IDENTIFIERS):
        return True
    if sql_state == SQL_STATE_UNDEFINED_TABLE:
        # Not a denial, and saying so out loud. A reader told they lack access to
        # an object that is not there goes and asks for a grant nobody can make.
        return False
    return False


#: What a denial is allowed to say. It names no catalog, no schema and no table.
#:
#: The warehouse's own sentence names every object the statement could not reach,
#: which is the correct thing for it to tell a client holding the credential and
#: the wrong thing for this agent to carry forward: the message travels into the
#: tool result, the evidence log, a trace stage persisted to Lakebase and a
#: stakeholder's screen, so an object somebody may not read would be disclosed to
#: exist, by name, to the person who was just refused it. Same decision, and the
#: same reasoning, as `AuthorizationRefused.disclosable` on the app side.
#:
#: The operator's copy is not lost. `statement_failure` prints it in full where
#: the refusal is read.
#: Kept SHORT on purpose as well as anonymous. `sql_object_denial` wraps it and
#: caps the result at 600 characters, and the first draft spent so many of those
#: explaining the withholding that the remedy was truncated away mid-word. The
#: reasoning belongs in this comment; what the reader gets is the fact and the
#: fix.
DENIAL_WITHOUT_OBJECT = (
    "the identity it ran as is not granted something the statement named, so no rows "
    "were produced. This is a missing grant rather than an outage, and what was refused "
    "is deliberately not named here"
)


class SqlDenied(RuntimeError):
    """A statement the warehouse refused on privileges.

    A TYPE rather than a string the caller re-matches, so the classification is
    made once, where the response is read, and read back by `isinstance` instead
    of by a second regex over a message that has already been redacted. Its
    `str()` is safe to show: it names no object.
    """

    def __init__(self, message: str, sql_state: str = "") -> None:
        super().__init__(message)
        self.sql_state = sql_state


def statement_state(response: Any) -> str:
    """The warehouse's own word for what happened to this statement.

    Read once and shared, because two callers now need it for different reasons:
    `statement_failure` turns it into a sentence, and the executor asks whether a
    non-success was SLOW (worth one retry) or REJECTED (not).
    """

    status = getattr(response, "status", None)
    return getattr(getattr(status, "state", None), "value", None) or "UNKNOWN"


def statement_failure(response: Any) -> str:
    """Why this statement's rows cannot be read, or "" when they can.

    One reading of the state for the statement the agent runs AND the one Genie
    ran, because the states are not interchangeable and this has already been
    got wrong once: with the SDK's default `on_wait_timeout` a statement still
    RUNNING came back and was reported as `statement failed`, and the model is
    instructed to relay a failure rather than work around it, so a slow query
    became a wrong answer about the data. A second reading of the same states,
    written separately for Genie, would be free to drift back into that.

    A PRIVILEGE DENIAL IS REDACTED HERE rather than at either call site, for that
    same reason. Both callers put this string somewhere a reader can reach it:
    the direct path raises it, and the Genie path folds it into the tool result.
    Redacting at one of them would leave the other leaking, and redacting at both
    is the second reading this function exists to prevent.
    """

    state = statement_state(response)
    status = getattr(response, "status", None)
    if state == "SUCCEEDED":
        return ""
    detail = getattr(getattr(status, "error", None), "message", "") or ""
    if statement_denied(response):
        # The operator's half, in full and in one line, beside the SQLSTATE that
        # classified it. Nothing downstream of here ever sees this text.
        print(
            f"[sql] DENIED (SQLSTATE {statement_sql_state(response) or 'unreported'}): "
            f"{' '.join(detail.split())}"
        )
        return f"SQL {state}: {DENIAL_WITHOUT_OBJECT}"
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
    #: What the evidence gateway decided about each thing this call produced.
    #:
    #: Carried BESIDE `sources` rather than replacing it, deliberately and for
    #: now: `sources` is read by the answer contract, the RunLog, the app and a
    #: dozen tests, and a field that changes meaning in the same release as a new
    #: control is a change nobody can review. These are the same facts with the
    #: decision and its reason attached, which is what the run has to persist.
    verdicts: tuple[Verdict, ...] = ()


class PlayerInsightTools:
    def __init__(
        self,
        settings: Settings,
        workspace_client: Any | None = None,
        user_authorized: bool = False,
        allow_unattributed_figures: bool = False,
    ):
        self.settings = settings
        if workspace_client is None:
            # NO DEFAULT CLIENT. A bare `WorkspaceClient()` inside a serving
            # container authenticates as the model version's own principal, so
            # this default turned "the caller forgot to pass a client" into a
            # full set of data tools reading the customer's tables as us. The
            # only two callers always passed one, which is why nobody saw it.
            raise ValueError(
                "PlayerInsightTools needs the client its data calls will authenticate as. "
                "There is deliberately no default: the one this would have built reads as "
                "this endpoint rather than as whoever asked."
            )
        self.workspace = workspace_client
        #: True when `workspace_client` carries the endpoint invoker's downscoped
        #: token rather than the model version's passthrough credentials. Changes
        #: nothing about how a call is made: it changes what the DECLARED
        #: manifest means, which `list_data_assets` has to say out loud.
        self.user_authorized = user_authorized
        #: The release's escape valve for a missing metric layer. A constructor
        #: argument rather than a `Settings` field, because it is a decision a
        #: release makes rather than a value that names a workspace, which is the
        #: same reason `user_authorized` is one. Defaults to strict here as well as
        #: at every other layer: a test, a script or a caller that predates the
        #: flag gets the safe behaviour without knowing the flag exists.
        self.allow_unattributed_figures = allow_unattributed_figures

    # -----------------------------------------------------------------------
    # Admission control
    # -----------------------------------------------------------------------

    def identity_mode(self) -> str:
        """Which identity this instance's data calls authenticate as.

        Derived from how the client was built rather than asked of the workspace,
        because it goes on every piece of evidence and an API round trip per
        candidate would be a call per tool call. The signed-in-user workstream
        owns the VERIFIED answer, which is a stronger claim than this one: this
        says which credentials the client holds, not that the endpoint accepted
        them. Where the two can differ, the run's own trace records both.
        """

        return (
            failures.IDENTITY_SIGNED_IN_USER
            if self.user_authorized
            else failures.IDENTITY_SERVICE_PRINCIPAL
        )

    def gateway(self) -> EvidenceGateway:
        """The admission control for ONE call.

        Built per call, not cached on the instance. One `PlayerInsightTools` is
        built per container for the passthrough path and Model Serving handles
        requests concurrently, so anything cached here that carries an identity
        would stamp the first caller's identity onto everybody after them,
        silently, with correct-looking answers. That is the same reason the
        user-authorized client is rebuilt per request.
        """

        return EvidenceGateway(
            self.settings.readable_tables,
            identity_mode=self.identity_mode(),
            # The manifest is the reviewed release boundary for every SQL route.
            # Genie spaces are live objects and may gain tables after this model
            # was logged; accepting those attachments would silently widen the
            # artifact without a model release.
            enforce_genie_manifest=True,
            allow_unattributed_figures=self.allow_unattributed_figures,
        )

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

        THERE ARE TWO DEADLINES, not one, because there are two different waits
        happening and one number could only ever be right for one of them. A
        space that is ANSWERING gets `GENIE_TIMEOUT_SECONDS`, unchanged, and it
        is the right bound: past that the question is too big for this turn. A
        warehouse that is STARTING gets `GENIE_WAREHOUSE_START_SECONDS`, because
        nothing about the question is wrong and the wait is for infrastructure
        that takes as long as it takes. Time spent starting is then given back to
        the answer budget, so a warehouse that comes up at forty seconds still
        gets its full allowance to answer rather than arriving to find the
        deadline already behind it.

        Both are bounded by the turn, and the warehouse one is bounded by the
        turn LESS a reserve: it ends early enough that the finder still has
        budget for the tools that do not need this warehouse. Ending that way
        raises `WarehouseStarting` rather than `TimeoutError`, which is what
        stops a cold start being reported as a failed Genie call.

        THE GAP BETWEEN CHECKS GROWS, from 0.5s up to `GENIE_POLL_SECONDS`. It
        used to be that interval flat, so a question Genie finished in 0.3s was
        reported at 2s: the answer sat done while the turn slept out a cycle it
        had no reason to wait for. Most questions asked here are fast, so that
        was being paid on nearly every call.

        THE NEW CHECKS ARE ADDED BETWEEN THE OLD ONES, NEVER INSTEAD OF THEM,
        and the clamp below is what makes that true. Doubling on its own does not
        give you that: 0.5s then 1s then 2s puts checks at 0.5s, 1.5s, 3.5s, so
        an answer arriving at 1.6s would have been reported at 3.5s where the
        flat interval had it at 2s. Faster on average and sometimes slower is a
        bad trade for a latency change, and the case it loses on is the ordinary
        one. Clamped to the old grid the checks fall at 0.5s, 1.5s, 2s, 4s, 6s --
        a superset of the old 2s, 4s, 6s -- so this cannot report anything later
        than before, and reports a sub-second answer up to 1.5s sooner. The first
        check is still immediate, as it was.
        """

        started = time.perf_counter()
        turn = runtime_settings.remaining_seconds()
        # The turn is the hard bound on everything below. Nothing here may run
        # past it, whatever the per-phase caps say.
        turn_deadline = started + turn
        answering_budget = min(GENIE_TIMEOUT_SECONDS, turn)
        # `max` against the answer budget so this can only ever LENGTHEN the wait
        # for a starting warehouse. On a short turn the reserve can exceed what
        # is left, and a warehouse allowance shorter than the answer allowance
        # would make a cold start fail sooner than it used to.
        starting_budget = max(
            answering_budget,
            min(
                GENIE_WAREHOUSE_START_SECONDS,
                max(0.0, turn - runtime_settings.answer_reserve_seconds()),
            ),
        )
        wait = self.workspace.genie.start_conversation(space_id, question)
        status: Any = None
        poll = GENIE_FIRST_POLL_SECONDS
        #: Seconds already observed with the warehouse down, closed off each time
        #: the status moves on. Added to the answer deadline so a space that spent
        #: forty seconds warming up is not then asked to answer in five.
        warming = 0.0
        warming_since: float | None = None
        while True:
            message = self.workspace.genie.get_message(
                space_id, wait.conversation_id, wait.message_id
            )
            status = getattr(message, "status", None)
            now = time.perf_counter()
            if status in _GENIE_WAREHOUSE_STARTING:
                if warming_since is None:
                    warming_since = now
            elif warming_since is not None:
                warming += now - warming_since
                warming_since = None
            if status == MessageStatus.COMPLETED:
                return message
            if status in _GENIE_TERMINAL_FAILURES:
                raise RuntimeError(
                    f"Genie {_GENIE_TERMINAL_FAILURES[status]} after "
                    f"{now - started:.0f}s: "
                    f"{getattr(message, 'error', None) or 'no detail was returned'}."
                )
            if warming_since is not None:
                deadline = min(started + starting_budget, turn_deadline)
            else:
                deadline = min(started + warming + answering_budget, turn_deadline)
            if now >= deadline:
                waited = now - started
                if warming_since is not None:
                    # NOT an error. The turn ran out of affordable waiting; the
                    # space is fine and the warehouse is on its way up.
                    raise WarehouseStarting(waited)
                name = getattr(status, "value", status)
                # The plain reason FIRST, the stopwatch after it: this string is
                # what a reader sees in the trace, usually clipped, and a clipped
                # sentence should still say what went wrong.
                hint = _GENIE_STALL_HINTS.get(status, "Try a narrower question or run SQL.")
                raise TimeoutError(
                    f"{hint} Genie did not answer within the {waited:.0f}s this turn could "
                    f"give it; it was still {name or 'working'}."
                )
            # Read from the module each time, so a test that pins the cap to zero
            # to stop the suite sleeping zeroes every gap rather than only the
            # ones that had already grown past it.
            cap = GENIE_POLL_SECONDS
            elapsed = now - started
            # When the flat interval would next have checked. Used as a CEILING,
            # which is what keeps the new schedule a refinement of the old one
            # rather than a different one that is sometimes worse.
            next_on_grid = ((int(elapsed // cap) + 1) * cap - elapsed) if cap > 0 else 0.0
            time.sleep(max(0.0, min(poll, next_on_grid, deadline - time.perf_counter())))
            poll *= 2

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
        tool: str = "",
        space_title: str = "",
        definitional: bool = False,
    ) -> ToolResult:
        """Ask one Genie space, and admit only what can be attributed.

        THE PROSE IS WITHHELD, NOT CAVEATED, when nothing that produced figures
        could be attributed. That is the change, and it is the whole change: the
        old path returned Genie's sentence with a note saying the sources were
        incomplete, and a sentence like "8,413 active players" IS the figure. A
        reader who has been told the sources are incomplete still reads the
        number, so a caveat was never a control, and the number was not checkable
        by the person it was shown to.

        All-or-nothing at the MESSAGE level, because Genie's prose and Genie's
        query arrive as separate attachments and nothing says which sentence
        belongs to which statement. So a message with no admitted evidence
        contributes nothing at all, and a message with some keeps what was
        admitted and discloses that the account is partial. That is the same
        rule the column policy has always used on this path, for the same
        reason: the prose is shared, and the values are in it.

        `definitional` says which of the two things this space is being asked
        for, and it changes what an unattributable attachment MEANS rather than
        loosening anything. The dictionary space is asked what a field means; the
        data space is asked for figures. A definition with no table behind it is
        an ordinary and often correct answer ("nothing documents this field"),
        while a figure with no table behind it is the whole reason this gate
        exists. Defaulted False so a caller that does not say gets the strict
        rule.
        """

        space_label = format_genie_space(space_id, space_title)
        asked_preamble = f"Asking Genie space {space_label}."
        combined_preamble = f"{asked_preamble}\n\n{preamble}" if preamble else asked_preamble

        with mlflow.start_span(name=name, span_type="TOOL") as span:
            span.set_inputs(
                {
                    "question": question,
                    "space_id": space_id,
                    "space_title": space_title or None,
                    "space_label": space_label,
                }
            )
            try:
                message = self._await_genie(space_id, question)
            except WarehouseStarting as starting:
                # Returned, not raised, and that is the whole fix for the cold
                # customer workspace. Raising here puts the step on the loop's
                # failure path: red in the trace, counted against the repeat
                # brake, and reported to the model as an outage it should relay.
                # None of that is true of a warehouse that is coming up, and the
                # finder has other tools it can spend the rest of the turn on.
                #
                # THE PLAIN REASON IS THE FIRST THING IN IT, and the "Asking
                # Genie space ..." preamble every other result opens with is
                # dropped here. The trace clips this line, so what survives is
                # whatever comes first, and what a reader needs from a clipped
                # line is why they got nothing -- not which space was asked, and
                # certainly not the head of a stack trace.
                unavailable = (
                    f"GENIE UNAVAILABLE ({failures.DEPENDENCY_UNAVAILABLE}): The SQL warehouse "
                    f"behind Genie space {space_label} was still starting after "
                    f"{starting.waited:.0f}s, so this question was not answered. "
                    f"{GENIE_WAREHOUSE_STARTING_GUIDANCE}"
                )
                span.set_outputs({"text": unavailable, "unavailable": True})
                return ToolResult(text=unavailable)
            gate = self.gateway()
            text_parts: list[str] = []
            sql_parts: list[str] = []
            sources: list[str] = []
            verdicts: list[Verdict] = []
            #: Attachments that produced FIGURES: a `query` attachment ran a
            #: statement, a `viz` attachment is a chart of one. Counted against
            #: how many of them the gateway admitted, because the interesting
            #: state is "this answer has numbers in it and none of them can be
            #: traced".
            value_bearing = 0
            #: Admitted, so its prose and rows may be used. Includes a WAIVED
            #: verdict, which is admitted precisely because the release said so.
            admitted = 0
            #: Admitted AND traceable to a table or a governed metric. Separate
            #: from `admitted` only because of the waiver, and the separation is
            #: the point: a waived result may be shown and still cites nothing, so
            #: counting it as attributed would produce an answer whose Sources
            #: block reads as complete while being empty, which is the exact
            #: under-reporting this workstream exists to remove.
            attributed = 0
            #: True once a query attachment has been judged as a DEFINITION, so
            #: the text-only fallback below does not judge the same call twice
            #: and record two verdicts for one question.
            definition_judged = False
            attachments = list(message.attachments or [])
            #: Whether the message carried any prose at all, read from the whole
            #: message before the loop starts. A Genie message's text attachment
            #: can arrive AFTER the query attachment it belongs to (the live
            #: dictionary space returns the query, then its suggested questions,
            #: then the answer), and whether a dictionary call produced a
            #: definition cannot be answered from the attachments seen so far.
            carries_text = any(
                getattr(getattr(item, "text", None), "content", None) for item in attachments
            )
            for attachment in attachments:
                text = getattr(getattr(attachment, "text", None), "content", None)
                query = getattr(attachment, "query", None)
                if query:
                    generated = str(getattr(query, "query", None) or "")
                    # Attribution AND the column check off one parse. The column
                    # policy is not optional just because the query already ran:
                    # Genie hands back a sentence with the values IN it, so
                    # refusing before that text is returned is what keeps an
                    # address out of the evidence log, the synthesis prompt, a
                    # persisted trace stage and a stakeholder's screen. That
                    # refusal RAISES and drops every attachment of the message,
                    # including the ones that were fine, on both routes.
                    if definitional:
                        definition_judged = True
                        verdict = gate.admit_definition_query(
                            tool or name, generated, has_definition_text=carries_text
                        )
                    else:
                        verdict = gate.admit_genie_query(tool or name, generated)
                    verdicts.append(verdict)
                    #: Whether this attachment belongs in the attribution tally at
                    #: all. Every one does on the figures route. On the definitions
                    #: route only a lookup that actually read a table does: a
                    #: definition that named none is not a figure whose source is
                    #: missing, and counting it as one would put an attribution
                    #: warning on the honest answer "nothing documents this field"
                    #: and report the step as partial for a reason no reader can
                    #: act on. So it is admitted, and it is not counted.
                    counted = bool(verdict.sources) or not definitional
                    if counted:
                        value_bearing += 1
                    if not verdict.accepted:
                        # Contributes nothing: no source, no statement, no rows,
                        # and none of its prose. Its rows are not even fetched,
                        # which also saves the round trip.
                        continue
                    if counted:
                        admitted += 1
                        if not verdict.waived:
                            attributed += 1
                    if text:
                        text_parts.append(text)
                    description = getattr(query, "description", None)
                    if description:
                        text_parts.append(f"Query interpretation: {description}")
                    if not counted:
                        # Its prose is the definition and is kept. Its STATEMENT
                        # and its ROWS are not: a statement that read no table is
                        # not the source of anything, so presenting it as the
                        # query behind the answer would claim a read that did not
                        # happen, and a result set nothing can attribute is the
                        # exact shape this gate refuses to render.
                        text_parts.append(DEFINITION_NOT_READ_NOTE)
                        continue
                    sql_parts.append(generated)
                    sources.extend(verdict.sources)
                    # After the column policy above, never before: otherwise
                    # this is a second route to the values the SQL was just
                    # refused for returning.
                    rows = self._genie_rows(space_id, message, attachment, budget)
                    if rows:
                        text_parts.append("Query result:\n" + rows)
                    continue
                if getattr(attachment, "viz", None):
                    value_bearing += 1
                    verdict = gate.admit_genie_visualization(tool or name)
                    verdicts.append(verdict)
                    if not verdict.accepted:
                        continue
                    admitted += 1
                    if not verdict.waived:
                        attributed += 1
                if text:
                    text_parts.append(text)

            if value_bearing and not admitted:
                # Nothing here can be traced to a table or a governed metric, so
                # there is no answer to caveat. Raised rather than returned so it
                # takes the loop's REFUSAL path: recorded beside the guards,
                # reported to the model as a control that fired, and explicitly
                # not a hint to go and ask a different surface.
                rejected = [verdict for verdict in verdicts if not verdict.accepted]
                raise EvidenceRefused(
                    Verdict(
                        outcome=evidence.REFUSED,
                        # The refused attachment's OWN candidate when there was
                        # only one, so the record keeps its statement fingerprint
                        # and can say which attempt failed. A synthesized
                        # candidate carries no hash, which a test caught by asking
                        # the record to identify the attempt.
                        candidate=rejected[0].candidate
                        if len(rejected) == 1
                        else gate.candidate(
                            tool or name, evidence.ROUTE_GENIE, evidence.PAYLOAD_VISUALIZATION
                        ),
                        code=failures.GENIE_UNATTRIBUTABLE,
                        reason=_unattributable_reason(verdicts, space_label),
                    ),
                    verdicts,
                )
            if value_bearing > attributed:
                # Said in the evidence as well as on the flag, because the flag
                # needs a caller to act on it and this reaches the model that is
                # about to describe where the figures came from.
                #
                # Two endings, because the two states are not the same and one
                # sentence for both would be false in one of them: under the strict
                # default the unattributable parts are GONE, and under a waiver
                # they are in the text the model is reading. Telling the model
                # something was withheld when it was not invites it to apologise
                # for a gap that is not there, or worse, to describe figures it can
                # see as missing.
                whole = "this answer" if attributed == 0 else "part of this answer"
                ending = (
                    "The figures that could not be attributed are still shown above, and this "
                    "release permits that, so report them as indicative and say they cannot be "
                    "traced to a table."
                    if admitted > attributed
                    else "The parts that could not be attributed have been withheld, so do not "
                    "describe this as everything the space returned."
                )
                text_parts.append(
                    f"Attribution note: the tables behind {whole} could not be determined, so "
                    "the sources are incomplete. Say they are incomplete rather than listing "
                    f"what happened to resolve. {ending}"
                )
            body = "\n\n".join(text_parts) or "(Genie returned no text.)"
            if not value_bearing and not definition_judged:
                # Text only: a definition, or an answer that read nothing. Not a
                # gap, and flagging it would cry wolf on every definitional
                # question, which a run-level caveat already covers.
                verdicts.append(gate.admit_definition(tool or name, has_text=bool(text_parts)))
            result = ToolResult(
                # The preamble says what was ASKED, so it belongs above the
                # answer and outside the "did Genie say anything" test: a call
                # whose question was rewritten has to disclose that even when
                # the space came back with nothing. The space label is always
                # present so a trace names which space answered.
                text=f"{combined_preamble}\n\n{body}",
                sql="\n\n".join(sql_parts),
                sources=list(dict.fromkeys(sources)),
                # Silence here would be the under-reporting failure again, one
                # layer along: an answer whose Sources block looks complete
                # because the parse quietly returned nothing. Compared against
                # `attributed` rather than `admitted` so that a waiver, which
                # admits without attributing, cannot silence this.
                attributed=value_bearing == attributed,
                verdicts=tuple(verdicts),
            )
            span.set_outputs(
                {
                    "text": result.text[:4000],
                    "sql": result.sql[:4000],
                    "sources": result.sources,
                    "attributed": result.attributed,
                    # The decisions, so a trace answers "was anything rejected,
                    # and under which control" without the run record beside it.
                    "validation": [verdict.as_record() for verdict in verdicts],
                }
            )
            return result

    def data_genie(self, question: str) -> ToolResult:
        return self._genie(
            self.settings.data_genie_space_id,
            question,
            "data_source_finder.data_genie",
            tool="data_genie",
            space_title=self.settings.data_genie_space_title,
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
            tool="dictionary_genie",
            space_title=self.settings.dictionary_genie_space_title,
            # This space is asked what a field MEANS, so its output is judged as a
            # definition. See `admit_definition_query`: holding it to the figures
            # rule refused it for answering correctly.
            definitional=True,
        )

    # -----------------------------------------------------------------------
    # SQL
    # -----------------------------------------------------------------------

    def _sql_allowance(self, wait_seconds: int) -> float:
        """How much of this statement's allowance the turn can still afford.

        Answering statements are the only ones that poll past the synchronous
        ceiling, and they must leave the same reserve the finder uses to decide
        whether another call may start. Captured when the statement is dispatched
        so the synchronous wait and later polling spend one shared allowance.
        """

        remaining = runtime_settings.remaining_seconds()
        reserve = (
            runtime_settings.answer_reserve_seconds()
            if wait_seconds > SQL_WAIT_CEILING_SECONDS
            else 0.0
        )
        return max(0.0, min(float(wait_seconds), remaining - reserve))

    def _wait_timeout(self, wait_seconds: int) -> str:
        """What to ask the warehouse to wait, clamped to what is legal and affordable.

        Four bounds, and each one matters. The turn's remaining time and answer
        reserve, so an answering statement leaves time to use its result. The
        API's fifty-second ceiling, so a longer allowance is not simply rejected.
        And the API's five-second FLOOR, which the old `min(30, remaining)` could
        fall through at the tail of a turn: `wait_timeout=1s` is not a short wait,
        it is an argument error where the caller expected a cancelled statement.
        """

        affordable = int(self._sql_allowance(wait_seconds))
        wanted = min(wait_seconds, SQL_WAIT_CEILING_SECONDS, max(affordable, 0))
        return f"{max(SQL_WAIT_FLOOR_SECONDS, wanted)}s"

    def _poll_until_deadline(self, response: Any, started: float, allowance: float) -> Any:
        """After a CONTINUE, wait out the rest of the allowance, then cancel.

        Past the sync ceiling the statement is still RUNNING. Leaving it that
        way used to be reported as a failure. Cancelling on the deadline makes
        the model read CANCELED — "too slow, narrow it".
        """

        statement_id = getattr(response, "statement_id", None)
        execution = self.workspace.statement_execution
        if not statement_id or not hasattr(execution, "get_statement"):
            return response
        poll = SQL_FIRST_POLL_SECONDS
        while statement_state(response) in _SQL_STILL_RUNNING:
            elapsed = time.perf_counter() - started
            if elapsed >= allowance:
                if hasattr(execution, "cancel_execution"):
                    execution.cancel_execution(statement_id)
                return self._settle_after_cancel(execution, statement_id)
            time.sleep(min(poll, max(0.0, allowance - elapsed)))
            poll = min(poll * 2, SQL_POLL_SECONDS)
            response = execution.get_statement(statement_id)
        return response

    def _settle_after_cancel(self, execution: Any, statement_id: str) -> Any:
        """Poll briefly for the terminal state that won the cancellation race."""

        deadline = time.perf_counter() + SQL_CANCEL_SETTLE_SECONDS
        latest = execution.get_statement(statement_id)
        for _ in range(SQL_CANCEL_SETTLE_MAX_POLLS):
            if statement_state(latest) not in _SQL_STILL_RUNNING:
                return latest
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                return latest
            time.sleep(min(SQL_CANCEL_SETTLE_POLL_SECONDS, remaining))
            latest = execution.get_statement(statement_id)
        return latest

    def _execute(
        self,
        sql: str,
        span_name: str,
        budget: RowBudget = SAMPLE_BUDGET,
        *,
        wait_seconds: int = SQL_WAIT_SECONDS,
        retry_when_slow: bool = False,
        tool: str = "statement",
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

        Discovery stays on CANCEL at the 50s ceiling and never polls. Answering
        reads CONTINUE at that ceiling, with up to 300s of statement allowance;
        the remaining turn budget can stop it earlier so the model still has
        time to use the result.

        `retry_when_slow` runs the statement a SECOND time when the first was
        cancelled or never started, and only then: a rejected statement is
        rejected identically the second time, and a denial is about who is
        asking. It exists for the cold warehouse, where the first statement of a
        turn is the one that pays for the warmup and the second lands on a warm
        warehouse. Gated on the turn having enough left to use the answer, so a
        retry cannot spend a budget the rest of the run needed.
        """

        with mlflow.start_span(name=span_name, span_type="TOOL") as span:
            span.set_inputs({"sql": sql, "wait_seconds": wait_seconds})
            retried = False
            while True:
                allowance = self._sql_allowance(wait_seconds)
                polls = (
                    wait_seconds > SQL_WAIT_CEILING_SECONDS and allowance > SQL_WAIT_CEILING_SECONDS
                )
                on_wait = (
                    ExecuteStatementRequestOnWaitTimeout.CONTINUE
                    if polls
                    else ExecuteStatementRequestOnWaitTimeout.CANCEL
                )
                started = time.perf_counter()
                response = self.workspace.statement_execution.execute_statement(
                    warehouse_id=self.settings.warehouse_id,
                    statement=sql,
                    wait_timeout=self._wait_timeout(wait_seconds),
                    on_wait_timeout=on_wait,
                    query_tags=sdk_attribution.query_tags("ask", tool),
                )
                if polls and statement_state(response) in _SQL_STILL_RUNNING:
                    response = self._poll_until_deadline(response, started, allowance)
                failure = statement_failure(response)
                if not failure:
                    break
                # A privilege denial leaves as its own type, so the loop
                # classifies it by `isinstance` rather than by matching prose
                # that `statement_failure` has already redacted. Everything else
                # is the RuntimeError it has always been.
                if statement_denied(response):
                    raise SqlDenied(failure, statement_sql_state(response))
                affordable = runtime_settings.remaining_seconds() >= SQL_RETRY_MIN_REMAINING_SECONDS
                if (
                    retry_when_slow
                    and not retried
                    and statement_state(response) in _SQL_TOO_SLOW_STATES
                    and affordable
                ):
                    retried = True
                    # The second attempt gets whatever the turn can still spare
                    # beyond its own reserve, so it cannot be the call that
                    # leaves the run with no time to use what it found.
                    wait_seconds = max(
                        SQL_WAIT_FLOOR_SECONDS,
                        min(
                            wait_seconds,
                            int(runtime_settings.remaining_seconds()) - SQL_RETRY_RESERVE_SECONDS,
                        ),
                    )
                    continue
                raise RuntimeError(
                    f"{failure} (tried twice; the second attempt was no faster)"
                    if retried
                    else failure
                )
            columns = [column.name for column in response.manifest.schema.columns]
            rows = self._collect_rows(response, budget)
            # The manifest's own count: `result.data_array` is the FIRST CHUNK,
            # and a paged result read as a complete one under-reports.
            total = getattr(response.manifest, "total_row_count", None)
            total = int(total) if isinstance(total, int) else len(rows)
            span.set_outputs({"row_count": len(rows), "total_row_count": total, "retried": retried})
            return columns, rows, max(total, len(rows))

    def _collect_rows(self, response: Any, budget: RowBudget = SAMPLE_BUDGET) -> list[list[Any]]:
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

    def _read(self, sql: str, span_name: str, tool: str) -> ToolResult:
        """Run one statement the model wrote, through the gateway on both sides.

        THE SAME TWO CHECKS AS BEFORE, in the same order, refusing with the same
        sentences: the gateway calls `validate_sql` and `restricted_output_columns`
        rather than reimplementing them, and the refusal re-raised here is the
        object the guard itself constructed. What is new is that the decision is
        recorded rather than only enforced, which is what lets a Genie result be
        held to the identical standard and lets a run say which control fired.
        """

        gate = self.gateway()
        admitted = gate.admit_statement(tool, sql)
        if admitted.refusal is not None:
            raise admitted.refusal

        columns, rows, total = self._execute(sql, span_name, tool=tool)

        # The static parse cannot expand `SELECT *` without the table's schema, so
        # the warehouse's result schema closes it, BEFORE any row becomes text:
        # from here rows reach the evidence log, the synthesis prompt, a trace
        # stage persisted to Lakebase, and a stakeholder's screen.
        checked = gate.admit_result_schema(admitted, columns)
        if checked.refusal is not None:
            raise checked.refusal

        return ToolResult(
            text=render_rows(columns, rows, total),
            sql=sql,
            sources=list(checked.sources),
            verdicts=(checked,),
        )

    def run_sql(self, sql: str) -> ToolResult:
        return self._read(sql, "data_source_finder.run_sql", "run_sql")

    def query_named_table(self, sql: str) -> ToolResult:
        """The fast path: query a table the USER named, without going via Genie.

        Shares `run_sql`'s guard and differs only in what a rejection MEANS, which
        is the point of having both. Here a missing three-part name is a question
        for the user rather than a reason to go hunting: the notebook's third
        routing path exists because crawling Unity Catalog for a half-named table
        is slow, guesses, and usually guesses wrong.
        """

        return self._read(sql, "orchestrator.query_named_table", "query_named_table")

    # -----------------------------------------------------------------------
    # Discovery
    # -----------------------------------------------------------------------

    def list_data_assets(self, catalog: str = "", schema: str = "") -> ToolResult:
        """Return the declared set in one call, optionally filtered.

        Under forty tables the whole set is printed at once. Walking catalogs →
        schemas → tables cost a model turn per level to learn names the process
        already had. Franchise tags are shown when baked beside the manifest;
        a missing tag is untagged, not "no such data".
        """

        declared = self.settings.readable_tables
        catalog = catalog.strip().strip("`")
        schema = schema.strip().strip("`")
        tags = dict(self.settings.franchise_tags)

        if not declared:
            return ToolResult(text="(no tables were declared with this model)")

        if catalog and not any(name.split(".")[0] == catalog for name in declared):
            return ToolResult(
                text=(
                    f"'{catalog}' has no declared tables. Declared catalogs: "
                    + ", ".join(sorted({name.split(".")[0] for name in declared}))
                )
            )
        if (
            catalog
            and schema
            and not any(
                name.split(".")[0] == catalog and name.split(".")[1] == schema for name in declared
            )
        ):
            in_catalog = [name for name in declared if name.split(".")[0] == catalog]
            return ToolResult(
                text=(
                    f"'{catalog}.{schema}' has no declared tables. Declared schemas in "
                    f"{catalog}: " + ", ".join(sorted({n.split(".")[1] for n in in_catalog}))
                )
            )

        tables = sorted(
            name
            for name in declared
            if (not catalog or name.split(".")[0] == catalog)
            and (not schema or name.split(".")[1] == schema)
        )
        heading = "Declared tables:"
        if catalog and schema:
            heading = f"Declared tables in {catalog}.{schema}:"
        elif catalog:
            heading = f"Declared tables in {catalog}:"
        lines = [heading]
        for name in tables:
            franchise = tags.get(name) or tags.get(name.lower()) or "untagged"
            lines.append(f"  - {name}  [franchise: {franchise}]")
        lines.append("")
        lines.append(
            "This is the declared set in one listing. A missing franchise tag "
            "means untagged, not that the table cannot answer. Call describe_table "
            "for columns, types, and comments."
        )
        if self.user_authorized:
            lines.append(GRANTS_DECIDE_NOTE)
        return ToolResult(text="\n".join(lines))

    def resolve_table(self, name: str = "") -> ToolResult:
        """Turn a bare or half-qualified table name into its declared full name.

        The alternative this replaces is asking the user to retype a name they
        already typed. A stakeholder who writes "count the rows in <table>" has
        named the table unambiguously as far as this deployment is concerned;
        bouncing that back as a clarification spends a turn of their attention
        to learn something the manifest already knows.

        RESOLVED AGAINST THE MANIFEST, not `information_schema`. The manifest is
        the declared set baked in at log time, which is exactly what passthrough
        granted, so a name it resolves is readable by construction and a name it
        does not is not readable by any route. That is the same reasoning
        `list_data_assets` is built on, and it is why this costs no round trip,
        needs no `USE CATALOG system` grant, and cannot offer a table the read
        path would then refuse.

        AMBIGUITY IS NOT BROKEN BY GUESSING. Two declared schemas can hold the
        same table name, and they are then two different tables that will answer
        the same question with different figures. Picking one silently is the
        failure mode the whole "which table to answer from" section exists to
        prevent, so every candidate is listed and the model is sent to
        request_clarification. Resolving is only allowed to save the user a
        keystroke, never to make a choice on their behalf.
        """

        raw = (name or "").strip().strip("`")
        parts = [part.strip().strip("`") for part in raw.split(".")] if raw else []
        if not raw or len(parts) > 3 or not all(_IDENT_RE.match(part) for part in parts):
            return ToolResult(
                text=(
                    f"REJECTED: resolve_table got '{name}'. Give a table name, optionally "
                    "qualified as schema.table or catalog.schema.table, using letters, "
                    "digits and underscores only."
                )
            )

        declared = list(self.settings.readable_tables)
        if not declared:
            return ToolResult(text="(no tables were declared with this model)")

        # Matched from the RIGHT, so `table`, `schema.table` and the full name are
        # one comparison rather than three branches, and a partly-qualified name
        # narrows the candidates instead of being rejected for not being whole.
        wanted = [part.lower() for part in parts]
        hits = [
            table
            for table in declared
            if [part.lower() for part in table.split(".")][-len(wanted) :] == wanted
        ]

        if len(hits) == 1:
            return ToolResult(
                text=(
                    f"RESOLVED: {hits[0]}\nCall describe_table on it before writing any SQL: "
                    "the columns it lists are the only ones that exist."
                )
            )
        if len(hits) > 1:
            listed = "\n".join(f"- {table}" for table in sorted(hits))
            return ToolResult(
                text=(
                    f"AMBIGUOUS: {len(hits)} declared tables are named '{parts[-1]}'. Do not "
                    "guess and do not describe them all to decide. Call request_clarification "
                    "asking the user which one they mean:\n" + listed
                )
            )

        # One pass for near names, as SUGGESTIONS ONLY. A near match is never the
        # resolution: `<table>` and `<table>_v2` are two tables,
        # and offering the second as the first is the silent substitution this
        # tool is otherwise built to avoid.
        target = parts[-1].lower()
        near = sorted(
            table
            for table in declared
            if target in table.split(".")[-1].lower() and table.split(".")[-1].lower() != target
        )
        message = (
            f"NOT FOUND: no declared table is named '{raw}', so it cannot be read by any "
            "route. Tell the user it is out of scope rather than trying another way in."
        )
        if near:
            message += "\nSimilar declared names:\n" + "\n".join(f"- {table}" for table in near)
        return ToolResult(text=message)

    def search_tagged_assets(self, tag: str = "", value: str = "") -> ToolResult:
        """Find declared tables and columns by their Unity Catalog tags.

        The point is to cut the candidate set BEFORE describing anything. The
        discovery path this joins walks the manifest and then describes tables one
        at a time, which is an inventory recited into the prompt; a governed estate
        has already written down which tables hold what, and this reads that
        instead of inferring it from names.

        THE MANIFEST STILL BOUNDS THE RESULT. Rows are intersected with
        `readable_tables` after the query, so a tagged table this model version was
        not logged with cannot be offered: `validate_sql` would refuse it, and a
        discovery tool that names tables the read path rejects sends the model to
        ask for something it cannot have. Under user authorization the caller's own
        grants filter `information_schema` as well, so the intersection is of two
        independent narrowings and neither is trusted to be the other.

        TAGS ARE NOT A PERMISSION MODEL and nothing here treats them as one. A tag
        is somebody's label on an object; whether the object can be read is decided
        by Unity Catalog at query time, as it is for every other tool.
        """

        declared = self.settings.readable_tables
        if not declared:
            return ToolResult(text="(no tables were declared with this model)")

        tag = tag.strip().strip("`")
        value = value.strip()
        catalogs = sorted({name.split(".")[0] for name in declared})
        schemas = sorted({name.split(".")[1] for name in declared})

        statement = _tag_search_sql(catalogs, schemas, tag=tag, value=value)
        try:
            _, rows, total = self._execute(
                statement,
                "orchestrator.search_tagged_assets",
                ENUMERATION_BUDGET,
                # A cold warehouse is the ordinary first-call state of a customer
                # workspace, and this read is a small metadata scan that only
                # looks slow because it is the one paying for the warmup. It is
                # also the read the turn can most afford to lose, which is what
                # makes it the right one to spend the API's whole wait on.
                wait_seconds=DISCOVERY_WAIT_SECONDS,
                retry_when_slow=True,
                tool="search_tagged_assets",
            )
        except Exception as error:  # noqa: BLE001 - discovery failing is not the run failing
            # Including SqlDenied, which is the EXPECTED shape of "this estate did
            # not grant information_schema" rather than an anomaly. Redacted
            # already by `statement_failure`, so it is safe to relay.
            detail = re.sub(r"\s+", " ", str(error)).strip()[:300]
            slow = _was_too_slow(detail)
            # Lead with the plain reason when there is one. `SQL CANCELED: the
            # statement was still running when its wait timeout...` is accurate
            # and is not what a person reading a clipped trace line needs; "the
            # SQL warehouse did not finish this read in time" is.
            why = (
                "the SQL warehouse did not finish this read in time, which usually means it "
                f"was still starting: {detail}"
                if slow
                else f"the tag views could not be read: {detail}"
            )
            return ToolResult(
                text=(
                    f"TAG SEARCH UNAVAILABLE ({failures.DEPENDENCY_UNAVAILABLE}): {why} "
                    f"{TAGS_SLOW_GUIDANCE if slow else TAGS_UNAVAILABLE_GUIDANCE}"
                )
            )

        return ToolResult(text=_rendered_tags(rows, declared, tag=tag, value=value, total=total))

    def describe_table(self, full_name: str, columns: str = "") -> ToolResult:
        """Columns, types, and comments for one declared table.

        `columns` narrows the list to names containing any of the comma-separated
        patterns, matched case-insensitively as substrings. THE HEADER ALWAYS
        STATES BOTH COUNTS, because the valuable half of a filter is the miss:
        "0 of 412 columns match `crm_customer_ref`" is a definitive answer that
        the column is not there, and it is the answer that stops the model
        querying the table to find out and then guessing from the error.

        A DEFINITIVE NEGATIVE IS ONLY MADE WHEN THE READ WAS WHOLE. `total` is
        what the DESCRIBE returned against what came back inside the budget, so
        a truncated read cannot support "no such column exists" -- the column
        may be sitting in the part that was cut, which is exactly the case a
        wide table produces. Absence and truncation are reported as two
        different things, in different words, and the second one says what to do
        about it. Collapsing them would put the guess back one step further on.

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
                    f"(three dot-separated parts); got '{full_name}'. Call resolve_table on "
                    "that name to get the full one; only if it comes back AMBIGUOUS or NOT "
                    "FOUND is this a question for the USER, and then ask it with "
                    "request_clarification. Do not guess it and do not crawl to find it."
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
        # The result schema is discarded: a DESCRIBE's own column names say
        # nothing, and the local would shadow the `columns` FILTER above.
        _, rows, total = self._execute(
            f"DESCRIBE TABLE EXTENDED {_quoted(name)}",
            "orchestrator.describe_table",
            ENUMERATION_BUDGET,
            wait_seconds=DISCOVERY_WAIT_SECONDS,
            tool="describe_table",
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
        described: list[tuple[str, str]] = []
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
            described.append(
                (field, f"- {field}: {data_type}" + (f" ({comment})" if comment else ""))
            )

        # `total` counts the DESCRIBE's own rows -- columns and extended metadata
        # together -- so it is compared against the rows that came back rather
        # than against the columns parsed out of them. A table whose extended
        # section was read whole has nothing missing to disclose.
        truncated = total > len(rows)
        patterns = [part.strip().lower() for part in (columns or "").split(",") if part.strip()]
        shown = (
            described
            if not patterns
            else [entry for entry in described if any(p in entry[0].lower() for p in patterns)]
        )

        lines = [name]
        if table_comment:
            lines.append(f"Table comment: {table_comment}")
        if patterns:
            quoted = ", ".join(f"`{pattern}`" for pattern in patterns)
            if shown:
                lines.append(f"{len(shown)} of {len(described)} columns match {quoted}:")
            elif truncated:
                # The one case where a miss says nothing. Worded so it cannot be
                # read as an absence, and it names the way out rather than
                # leaving the model to invent one.
                lines.append(
                    f"None of the {len(described)} columns read so far match {quoted}, but "
                    "this description was CUT before the end, so the column may be in the "
                    "part that was not read. This is not evidence that it does not exist. "
                    "Describe the table again with no `columns` filter, or a shorter "
                    "pattern, before concluding anything."
                )
            else:
                lines.append(
                    f"0 of {len(described)} columns match {quoted} — no column of that name "
                    "exists in this table. That is definitive: do NOT query the table to "
                    "check, and do not re-run a statement that already failed on it. Use a "
                    "column that is listed here, or describe the table with no `columns` "
                    "filter to see what is."
                )
        lines.append("")
        lines.extend(line for _, line in shown)
        if truncated:
            lines.append("")
            lines.append(truncation_note(len(rows), total))
        # A description is a read of the table's metadata, and it is what an answer
        # about the table's shape is grounded in, so it is attributed. Through the
        # gateway like everything else, and admitted without a statement to parse
        # because the asset it read is named: the verdict says so, and says the
        # result may not become a figure.
        return ToolResult(
            text="\n".join(lines),
            sources=[name],
            verdicts=(self.gateway().admit_metadata("describe_table", assets=(name,)),),
        )


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


def data_genie_tool(space_title: str = "") -> dict[str, Any]:
    """The data Genie tool schema, naming the space when a title is known."""

    named = f' "{space_title}"' if space_title.strip() else ""
    return _one_arg(
        "data_genie",
        f"Ask the curated Genie Space{named} that holds the ACTUAL player, gameplay, and purchase "
        "data. Use for figures, aggregations, overviews, and small samples over the governed "
        "tables. Send one self-contained natural-language question: it has no memory of this "
        "conversation, so spell out the tables, columns, and filters you have established. "
        # Cheaper here than in the refusal, and this is the sentence that decides how
        # often the refusal happens at all. A chart-only reply carries no query, so it
        # cannot be attributed and is refused; asking for the rows or the grouping gets
        # the same numbers WITH the query behind them, and this agent can chart them
        # afterwards. Phrased as what to ask for rather than as a warning, because the
        # model is choosing wording here, not handling an error.
        "ASK FOR A TABLE, not a chart or a picture: say you want the rows, the counts or the "
        "grouping. A table comes back with the query behind it, which is what lets this agent "
        "cite a source and draw the chart itself. A reply that is only a chart cannot be "
        "traced and will be rejected.",
        "question",
        "A self-contained natural-language question.",
    )


def dictionary_genie_tool(space_title: str = "") -> dict[str, Any]:
    """The dictionary Genie tool schema, naming the space when a title is known."""

    titled = (space_title or "").strip()
    head = (
        f'Ask the Data Dictionary Genie Space "{titled}" (metadata only, no underlying data) '
        if titled
        else "Ask the Data Dictionary Genie Space (metadata only, no underlying data) "
    )
    return _one_arg(
        "dictionary_genie",
        head + "what a table or column MEANS. Consult it before querying or reporting on any field "
        "whose meaning is unclear or unlabeled. Never guess a field's meaning. Ask about the FIELD "
        "on its own: naming a wide table alongside it makes this space read that table too, "
        "and the call then times out and returns nothing. Name a table here only when the "
        "table itself is what you are asking about.",
        "question",
        "A question about one definition, field, or rule, without a table qualifying it.",
    )


DATA_GENIE_TOOL = data_genie_tool()
DICTIONARY_GENIE_TOOL = dictionary_genie_tool()

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

RESOLVE_TABLE_TOOL = _one_arg(
    "resolve_table",
    "Turn a table name the user gave you into its full catalog.schema.table. Call this "
    "FIRST whenever a request names a specific table without fully qualifying it, instead "
    "of asking the user to retype it: one lookup against the declared set, no query. If it "
    "RESOLVES, describe_table it and carry on. If it comes back AMBIGUOUS the name belongs "
    "to more than one declared table, and those are different tables that will give "
    "different figures: call request_clarification with the candidates rather than picking "
    "one. If it comes back NOT FOUND the table is out of scope, so say so rather than "
    "hunting for it.",
    "name",
    "A table name: table, schema.table, or catalog.schema.table.",
)

DESCRIBE_TABLE_TOOL = {
    "type": "function",
    "function": {
        "name": "describe_table",
        "description": (
            "Describe one declared table: columns, data types, and comments. Use before "
            "writing SQL against a table, and to answer a bare 'what is in <table>' with no "
            "query at all. Needs the full catalog.schema.table: if the user under-qualified "
            "a name, call resolve_table on it first. Pass `columns` to ask whether a "
            "particular column is there instead of reading the whole list: the header "
            "reports how many of the table's columns matched, so a zero is a definitive "
            "answer that the column does not exist. If a column you expected is absent, it "
            "is absent — map your question to one that IS listed rather than running a "
            "query to test for it."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "full_name": {
                    "type": "string",
                    "description": "Fully-qualified table name: catalog.schema.table",
                },
                "columns": {
                    "type": "string",
                    "description": (
                        "Optional comma-separated name patterns, matched case-insensitively "
                        'as substrings (e.g. "id,country"). Omit to list every column.'
                    ),
                },
            },
            "required": ["full_name"],
        },
    },
}


def _tag_search_sql(
    catalogs: Sequence[str], schemas: Sequence[str], *, tag: str, value: str
) -> str:
    """One statement over every declared catalog's tag views.

    UNION ALL across catalogs and across the table and column views, because
    `information_schema` is per catalog and the availability of it is per catalog
    too: a manifest spanning two catalogs must not silently report the tags of
    whichever one happens to be granted.

    The schema list is pushed into the WHERE clause rather than filtered
    afterwards. It cuts the scan on a large metastore, and it keeps the statement
    from reading rows about schemas this deployment was never told about, which is
    a narrowing worth having even though the manifest intersection would drop them
    anyway.
    """

    schema_list = ", ".join(_string_literal(name) for name in schemas)
    conditions = [f"schema_name IN ({schema_list})"]
    if tag:
        # Case-insensitively, because a tag is typed by a person. Unity Catalog
        # preserves the case it was created with, so matching exactly turns
        # `PII` and `pii` into different tags and hands the model an empty result
        # that looks like an answer.
        conditions.append(f"lower(tag_name) = lower({_string_literal(tag)})")
    if value:
        conditions.append(f"lower(tag_value) = lower({_string_literal(value)})")
    where = " AND ".join(conditions)

    selects: list[str] = []
    for catalog in catalogs:
        prefix = _quoted(catalog)
        selects.append(
            "SELECT 'table' AS level, catalog_name, schema_name, table_name, "
            f"'' AS column_name, tag_name, tag_value FROM {prefix}.information_schema."
            f"table_tags WHERE {where}"
        )
        selects.append(
            "SELECT 'column' AS level, catalog_name, schema_name, table_name, "
            f"column_name, tag_name, tag_value FROM {prefix}.information_schema."
            f"column_tags WHERE {where}"
        )
    return (
        " UNION ALL ".join(selects)
        + " ORDER BY catalog_name, schema_name, table_name, column_name, tag_name"
        + f" LIMIT {MAX_TAG_ROWS}"
    )


def _rendered_tags(
    rows: Sequence[Sequence[Any]],
    declared: Sequence[str],
    *,
    tag: str,
    value: str,
    total: int,
) -> str:
    """Tagged objects, grouped by table, with everything undeclared dropped.

    Grouped rather than listed row by row, because the model's next call is per
    table and a flat list of tag rows makes it re-derive that grouping in prose.
    """

    allowed = {name.lower(): name for name in declared}
    grouped: dict[str, list[str]] = {}
    dropped = 0
    for row in rows:
        values = [str(item) if item is not None else "" for item in row]
        if len(values) < 7:
            continue
        level, catalog, schema, table, column, tag_name, tag_value = values[:7]
        full = f"{catalog}.{schema}.{table}"
        canonical = allowed.get(full.lower())
        if not canonical:
            # A tagged table outside the manifest. Counted for the operator and
            # not named: the read path would refuse it, so naming it here would
            # send the model to ask for something that cannot be answered.
            dropped += 1
            continue
        label = f"{tag_name}={tag_value}" if tag_value else tag_name
        entry = f"{column} ({label})" if level == "column" and column else label
        grouped.setdefault(canonical, []).append(entry)

    asked = " ".join(
        part for part in (f"tag {tag}" if tag else "", f"value {value}" if value else "") if part
    )
    if not grouped:
        subject = f" for {asked}" if asked else ""
        return (
            f"No declared table carries a tag{subject}. This means the tags are not there or "
            "are on objects outside this deployment's declared set; it does not mean the "
            "tables cannot answer the question. Use list_data_assets and describe_table, or "
            "search_semantics where this deployment has a semantic layer."
        )

    heading = f"Tagged declared assets{f' matching {asked}' if asked else ''}:"
    lines = [heading]
    spent = len(heading)
    shown = 0
    for table in sorted(grouped):
        # Deduplicated: the same tag can arrive from the table view and from
        # several of its columns, and the repetition is noise the model pays for.
        entries = sorted(dict.fromkeys(grouped[table]))
        block = f"  - {table}: " + ", ".join(entries)
        if shown and spent + len(block) + 1 > MAX_TAG_RESULT_CHARS:
            break
        lines.append(block)
        spent += len(block) + 1
        shown += 1
    if shown < len(grouped):
        lines.append(
            f"{len(grouped) - shown} further tagged table(s) matched and were left out to stay "
            "inside the result budget. Search a narrower tag or value."
        )
    if total > len(rows):
        lines.append(
            f"The tag views returned {total} rows and this read {len(rows)} of them, so the "
            "list above may be partial. Narrow by tag or value rather than treating it as "
            "the whole estate."
        )
    lines.append("")
    lines.append(
        "Tags say what somebody labelled an object, not what it holds or who may read it. "
        "Call describe_table for columns and types, and get figures from data_genie, "
        "dictionary_genie or SQL."
    )
    return "\n".join(lines)


SEARCH_TAGGED_ASSETS_TOOL = {
    "type": "function",
    "function": {
        "name": "search_tagged_assets",
        "description": (
            "Find declared tables and columns by their Unity Catalog tags, so you can narrow "
            "to a few candidates instead of describing every table. Call it with no arguments "
            "to see which tags exist, then with a tag (and optionally a value) to get the "
            "objects carrying it. Tags are what somebody labelled an object, not a reading of "
            "it and not permission to read it: no figure, count or fact about the business may "
            "come from here. It can be unavailable on an estate that never granted access to "
            "tag metadata, which is not a failure of the question: fall back to "
            "list_data_assets and describe_table, and never tell the user their data is "
            "untagged or absent on the strength of an unavailable result."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "tag": {
                    "type": "string",
                    "description": (
                        "Tag key to match, case-insensitively, exactly as a person would have "
                        "typed it (for example 'pii' or 'domain'). Omit to see what tags exist."
                    ),
                },
                "value": {
                    "type": "string",
                    "description": (
                        "Tag value to match, case-insensitively. Only useful with a tag."
                    ),
                },
            },
            "required": [],
        },
    },
}


LIST_DATA_ASSETS_TOOL = {
    "type": "function",
    "function": {
        "name": "list_data_assets",
        "description": (
            "List every table this agent is permitted to read in one call, already "
            "labelled with franchise when a tag was baked. Optional catalog/schema "
            "arguments only filter that set. This is browsing, not discovery: the "
            "declared set is already in memory. A missing franchise tag means "
            "untagged, not that the table cannot answer. Read a table with "
            "describe_table rather than inferring what it holds from the name."
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
