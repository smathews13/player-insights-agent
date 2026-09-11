"""That describing a plan's candidate tables together keeps every candidate.

Describing candidates concurrently replaced a per-table deadline check with a
per-WAVE one, and the docstring claims that "nothing is dropped for being past
the cap". Nothing tested it, and it is exactly the kind of claim that stops being
true silently: `PLAN_MAX_TABLES` is 3 today, so there is only ever one wave, and a
truncation bug would sit dormant until somebody raised that limit and got a plan
written against the first five tables of eight without anything saying so.

Three properties, and the third is the one a person using the app notices:

1. Every candidate is described, however many there are -- chunked into waves,
   never truncated to the width of one.
2. No more than `MAX_PARALLEL_TOOL_CALLS` are in flight at once, which is what
   stops one turn's discovery becoming the reason another turn's is slow.
3. The candidate step's ORDER survives. The model reads the order of this
   catalogue as priority, so returning them as they complete would reorder the
   plan by whichever table the warehouse happened to answer first.

The deadline case is here too, because a wave-granular deadline still has to bound
the work and still has to keep what it already learned: cutting discovery short
and returning nothing are very different answers.
"""

from __future__ import annotations

import threading
import time

from agent import MAX_PARALLEL_TOOL_CALLS
from tests.test_agent import PLAN_COLUMNS, FakeTools, ScriptedLlm, build, describe_result

NAMESPACE = "test_catalog.test_schema"


class CountingTools(FakeTools):
    """Counts how many describes are in flight at once, and in what order."""

    def __init__(self, hold: float = 0.05):
        super().__init__()
        self.hold = hold
        self.described: list[str] = []
        self.peak = 0
        self._live = 0
        self._lock = threading.Lock()

    def describe_table(self, full_name: str, columns: str = ""):
        with self._lock:
            self.described.append(full_name)
            self._live += 1
            self.peak = max(self.peak, self._live)
        try:
            time.sleep(self.hold)
            return describe_result(full_name, *PLAN_COLUMNS)
        finally:
            with self._lock:
                self._live -= 1


def candidates(count: int) -> list[str]:
    return [f"{NAMESPACE}.candidate_{index}" for index in range(count)]


def test_more_candidates_than_one_wave_are_chunked_not_truncated():
    """Twelve candidates, three waves, twelve descriptions."""

    tools = CountingTools()
    runtime = build(ScriptedLlm(), tools)
    wanted = candidates(12)

    described = runtime._describe_for_plan(tools, wanted, time.perf_counter() + 30).described

    assert tools.described == wanted, (
        "the candidates past the first wave were dropped rather than described in "
        "a second one, so a plan would be written against fewer tables than the "
        "candidate step chose"
    )
    assert list(described) == wanted, "the candidate step's priority order was not preserved"


def test_no_more_than_the_cap_are_described_at_once():
    """The pool width, which is what keeps one turn from starving another."""

    tools = CountingTools()
    runtime = build(ScriptedLlm(), tools)

    runtime._describe_for_plan(tools, candidates(12), time.perf_counter() + 30)

    assert tools.peak <= MAX_PARALLEL_TOOL_CALLS, (
        f"{tools.peak} describes were in flight at once, past the cap of "
        f"{MAX_PARALLEL_TOOL_CALLS}"
    )
    assert tools.peak > 1, "nothing ran concurrently, so the batch is serial again"


def test_a_spent_deadline_keeps_what_was_already_described():
    """Cut short, not thrown away.

    A deadline that returned nothing would send every slow discovery turn to the
    generic plan, which is the plan that names no tables -- so a reviewer would be
    asked to approve a run without being told what it reads.
    """

    tools = CountingTools(hold=0.12)
    runtime = build(ScriptedLlm(), tools)
    wanted = candidates(12)

    discovery = runtime._describe_for_plan(tools, wanted, time.perf_counter() + 0.2)
    described = discovery.described

    assert 0 < len(described) < len(wanted), (
        f"the deadline neither bounded the work nor kept its results: "
        f"{len(described)} of {len(wanted)}"
    )
    assert list(described) == wanted[: len(described)], (
        "the tables kept were not the ones the candidate step ranked first"
    )
    # A table the budget never reached is not a table the caller was refused, and
    # a plan that conflated them would send somebody to an admin to be granted
    # something they already hold.
    assert not discovery.unreadable, (
        f"tables cut off by the deadline were reported as unreadable: "
        f"{discovery.unreadable}"
    )
