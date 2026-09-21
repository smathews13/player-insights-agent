"""That the saving is a recorded fact, not something a reader has to reconstruct.

`test_definition_coalescing.py` asserts the mechanism against the fake tool surface:
eight questions reach the dictionary space once. This file asserts the same turn
against a REAL tracing backend and reads the spans back, because the claim being
made is about what a trace will show. "Eight calls became one" is only worth
anything if somebody opening the run can see it without counting.

Three facts are read back, and each answers a question the recorded runs could not:

1. `calls_saved` on the loop span -- how many calls the model asked for that no
   space was asked for. Without it, the saving is invisible: a trace with one
   dictionary call looks like a run where the model only asked once.
2. `evidence_blocks` and `prompt_chars` on the synthesis and charting spans. Those
   two steps have been the erratic ones (synthesis 8-22s, charting reaching 13.1s
   against a typical 2-3s) and nothing on the span distinguished a long prompt from
   a slow model. Sizes are recorded, never content: a prompt must not be
   reconstructable from a trace, and neither must a question.
3. `structured_output` on the synthesis span. Synthesis asks for JSON and falls
   back to a second, full model call if the endpoint refuses the parameter. If that
   fallback is firing in production then every answer pays two calls, and no
   recorded run could tell us which path it took.
"""

from __future__ import annotations

import mlflow
import pytest
from mlflow.tracking import MlflowClient

from tests.test_agent import Call, FakeTools, ScriptedLlm, ask, build
from tools import ToolResult

FIELDS = (
    "net_bookings_usd",
    "recurrent_consumer_spending_usd",
    "completed_purchases",
    "list_price_usd",
    "gross_bookings_usd",
    "refunds_usd",
    "session_count",
    "days_active",
)


@pytest.fixture()
def tracing(tmp_path, monkeypatch):
    """A real backend, so spans carry attributes instead of being no-ops.

    With no tracking destination MLflow hands back `MLFLOW_NO_OP_SPAN` and every
    assertion below would pass while reading nothing.
    """

    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    mlflow.set_tracking_uri(f"sqlite:///{tmp_path}/mlflow.db")
    experiment = mlflow.set_experiment("definition-saving")
    yield experiment.experiment_id


def one_span(experiment_id: str, name: str):
    """The named span, read back the way somebody auditing the run would read it."""

    mlflow.flush_trace_async_logging()
    traces = MlflowClient().search_traces(locations=[experiment_id]) or []
    found = [span for trace in traces for span in trace.data.spans if span.name == name]
    assert found, f"no {name} span was recorded, so the run cannot be audited"
    return found[0]


def test_the_loop_span_records_how_many_calls_were_saved(tracing):
    """Eight asked, one made, seven recorded as saved."""

    tools = FakeTools(dictionary_genie=ToolResult(text="All of those are governed fields."))
    llm = ScriptedLlm(
        [
            Call("dictionary_genie", {"question": f"What does {field} mean?"}, call_id=field)
            for field in FIELDS
        ]
    )

    ask(build(llm, tools))

    assert len(tools.named("dictionary_genie")) == 1, "the step did not collapse to one call"
    loop = one_span(tracing, "orchestrator.loop")
    saved = loop.outputs.get("calls_saved")
    assert saved == len(FIELDS) - 1, (
        f"the loop span reports {saved} saved calls, so a reader auditing the run "
        "cannot see that eight questions were asked and one call was made"
    )


def test_the_synthesis_span_records_its_prompt_size_and_which_path_it_took(tracing):
    """The two facts that would have explained the 8-22s spread."""

    tools = FakeTools(dictionary_genie=ToolResult(text="All of those are governed fields."))
    llm = ScriptedLlm(
        [
            Call("dictionary_genie", {"question": f"What does {field} mean?"}, call_id=field)
            for field in FIELDS
        ]
    )

    ask(build(llm, tools))

    synthesis = one_span(tracing, "orchestrator.synthesis")
    assert synthesis.inputs.get("evidence_blocks") == 1, (
        "the synthesis prompt carried more than one copy of the shared answer, which "
        "is the prompt-size half of the saving"
    )
    assert synthesis.inputs.get("prompt_chars", 0) > 0, "the prompt size was not recorded"
    assert synthesis.outputs.get("structured_output") in {"schema", "json_object", "unconstrained"}, (
        "nothing records whether the structured-output request was honoured, so a "
        "run that silently paid for two model calls looks identical to one that did not"
    )


def test_no_prompt_text_or_question_text_is_recorded_as_a_size(tracing):
    """The sizes are sizes. A trace must not become a way to read a prompt."""

    tools = FakeTools(dictionary_genie=ToolResult(text="All of those are governed fields."))
    llm = ScriptedLlm(
        [Call("dictionary_genie", {"question": "What does net_bookings_usd mean?"}, call_id="a")]
    )

    ask(build(llm, tools))

    synthesis = one_span(tracing, "orchestrator.synthesis")
    for field in ("prompt_chars", "evidence_blocks"):
        assert isinstance(synthesis.inputs.get(field), int), (
            f"{field} is meant to be a count; a string there would be the prompt itself"
        )
