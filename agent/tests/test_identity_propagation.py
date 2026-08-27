"""That every data call goes through the identity the turn was verified for.

The gate in `execution_identity.py` establishes WHO a turn runs as. It buys
nothing if a tool then reaches for a different client, and that is not a
hypothetical: `PlayerInsightTools.__init__` constructs a bare `WorkspaceClient()`
when it is handed none, which under automatic authentication resolves to the
model version's passthrough principal. One tool built that way, or one call made
on a module-level client instead of `self.workspace`, and that surface reads
every table the manifest granted regardless of who asked -- and it looks exactly
like a working answer.

So the assertions here are about the CLIENT each of the four surfaces used, not
about what came back. A recording client stands in for the invoker's, and any
call that did not land on it is a call that got its credentials somewhere else.

NOT COVERED, because it is the platform's half: whether the token the SDK finds
is really the invoker's downscoped one. `agent/tests/verify_identity_live.py` is
where that is established, against a deployment.
"""

from __future__ import annotations

import inspect
import re
from types import SimpleNamespace

import pytest
from databricks.sdk.service.dashboards import MessageStatus

import tools as tools_module
from config import Settings
from tools import PlayerInsightTools

DECLARED = "test_catalog.test_schema.gold_player_profiles"
MANIFEST = (DECLARED,)


class RecordingWorkspace:
    """A client that answers plausibly and remembers it was the one asked.

    Every surface returns the shape its caller expects, because a tool that
    raises has not demonstrated which client it would have used.
    """

    def __init__(self, name: str = "invoker"):
        self.name = name
        self.used: list[str] = []
        self.genie = SimpleNamespace(
            start_conversation=self._start,
            get_message=self._message,
        )
        self.statement_execution = SimpleNamespace(
            execute_statement=self._execute,
            get_statement_result_chunk_n=self._chunk,
        )

    def _start(self, space_id: str, question: str):
        self.used.append(f"genie:{space_id}")
        return SimpleNamespace(conversation_id="c1", message_id="m1")

    def _message(self, space_id: str, conversation_id: str, message_id: str):
        return SimpleNamespace(
            status=MessageStatus.COMPLETED,
            content="Active players rose.",
            attachments=[SimpleNamespace(text=SimpleNamespace(content="Active players rose."))],
        )

    def _execute(
        self,
        warehouse_id: str,
        statement: str,
        wait_timeout: str,
        on_wait_timeout=None,
        query_tags=None,
    ):
        self.used.append(f"sql:{' '.join(statement.split())}")
        return SimpleNamespace(
            statement_id="s1",
            status=SimpleNamespace(
                state=SimpleNamespace(value="SUCCEEDED"),
                error=SimpleNamespace(message=""),
            ),
            result=SimpleNamespace(data_array=[["1"]], chunk_index=0, next_chunk_index=None),
            manifest=SimpleNamespace(
                total_row_count=1,
                schema=SimpleNamespace(columns=[SimpleNamespace(name="col_name")]),
            ),
        )

    def _chunk(self, statement_id: str, chunk_index: int):
        return SimpleNamespace(data_array=[], chunk_index=chunk_index, next_chunk_index=None)


def build(workspace) -> PlayerInsightTools:
    settings = Settings(
        llm_endpoint="fake",
        warehouse_id="test-warehouse",
        data_genie_space_id="data-space",
        dictionary_genie_space_id="dictionary-space",
        catalog="test_catalog",
        schema="test_schema",
        catalog_allowlist=("test_catalog",),
        max_output_tokens=1000,
        declared_manifest=MANIFEST,
    )
    return PlayerInsightTools(settings, workspace, user_authorized=True)


@pytest.fixture(autouse=True)
def _no_polling(monkeypatch):
    monkeypatch.setattr(tools_module, "GENIE_POLL_SECONDS", 0)


@pytest.fixture(autouse=True)
def _no_ambient_client(monkeypatch):
    """Make a fallback to ambient credentials fail loudly instead of silently.

    This is the fixture that gives the rest of the file its teeth. Without it a
    tool that built its own `WorkspaceClient()` would get one -- the SDK finds
    the container's credentials perfectly well -- and the test would report a
    passing call on the wrong identity.
    """

    def refuse(*args, **kwargs):
        raise AssertionError(
            "A tool built its own WorkspaceClient instead of using the one the "
            "turn was verified for. That client authenticates as the model "
            "version's passthrough principal, so the call would have run under "
            "the manifest's grants rather than the asker's."
        )

    monkeypatch.setattr("databricks.sdk.WorkspaceClient", refuse)


# ---------------------------------------------------------------------------
# The four surfaces
# ---------------------------------------------------------------------------


def test_data_genie_asks_through_the_verified_client():
    workspace = RecordingWorkspace()
    build(workspace).data_genie("How many active players?")
    assert "genie:data-space" in workspace.used


def test_dictionary_genie_asks_through_the_verified_client():
    workspace = RecordingWorkspace()
    build(workspace).dictionary_genie("What is a label?")
    assert "genie:dictionary-space" in workspace.used


def test_metadata_lookup_reads_through_the_verified_client():
    """`describe_table` is a SQL statement like any other, which is the point:
    there is no metadata API path that could quietly run somewhere else."""

    workspace = RecordingWorkspace()
    build(workspace).describe_table(DECLARED)
    assert any(entry.startswith("sql:") for entry in workspace.used)


def test_guarded_sql_executes_through_the_verified_client():
    workspace = RecordingWorkspace()
    build(workspace).run_sql(f"SELECT 1 FROM {DECLARED}")
    assert any(DECLARED.split(".")[-1] in entry for entry in workspace.used)


def test_every_surface_uses_the_same_client_and_no_other():
    """The whole point, asserted once over all four rather than per surface.

    A second client anywhere in here is a second identity, and the answer would
    be assembled from evidence read under two different sets of grants without
    anything saying so.
    """

    workspace = RecordingWorkspace()
    tools = build(workspace)
    tools.data_genie("How many active players?")
    tools.dictionary_genie("What is a label?")
    tools.describe_table(DECLARED)
    tools.run_sql(f"SELECT 1 FROM {DECLARED}")

    assert len(workspace.used) >= 4
    # `_no_ambient_client` has already failed the test if anything reached for
    # its own. This says the one it did reach for is the one that was passed.
    assert tools.workspace is workspace


# ---------------------------------------------------------------------------
# The invariant behind the four
# ---------------------------------------------------------------------------


def test_no_remote_call_is_made_on_anything_but_self_workspace():
    """Read from the source, because the tests above can only cover the calls
    somebody remembered to write a test for.

    A new tool added next year gets this assertion for free, which is the only
    kind of coverage worth having for a rule this easy to break by accident.
    """

    # Matches a call on an SDK service, and only a call: prose in a docstring
    # that happens to mention Genie does not have a receiver, and a rule that
    # fires on prose gets relaxed until it fires on nothing.
    call = re.compile(r"([\w.]*)\.(genie|statement_execution|current_user)\.\w+\(")
    found = 0
    for line in inspect.getsource(PlayerInsightTools).splitlines():
        for match in call.finditer(line):
            found += 1
            assert match.group(1) == "self.workspace", (
                f"A remote call not made on self.workspace: {line.strip()!r}. "
                "Every call has to go through the client the turn was verified "
                "for, or that surface runs as somebody else."
            )
    # The scan itself has been wrong before in the direction that matters: a
    # pattern that matches nothing passes silently and reads as a guarantee.
    assert found >= 3


def test_the_agent_never_caches_a_user_authorized_toolset():
    """Model Serving parks one invoker's token per request in a thread-local and
    serves concurrent requests from one container, so a cached user-authorized
    toolset hands the first caller's identity to everyone after them.

    Asserted against the source of `_runtime` rather than by driving the agent,
    because the failure is an assignment that is absent, and an integration test
    would need two concurrent requests against a real endpoint to see it.

    `_runtime` now reaches the invoker's client through `_authorized_client`,
    which memoises it FOR ONE TURN. So the scan follows that one step: the
    toolset must still be built on the invoker's client and still not be kept on
    the agent, and the memo has to live somewhere narrower than the agent, which
    is built once at import. `test_turn_credentials.py` drives the per-turn scope
    itself; this stays a source scan because what it is looking for is an
    assignment that must not appear.
    """

    import agent as agent_module

    source = inspect.getsource(agent_module.PlayerInsightsResponsesAgent._runtime)
    # Everything after the injected-tools escape hatch, which is the only
    # assignment to `self._tools` left and exists for these tests.
    built = source.split("if self._tools is not None:", 1)[1]

    assert "self._authorized_client()" in built
    assert "self._tools =" not in built, "a toolset was cached for the next caller to inherit"
    # And the passthrough client cannot be what a toolset is built on. This is
    # the removed fallback, asserted where it was written rather than where it
    # was reached: `_system_workspace` survives for the model call and must not
    # come back here.
    assert "_system_workspace" not in built, (
        "data tools were built on this endpoint's own principal, which is the "
        "service-principal fallback this method no longer has"
    )

    # The step `_runtime` now delegates to. This is where the invoker's client is
    # actually built, so this is where the old assertion has to hold.
    memoised = inspect.getsource(agent_module.PlayerInsightsResponsesAgent._authorized_client)
    assert "user_authorized_client()" in memoised
    assert "_system_workspace" not in memoised
    # THE SCOPE OF THE MEMO IS THE WHOLE SAFETY ARGUMENT. Anything hung off the
    # agent is hung off a singleton shared by every concurrent caller.
    assert "self._client" not in memoised and "self._authorized" not in memoised, (
        "the invoker's client was cached on the agent, which every request shares"
    )
    assert "_TURN_CREDENTIALS" in memoised, (
        "the client is memoised somewhere other than the per-turn context, so "
        "nothing bounds how long it outlives the request that authenticated it"
    )
