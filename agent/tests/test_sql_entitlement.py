"""A serving principal with no `databricks-sql-access`, and the answer that
called it an outage.

Observed on a customer POC. Every direct-SQL tool was refused by the Statement
Execution API for a missing WORKSPACE ENTITLEMENT, and the stakeholder read that
"table descriptions did not respond during this run". Nothing did not respond: an
entitlement is an assignment on the identity, so it refuses every statement on
every warehouse until an admin patches the account.

The cost of getting this wrong is specific rather than cosmetic. The two remedies
a reader reaches for on a SQL refusal are `CAN_USE` on the warehouse and `SELECT`
on the table. Both are grants, an entitlement is not, so both of them run, change
nothing observable, and send the reader back.

These hold the distinction in the three places it has to survive: the classifier,
the instruction handed back to the model, and the answer the stakeholder reads.
"""

from __future__ import annotations

from agent import (
    DEGRADED_ANSWER_MARKER,
    SQL_ACCESS_ENTITLEMENT,
    sql_entitlement_denial,
)
from tests.test_agent import Call, FakeTools, ScriptedLlm, ask, build, stages

TABLE = "cat.sch.master_table"


class PermissionDenied(Exception):
    """The SDK's own exception name, which is how the SDK reports a 403."""


#: The API's refusal, transcribed from the customer's own trace rather than
#: paraphrased. The prose around the identifiers is what varies between
#: platform versions, so the classifier matches the identifiers and this string
#: is here to prove it does so on the real one.
OBSERVED = (
    "PermissionDenied: This API is disabled for users without the "
    "databricks-sql-access or workspace-consume entitlement."
)


# ---------------------------------------------------------------------------
# Telling a refused identity from a refused object
# ---------------------------------------------------------------------------


def test_the_observed_refusal_is_recognised():
    denial = sql_entitlement_denial(PermissionDenied(OBSERVED))

    assert denial is not None
    assert "REFUSED" in denial


def test_either_entitlement_name_is_enough_on_its_own():
    """The API names two, and which one it names is not the deployer's choice."""

    assert sql_entitlement_denial(RuntimeError("needs databricks-sql-access")) is not None
    assert sql_entitlement_denial(RuntimeError("needs workspace-consume")) is not None


def test_an_ordinary_sql_refusal_is_not_read_as_an_entitlement():
    """The guard, and the half that matters more.

    A 403 from this API is USUALLY a missing `CAN_USE` or a missing `SELECT`,
    and those really are fixed by a grant. Telling somebody to go to SCIM for
    one of those sends them to an admin they do not need and leaves the grant
    they do need unmade.
    """

    assert sql_entitlement_denial(PermissionDenied("HTTP 403")) is None
    assert (
        sql_entitlement_denial(
            RuntimeError("[INSUFFICIENT_PERMISSIONS] User does not have SELECT on table")
        )
        is None
    )
    assert sql_entitlement_denial(TimeoutError("the warehouse did not answer")) is None
    assert sql_entitlement_denial(RuntimeError("PERMISSION_DENIED: no grant")) is None


def test_the_refusal_says_no_grant_reaches_it_and_who_can():
    denial = sql_entitlement_denial(PermissionDenied(OBSERVED))
    assert denial is not None

    # The entitlement by name, because it is the string the SCIM patch carries.
    assert SQL_ACCESS_ENTITLEMENT in denial
    # The two dead ends, named so they are not tried.
    assert "GRANT" in denial and "CAN_USE" in denial
    # Who fixes it, and on which SCIM collection: a service principal is not
    # patched at /Users, and a patch aimed at the wrong collection 404s in a
    # way that reads as the id being wrong.
    assert "workspace admin" in denial
    assert "ServicePrincipals" in denial
    # And NOT the sentence for an outage, which invites a retry that cannot work.
    assert "did not respond" not in denial


def test_the_refusal_names_who_was_refused_when_the_run_knows():
    """Under user authorization the refused identity may be the caller's own."""

    denial = sql_entitlement_denial(PermissionDenied(OBSERVED), "someone@example.test")
    assert denial is not None
    assert "someone@example.test" in denial

    unknown = sql_entitlement_denial(PermissionDenied(OBSERVED))
    assert unknown is not None
    assert "the agent's serving principal" in unknown


# ---------------------------------------------------------------------------
# What reaches the stakeholder
# ---------------------------------------------------------------------------


def test_a_refused_entitlement_marks_the_answer_rather_than_reading_as_an_outage():
    tools = FakeTools(describe_table=PermissionDenied(OBSERVED))
    llm = ScriptedLlm(
        [Call("describe_table", {"full_name": TABLE})],
        "No table could be read, so no figure is reported.",
    )

    answer = ask(build(llm, tools)).custom_outputs["answer"]

    caveats = " ".join(answer["caveats"])
    assert DEGRADED_ANSWER_MARKER in caveats
    assert SQL_ACCESS_ENTITLEMENT in caveats
    assert "did not respond" not in caveats


def test_the_model_is_told_the_other_sql_tools_are_already_refused():
    """The old text offered "a different surface", and the next surface is this
    same API: one refusal became three, and the turn ended having learned
    nothing it did not know after the first.
    """

    tools = FakeTools(describe_table=PermissionDenied(OBSERVED))
    llm = ScriptedLlm(
        [Call("describe_table", {"full_name": TABLE})],
        "An answer.",
    )

    response = ask(build(llm, tools))

    refused = next(stage for stage in stages(response) if "REFUSED" in stage["output"])
    model_guidance = "\n".join(
        str(message["content"]) for message in llm.transcript if message["role"] == "tool"
    )
    assert "try a different surface" not in model_guidance
    assert "Do not retry it" in model_guidance
    assert "query_named_table" in model_guidance and "run_sql" in model_guidance
    assert "Do not retry it" not in refused["output"]
    assert "query_named_table" not in refused["output"] and "run_sql" not in refused["output"]
    # The Genie wording belongs to the other classifier. A SQL refusal is not
    # about a Genie space and must not tell the reader to go and share one.
    assert "Genie" not in refused["output"]


def test_a_genie_refusal_still_gets_the_genie_wording():
    """Both classifiers on one branch, so this pins that neither swallowed the
    other: the SQL one runs only for the non-Genie tools.
    """

    tools = FakeTools(data_genie=PermissionDenied("space is not shared"))
    llm = ScriptedLlm(
        [Call("data_genie", {"question": "q"})],
        "An answer.",
    )

    response = ask(build(llm, tools))

    refused = next(stage for stage in stages(response) if "REFUSED" in stage["output"])
    model_guidance = "\n".join(
        str(message["content"]) for message in llm.transcript if message["role"] == "tool"
    )
    assert "NOT grounded in the Genie space" in model_guidance
    assert "NOT grounded in the Genie space" not in refused["output"]
    assert SQL_ACCESS_ENTITLEMENT not in refused["output"]
