#!/usr/bin/env python3
"""Select exact Dev=N and Prod=N-1 versions from a UC model-version listing."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def records(document: Any) -> list[dict[str, Any]]:
    if isinstance(document, list):
        return [row for row in document if isinstance(row, dict)]
    if isinstance(document, dict):
        for key in ("model_versions", "versions"):
            value = document.get(key)
            if isinstance(value, list):
                return [row for row in value if isinstance(row, dict)]
    raise ValueError("model-version response carries no model_versions list")


def ready_versions(document: Any) -> set[int]:
    versions: set[int] = set()
    for row in records(document):
        status = str(row.get("status") or "READY").upper()
        if status != "READY":
            continue
        try:
            version = int(str(row["version"]))
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"model version has no integer version: {row!r}") from exc
        if version > 0:
            versions.add(version)
    return versions


def select(document: Any, latest: int | None = None) -> dict[str, int]:
    versions = ready_versions(document)
    if not versions:
        raise ValueError("registered model has no READY versions")
    dev = latest if latest is not None else max(versions)
    if dev not in versions:
        raise ValueError(f"requested Dev version {dev} is not READY")
    prod = dev - 1
    if prod not in versions:
        raise ValueError(
            f"Prod must be exactly Dev-1, but version {prod} is not READY; "
            "refusing to silently choose an older version"
        )
    return {"dev": dev, "prod": prod}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, help="CLI JSON; stdin when omitted")
    parser.add_argument("--latest-version", type=int)
    args = parser.parse_args(argv)
    try:
        raw = args.input.read_text(encoding="utf-8") if args.input else sys.stdin.read()
        selected = select(json.loads(raw), args.latest_version)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(selected, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
