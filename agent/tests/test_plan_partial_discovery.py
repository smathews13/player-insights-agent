"""That one table a caller may not read costs the plan only that table.

A REFUSAL IS THE NORMAL CASE HERE, NOT THE EXCEPTION. The premise of this
deployment is that two people asking the same question see different data
according to their own Unity Catalog grants, so "one of the candidate tables is
not readable by this caller" is the state most turns are in. Discovery used to
describe the candidates and let the first refusal escape, which the plan step
caught as a total failure and answered with the generic plan -- the one that names
no table, no column and no filter, and so cannot be refused by the reviewer it is
shown to. The governance control got weakest exactly where governance was working.

Four properties:

1. The plan keeps the detail from the tables that DID resolve.
2. It says a table was refused, and that this is a permissions matter rather than
   a broken query, so the reader is not left guessing whether to retry.
3. It invents NO detail for the table it could not read: that table appears in no
   step, and none of its columns are named. Partial knowledge stated as partial is
   fine; partial knowledge presented as complete is not.
4. A refusal is distinguished from a table that is missing or broken, because the
   two have different remedies and only one of them is somebody's grant.

Naming the refused table here is deliberate and is NOT the disclosure that
`sql_object_denial` and `tools.DENIAL_WITHOUT_OBJECT` refuse to make. Those redact
the object because an arbitrary statement's refusal could name something the
caller was never shown. A plan candidate is always one of the DECLARED tables,
and `list_data_assets` reads that same declaration and shows every name in it to
every caller regardless of grants -- so the reader has already been shown this
table exists, and withholding the name would only stop them understanding which
part of their own answer is missing.
"""

from __future__ import annotations

import pytest

from tests.test_agent import (
    ACTIVITY,
    PLAN_COLUMNS,
    PLAN_FACTS,
    PLAN_QUESTION,
    PROFILES,
    TITLE_DAILY,
    FakeTools,
    ScriptedLlm,
    app_request,
    build,
    describe_result,
)
from tools import SqlDenied, ToolResult

#: The three candidates the planner picks. `TITLE_DAILY` is the one `PLAN_FACTS`
#: writes steps against, so the plan stays specific as long as that one resolves.
CANDIDATES = [TITLE_DAILY, ACTIVITY, PROFILES]

#: What the warehouse raises when the caller holds no SELECT on the table. Its
#: own message names no object, which is why the plan has to name the table
#: itself rather than relaying this.
DENIED = SqlDenied(
    "SQL FAILED: the identity it ran as is not granted something the statement named",
    "42501",
)


class PerTableTools(FakeTools):
    """A describe surface that answers per table, so one can be refused."""

    def __init__(self, refused: dict[str, BaseException] | None = None, **results):
        super().__init__(**results)
        self.refused = refused or {}
        self.described: list[str] = []

    def describe_table(self, full_name: str, columns: str = ""):
        self.described.append(full_name)
        outcome = self.refused.get(full_name)
        if isinstance(outcome, BaseException):
            raise outcome
        if isinstance(outcome, ToolResult):
            return outcome
        return describe_result(full_name, *PLAN_COLUMNS)


def plan_with(refused=None, candidates=CANDIDATES):
    tools = PerTableTools(refused=refused)
    llm = ScriptedLlm(plan_tables=list(candidates), plan_facts=PLAN_FACTS)
    runtime = build(llm, tools)
    response = runtime.predict(
        app_request(input=[{"role": "user", "content": PLAN_QUESTION}])
    )
    return response.custom_outputs["plan"], tools


def described_text(plan) -> str:
    return " ".join(step["description"] for step in plan["steps"])


def test_a_readable_candidate_set_still_plans_specifically():
    """The control. If this failed the harness would be the fault, not the fix."""

    plan, tools = plan_with()

    assert TITLE_DAILY in described_text(plan)
    assert "net_bookings_usd" in described_text(plan)


def test_one_refused_table_leaves_the_rest_of_the_plan_intact():
    """The regression: a refusal used to cost the plan every table's detail."""

    plan, tools = plan_with(refused={PROFILES: DENIED})

    assert set(tools.described) == set(CANDIDATES), "not every candidate was attempted"
    assert TITLE_DAILY in described_text(plan), (
        "one refused candidate dropped the plan back to the generic one, which names "
        "no table and so cannot be refused by the reviewer it is shown to"
    )
    assert "net_bookings_usd" in described_text(plan)
    assert "activity_date >= current_date() - INTERVAL 180 DAYS" in described_text(plan)


def test_the_plan_says_a_table_was_refused_and_that_it_is_about_permissions():
    """Refused is not the same as broken, and the reader has to be told which."""

    plan, _ = plan_with(refused={PROFILES: DENIED})
    summary = plan["summary"]

    assert PROFILES.split(".")[-1] in summary, (
        f"the plan does not say which table it could not read: {summary!r}"
    )
    assert "grant" in summary.lower(), (
        f"the reader is not told this was a permissions matter: {summary!r}"
    )


def test_a_refused_table_gets_no_invented_detail():
    """No step reads it, and none of its columns are named against it.

    A plan that named the refused table as one it would read would be inviting
    approval for work that cannot happen, which is the same defect as naming a
    column that is not in the table.
    """

    facts = {
        **PLAN_FACTS,
        "tables": [
            *PLAN_FACTS["tables"],
            {
                "name": PROFILES,
                "purpose": "per-player profile detail",
                "columns": list(PLAN_COLUMNS),
                "filters": ["label IN ('Northwind')"],
            },
        ],
    }
    tools = PerTableTools(refused={PROFILES: DENIED})
    llm = ScriptedLlm(plan_tables=list(CANDIDATES), plan_facts=facts)
    response = build(llm, tools).predict(
        app_request(input=[{"role": "user", "content": PLAN_QUESTION}])
    )
    plan = response.custom_outputs["plan"]

    reading = [step for step in plan["steps"] if step["description"].startswith("Read ")]
    assert reading, "the plan named no table at all"
    assert all(PROFILES not in step["description"] for step in reading), (
        "the plan promises to read a table the caller was refused"
    )
    assert f"Read {TITLE_DAILY}." in described_text(plan)


def test_every_candidate_refused_still_tells_the_reader_why():
    """The edge. Nothing to plan against, but the reason is not swallowed.

    The plan necessarily falls back to the generic one here -- there is no detail
    left to write it from -- but a reader who is shown a vague plan and no reason
    has no way to tell a governance refusal from a broken deployment.
    """

    plan, tools = plan_with(
        refused={table: DENIED for table in CANDIDATES}
    )

    assert set(tools.described) == set(CANDIDATES)
    summary = plan["summary"]
    assert "grant" in summary.lower(), (
        f"every candidate was refused and the plan says nothing about it: {summary!r}"
    )
    for table in CANDIDATES:
        assert table not in described_text(plan), "a refused table was planned against"


def test_a_missing_table_is_not_reported_as_a_permissions_matter():
    """A broken read and a refused one have different remedies.

    Telling somebody their grants are short when the table does not exist sends
    them to an admin who will find nothing to fix.
    """

    plan, _ = plan_with(
        refused={PROFILES: RuntimeError("SQL FAILED: TABLE_OR_VIEW_NOT_FOUND")}
    )
    summary = plan["summary"]

    assert PROFILES.split(".")[-1] in summary, summary
    assert "grant" not in summary.lower(), (
        f"a missing table was reported as a permissions problem: {summary!r}"
    )
    assert TITLE_DAILY in described_text(plan), "a broken table also cost the whole plan"


@pytest.mark.parametrize("refused_table", [ACTIVITY, PROFILES])
def test_which_candidate_is_refused_does_not_change_the_outcome(refused_table):
    """Order must not matter: the refusal is not simply the last one described."""

    plan, _ = plan_with(refused={refused_table: DENIED})

    assert TITLE_DAILY in described_text(plan)
    assert refused_table.split(".")[-1] in plan["summary"]
