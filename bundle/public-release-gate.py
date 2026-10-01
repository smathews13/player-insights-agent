#!/usr/bin/env python3
"""Compare the resolved App declaration with the live public App."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def contains(actual: Any, expected: Any) -> bool:
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            key in actual and contains(actual[key], value) for key, value in expected.items()
        )
    if isinstance(expected, list):
        return actual == expected
    return actual == expected


def findings(expected: dict[str, Any], live: dict[str, Any]) -> list[str]:
    app = expected["resources"]["apps"]["player_insights_app"]
    out: list[str] = []
    if live.get("name") != app.get("name"):
        out.append(f"app name: declared={app.get('name')!r}, live={live.get('name')!r}")
    declared_scopes = set(app.get("user_api_scopes") or [])
    live_scopes = set(live.get("user_api_scopes") or [])
    if declared_scopes != live_scopes:
        out.append(
            f"user_api_scopes: missing={sorted(declared_scopes-live_scopes)}, "
            f"extra={sorted(live_scopes-declared_scopes)}"
        )
    live_resources = {
        str(resource.get("name") or ""): resource
        for resource in (live.get("resources") or [])
        if isinstance(resource, dict)
    }
    for resource in app.get("resources") or []:
        name = str(resource.get("name") or "")
        actual = live_resources.get(name)
        if actual is None:
            out.append(f"resource {name!r} is declared but not attached")
        elif not contains(actual, resource):
            out.append(f"resource {name!r} differs from the resolved declaration")
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected", type=Path, required=True)
    parser.add_argument("--live", type=Path, required=True)
    args = parser.parse_args()
    expected = json.loads(args.expected.read_text(encoding="utf-8"))
    live = json.loads(args.live.read_text(encoding="utf-8"))
    errors = findings(expected, live)
    if errors:
        for error in errors:
            print(f"FAIL  {error}")
        return 1
    print("ok    live App scopes and resource bindings match the resolved bundle")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
