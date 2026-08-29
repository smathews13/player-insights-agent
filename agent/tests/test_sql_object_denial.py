"""A table the executing identity was not granted, and what the reader is told.

THE FIXTURE IN THIS FILE IS A REAL MEASUREMENT, not a plausible sentence. It was
produced on 2026-08-10 against the example workspace by a purpose-built identity
probe: the app's own service principal read a table it holds no grant on, through a SQL
warehouse, and the warehouse answered with `OBSERVED_DENIAL` below and
`sql_state: 42501` as a separate field on the status.

That matters because the redaction this file pins was originally written against
an ASSUMED message. Nobody had a workspace where a denial actually happened, since
every identity in the demo estate can read everything, which is the condition the
probe was built to break. A test carrying the assumption cannot fail on the day
the assumption is wrong, so this one carries the measurement instead.

WHAT IS PINNED, in the order the failure used to travel:

  1. `statement_failure` does not repeat the warehouse's words. The message names
     `pia_identity_probe` and `canary_rows`, and both callers of that function put
     their string somewhere a reader reaches: the direct path raises it into a
     trace stage, the Genie path folds it into a tool result. A trace stage is
     rendered in the browser (`client/src/TraceTimeline.tsx` prints `stage.output`
     verbatim), so this is the difference between an operator log and a leak.
  2. A denial is CLASSIFIED as one. It used to reach the generic handler and be
     disclosed as a surface that "did not respond", which sends the reader to wait
     out an outage that is not one, and tells the model the data "may well be
     readable another way".
  3. `42501` and `42P01` stay apart. Telling somebody they lack access to a table
     that is simply not there sends them to ask for a grant nobody can make; the
     reverse confirms that an object they may not read exists.

DO NOT WIDEN THE CLASSIFIER TO "does not have". That phrase is in the fixture and
is deliberately not what any of this keys on: it appears in failures about
entirely unrelated objects, and a false positive tells a reader they were denied
when something else broke. The probe that produced the fixture was narrowed away
from the same trap on the same day. `test_the_trap_phrase_alone_is_not_a_denial`
holds it.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent import DEGRADED_ANSWER_MARKER, sql_object_denial
from tests.test_agent import Call, FakeTools, ScriptedLlm, ask, build, stages
from tools import (
    SQL_STATE_INSUFFICIENT_PRIVILEGE,
    SQL_STATE_UNDEFINED_TABLE,
    SqlDenied,
    statement_denied,
    statement_failure,
    statement_sql_state,
)

# ---------------------------------------------------------------------------
# The measurement
# ---------------------------------------------------------------------------

#: Verbatim, from the example workspace on 2026-08-10, via a SQL warehouse, as the
#: app's service principal reading `pia_identity_probe.canary_rows` with no grant.
#:
#: The newlines are the platform's own. It came from the legacy metastore, which
#: spells the schema privilege USAGE; Unity Catalog words the equivalent denial
#: differently, so this is one confirmed sample rather than the only shape. That
#: is exactly why the code keys on the SQLSTATE and the bracketed identifier, both
#: of which survive a rewording, and not on the prose around them.
OBSERVED_DENIAL = (
    "[INSUFFICIENT_PERMISSIONS] Insufficient privileges:\n"
    "User does not have permission SELECT on table `pia_identity_probe`.`canary_rows`.\n"
    "User does not have permission USAGE on database `pia_identity_probe`. SQLSTATE: 42501"
)

#: The same principal, the same three-part name, after the probe was DROPPED. A
#: different class entirely, and the one the denial path must not swallow.
OBSERVED_NOT_FOUND = (
    "[TABLE_OR_VIEW_NOT_FOUND] The table or view `pia_identity_probe`.`canary_rows` "
    "cannot be found. Verify the spelling and correctness of the schema and catalog. "
    "SQLSTATE: 42P01"
)

#: The object names the probe puts in the message. Nothing a reader can see may
#: contain either of them.
PROBE_SCHEMA = "pia_identity_probe"
PROBE_TABLE = "canary_rows"


def response(message: str, sql_state: str = "", state: str = "FAILED"):
    """A statement-execution response, shaped as the SDK returns one."""

    return SimpleNamespace(
        statement_id="statement-1",
        status=SimpleNamespace(
            state=SimpleNamespace(value=state),
            sql_state=sql_state,
            error=SimpleNamespace(message=message),
        ),
    )


DENIED = response(OBSERVED_DENIAL, SQL_STATE_INSUFFICIENT_PRIVILEGE)
NOT_FOUND = response(OBSERVED_NOT_FOUND, SQL_STATE_UNDEFINED_TABLE)


# ---------------------------------------------------------------------------
# Reading the response
# ---------------------------------------------------------------------------


def test_the_observed_denial_is_recognised_as_one():
    assert statement_sql_state(DENIED) == "42501"
    assert statement_denied(DENIED) is True


def test_the_sqlstate_alone_is_enough():
    """The prose is what varies between platform versions; the class is not."""

    assert statement_denied(response("something the matcher has never seen", "42501")) is True


def test_the_identifier_alone_is_enough():
    """And the other way round, for a transport that reports no sql_state."""

    assert statement_denied(response(OBSERVED_DENIAL)) is True
    assert statement_denied(response("PERMISSION_DENIED: no grant")) is True


def test_a_dropped_object_is_not_a_denial():
    """42P01 is the answer a DROPPED probe gives, and it means something else.

    Told they lack access to an object that is not there, a reader goes and asks
    an admin for a grant nobody can make.
    """

    assert statement_sql_state(NOT_FOUND) == "42P01"
    assert statement_denied(NOT_FOUND) is False


def test_the_trap_phrase_alone_is_not_a_denial():
    """The guard, and the half that matters more.

    "does not have" is in the observed denial and is deliberately not matched. It
    appears in failures about entirely unrelated objects, and a false positive
    here tells a reader they were denied when something else broke.
    """

    assert statement_denied(response("The join key does not have a matching column")) is False
    assert statement_denied(response("the warehouse did not answer")) is False


def test_a_succeeded_statement_is_not_read_at_all():
    assert statement_failure(response("", state="SUCCEEDED")) == ""


# ---------------------------------------------------------------------------
# The redaction
# ---------------------------------------------------------------------------


def test_the_failure_text_does_not_repeat_the_warehouses_words():
    """The leak, at the point it used to start.

    Both callers of `statement_failure` put this string where a reader reaches
    it, so redacting here rather than at either call site is what makes the
    guarantee hold on both paths.
    """

    failure = statement_failure(DENIED)

    assert PROBE_SCHEMA not in failure
    assert PROBE_TABLE not in failure
    assert "does not have permission" not in failure
    # And it still says what happened, and that waiting is not the remedy.
    assert "not granted" in failure
    assert "missing grant" in failure


def test_the_operator_keeps_the_full_message(capsys):
    """Withholding it from the reader is only defensible if somebody still has it."""

    statement_failure(DENIED)

    logged = capsys.readouterr().out
    assert PROBE_SCHEMA in logged and PROBE_TABLE in logged
    assert "42501" in logged


def test_a_not_found_is_still_described_as_a_not_found():
    """Nothing is redacted here, and nothing should be.

    The name in this message is the one the run itself asked for, so it is already
    in the stage's own arguments. Blanking it would cost the model the one fact it
    can act on and buy no privacy at all.
    """

    failure = statement_failure(NOT_FOUND)

    assert "TABLE_OR_VIEW_NOT_FOUND" in failure
    assert "not granted" not in failure


# ---------------------------------------------------------------------------
# Classifying it in the loop
# ---------------------------------------------------------------------------


class FakeWarehouse:
    """A warehouse whose statements all end the same way."""

    def __init__(self, outcome):
        self.statement_execution = SimpleNamespace(execute_statement=lambda **_: outcome)


def test_a_denied_statement_leaves_as_its_own_type():
    """Carried as a TYPE so the loop never re-matches a string it just redacted."""

    from tests.test_tools import build as build_tools

    with pytest.raises(SqlDenied) as denied:
        build_tools(FakeWarehouse(DENIED))._execute("SELECT 1", "span")

    assert denied.value.sql_state == "42501"
    assert PROBE_TABLE not in str(denied.value)


def test_a_not_found_statement_is_still_an_ordinary_failure():
    from tests.test_tools import build as build_tools

    with pytest.raises(RuntimeError) as failed:
        build_tools(FakeWarehouse(NOT_FOUND))._execute("SELECT 1", "span")

    assert not isinstance(failed.value, SqlDenied)


def test_the_classifier_takes_the_typed_denial():
    denial = sql_object_denial(SqlDenied(statement_failure(DENIED), "42501"))

    assert denial is not None
    assert "REFUSED" in denial
    assert PROBE_SCHEMA not in denial and PROBE_TABLE not in denial


def test_the_classifier_takes_a_denial_that_arrives_as_an_exception():
    """Unity Catalog's wording differs; the identifiers it is keyed on do not."""

    assert sql_object_denial(RuntimeError(OBSERVED_DENIAL)) is not None
    assert sql_object_denial(RuntimeError("PERMISSION_DENIED: no grant on that table")) is not None


def test_the_classifier_declines_everything_that_is_not_a_denial():
    assert sql_object_denial(RuntimeError(OBSERVED_NOT_FOUND)) is None
    assert sql_object_denial(TimeoutError("the warehouse did not answer")) is None
    assert sql_object_denial(RuntimeError("The join key does not have a matching column")) is None


def test_the_denial_carries_the_remedy_and_not_the_object():
    denial = sql_object_denial(SqlDenied("refused", "42501"), "someone@example.test")

    assert denial is not None
    # Whose grants decided it, when the run knows.
    assert "someone@example.test" in denial
    # The remedy is a grant, from somebody the reader can go and find.
    assert "GRANT" in denial
    assert "USE CATALOG" in denial and "USE SCHEMA" in denial
    # And NOT the sentence for an outage, which invites a wait that cannot end.
    assert "did not respond" not in denial


# ---------------------------------------------------------------------------
# What reaches the stakeholder
# ---------------------------------------------------------------------------


#: The two shapes a denial arrives in, run through the whole turn as both.
#:
#: The second is the one that does the work, and the difference is worth stating
#: because the first can pass while the app leaks. `SqlDenied` is built by
#: `statement_failure`, so a fixture made from it is ALREADY redacted and proves
#: only that the loop adds nothing back. The raw `RuntimeError` is the platform's
#: verbatim words entering the loop unredacted, which is both the fall-through
#: case if `tools.py` ever stops classifying and the Unity Catalog rewording the
#: brief warns not to overfit against. Everything below has to hold for both.
ARRIVALS = [
    (
        "a FAILED statement, classified where the response is read",
        SqlDenied(statement_failure(DENIED), "42501"),
    ),
    ("a denial raised with the platform's own words", RuntimeError(OBSERVED_DENIAL)),
]


def denied_run(error, *, with_llm=False):
    """One turn whose only tool call is refused by the warehouse on privileges."""

    tools = FakeTools(run_sql=error)
    llm = ScriptedLlm(
        [Call("run_sql", {"sql": f"SELECT * FROM cat.{PROBE_SCHEMA}.{PROBE_TABLE}"})],
        "No rows could be read, so no figure is reported.",
    )
    response_ = ask(build(llm, tools))
    return (response_, llm) if with_llm else response_


@pytest.mark.parametrize("_shape,error", ARRIVALS)
def test_a_denial_marks_the_answer_rather_than_reading_as_an_outage(_shape, error):
    caveats = " ".join(denied_run(error).custom_outputs["answer"]["caveats"])

    assert DEGRADED_ANSWER_MARKER in caveats
    assert "REFUSED" in caveats
    assert "GRANT" in caveats
    # The untruth this replaces. Nothing failed to respond: the warehouse
    # answered, promptly and in the negative.
    assert "did not respond" not in caveats


@pytest.mark.parametrize("_shape,error", ARRIVALS)
def test_no_caveat_names_the_object_that_was_refused(_shape, error):
    caveats = " ".join(denied_run(error).custom_outputs["answer"]["caveats"])

    assert PROBE_SCHEMA not in caveats
    assert PROBE_TABLE not in caveats


@pytest.mark.parametrize("_shape,error", ARRIVALS)
def test_no_trace_stage_carries_the_warehouses_own_words(_shape, error):
    """The surface the leak actually reached.

    `stage.output` crosses the wire on the answer contract and is rendered in the
    browser by `TraceTimeline.tsx`, which prints it verbatim inside a `<pre>`. A
    message that stops at the server log is fine; this one did not stop there.

    Only the OUTPUT is asserted on. The `input` of this stage is the model's own
    SQL and names the table on purpose: that is the statement the run chose to
    issue, and hiding it would make the trace a worse record without withholding
    anything the reader did not already supply.
    """

    outputs = " ".join(stage["output"] for stage in stages(denied_run(error)))

    assert "REFUSED" in outputs
    assert PROBE_SCHEMA not in outputs
    assert PROBE_TABLE not in outputs
    assert "does not have permission" not in outputs
    assert "SQLSTATE" not in outputs


@pytest.mark.parametrize("_shape,error", ARRIVALS)
def test_the_model_is_not_invited_to_ask_a_second_surface_for_denied_data(_shape, error):
    """A rerouted authorization failure is the same request with the guard off.

    `NEVER_REROUTE_LAYERS` and `failures.NO_LATER_ROUTE_ATTEMPT` both say so. The
    generic handler this used to reach said the opposite in as many words: "This
    is an outage, not a refusal, so the data may well be readable another way."
    """

    response_, llm = denied_run(error, with_llm=True)
    refused = next(stage for stage in stages(response_) if "REFUSED" in stage["output"])
    model_guidance = "\n".join(
        str(message["content"]) for message in llm.transcript if message["role"] == "tool"
    )

    assert "Do NOT ask another surface" in model_guidance
    assert "not a refusal" not in model_guidance
    assert "readable another way" not in model_guidance
    assert "Do NOT ask another surface" not in refused["output"]
    # And the entitlement's blanket instruction, which would be wrong here: a
    # grant is per object, so the next table may well be readable.
    assert "do not call another one" not in refused["output"]


def test_a_not_found_is_not_marked_as_a_denial_anywhere_in_the_answer():
    """The other direction, and the one that costs somebody an afternoon.

    A dropped table reported as a denial sends the reader to an admin for a grant
    on an object that is not there. It stays an ordinary failure.
    """

    response_ = denied_run(RuntimeError(OBSERVED_NOT_FOUND))

    caveats = " ".join(response_.custom_outputs["answer"]["caveats"])
    assert "REFUSED" not in caveats
    assert "missing grant" not in caveats


def test_the_entitlement_refusal_still_gets_the_entitlement_wording():
    """Three classifiers on one branch, so this pins that none swallowed another.

    The entitlement is checked first and must stay first: it refuses the API
    rather than an object, and its "do not call the others" instruction would be
    wrong for anything narrower.
    """

    from agent import SQL_ACCESS_ENTITLEMENT

    tools = FakeTools(
        describe_table=RuntimeError(
            "This API is disabled for users without the databricks-sql-access entitlement."
        )
    )
    llm = ScriptedLlm([Call("describe_table", {"full_name": "cat.sch.t"})], "An answer.")

    response_ = ask(build(llm, tools))

    refused = next(stage for stage in stages(response_) if "REFUSED" in stage["output"])
    model_guidance = "\n".join(
        str(message["content"]) for message in llm.transcript if message["role"] == "tool"
    )
    assert SQL_ACCESS_ENTITLEMENT in refused["output"]
    assert "do not call another one" in model_guidance
    assert "do not call another one" not in refused["output"]
