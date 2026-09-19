"""One question, one MLflow session -- so a benchmark reads a row per question.

A single question is not a single trace. The plan proposal, the approval that
runs it, and any re-ask of the same words are separate serving invokes, so
MLflow lists them as separate traces; benchmarking them one trace at a time is
the difficulty this groups away. `_plan_id` is already a fingerprint of the
question (see `agent._plan_id` and `test_agent`), the same across the
propose/approve round trip and independent of the run id, so recording it as the
trace SESSION collapses those traces into one group in MLflow's "Group by
session" view.

WHY A REAL BACKEND AND A WRAPPING SPAN. Session lives in trace METADATA, which
MLflow fixes at trace creation. The agent records it before the orchestrator
span, where in a served invoke the root trace already exists. A direct
`predict()` in a test has no root until its first span, so these tests open one
-- the same shape serving provides -- and then look the trace up the way the UI
groups it: `search_traces` filtered on the session metadata key. Same fixture
reasoning as `test_correlation.py`.
"""

from __future__ import annotations

import mlflow
import pytest
from mlflow.tracking import MlflowClient

from agent import _plan_id
from tests.test_agent import Call, FakeTools, ScriptedLlm, app_request, build

#: A nontrivial question (the "analyze" marker makes it plan-first), so the
#: propose turn returns a plan and the approve turn runs the loop -- the two
#: traces this file insists are one session.
QUESTION = "Analyze activity by label."


@pytest.fixture()
def tracing(tmp_path, monkeypatch):
    """A real (sqlite) tracing backend, so a trace is a trace and not a no-op."""

    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    mlflow.set_tracking_uri(f"sqlite:///{tmp_path}/mlflow.db")
    experiment = mlflow.set_experiment("session-grouping")
    yield experiment.experiment_id


def _invoke(runtime, request):
    """Drive one turn under a root span, the way a served invoke would.

    A served `/invocations` already has a root trace open when the agent records
    the session; a bare `predict()` does not until its first span opens, and the
    session is set before the orchestrator span. Opening the root here is what
    makes the test exercise the real ordering rather than a no-op.
    """

    with mlflow.start_span(name="serving.invoke", span_type="AGENT"):
        return runtime.predict(request)


def _grouped_by(experiment_id: str, session_id: str):
    """The traces the UI would fold under one session header, found its way."""

    mlflow.flush_trace_async_logging()
    return MlflowClient().search_traces(
        locations=[experiment_id],
        filter_string=f"metadata.`mlflow.trace.session` = '{session_id}'",
    )


def test_a_question_and_its_approval_land_in_one_session(tracing):
    """The plan and the run that answered it group together, not apart."""

    session = _plan_id(QUESTION, "")

    # Propose: nontrivial and unapproved, so the agent returns a plan and never
    # reaches the orchestrator loop -- the path that used to carry no session.
    proposed = _invoke(
        build(ScriptedLlm(), FakeTools()),
        app_request(input=[{"role": "user", "content": QUESTION}]),
    )
    assert proposed.custom_outputs["type"] == "plan"
    assert proposed.custom_outputs["plan"]["id"] == session

    # Approve: the same question, now named by that plan id, runs the loop.
    llm = ScriptedLlm([Call("data_genie", {"question": "activity by label"})], "Done.")
    answered = _invoke(
        build(llm, FakeTools()),
        app_request(
            input=[{"role": "user", "content": QUESTION}],
            custom_inputs={"approved_plan_id": session},
        ),
    )
    assert answered.custom_outputs["type"] == "answer"

    grouped = _grouped_by(tracing, session)
    assert len(grouped) == 2, "the plan and the run that answered it are one session"


def test_a_different_question_is_a_different_session(tracing):
    """The session discriminates, so the grouping above is not folding everything."""

    _invoke(
        build(ScriptedLlm(), FakeTools()),
        app_request(input=[{"role": "user", "content": QUESTION}]),
    )

    assert _grouped_by(tracing, _plan_id("Analyze spend by region.", "")) == []


def test_the_proposed_plan_trace_is_findable_by_the_apps_run_id(tracing):
    """The plan half of a session carries the ids the app logged, not only the run.

    Before the session was recorded, the proposed-plan turn returned before the
    orchestrator span and so wrote no correlation/run tags: a plan trace could be
    grouped but not reached from an app log line. The ids are now set on the plan
    path too.
    """

    run_id = "req-deadbeef-0000-4000-8000-000000000009"
    _invoke(
        build(ScriptedLlm(), FakeTools()),
        app_request(
            input=[{"role": "user", "content": QUESTION}],
            custom_inputs={"run_id": run_id},
        ),
    )

    trace = _grouped_by(tracing, _plan_id(QUESTION, ""))[0]
    assert trace.info.tags.get("run_id") == run_id
