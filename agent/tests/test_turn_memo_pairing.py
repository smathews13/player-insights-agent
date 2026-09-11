"""That the turn's reused search surface is never read half-written.

The memo caches a thing that only means anything AS A PAIR: the search surface
belongs to a TOOLSET, and so to that caller's client and that caller's Unity
Catalog scopes. It was stored as two separate keys and read by validating one and
then trusting the other, which is only safe if no two threads are ever inside the
function at once.

Nothing can get two threads in there today, and that is the problem. The reason
is `tool_repetition.skip_batch`, which forces repeated calls to ONE tool to run
one at a time -- a PERFORMANCE decision about budget, in a different module, that
happens to serialise the only concurrent path into the memo. A correctness
property resting on that is a property that disappears the day somebody makes
same-tool calls concurrent, and the person doing it will have no way to know they
opened anything.

So the property is pinned here directly. The interleaving is FORCED rather than
raced for: the memo stops its first writer mid-write and lets a reader in, which
is deterministic and fails on the first run rather than one run in ten thousand.

Two shapes, and the second is the one that matters:

  1. The reader arrives after the first of two writes and the pairing it needs is
     not there yet -- a crash, which at least announces itself.
  2. The memo already held a pairing, so the reader arrives after the KEY has been
     replaced but before the VALUE has, validates against the new key, and is
     handed the old value. Nothing raises. One caller gets a search surface built
     from another caller's grants, which is the failure this whole memo is
     careful about everywhere else.
"""

from __future__ import annotations

import threading

from agent import _TURN_CREDENTIALS
from semantic_retrieval import SemanticRetrieval
from tests.test_agent import FakeTools, ScriptedLlm, build

#: Long enough that a genuinely stuck thread is a failure rather than a hang,
#: short enough that a failing run does not look like a broken suite.
PATIENCE = 5.0


def toolset() -> FakeTools:
    """A distinct toolset, with the one attribute the retrieval reads off it."""

    tools = FakeTools()
    tools.user_authorized = True
    return tools


class SteppedMemo(dict):
    """A turn memo that pauses its first writer one write in.

    The pause is AFTER the write lands, which is what makes this a probe for a
    half-published pairing rather than for an empty one: a reader that wakes here
    sees exactly what the writer has published so far, and the question is
    whether that is a whole pairing or half of one.

    Deliberately agnostic about key names. It counts writes rather than watching
    for a particular key, so it keeps testing the property after the storage
    layout changes -- which is the point of the fix it is here to check.
    """

    def __init__(self, seed: dict | None = None):
        super().__init__(seed or {})
        self.published = threading.Event()
        self.reader_done = threading.Event()
        self.writes: list[str] = []
        self._armed = True

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        self.writes.append(key)
        if self._armed:
            self._armed = False
            self.published.set()
            self.reader_done.wait(timeout=PATIENCE)


def seeded_memo(runtime, tools):
    """A memo holding whatever the code ITSELF stores for `tools`, and that value.

    Seeded by running the real function rather than by writing keys by hand, so
    this stays honest across a change to how the pairing is stored -- which is the
    change it exists to check. `dict.__init__` does not route through
    `__setitem__`, so copying the state in does not arm the probe.
    """

    plain: dict = {}
    _TURN_CREDENTIALS.set(plain)
    try:
        held = runtime._semantic_retrieval(tools)
    finally:
        _TURN_CREDENTIALS.set(None)
    return SteppedMemo(plain), held


def run_interleaved(runtime, memo, call, reader_call=None):
    """`call` on two threads, the second entering mid-write of the first."""

    results: dict[str, object] = {}

    def writer():
        # Set in the thread, because a thread starts from an empty context and
        # this is exactly how the real path shares one dict: `copy_context`
        # copies the BINDING, so both threads hold the same memo object.
        _TURN_CREDENTIALS.set(memo)
        try:
            results["writer"] = call(runtime)
        except BaseException as error:  # noqa: BLE001 - reported, not raised
            results["writer"] = error
        finally:
            memo.reader_done.set()

    def reader():
        _TURN_CREDENTIALS.set(memo)
        assert memo.published.wait(timeout=PATIENCE), "the writer never published"
        try:
            results["reader"] = (reader_call or call)(runtime)
        except BaseException as error:  # noqa: BLE001 - reported, not raised
            results["reader"] = error
        finally:
            memo.reader_done.set()

    threads = [threading.Thread(target=writer), threading.Thread(target=reader)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=PATIENCE * 2)
    assert not any(thread.is_alive() for thread in threads), "a thread never finished"
    _TURN_CREDENTIALS.set(None)
    return results


# ---------------------------------------------------------------------------
# The search surface
# ---------------------------------------------------------------------------


def test_a_reader_mid_write_is_not_handed_half_a_search_surface():
    """Shape 1: the pairing is not complete yet, and the reader must not crash."""

    runtime = build(ScriptedLlm(), FakeTools())
    tools = toolset()
    memo = SteppedMemo()

    results = run_interleaved(runtime, memo, lambda r: r._semantic_retrieval(tools))

    assert not isinstance(results["reader"], BaseException), (
        f"a second thread in the same turn read a half-written memo: "
        f"{results['reader']!r} after writes {memo.writes}"
    )
    assert isinstance(results["reader"], SemanticRetrieval)


def test_a_reader_mid_write_is_never_handed_another_callers_search_surface():
    """Shape 2, and the one that fails silently.

    The memo already holds a surface for one toolset. A rebuild for a second
    toolset replaces the key first, so a reader validating against the new key is
    handed the old surface -- built from a different caller's client, and so from
    a different caller's Unity Catalog scopes. Discovery would be narrowed, or
    widened, by grants that are not the asker's.
    """

    runtime = build(ScriptedLlm(), FakeTools())
    memo, stale = seeded_memo(runtime, toolset())
    tools = toolset()

    results = run_interleaved(runtime, memo, lambda r: r._semantic_retrieval(tools))

    assert results["reader"] is not stale, (
        "a caller was handed a search surface built from another caller's client, "
        "so their discovery was scoped by somebody else's grants"
    )
    assert not isinstance(results["reader"], BaseException), results["reader"]
    assert results["reader"].workspace is tools.workspace, (
        "the surface was not built from the toolset that asked for it"
    )


def test_the_surface_is_still_built_once_when_nothing_is_racing():
    """The saving this memo exists for has to survive the fix."""

    runtime = build(ScriptedLlm(), FakeTools())
    tools = toolset()
    _TURN_CREDENTIALS.set({})
    try:
        first = runtime._semantic_retrieval(tools)
        second = runtime._semantic_retrieval(tools)
    finally:
        _TURN_CREDENTIALS.set(None)

    assert first is second, "the retrieval was rebuilt, so the memo does nothing"


def test_a_different_toolset_never_reuses_the_memo():
    """The rule the memo already had, kept: a surface is one caller's."""

    runtime = build(ScriptedLlm(), FakeTools())
    _TURN_CREDENTIALS.set({})
    try:
        mine = runtime._semantic_retrieval(toolset())
        theirs = runtime._semantic_retrieval(toolset())
    finally:
        _TURN_CREDENTIALS.set(None)

    assert mine is not theirs, "two toolsets shared one retrieval surface"


def test_no_open_turn_still_means_no_caching():
    """Outside a turn there is nothing to cache into, and nothing is."""

    runtime = build(ScriptedLlm(), FakeTools())
    tools = toolset()
    _TURN_CREDENTIALS.set(None)

    assert runtime._semantic_retrieval(tools) is not runtime._semantic_retrieval(tools)


# ---------------------------------------------------------------------------
# The measured identity carries the same two-key pairing and is stored the same
# way for that reason, but it is deliberately NOT probed here. Both of its keys
# are written by two different functions on the turn's own thread, so producing a
# torn pairing means hand-seeding a memo state the code cannot reach -- and a test
# that pins an impossible state is decoration. The property that matters for it,
# that an identity measured for one client is never returned for another, is
# already pinned in `test_turn_credentials.py` from a state the code does produce.
# ---------------------------------------------------------------------------
