"""The Genie-to-SQL fallback, at the loop level, proven gone.

`test_route_disclosure.py` tests the ledger in isolation. This file is the part
that matters to a reader of an answer: a run where a Genie space fails and the
model then reaches for the warehouse, checked end to end for the two things that
were missing before. The model is no longer invited to reroute, and when it
reroutes anyway the answer says so.

Written against the same scenario the outage audit used, because that run is the
one the old behaviour looked best on: every figure in it was real and governed,
which is why a substitution that changed what the figures MEANT went unnoticed
for so long.
"""

import evidence
import failures
from evidence import EvidenceCandidate, EvidenceRefused, Verdict
from tests.test_agent import ACTIVITY, Call, FakeTools, ScriptedLlm, ask, build
from tools import ToolResult

SQL = f"SELECT label, count(*) FROM {ACTIVITY} GROUP BY label"


def genie_down_then_sql() -> tuple[ScriptedLlm, FakeTools]:
    """The audited run: the Genie route fails, and the model asks for SQL instead."""

    tools = FakeTools(
        data_genie=RuntimeError("failed to reach COMPLETED, got MessageStatus.FAILED"),
        run_sql=ToolResult(
            text="label | active_players_30d\nNorthwind | 8413",
            sql=SQL,
            sources=[ACTIVITY],
        ),
    )
    llm = ScriptedLlm(
        [Call("data_genie", {"question": "active players"})],
        [Call("run_sql", {"sql": SQL})],
        "8,413 active players for Northwind.",
    )
    return llm, tools


# ---------------------------------------------------------------------------
# What the model is told when the route fails
# ---------------------------------------------------------------------------


def test_the_model_is_no_longer_invited_to_try_a_different_surface():
    """The fallback was this sentence, so its absence is the removal.

    Asserted on the transcript rather than on the function that builds the string,
    because the string only matters if it reaches the model, and the loop has more
    than one handler that could put text in front of it.
    """

    llm, tools = genie_down_then_sql()

    ask(build(llm, tools))

    tool_messages = [
        str(message.get("content")) for message in llm.transcript if message.get("role") == "tool"
    ]
    outage = next(message for message in tool_messages if "MessageStatus.FAILED" in message)
    assert "try a different surface" not in outage
    assert "its own tool call" in outage, "a reroute is something to request, not to assume"
    assert "spends a step" in outage, "and it costs the same as any other call"


def test_the_model_is_told_the_substitution_will_be_disclosed():
    """Cheaper than forbidding it: a model that knows the record already exists has
    no reason to present the substitute as the plan it always had.
    """

    llm, tools = genie_down_then_sql()

    ask(build(llm, tools))

    outage = next(
        str(message.get("content"))
        for message in llm.transcript
        if message.get("role") == "tool" and "MessageStatus.FAILED" in str(message.get("content"))
    )
    assert "will disclose" in outage
    assert "do not describe a direct SQL result as governed or curated" in outage


def test_an_attribution_refusal_reaches_the_model_as_a_re_ask_not_a_dead_end():
    """The guidance is only worth anything if the loop is what delivers it.

    Checked on the transcript because the loop wraps every refusal in its own
    text, and that wrapper is where the contradiction lived: the tool asked for a
    re-ask and the wrapper forbade it in the next sentence.
    """

    tools = FakeTools(
        data_genie=EvidenceRefused(
            Verdict(
                outcome=evidence.REFUSED,
                candidate=EvidenceCandidate(
                    tool="data_genie",
                    route=evidence.ROUTE_GENIE,
                    payload_type=evidence.PAYLOAD_VISUALIZATION,
                ),
                code=failures.GENIE_UNATTRIBUTABLE,
                reason="Genie returned a chart with no query behind it.",
            )
        )
    )
    llm = ScriptedLlm(
        [Call("data_genie", {"question": "chart active players"})],
        "I could not attribute those figures.",
    )

    ask(build(llm, tools))

    refused = next(
        str(message.get("content"))
        for message in llm.transcript
        if message.get("role") == "tool" and str(message.get("content")).startswith("REFUSED")
    )
    assert "ASK THE SAME GENIE SPACE AGAIN" in refused
    assert "Do NOT ask another tool the same question" not in refused


# ---------------------------------------------------------------------------
# What the reader is told when it reroutes anyway
# ---------------------------------------------------------------------------


def test_a_rerouted_answer_discloses_that_it_changed_surfaces():
    llm, tools = genie_down_then_sql()

    answer = ask(build(llm, tools)).custom_outputs["answer"]

    substitution = next(
        caveat for caveat in answer["caveats"] if "did not come from the route" in caveat
    )
    assert "the governed Genie space" in substitution
    assert "direct SQL over the warehouse" in substitution
    assert "degraded" in substitution, "the app lifts marked caveats into the panel readers see"


def test_the_outage_caveat_still_leads_and_the_substitution_refines_it():
    """Order is load-bearing: the app lifts the first marked caveat.

    "A surface was down" is the event and belongs first. "So these figures did not
    come from the curated layer" is what the reader needs BECAUSE of it, and
    leading with the refinement buries the thing being refined.
    """

    llm, tools = genie_down_then_sql()

    caveats = ask(build(llm, tools)).custom_outputs["answer"]["caveats"]

    assert "Genie space" in caveats[0] and "during this run" in caveats[0], "the outage leads"
    assert "did not come from the route" in caveats[1], "and this sits directly beneath it"


def test_the_answer_keeps_the_figures_it_legitimately_read():
    """The disclosure is the control, not a reason to throw the answer away.

    Refusing the substitution outright would take a working answer from a
    stakeholder mid-demo over an outage nobody in the room can fix. The SQL read
    was governed and its source is real, so it is cited.
    """

    llm, tools = genie_down_then_sql()

    answer = ask(build(llm, tools)).custom_outputs["answer"]

    assert "8,413" in str(answer)
    assert [source["name"] for source in answer["sources"]] == [ACTIVITY]


def test_a_run_that_simply_used_sql_says_nothing_about_substitution():
    """The spurious firing that would make this caveat worthless.

    Nothing failed, so nothing stood in for anything, and a run that planned to
    use SQL must not be described as having fallen back to it.
    """

    tools = FakeTools(
        run_sql=ToolResult(
            text="label | active_players_30d\nNorthwind | 8413",
            sql=SQL,
            sources=[ACTIVITY],
        )
    )
    llm = ScriptedLlm(
        [Call("run_sql", {"sql": SQL})],
        "8,413 active players for Northwind.",
    )

    answer = ask(build(llm, tools)).custom_outputs["answer"]

    assert not any("did not come from the route" in caveat for caveat in answer["caveats"])


def test_a_genie_outage_with_no_substitute_is_still_only_an_outage():
    """A failure alone is not a substitution, or every degraded run claims one."""

    tools = FakeTools(dictionary_genie=RuntimeError("Genie did not answer within 45s"))
    llm = ScriptedLlm(
        [Call("dictionary_genie", {"question": "what is an active player"})],
        "I could not confirm the definition.",
    )

    answer = ask(build(llm, tools)).custom_outputs["answer"]

    assert any("This answer is degraded" in caveat for caveat in answer["caveats"]), (
        "the outage is said"
    )
    assert not any("did not come from the route" in caveat for caveat in answer["caveats"])
