"""That a whole REAL turn's parallel tool calls still land in one audit trail.

`test_trace_context.py` pins `_in_trace_context` in isolation: given a span on
the dispatching thread, a worker's span nests under it. That is the helper, not
the loop, and the gap between them is where this defect would hide. The helper
copies whatever context it finds, so if the loop dispatched a batch from a point
where no span was active, every tool span would still open a root span in a trace
of its own -- and the helper's own test would keep passing while the run anybody
audits lost its tool calls.

So this drives a turn end to end, through `predict`, against a real tracing
backend, and asserts on where the spans actually landed: one trace, one parent,
no orphans, and the same shape whether the batch ran concurrently or serially.
The trace is what the Run Explorer, the per-request record and every "what did
this turn actually read" question are served from, so a dropped tool span costs
nothing at answer time and everything at audit time.

The serial case is asserted beside the parallel one deliberately. "The trace of a
parallel step is the same shape as the trace of a serial one" is the claim the
change makes, and comparing the two is the only way to test a claim about
sameness.
"""

from __future__ import annotations

import mlflow
import pytest
from test_agent import ACTIVITY, Call, FakeTools, ScriptedLlm, ask, build


@pytest.fixture()
def tracing(tmp_path, monkeypatch):
    """A real backend, so spans are spans and not no-ops.

    Without a tracking destination MLflow hands back `MLFLOW_NO_OP_SPAN`, whose
    parent and trace ids are all `None` and therefore all equal. Every assertion
    below would pass against it while proving nothing.
    """

    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    mlflow.set_tracking_uri(f"sqlite:///{tmp_path}/mlflow.db")
    mlflow.set_experiment("parallel-audit-trail")
    yield


class SpanningTools(FakeTools):
    """Opens a span per call the way the real tool surface does, and records it."""

    def __init__(self, **results):
        super().__init__(**results)
        #: (tool, parent span id, trace id) as MLflow assigned them.
        self.landed: list[tuple[str, str | None, str]] = []

    def _answer(self, tool: str, /, **arguments):
        with mlflow.start_span(name=f"tool.{tool}", span_type="TOOL") as span:
            self.landed.append((tool, span.parent_id, span.trace_id))
            return super()._answer(tool, **arguments)


def assert_one_audit_trail(tools: SpanningTools, expected: int) -> None:
    assert len(tools.landed) == expected, f"only {len(tools.landed)} of {expected} calls traced"

    orphans = [tool for tool, parent, _ in tools.landed if parent is None]
    assert not orphans, (
        f"{orphans} opened a ROOT span, so those tool calls formed traces of their "
        "own and vanished from the run an auditor reads"
    )

    traces = {trace for _, _, trace in tools.landed}
    assert len(traces) == 1, f"the step's calls were split across {len(traces)} traces"

    parents = {parent for _, parent, _ in tools.landed}
    assert len(parents) == 1, (
        f"the step's calls were attributed to {len(parents)} different parents, so at "
        "least one is nested under something that did not dispatch it"
    )

    assert not next(iter(traces)).startswith("MLFLOW_NO_OP"), (
        "tracing was disabled, so every assertion above passed vacuously"
    )


def test_a_parallel_batch_lands_in_one_trace_under_one_parent(tracing):
    """Three distinct tools, dispatched to the pool, in a real turn."""

    tools = SpanningTools()
    llm = ScriptedLlm(
        [
            Call("data_genie", {"question": "how many active players"}),
            Call("dictionary_genie", {"question": "what does label mean"}),
            Call("list_data_assets", {}),
        ]
    )

    ask(build(llm, tools))

    assert_one_audit_trail(tools, expected=3)


def test_a_single_serial_call_traces_the_same_shape(tracing):
    """The comparison that gives the test above its meaning.

    One call takes the serial path, so its span is opened on the dispatching
    thread and needs no help to nest. If this failed too, the fault would be in
    the harness rather than in the pool.
    """

    tools = SpanningTools()
    llm = ScriptedLlm([Call("describe_table", {"full_name": ACTIVITY}, call_id="only")])

    ask(build(llm, tools))

    assert_one_audit_trail(tools, expected=1)


def test_a_failing_call_is_still_traced_beside_its_siblings(tracing):
    """An outage must not take the record of itself down with it.

    The worker catches the exception and the dispatching thread classifies it, so
    the span is opened and closed inside the worker either way. A failed call that
    left no span would make the trace read as a turn that never tried.
    """

    tools = SpanningTools(list_data_assets=RuntimeError("warehouse unavailable"))
    llm = ScriptedLlm(
        [
            Call("data_genie", {"question": "how many active players"}),
            Call("list_data_assets", {}),
            Call("dictionary_genie", {"question": "what does label mean"}),
        ]
    )

    ask(build(llm, tools))

    assert_one_audit_trail(tools, expected=3)
    assert "list_data_assets" in [tool for tool, _, _ in tools.landed]
