"""A Genie space that was never shared, and the answer that pretended otherwise.

Sharing a space with the serving principal at CAN RUN is a manual, UI-only step,
so it is the step a first deploy skips, and the space then refuses every call.

A space that DID NOT RESPOND may work next time and the sensible response is to
retry. A space that REFUSED will refuse forever and the sensible response is for
a person to open the Genie UI. Reporting the second as the first means every
remedy a deployer tries is one that cannot work.

These hold the distinction in the three places it has to survive: the classifier,
the instruction handed back to the model, and the answer the stakeholder reads.
"""

from __future__ import annotations

from agent import (
    DEGRADED_ANSWER_MARKER,
    genie_access_denial,
)
from tests.test_agent import Call, FakeTools, ScriptedLlm, ask, build, stages

SPACE = "01ef0000000000000000000000000000"


class PermissionDenied(Exception):
    """The SDK's own exception name, which is how the SDK reports a 403.

    Reproduced by name rather than imported so the test states the contract it
    depends on. `databricks.sdk.errors.PermissionDenied` is what actually
    arrives; if the SDK renames it, this test keeps passing and production
    stops working, so `_GENIE_DENIAL_TYPES` also matches on status and error
    code, and the cases below cover those routes independently.
    """


class NotFound(Exception):
    """A space the principal cannot see is often 404 rather than 403.

    Which of the two a deployment gets is not something the deployer chose, and
    reading the 404 as "wrong space id" is wrong nearly every time: the id came
    out of the bundle, so it is right.
    """


def sdk_error(status: int | None = None, code: str = "", message: str = "denied"):
    error = RuntimeError(message)
    if status is not None:
        error.status_code = status  # type: ignore[attr-defined]
    if code:
        error.body = {"error_code": code}  # type: ignore[attr-defined]
    return error


# ---------------------------------------------------------------------------
# Telling a refusal from a failure
# ---------------------------------------------------------------------------


def test_a_permission_denied_exception_is_recognised_as_a_refusal():
    denial = genie_access_denial(PermissionDenied("space not shared"), SPACE)

    assert denial is not None
    assert "REFUSED" in denial


def test_a_space_the_principal_cannot_see_is_a_refusal_not_a_bad_id():
    assert genie_access_denial(NotFound("space does not exist"), SPACE) is not None
    assert genie_access_denial(sdk_error(status=404), SPACE) is not None


def test_the_http_status_and_the_error_code_are_each_enough_on_their_own():
    """Three independent routes to the same verdict, because one is not reliable.

    The SDK's exception class, the HTTP status, and the `error_code` in the body
    are populated inconsistently across SDK builds and across the workspace's
    own gateway. Requiring all three would mean the diagnosis appears on some
    deployments and not others, and an intermittent diagnosis is one nobody
    believes.
    """

    assert genie_access_denial(sdk_error(status=403), SPACE) is not None
    assert genie_access_denial(sdk_error(code="PERMISSION_DENIED"), SPACE) is not None
    assert genie_access_denial(RuntimeError("PERMISSION_DENIED: no grant"), SPACE) is not None


def test_a_timeout_is_not_a_refusal():
    """The guard, and the more important half of the classifier.

    A diagnosis that fires for every failure is worth nothing. Telling somebody
    whose warehouse was cold to go and re-share a Genie space that is already
    shared spends the trust the real message needs.
    """

    assert genie_access_denial(TimeoutError("Genie did not answer within 45s"), SPACE) is None
    assert (
        genie_access_denial(RuntimeError("failed to reach COMPLETED, got FAILED"), SPACE) is None
    )
    assert genie_access_denial(sdk_error(status=500), SPACE) is None
    assert genie_access_denial(sdk_error(status=429, code="REQUEST_LIMIT_EXCEEDED"), SPACE) is None


def test_a_message_that_merely_mentions_permission_is_not_a_refusal():
    """Matched on the error CODES, not on loose words.

    Genie answers in prose and is perfectly capable of saying "permission" or
    "denied" while describing something else: a row filter, a masked column, a
    question about access. Matching those would fire the whole banner on a
    successful run.
    """

    assert genie_access_denial(RuntimeError("the query mentions permission levels"), SPACE) is None
    assert genie_access_denial(RuntimeError("access was denied to one row group"), SPACE) is None


# ---------------------------------------------------------------------------
# What the refusal says
# ---------------------------------------------------------------------------


def test_the_refusal_names_the_space_the_remedy_and_the_cli():
    denial = genie_access_denial(PermissionDenied("no grant"), SPACE)
    assert denial is not None

    # Which space. A deployment has two, and "a Genie space" sends the deployer
    # to check both, including the one that is fine.
    assert SPACE in denial
    # The exact permission level, because CAN VIEW looks like sharing and is not
    # enough to run a query.
    assert "CAN RUN" in denial
    # The remedy names the CLI, because older copy claimed sharing was UI-only.
    assert "databricks permissions update genie" in denial
    # And it does not send the fix to the serving endpoint principal.
    assert "serving endpoint principal" in denial and "NOT the serving" in denial
    # And that no amount of redeploying will do it, which is otherwise the first
    # thing anyone tries.
    assert "Redeploying will not fix it" in denial


def test_the_refusal_prefers_a_human_readable_title_beside_the_id():
    """The shape `_genie_space_for` hands in when a title was baked at log time.

    A deployer looking at two spaces needs the name they would search for in
    the Genie UI, not only the hex the bundle recorded.
    """

    labelled = f"Player Insights Data ({SPACE})"
    denial = genie_access_denial(PermissionDenied("no grant"), labelled)
    assert denial is not None
    assert labelled in denial
    assert SPACE in denial


def test_format_genie_space_joins_title_and_id():
    from config import format_genie_space

    assert format_genie_space(SPACE, "Player Insights Data") == f"Player Insights Data ({SPACE})"
    assert format_genie_space(SPACE, "") == SPACE
    assert format_genie_space("", "Named") == "Named ((unset))"
    assert format_genie_space("", "") == "(unset)"


def test_the_refusal_names_who_was_refused_when_the_run_knows():
    """Under user authorization the refused identity may be the caller's, not ours.

    Telling a stakeholder to grant CAN RUN to "the serving principal" when it
    was their own token that was refused sends the fix to the wrong identity.
    """

    denial = genie_access_denial(PermissionDenied("no grant"), SPACE, "someone@example.test")
    assert denial is not None
    assert "someone@example.test" in denial

    unknown = genie_access_denial(PermissionDenied("no grant"), SPACE)
    assert unknown is not None
    assert "the signed-in caller" in unknown


# ---------------------------------------------------------------------------
# What reaches the stakeholder
# ---------------------------------------------------------------------------


def test_a_refused_genie_space_marks_the_answer_it_fell_back_to():
    """The whole defect, end to end: an answer over SQL that says what it is.

    The fallback itself is kept (refusing to answer would break a live demo
    over a setup step), but the answer can no longer be mistaken for one the
    governed Genie space produced.
    """

    tools = FakeTools(data_genie=PermissionDenied("space is not shared with this principal"))
    llm = ScriptedLlm(
        [Call("data_genie", {"question": "active players by title"})],
        [Call("run_sql", {"sql": "SELECT 1 AS n"})],
        "VLH Online leads with 8,413 active players.",
    )

    answer = ask(build(llm, tools)).custom_outputs["answer"]

    caveats = " ".join(answer["caveats"])
    assert DEGRADED_ANSWER_MARKER in caveats
    assert "REFUSED" in caveats
    assert "CAN RUN" in caveats
    # And NOT the sentence for an outage, which would invite a retry that cannot
    # work. This is the assertion the incident turns on.
    assert "did not respond" not in caveats


def test_a_refused_genie_space_names_its_baked_title_in_the_caveat():
    """Title threading into the refusal the stakeholder reads.

    `_genie_space_for` reads the title off the same settings the call used, so a
    deployer is told which space to open by name rather than by hex alone.
    """

    from tests.test_agent import settings as agent_settings

    tools = FakeTools(data_genie=PermissionDenied("not shared"))
    tools.settings = agent_settings(data_genie_space_title="Player Insights Data")
    llm = ScriptedLlm(
        [Call("data_genie", {"question": "q"})],
        [Call("run_sql", {"sql": "SELECT 1 AS n"})],
        "An answer.",
    )

    answer = ask(
        build(llm, tools, data_genie_space_title="Player Insights Data")
    ).custom_outputs["answer"]

    caveats = " ".join(answer["caveats"])
    assert "Player Insights Data (data)" in caveats


def test_the_degradation_is_the_first_caveat_a_reader_meets():
    """Position is part of the disclosure, not decoration.

    The app splits caveats on the marker and renders the matching ones above the
    figures rather than below them, but an app build that has not caught up
    renders them in order, so the order has to be right on its own.
    """

    tools = FakeTools(data_genie=PermissionDenied("not shared"))
    llm = ScriptedLlm(
        [Call("data_genie", {"question": "q"})],
        [Call("run_sql", {"sql": "SELECT 1 AS n"})],
        "An answer.",
    )

    answer = ask(build(llm, tools)).custom_outputs["answer"]

    assert answer["caveats"][0].startswith(DEGRADED_ANSWER_MARKER)


def test_the_marker_is_the_exact_string_the_app_splits_on():
    """A CROSS-BOUNDARY CONTRACT with `client/src/degraded-answer.ts`.

    The agent is a serving endpoint released separately from the app and in
    either order, so nothing at build time can catch the two disagreeing. Both
    sides write the literal string out in a test; changing one without the other
    fails here rather than quietly un-marking every degraded answer in the UI.
    """

    assert DEGRADED_ANSWER_MARKER == "This answer is degraded:"


def test_the_model_is_not_invited_to_route_around_a_refusal():
    """The sentence that caused the silent fallback, removed from this path.

    "try a different surface if one applies" is routing advice, and the model
    took it, which is how the answer came to be produced over SQL with nothing
    saying so. It may still answer another way; it is now told what that answer
    is not.
    """

    tools = FakeTools(data_genie=PermissionDenied("not shared"))
    llm = ScriptedLlm(
        [Call("data_genie", {"question": "q"})],
        [Call("run_sql", {"sql": "SELECT 1 AS n"})],
        "An answer.",
    )

    response = ask(build(llm, tools))

    refused = next(stage for stage in stages(response) if "REFUSED" in stage["output"])
    assert "try a different surface" not in refused["output"]
    assert "Do not retry it" in refused["output"]
    assert "NOT grounded in the Genie space" in refused["output"]


def test_the_synthesis_package_separates_a_refusal_from_a_failure():
    """Or the narrative above the caveat still reads as a complete account."""

    tools = FakeTools(
        data_genie=PermissionDenied("not shared"),
        dictionary_genie=TimeoutError("Genie did not answer within 45s"),
    )
    llm = ScriptedLlm(
        [Call("data_genie", {"question": "q"})],
        [Call("dictionary_genie", {"question": "what is active"})],
        [Call("run_sql", {"sql": "SELECT 1 AS n"})],
        "An answer.",
    )
    runtime = build(llm, tools)

    ask(runtime)

    package = next(
        call for call in llm.calls if "assessed data package" in call["messages"][-1]["content"]
    )["messages"][-1]["content"]
    # Two headings, two lists, and the tools under the right one. Collapsing
    # them is what let the model describe a refused space as unavailable.
    assert "Surfaces that REFUSED this run's identity" in package
    assert "Tool calls that FAILED this run" in package
    refused_section = package.split("Surfaces that REFUSED this run's identity")[1]
    assert "data_genie" in refused_section.split("Governance controls")[0]
    failed_section = package.split("Tool calls that FAILED this run")[1]
    assert "dictionary_genie" in failed_section.split("Surfaces that REFUSED")[0]


def test_a_refusal_is_not_reported_as_a_governance_control_firing():
    """The other misfiling, and the one that would flatter us.

    A governance refusal is the product working, and PIA's demo is largely about
    showing one. Crediting a control that never fired for a setup step nobody
    performed hides an unfinished deployment behind a feature.
    """

    tools = FakeTools(data_genie=PermissionDenied("not shared"))
    llm = ScriptedLlm(
        [Call("data_genie", {"question": "q"})],
        [Call("run_sql", {"sql": "SELECT 1 AS n"})],
        "An answer.",
    )

    answer = ask(build(llm, tools)).custom_outputs["answer"]

    assert "governance control refused" not in " ".join(answer["caveats"])


def test_a_correctly_shared_deployment_carries_no_refusal_caveat():
    """The property the rest of this file depends on.

    A deployment whose spaces are shared has to look exactly as it did before
    this change: no marker, no red panel in the app, no new sentence. A warning
    that is always on is one nobody reads.
    """

    llm = ScriptedLlm([Call("data_genie", {"question": "q"})], "Done.")

    answer = ask(build(llm)).custom_outputs["answer"]

    caveats = " ".join(answer["caveats"])
    assert DEGRADED_ANSWER_MARKER not in caveats
    assert "REFUSED" not in caveats
    assert "CAN RUN" not in caveats


def test_an_ordinary_genie_outage_still_reads_as_an_outage():
    """The classifier's guard, restated where it reaches the reader.

    A space that timed out has to keep the wording it had. If everything became
    a refusal, the refusal message would be the new generic one and the deployer
    would be sent to the Genie UI for a cold warehouse.
    """

    tools = FakeTools(data_genie=TimeoutError("Genie did not answer within 45s"))
    llm = ScriptedLlm(
        [Call("data_genie", {"question": "q"})],
        [Call("run_sql", {"sql": "SELECT 1 AS n"})],
        "An answer.",
    )

    answer = ask(build(llm, tools)).custom_outputs["answer"]

    caveats = " ".join(answer["caveats"])
    assert "did not respond during this run" in caveats
    assert "CAN RUN" not in caveats
    # Still marked degraded, though: it is still an answer over fewer surfaces.
    assert DEGRADED_ANSWER_MARKER in caveats
