#!/usr/bin/env python3
"""Compare two held-out scorecards. Block promotion on a guardrail regression.

X3. `eval/run_eval.py` still only reports. This file is the gate: it reads two
already-produced scorecards and returns non-zero when any guardrail metric
moves the wrong way past its threshold. A single-metric scorecard is refused
(AP-8): optimizing one number is how a worse model looks better.

    python agent/experiments/compare_runs.py --baseline a.json --candidate b.json

    0  candidate is not worse on any guardrail
    1  a finding: at least one guardrail regressed
    2  the comparison could not run (not a pass)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

EXIT_OK, EXIT_FINDING, EXIT_COULD_NOT_RUN = 0, 1, 2

#: Higher is better. Rates in [0, 1].
HIGHER_IS_BETTER = frozenset(
    {
        "sql_validity",
        "provenance_completeness",
        "tool_selection",
        "refusal_quality",
        "coverage_caveat",
        "semantic_recall",
        "identity_execution_mode",
        "correctness",
    }
)
#: Lower is better. Mix of rates and absolute quantities.
LOWER_IS_BETTER = frozenset(
    {
        "stale_index",
        "error_rate",
        "latency_ms",
        "total_tokens",
        "warehouse_calls",
    }
)
GUARDRAILS = HIGHER_IS_BETTER | LOWER_IS_BETTER
RATE_DROP = 0.05
QUANTITY_RELATIVE = 0.20
QUANTITIES = frozenset({"latency_ms", "total_tokens", "warehouse_calls"})
MIN_COMPARABLE = 3


def load_scorecard(path: Path) -> dict[str, Any]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{path} is not readable JSON: {exc}") from exc
    if not isinstance(document, dict):
        raise ValueError(f"{path} is not a JSON object")
    aggregates = document.get("aggregates")
    if not isinstance(aggregates, list):
        raise ValueError(f"{path} has no aggregates list")
    return document


def scored_values(scorecard: dict[str, Any]) -> dict[str, float]:
    values: dict[str, float] = {}
    for row in scorecard["aggregates"]:
        if not isinstance(row, dict):
            continue
        name = str(row.get("scorerId") or "")
        if name not in GUARDRAILS:
            continue
        if row.get("state") not in {None, "scored"}:
            continue
        value = row.get("value")
        if isinstance(value, bool):
            values[name] = 1.0 if value else 0.0
        elif isinstance(value, (int, float)):
            values[name] = float(value)
    return values


def regressions(baseline: dict[str, float], candidate: dict[str, float]) -> list[str]:
    findings: list[str] = []
    for name in sorted(set(baseline) & set(candidate)):
        before = baseline[name]
        after = candidate[name]
        if name in HIGHER_IS_BETTER:
            if after + RATE_DROP < before:
                findings.append(
                    f"{name} fell from {before:.3f} to {after:.3f} (threshold {RATE_DROP:.2f})"
                )
        elif name in QUANTITIES:
            if before > 0 and after > before * (1 + QUANTITY_RELATIVE):
                findings.append(
                    f"{name} rose from {before:.1f} to {after:.1f} "
                    f"(threshold {QUANTITY_RELATIVE:.0%} worse)"
                )
        elif name in LOWER_IS_BETTER:
            if after - RATE_DROP > before:
                findings.append(
                    f"{name} rose from {before:.3f} to {after:.3f} (threshold {RATE_DROP:.2f})"
                )
    return findings


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", required=True)
    ap.add_argument("--candidate", required=True)
    args = ap.parse_args(argv)
    try:
        baseline_card = load_scorecard(Path(args.baseline))
        candidate_card = load_scorecard(Path(args.candidate))
    except ValueError as exc:
        print(f"  COULD NOT RUN. {exc}")
        return EXIT_COULD_NOT_RUN

    baseline = scored_values(baseline_card)
    candidate = scored_values(candidate_card)
    comparable = sorted(set(baseline) & set(candidate))
    if len(comparable) < MIN_COMPARABLE:
        print(
            f"  COULD NOT RUN. only {len(comparable)} guardrail metric(s) are scored on both "
            f"cards ({', '.join(comparable) or 'none'}). A single-metric comparison is refused."
        )
        return EXIT_COULD_NOT_RUN

    findings = regressions(baseline, candidate)
    if findings:
        print("  the candidate is worse than the baseline on a guardrail:")
        print()
        for finding in findings:
            print(f"  FAIL  {finding}")
        print()
        print(f"        compared {len(comparable)} metrics: {', '.join(comparable)}")
        return EXIT_FINDING

    print(
        f"  ok    candidate is not worse than baseline on {len(comparable)} guardrails: "
        + ", ".join(comparable)
    )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
