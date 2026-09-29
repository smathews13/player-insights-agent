"""Run the held-out evaluation and publish its scorecard.

    uv run python -m eval.run_eval --out ../player-insights-agent/client/src/eval/scorecard.json

WHAT THIS DOES NOT DO. It does not deploy anything, restart anything or re-log
the model, and it never calls the app's serving endpoint. The agent is imported
and invoked IN PROCESS, which is the development path MLflow's own guidance
recommends for evaluation and which leaves the deployed app entirely alone. The
only shared resources it touches are the ones any analytical question touches:
the Genie spaces, the SQL warehouse, and the model endpoints behind the
orchestrator.

NOTHING IT PRODUCES GATES ANYTHING ON ITS OWN. The exit status is 0 whenever the
run completed, whatever the scores were. Promotion is gated by
`experiments/compare_runs.py`, which reads two scorecards and fails a release
when a guardrail regresses. This runner still has no `--fail-under`.

THE IDENTITY CAVEAT, WHICH IS THE BIGGEST ONE. This harness is not the app. It
has no forwarded caller credential, so the run does not read governed data as a
signed-in user the way a real request does -- it reads as whoever is
authenticated to the CLI. That is why `identity_execution_mode` is reported as
unmeasured rather than as a failure when the harness cannot establish one: the
absence is a property of running evaluation locally, not a finding about the
agent, and reporting it as a finding would be the more misleading of the two.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
from datetime import UTC, datetime

#: Default judge endpoint, matching `DEFAULT_JUDGE_ENDPOINT` in
#: `shared/benchmark-contract.ts`. Overridden by --judge-endpoint or the
#: environment, because the endpoint is configuration and this is a default,
#: not a decision.
DEFAULT_JUDGE_ENDPOINT = "databricks-claude-sonnet-4-5"


def _agent_commit():
    """The commit the agent is at, or a stated unknown. Never a guess."""

    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def _executing_account():
    """Who this evaluation is running as, and what that account is.

    Both halves are returned because the second is the one that qualifies every
    governed-access number on the scorecard. An evaluation run by an
    administrator measures the agent as an administrator sees it, and the row
    filter and column mask are exactly the things an administrator is not
    subject to.
    """

    try:
        from databricks.sdk import WorkspaceClient

        me = WorkspaceClient().current_user.me()
        email = me.user_name or "unknown"
    except Exception:  # noqa: BLE001
        return (
            "unknown",
            "The executing account could not be established, so no claim is made "
            "about whose grants produced these numbers.",
        )
    return email, (
        "These numbers describe the agent as this account sees it. If the account is "
        "an administrator, the per-persona row filter and column mask were not "
        "applied to it, which is why those scorers abstain "
        "rather than reporting a pass."
    )


def build_predict_fn(agent):
    """The function `mlflow.genai.evaluate` calls once per case.

    Returns the agent's own `custom_outputs` envelope, enriched with three
    things the envelope does not carry and three scorers need. Each is recorded
    ONLY when it can be established; an absent key makes the scorer report
    `unmeasured`, which is the honest state and is not the same as a zero.
    """

    from mlflow.types.responses import ResponsesAgentRequest

    def predict_fn(question, case_id):
        request = ResponsesAgentRequest(input=[{"role": "user", "content": question}])
        response = agent.predict(request)
        envelope = dict(response.custom_outputs or {})

        # The plan-approval round trip. A turn that ends in a plan has not
        # answered anything yet, and scoring the plan as though it were the
        # answer would score every analytical case against a summary of what
        # the agent intended to do.
        if envelope.get("type") == "plan":
            plan_id = ((envelope.get("plan") or {}).get("id")) or ""
            approved = ResponsesAgentRequest(
                input=[{"role": "user", "content": question}],
                custom_inputs={"approved_plan_id": plan_id},
            )
            envelope = dict(agent.predict(approved).custom_outputs or {})

        envelope["case_id"] = case_id

        # Which tables the semantic index describes, for `stale_index`. Left
        # absent when the layer cannot be read, so the scorer says the index
        # freshness was not established rather than saying it was fresh.
        tables = _semantic_layer_tables(agent)
        if tables is not None:
            envelope["semantic_layer_tables"] = tables

        # The identity the run genuinely had. Absent under a local harness with
        # no forwarded caller credential -- see the module docstring.
        identity = _execution_identity(agent, envelope)
        if identity is not None:
            envelope["execution_identity"] = identity
        return envelope

    return predict_fn


def _semantic_layer_tables(agent):
    """The tables the semantic layer describes, or None when it cannot be read."""

    try:
        import semantic_layer

        for name in ("described_tables", "table_names", "tables"):
            reader = getattr(semantic_layer, name, None)
            if callable(reader):
                return [str(value) for value in reader(agent.settings)]
        return None
    except Exception:  # noqa: BLE001
        return None


def _execution_identity(agent, envelope):
    """The identity mode the run actually executed under, or None if unknown.

    The envelope's own record wins when there is one: the identity-gate refusal
    path publishes it, and that is the run telling us directly. Otherwise this
    reports an identity only when the agent is configured to run as the
    invoker, because that is the only configuration under which a claim about
    executing as the caller means anything.
    """

    recorded = envelope.get("execution_identity")
    if isinstance(recorded, dict) and recorded.get("mode"):
        return recorded
    if not getattr(agent, "user_authorization", False):
        return None
    return None


def _aggregate(values):
    """Mean of the scored values, or None when nothing was scored.

    Never 0 for "nothing was measured". A rate of zero and an absence of
    measurement render identically to a reader who is not looking for the
    difference, and they are the two things a scorecard most has to keep apart.
    """

    numbers = [value for value in values if isinstance(value, (int, float))]
    return (sum(numbers) / len(numbers)) if numbers else None


def _median(values):
    numbers = [value for value in values if isinstance(value, (int, float))]
    return statistics.median(numbers) if numbers else None


def collect_scorecard(results, judge_endpoint, mlflow_run_id):
    """Turn an MLflow evaluation result into the scorecard the app renders.

    Reads the per-row assessments rather than MLflow's aggregate metrics,
    because the aggregates fold a not-applicable into the denominator in some
    versions and the whole design of this scorecard is that they do not.
    """

    from eval import dataset, scorers

    unimplementable = scorers.unimplementable_scorers()
    rows = results.tables.get("eval_results") if hasattr(results, "tables") else None
    per_case = {}
    per_scorer = {}

    for record in rows.to_dict("records") if rows is not None else []:
        case_id = str((record.get("inputs") or {}).get("case_id") or "")
        outputs = record.get("outputs") or {}
        outcome = str(outputs.get("type") or "unknown") if isinstance(outputs, dict) else "unknown"
        entry = per_case.setdefault(
            case_id, {"caseId": case_id, "group": "", "outcome": outcome, "scores": []}
        )
        for assessment in record.get("assessments") or []:
            name = str(getattr(assessment, "name", "") or (assessment or {}).get("name", ""))
            value = getattr(assessment, "value", None)
            if value is None and isinstance(assessment, dict):
                value = assessment.get("value")
            numeric = _numeric(value)
            state = "scored" if numeric is not None else "not-applicable"
            entry["scores"].append(
                {
                    "scorerId": name,
                    "state": state,
                    "value": numeric,
                    "scored": 1 if numeric is not None else 0,
                    "notApplicable": 0 if numeric is not None else 1,
                    "errored": 0,
                    "reason": "",
                }
            )
            per_scorer.setdefault(name, []).append(numeric)

    groups = {case["case_id"]: case["group"] for case in dataset.HELD_OUT_CASES}
    for case_id, entry in per_case.items():
        entry["group"] = groups.get(case_id, "")

    aggregates = []
    for name, values in sorted(per_scorer.items()):
        scored = [value for value in values if value is not None]
        # Latency, tokens and warehouse calls are absolute quantities, so their
        # aggregate is a median rather than a mean: one slow case must not drag
        # a typical-run figure somewhere no run was.
        summary = (
            _median(scored)
            if name in {"latency_ms", "total_tokens", "warehouse_calls"}
            else _aggregate(scored)
        )
        aggregates.append(
            {
                "scorerId": name,
                "state": "scored" if summary is not None else "not-applicable",
                "value": summary,
                "scored": len(scored),
                "notApplicable": len(values) - len(scored),
                "errored": 0,
                "reason": ""
                if summary is not None
                else "No case in the set produced a verdict for this scorer.",
            }
        )
    for name, reason in unimplementable.items():
        aggregates.append(
            {
                "scorerId": name,
                "state": "unimplementable",
                "value": None,
                "scored": 0,
                "notApplicable": len(per_case),
                "errored": 0,
                "reason": reason,
            }
        )

    account, account_note = _executing_account()
    return {
        "provenance": {
            "evaluatedAt": datetime.now(UTC).isoformat(timespec="seconds"),
            "agentCommit": _agent_commit(),
            "executedAs": account,
            "executedAsNote": account_note,
            "judgeEndpoint": judge_endpoint,
            "labelProvenance": dataset.LABEL_PROVENANCE,
            "heldOutFrom": dataset.HELD_OUT_FROM,
            "mlflowRunId": mlflow_run_id or "",
            "caseCount": len(per_case),
        },
        "aggregates": aggregates,
        "cases": sorted(per_case.values(), key=lambda entry: entry["caseId"]),
    }


def _numeric(value):
    """A scorer verdict as a number, or None when it did not produce one.

    MLflow judges answer `yes`/`no` and custom scorers answer with booleans or
    floats. `None` stays `None`: an abstention is not a zero, and the single
    most damaging thing this function could do is turn one into the other.
    """

    if value is None:
        return None
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().lower()
    if text in {"yes", "true", "pass"}:
        return 1.0
    if text in {"no", "false", "fail"}:
        return 0.0
    return None


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Run the held-out evaluation. Reports; gates nothing."
    )
    parser.add_argument("--out", required=True, help="Where to write the scorecard JSON.")
    parser.add_argument(
        "--judge-endpoint",
        default=os.environ.get("PLAYER_INSIGHTS_JUDGE_ENDPOINT") or DEFAULT_JUDGE_ENDPOINT,
    )
    parser.add_argument(
        "--experiment", default=os.environ.get("PLAYER_INSIGHTS_EVAL_EXPERIMENT") or ""
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Run only the first N cases. For checking the harness, not for publishing.",
    )
    args = parser.parse_args(argv)

    import mlflow

    from agent import PlayerInsightsResponsesAgent
    from eval import dataset, scorers

    # The judged scorers read the endpoint from here when the driver does not
    # pass one, which is how `refusal_quality` reaches the same endpoint
    # `correctness` was constructed with.
    os.environ[scorers.JUDGE_ENDPOINT_ENV] = args.judge_endpoint

    if args.experiment:
        mlflow.set_experiment(args.experiment)

    records = dataset.evaluation_records()
    if args.limit:
        records = records[: args.limit]

    agent = PlayerInsightsResponsesAgent()
    scoring = (
        list(scorers.REPORTING_SCORERS)
        + [scorers.correctness_scorer(args.judge_endpoint)]
        + list(scorers.ABSTAINING_SCORERS)
    )

    results = mlflow.genai.evaluate(
        data=records,
        predict_fn=build_predict_fn(agent),
        scorers=scoring,
    )

    scorecard = collect_scorecard(results, args.judge_endpoint, getattr(results, "run_id", ""))

    # THE GUARD. An offline harness has no forwarded caller credential, so the
    # agent refuses it with IDENTITY_REQUIRED and every case comes back with no
    # answer. The scorers handle that correctly -- they abstain -- but the
    # resulting scorecard is a page of dashes with a 100% error rate, and
    # publishing it would put a catastrophic-looking result on screen that is
    # a fact about where the harness ran and not about the agent.
    #
    # Refusing to write is the right response rather than writing it with a
    # caveat, because the caveat is the thing a reader skips.
    refused = [case for case in scorecard["cases"] if case["outcome"] != "answer"]
    if scorecard["cases"] and len(refused) == len(scorecard["cases"]):
        print(
            "[eval] REFUSING TO PUBLISH. Every case came back without an answer, "
            "which means this run had no forwarded caller credential and was "
            "refused at the identity gate. That is the agent behaving correctly -- "
            "it has no service-principal fallback, by design -- and it means an "
            "evaluation has to execute where a real invoker exists, inside the "
            "serving endpoint. Nothing was written.",
            file=sys.stderr,
        )
        return 0
    if args.limit:
        scorecard["provenance"]["heldOutFrom"] += (
            f" NOTE: this run covered only the first {args.limit} case(s) of the "
            "set, so every rate below is over that subset and not over the "
            "held-out set."
        )

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(scorecard, handle, indent=2, sort_keys=False)
        handle.write("\n")
    print(
        f"[eval] wrote {args.out} over {scorecard['provenance']['caseCount']} "
        "case(s); nothing is gated on it."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
