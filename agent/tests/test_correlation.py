"""That one id, minted in the browser, finds the trace of the run it names.

THE JOIN IS THE SUBJECT, NOT THE FIELD. Asserting that a tag was set proves the
agent wrote something; it does not prove an operator holding an id from an app
log line can find this run. So the test that matters here writes a real trace to
a real (sqlite) tracking backend and then goes looking for it the way a person
would: `search_traces` filtered on the tag. Everything else in this file exists
to stop that one from passing for the wrong reason.

WHY A TAG AND NOT AN ATTRIBUTE, restated because the test shape depends on it:
`search_traces` filters on tags, and cannot filter on span attributes. An id
recorded only as an attribute is findable only by opening traces one at a time,
which is the problem the id was introduced to remove.

WHAT STANDS IN FOR WHAT. `SpanningTools.data_genie` opens a span the same way
`tools.PlayerInsightTools._genie` does -- `mlflow.start_span` inside the tool
call, with no explicit parent -- because the real one needs a Genie space to talk
to. What is being demonstrated is that a child span opened in that position lands
in the trace the tag is on, which is what makes the Genie and Vector Search calls
joinable to the same question. `test_trace_context.py` covers the harder version
of the same claim, for a tool call dispatched onto a worker thread.
"""

from __future__ import annotations

from types import SimpleNamespace

import mlflow
import pytest
from mlflow.tracking import MlflowClient

import correlation
from tests.test_agent import ACTIVITY, Call, FakeTools, ScriptedLlm, ask, build, settings
from tools import ToolResult

#: A well-formed id in the shape `shared/correlation.ts` mints: the prefix, then
#: a hyphenated lowercase UUID.
#:
#: SHAPED SO THAT NOBODY HAS TO ASK WHETHER IT IS REAL. A fixture written as
#: plausible random hex is indistinguishable from a leaked identifier for as long
#: as it is in the tree, and check-mirror-leaks.sh cannot tell them apart either.
#: This one spells `deadbeef` and is all zeroes but for a counter, so a reader and
#: the publication gate reach the same conclusion without consulting anyone. Keep
#: any new correlation-id fixture in this family; see the note beside these values
#: in check-mirror-leaks.sh's ALLOWED_LITERALS.
MINTED = "req-deadbeef-0000-4000-8000-000000000001"
#: The ledger's primary key for the same question, which the app sends alongside.
#: A different value on purpose: the two are separate ids and a test that used
#: one value for both could not tell a swap from a success.
LEDGER_RUN = "req-deadbeef-0000-4000-8000-000000000002"


def requirement(**fields):
    """The parsed `custom_inputs` shape `facts` reads, without the parser."""

    return SimpleNamespace(**{"request_id": "", "run_id": "", **fields})


# ---------------------------------------------------------------------------
# The shape rule. This value is printed and stored, so it is validated first.
# ---------------------------------------------------------------------------


def test_the_app_minted_shape_is_accepted():
    assert correlation.usable(MINTED) == MINTED


def test_surrounding_whitespace_is_trimmed_rather_than_refused():
    """A header or a JSON field that arrived padded is still the same id."""

    assert correlation.usable(f"  {MINTED}\t") == MINTED


@pytest.mark.parametrize(
    "value",
    [
        None,
        42,
        {"request_id": MINTED},
        "",
        "   ",
        # No prefix, so it is not one of ours and cannot be told apart from a
        # platform id in a log line.
        MINTED.removeprefix("req-"),
        # Uppercase hex. Refused rather than folded: two spellings of one id do
        # not join, and the app mints only the lowercase one.
        MINTED.upper(),
        # A different prefix, including one that merely starts the same way.
        MINTED.replace("req-", "run-"),
        f"x{MINTED}",
        # Right shape, wrong length in one group.
        "req-deadbee-0000-4000-8000-000000000001",
        # Trailing junk after a valid id, which is how a filter written as a
        # prefix match gets fed something longer than it bargained for.
        f"{MINTED}-and-more",
        f"{MINTED};DROP TABLE",
    ],
)
def test_anything_that_is_not_that_shape_is_dropped(value):
    assert correlation.usable(value) == ""


def test_an_embedded_newline_cannot_reach_a_log_line():
    """The reason the shape is strict, as its own case.

    A refused turn prints the caller's id (`_identity_unavailable`), and a
    newline in a printed value writes a second line into the endpoint's log
    under the endpoint's own name. Every id below is otherwise well formed.
    """

    forged = "[identity] REFUSED nothing: all clear"
    for hostile in (
        f"{MINTED}\n{forged}",
        f"{MINTED}\r\n{forged}",
        f"{forged}\n{MINTED}",
    ):
        assert correlation.usable(hostile) == ""


# ---------------------------------------------------------------------------
# What gets recorded, and what is left unsaid
# ---------------------------------------------------------------------------


def test_both_ids_are_recorded_under_the_names_a_search_uses():
    recorded = correlation.facts(requirement(request_id=MINTED, run_id=LEDGER_RUN))
    assert recorded[correlation.CORRELATION_TAG] == MINTED
    assert recorded[correlation.RUN_TAG] == LEDGER_RUN


def test_a_request_that_sent_no_ids_records_none_rather_than_empty_ones():
    """Absent is absent. A tag reading "" is a measurement that came back blank."""

    assert correlation.facts(requirement()) == {}


def test_an_unusable_id_is_dropped_and_does_not_take_the_other_with_it():
    """A `curl` with a hand-written id still gets its ledger key recorded."""

    recorded = correlation.facts(requirement(request_id="whatever I like", run_id=LEDGER_RUN))
    assert correlation.CORRELATION_TAG not in recorded
    assert recorded[correlation.RUN_TAG] == LEDGER_RUN


def test_the_release_and_cost_facts_this_side_owns_are_recorded():
    """The build that answered, and the warehouse the statements billed to.

    Both come off settings, which are baked into the model artifact, rather than
    off the container's environment. The app records the other half -- release
    id, bundle target, workspace, serving endpoint -- beside them in the ledger.
    """

    recorded = correlation.facts(
        requirement(request_id=MINTED),
        settings(build_sha="abc1234", warehouse_id="w-42"),
    )
    assert recorded["release.build_sha"] == "abc1234"
    assert recorded["deployment.warehouse_id"] == "w-42"


def test_a_build_that_baked_no_sha_records_no_release_fact():
    """A local run and an uncertified build both arrive with it empty."""

    assert "release.build_sha" not in correlation.facts(
        requirement(request_id=MINTED), settings()
    )


def test_facts_are_all_strings_because_a_tag_value_is_text():
    recorded = correlation.facts(requirement(request_id=MINTED, run_id=LEDGER_RUN), settings())
    assert all(isinstance(value, str) for value in recorded.values())


# ---------------------------------------------------------------------------
# The join, end to end, against a real tracking backend
# ---------------------------------------------------------------------------


@pytest.fixture()
def tracing(tmp_path, monkeypatch):
    """A real tracing backend, so a trace is a trace and not a no-op.

    Without a tracking destination MLflow hands back `MLFLOW_NO_OP_SPAN`, and
    `update_current_trace` has nothing to tag. Every assertion below would pass
    against it while proving nothing, so the backend is explicit. Same fixture
    as `test_trace_context.py`, for the same reason.
    """

    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    mlflow.set_tracking_uri(f"sqlite:///{tmp_path}/mlflow.db")
    experiment = mlflow.set_experiment("correlation-join")
    yield experiment.experiment_id


class SpanningTools(FakeTools):
    """Tools whose Genie call opens a span where the real one opens it."""

    def data_genie(self, question: str):
        with mlflow.start_span(name="data_genie", span_type="TOOL"):
            return ToolResult(
                text="8,413 active players in the latest 30-day window.",
                sql=f"SELECT count(DISTINCT platformid_accountid) FROM {ACTIVITY}",
                sources=[ACTIVITY],
            )


def asking_genie() -> ScriptedLlm:
    """A model that asks the data space one question, then stops.

    A turn that calls no tool opens no tool span, and the claim being made below
    is about where a tool span lands.
    """

    return ScriptedLlm([Call("data_genie", {"question": "how many active players"})])


def _found(experiment_id: str, tag: str, value: str):
    mlflow.flush_trace_async_logging()
    # `locations` rather than the older `experiment_ids`, which mlflow 3.14
    # deprecates. Both work at the locked version; only one does without a
    # warning, and a warning here trains a reader to ignore this file's output.
    return MlflowClient().search_traces(
        locations=[experiment_id],
        filter_string=f"tags.{tag} = '{value}'",
    )


def test_the_browsers_id_finds_the_trace_of_the_run_it_named(tracing):
    """The whole point, in one test: an id from a log line, then the trace.

    This is the join the plan asks to be demonstrated rather than asserted. The
    id is not read back off the response -- it is used as a search filter, which
    is what somebody holding it actually has.
    """

    ask(build(asking_genie(), SpanningTools()), request_id=MINTED, run_id=LEDGER_RUN)

    found = _found(tracing, correlation.CORRELATION_TAG, MINTED)
    assert len(found) == 1, "the browser's id did not find exactly one trace"
    trace = found[0]

    # The ledger key is on the same trace, so the join runs the other way too:
    # a Lakebase row leads to the trace, not only the trace to the row.
    assert trace.info.tags[correlation.RUN_TAG] == LEDGER_RUN

    # And the Genie call is inside it. This is what makes the id a join across
    # systems rather than a label on one span: every data call the turn made is
    # a child of the span the tags were set from.
    names = {span.name for span in trace.data.spans}
    assert "orchestrator.loop" in names
    assert "data_genie" in names


def test_a_different_id_finds_nothing_of_this_run(tracing):
    """The filter discriminates, so the test above is not matching everything."""

    ask(build(asking_genie(), SpanningTools()), request_id=MINTED, run_id=LEDGER_RUN)

    assert _found(tracing, correlation.CORRELATION_TAG, LEDGER_RUN) == []


def test_the_facts_are_on_the_span_as_well_as_the_trace(tracing):
    """Both places, because they are read by different people.

    Tags are how a trace is FOUND; attributes are what a reader who already has
    the orchestrator span open sees without leaving it. The identity attributes
    beside them are set the same way for the same reason.
    """

    ask(build(asking_genie(), SpanningTools()), request_id=MINTED, run_id=LEDGER_RUN)

    trace = _found(tracing, correlation.CORRELATION_TAG, MINTED)[0]
    loop = next(span for span in trace.data.spans if span.name == "orchestrator.loop")
    assert loop.attributes[correlation.CORRELATION_TAG] == MINTED
    assert loop.attributes[correlation.RUN_TAG] == LEDGER_RUN


def test_a_run_with_no_id_is_still_traced(tracing):
    """A missing id must cost a trace, not the run and not the trace.

    `update_current_trace` is skipped entirely when there is nothing to record,
    and skipping it must not be confused with skipping the span.
    """

    ask(build(asking_genie(), SpanningTools()))

    mlflow.flush_trace_async_logging()
    traces = MlflowClient().search_traces(locations=[tracing])
    assert len(traces) == 1
    assert correlation.CORRELATION_TAG not in traces[0].info.tags
