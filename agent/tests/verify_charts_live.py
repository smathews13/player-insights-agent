"""Runs the real agent against the live Genie space and LLM, and reports the charts.

Not a unit test: it needs credentials and a working warehouse. The pytest suite proves
`new_plot` is correct about specs it is handed; this proves the model reaches for it, and
that what comes back is shaped by what the query returned.

The four questions are phrased in terms of result *shape*, and none names a column, title
or series, so they still ask for the same four shapes after the dataset is replaced.

    uv run python tests/verify_charts_live.py [--out charts.json]

Writes the charts to JSON so the app can be pointed at real specs without redeploying.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mlflow.types.responses import ResponsesAgentRequest  # noqa: E402

from agent import PlayerInsightsResponsesAgent  # noqa: E402

# Shape first, subject second. A question that named a title or a metric would still pass
# on a dataset it happened to fit and stop meaning anything on the next one.
SHAPES = [
    ("single series", "Rank the top five titles by active players. One measure only."),
    (
        "multiple series",
        "For the top five titles, compare active players against paying players so both "
        "measures appear side by side.",
    ),
    ("time series", "Show daily active players over the last 30 days as a trend."),
    (
        "categorical breakdown",
        "Break down active players by platform, as a share of the total.",
    ),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path("live-charts.json"))
    args = parser.parse_args()

    agent = PlayerInsightsResponsesAgent()
    captured: dict[str, list[dict]] = {}
    failures: list[str] = []

    for shape, question in SHAPES:
        print(f"\n{'=' * 78}\n{shape}: {question}\n{'=' * 78}")
        response = agent.predict(
            ResponsesAgentRequest(
                input=[{"role": "user", "content": question}],
                custom_inputs={"execute_plan": True},
            )
        )
        answer = (response.custom_outputs or {}).get("answer", {})
        charts = answer.get("charts", [])
        captured[shape] = charts

        plot_stage = next(
            (s for s in answer.get("trace", {}).get("stages", []) if s["id"] == "plot"), None
        )
        print(f"  takeaway : {answer.get('takeaway', '')[:100]}")
        print(f"  sql      : {'yes' if answer.get('sql') else 'no'}")
        print(f"  plot     : {plot_stage['output'] if plot_stage else '(no plot stage)'}")

        if not charts:
            failures.append(f"{shape}: no chart")
            continue

        for chart in charts:
            traces = chart["data"]
            colours = [
                t.get("marker", {}).get("color")
                or t.get("line", {}).get("color")
                or t.get("marker", {}).get("colors")
                for t in traces
            ]
            points = [
                max(
                    (
                        len(t[k])
                        for k in ("x", "y", "values", "labels")
                        if isinstance(t.get(k), list)
                    ),
                    default=0,
                )
                for t in traces
            ]
            print(
                f"  chart    : kind={chart['kind']!r} title={chart['title']!r} "
                f"traces={len(traces)} points={points}"
            )
            print(f"             names={[t.get('name') for t in traces]}")
            print(f"             colours={colours}")

    args.out.write_text(json.dumps(captured, indent=2))
    print(f"\nWrote {args.out}")

    if failures:
        print("\nShapes that produced no chart:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("\nAll four shapes produced a chart.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
