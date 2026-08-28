"""That a step's concurrent tool calls behave exactly as the serial ones did.

The loop used to run a step's tool calls one after another, and every decision it
makes about a result -- is this a refusal, an access denial or an outage; does it
contribute evidence; does it brake the tool -- was made between two calls with
nothing else in flight. Now up to `MAX_PARALLEL_TOOL_CALLS` run at once, and the
whole safety argument is that the DECISIONS stayed sequential while only the I/O
moved: a worker does `_call_tool` and nothing else, and the results are read back
on the dispatching thread in the model's own order.

Nothing pinned that. The change landed with no test that a batch runs
concurrently at all, and none of the four properties below -- each of which is a
behaviour somebody using the app would notice losing -- was covered:

1. Distinct tools in one step really do overlap. Without this the optimisation
   could regress to serial and only a stopwatch would notice.
2. Calls to the SAME tool overlap too. The repeat brake cannot stop siblings
   already in flight, so calls that the serial path would have refused return
   their budget units after the repeated failure is classified.
3. One call raising does not lose the others. When the calls were serial the
   first failure stopped the batch; now three are in flight and the two that
   succeeded still have to reach the model, or a warehouse blip silently deletes
   evidence the answer was entitled to.
4. A governance refusal is still reported as a refusal, with its own message.
   `SqlRefused` is raised on a worker and re-raised here, and if it were caught
   by the generic handler on the way back the reader would be told a control that
   fired correctly was a surface that broke -- and the model would be invited to
   "try a different surface", which is how a refused query gets asked again
   somewhere the guard is not.

Overlap is measured by recording when each call entered and left and looking for
two spans that intersect, rather than by asserting on wall-clock totals: a timing
assertion on a loaded machine is a test that fails for its own reasons.
"""

from __future__ import annotations

import threading
import time

import pytest
from test_agent import (
    ACTIVITY,
    Call,
    FakeTools,
    ScriptedLlm,
    ask,
    build,
    resource_calls,
    stages,
)

from agent import ORCHESTRATOR_INSTRUCTIONS
from tools import SqlRefused


class TimedTools(FakeTools):
    """`FakeTools` that records the interval each call occupied, and its thread.

    The hold is what makes overlap observable at all: without it three calls that
    return immediately would finish before the third was submitted, and a serial
    loop would be indistinguishable from a concurrent one.
    """

    def __init__(self, hold: float = 0.2, **results):
        super().__init__(**results)
        self.hold = hold
        #: (tool, entered, left, thread name), appended under a lock because the
        #: point of this class is that several threads reach it at once.
        self.spans: list[tuple[str, float, float, str]] = []
        self._lock = threading.Lock()

    def _answer(self, tool: str, /, **arguments):
        entered = time.perf_counter()
        time.sleep(self.hold)
        try:
            return super()._answer(tool, **arguments)
        finally:
            with self._lock:
                self.spans.append(
                    (tool, entered, time.perf_counter(), threading.current_thread().name)
                )

    def overlapped(self) -> bool:
        """Whether any two calls were inside the tool surface at the same time."""

        for index, (_, mine_in, mine_out, _thread) in enumerate(self.spans):
            for _, theirs_in, theirs_out, _other in self.spans[index + 1 :]:
                if mine_in < theirs_out and theirs_in < mine_out:
                    return True
        return False

    def threads(self) -> set[str]:
        return {thread for _, _, _, thread in self.spans}


def tool_outputs(response) -> list[tuple[str, str]]:
    """Each tool stage's status and output, in the order the rail shows them."""

    return [
        (str(stage.get("status")), str(stage.get("output") or ""))
        for stage in stages(response)
        if stage.get("kind") in {"tool", "genie", "sql", "discovery", "plot", "knowledge"}
    ]


def test_distinct_tools_in_one_step_run_at_the_same_time():
    """The optimisation itself: three tools, three threads, overlapping spans."""

    tools = TimedTools()
    llm = ScriptedLlm(
        [
            Call("data_genie", {"question": "how many active players"}),
            Call("dictionary_genie", {"question": "what does label mean"}),
            Call("list_data_assets", {}),
        ]
    )

    ask(build(llm, tools))

    assert len(tools.spans) == 3
    assert tools.overlapped(), "a step's distinct tool calls ran one after another"
    assert "MainThread" not in tools.threads(), (
        "the batch ran on the dispatching thread, so nothing was dispatched to the pool"
    )


def test_one_call_stays_on_the_sequential_path():
    tools = TimedTools(hold=0.01)

    ask(build(ScriptedLlm([Call("resolve_table", {"name": "players"})]), tools))

    assert tools.threads() == {"MainThread"}


def test_repeated_tool_names_and_their_mixed_name_sibling_run_together():
    """A repeated name neither serialises itself nor drags another tool behind it."""

    tools = TimedTools()
    llm = ScriptedLlm(
        [
            Call("describe_table", {"full_name": ACTIVITY}, call_id="first"),
            Call("describe_table", {"full_name": f"{ACTIVITY}_v2"}, call_id="second"),
            Call("dictionary_genie", {"question": "what does label mean"}),
        ]
    )

    ask(build(llm, tools))

    assert len(tools.spans) == 3
    describes = [span for span in tools.spans if span[0] == "describe_table"]
    assert describes[0][1] < describes[1][2] and describes[1][1] < describes[0][2], (
        "the two describe_table calls did not overlap"
    )
    dictionary = next(span for span in tools.spans if span[0] == "dictionary_genie")
    assert any(
        mine_in < dictionary[2] and dictionary[1] < mine_out
        for _, mine_in, mine_out, _ in describes
    ), "the mixed-name call was dragged onto a serial path"
    assert "MainThread" not in tools.threads()


def test_repeat_brake_refunds_every_later_same_step_call_budget_unit():
    """Concurrent execution spends the same admission budget as the serial brake.

    Four identical failures physically run in the first step. The second failure
    would make a serial loop refuse calls three and four, so those two units are
    refunded and all four calls in the next step still fit under a six-call cap.
    Trace/resource accounting remains physical: all four Genie calls still count.
    """

    tools = TimedTools(hold=0.01, data_genie=RuntimeError("warehouse unavailable"))
    llm = ScriptedLlm(
        [
            Call("data_genie", {"question": f"broken-{index}"}, f"broken-{index}")
            for index in range(4)
        ],
        [
            Call("dictionary_genie", {"question": "define label"}, "next-1"),
            Call("resolve_table", {"name": "players"}, "next-2"),
            Call("describe_table", {"full_name": ACTIVITY}, "next-3"),
            Call("list_data_assets", {}, "next-4"),
        ],
        "Enough metadata was gathered.",
    )

    response = ask(
        build(llm, tools),
        runtime_settings={"loop": {"maxSteps": 4, "maxToolCalls": 6, "maxRunSeconds": 30}},
    )

    assert len(tools.named("data_genie")) == 4, "repeated calls were not dispatched together"
    assert len(tools.spans) == 8, (
        "the next step did not receive the four units the serial brake would have left"
    )
    failed = [
        stage
        for stage in stages(response)
        if stage["id"].startswith("step-1-") and stage["status"] == "failed"
    ]
    assert len(failed) == 4, "refunding admission budget hid physical failures from the trace"
    assert resource_calls(response) == [
        {"kind": "genie-space", "id": "data", "tool": "data_genie", "calls": 4},
        {
            "kind": "genie-space",
            "id": "dictionary",
            "tool": "dictionary_genie",
            "calls": 1,
        },
    ], "budget refunds changed physical resource-call accounting"
    assert any(
        "abandoned rather than retried" in caveat
        for caveat in response.custom_outputs["answer"]["caveats"]
    )


def test_budget_cap_inside_batch_is_cleared_after_repeat_refunds():
    """A stale dispatch-time cap must not erase the entire following step."""

    tools = TimedTools(hold=0.01, data_genie=RuntimeError("warehouse unavailable"))
    llm = ScriptedLlm(
        [
            Call("data_genie", {"question": f"broken-{index}"}, f"broken-{index}")
            for index in range(5)
        ],
        [
            Call("resolve_table", {"name": "players"}, "next-1"),
            Call("describe_table", {"full_name": ACTIVITY}, "next-2"),
        ],
        "The following reasoning step completed.",
    )

    response = ask(
        build(llm, tools),
        runtime_settings={"loop": {"maxSteps": 4, "maxToolCalls": 4, "maxRunSeconds": 30}},
    )

    assert len(tools.named("data_genie")) == 4
    assert len(tools.named("resolve_table")) == 1
    assert len(tools.named("describe_table")) == 1
    assert len(llm.loop_calls) == 3, "the stale over-budget flag removed the following step"
    assert not any(
        "stopped early because the 4-tool-call budget" in caveat
        for caveat in response.custom_outputs["answer"]["caveats"]
    )


def test_one_call_failing_does_not_lose_the_others_results():
    """Three in flight, the middle one dies: the other two still reach the model.

    Asserted on the transcript as well as the rail, because the transcript is
    what the model answers from. A batch that dropped its siblings' results would
    still draw three rows and answer from one.
    """

    tools = TimedTools(hold=0.02, list_data_assets=RuntimeError("warehouse unavailable"))
    llm = ScriptedLlm(
        [
            Call("data_genie", {"question": "how many active players"}),
            Call("list_data_assets", {}),
            Call("dictionary_genie", {"question": "what does label mean"}),
        ]
    )

    response = ask(build(llm, tools))
    reported = tool_outputs(response)

    statuses = [status for status, _ in reported[:3]]
    assert statuses == ["complete", "failed", "complete"], (
        f"the batch did not report all three outcomes in the model's order: {statuses}"
    )
    assert "8,413" in reported[0][1], "the first call's result was lost with the second's failure"
    assert "warehouse unavailable" in reported[1][1]
    assert "labels separate" in reported[2][1], "the third call's result was lost"

    answered = [message["content"] for message in llm.transcript if message.get("role") == "tool"]
    assert len(answered) == 3, "the model was not told the outcome of every call in the step"


class StaggeredTools(TimedTools):
    """Completes calls in reverse order so reporting order cannot pass by luck."""

    def __init__(self):
        super().__init__(hold=0)
        self.completed: list[str] = []

    def _answer(self, tool: str, /, **arguments):
        marker = str(next(iter(arguments.values())))
        time.sleep({"slow": 0.06, "middle": 0.03, "fast": 0.0}[marker])
        with self._lock:
            self.completed.append(marker)
        return super()._answer(tool, **arguments)


def test_results_and_trace_stages_keep_model_order_when_completion_reverses():
    tools = StaggeredTools()
    llm = ScriptedLlm(
        [
            Call("resolve_table", {"name": "slow"}, "slow"),
            Call("resolve_table", {"name": "middle"}, "middle"),
            Call("resolve_table", {"name": "fast"}, "fast"),
        ],
        "All lookups completed.",
    )

    response = ask(build(llm, tools))

    assert tools.completed == ["fast", "middle", "slow"], "the fixture did not reverse completion"
    answered = [
        message["tool_call_id"] for message in llm.transcript if message.get("role") == "tool"
    ]
    assert answered[:3] == ["slow", "middle", "fast"]
    trace_ids = [stage["id"] for stage in stages(response) if stage["id"].startswith("step-1-")]
    assert trace_ids == [
        "step-1-1-resolve_table",
        "step-1-2-resolve_table",
        "step-1-3-resolve_table",
    ]


def test_a_refusal_beside_two_successes_is_still_reported_as_a_refusal():
    """A control that fired must not come back as a surface that broke.

    `SqlRefused` is raised inside a worker, carried back, and re-raised on the
    dispatching thread so the refusal handler sees it first. If the generic
    failure handler caught it instead, the stage would read `failed`, the run
    would record an outage rather than a refusal, and the model would be told it
    may try another surface.
    """

    tools = TimedTools(hold=0.02, run_sql=SqlRefused("a cross-label join is refused"))
    llm = ScriptedLlm(
        [
            Call("data_genie", {"question": "how many active players"}),
            Call("run_sql", {"sql": f"SELECT profile_label FROM {ACTIVITY}"}),
            Call("dictionary_genie", {"question": "what does label mean"}),
        ]
    )

    response = ask(build(llm, tools))
    status, output = tool_outputs(response)[1]

    assert status == "partial", "a governance refusal was reported as a failed call"
    assert output.startswith("REFUSED:"), output[:120]
    assert "a cross-label join is refused" in output, (
        "the refusal reached the model without its own message, so the reason a "
        "control fired was replaced by a generic failure"
    )
    assert "ERROR:" not in output


@pytest.mark.parametrize(
    "names",
    [
        ("data_genie", "dictionary_genie"),
        ("data_genie", "dictionary_genie", "list_data_assets"),
    ],
)
def test_every_call_in_a_batch_is_answered_exactly_once(names):
    """No call is dropped and none is issued twice, at either batch width.

    A batch is dispatched from one list and read back from another, and the two
    passes are what a mistake here would fall between: a call answered twice
    spends the budget twice, and one answered not at all leaves the model a
    tool_call_id with no reply, which some providers reject outright.
    """

    tools = TimedTools(hold=0.01)
    llm = ScriptedLlm([Call(name, {"question": name}) for name in names])

    ask(build(llm, tools))

    called = [tool for tool, _, _, _ in tools.spans]
    assert sorted(called) == sorted(names), f"the step ran {called}, not {list(names)}"


def test_prompt_allows_only_cheap_metadata_batching():
    section = ORCHESTRATOR_INSTRUCTIONS.split("# Batching cheap metadata", 1)[1].split(
        "A table named without", 1
    )[0]

    for cheap in (
        "resolve_table",
        "describe_table",
        "search_tagged_assets",
        "search_semantics",
    ):
        assert cheap in section
    assert "You may batch" in section
    assert "descriptions/columns" in section
    assert "Do not speculatively batch" in section
    for expensive in (
        "Genie/natural-language layer",
        "query_named_table",
        "run_sql",
        "full list_data_assets table listing",
    ):
        assert expensive in section
