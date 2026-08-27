#!/usr/bin/env python3
"""Find the last JSON object carrying ``model_version`` in log_model.py stdout.

Versions 5 and 6 of a sibling release existed because the release script treated
the last *line* of stdout as the summary. A warning printed after the JSON made
that parse fail, the run looked like a failure, and a release that had in fact
worked was retried twice.

This reads every line that is a JSON object with ``model_version`` and keeps the
last one. Missing that object is not a retry signal: the model may already be
registered.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def last_summary(text: str) -> dict:
    found: dict | None = None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("{"):
            continue
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and obj.get("model_version") not in (None, ""):
            found = obj
    if found is None:
        raise ValueError("no JSON object with model_version in log_model.py stdout")
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("stdout_path")
    parser.add_argument(
        "--write",
        metavar="PATH",
        help="copy the summary object here as a single JSON line",
    )
    args = parser.parse_args(argv)
    path = Path(args.stdout_path)
    try:
        summary = last_summary(path.read_text())
    except (OSError, ValueError) as error:
        sys.stderr.write(f"{error}\n")
        return 1
    if args.write:
        Path(args.write).write_text(json.dumps(summary) + "\n")
    print(summary["model_version"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
