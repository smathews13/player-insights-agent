#!/usr/bin/env python3
"""Dependency-free freshness check for the generated shared response contract."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[1]
CONTRACT = REPOSITORY / "contracts" / "agent-response.schema.json"


def main() -> int:
    try:
        document = json.loads(CONTRACT.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as error:
        print(f"Shared response contract is missing or unreadable: {error}", file=sys.stderr)
        return 1

    declared = document.get("x-pia-generated-from")
    if not isinstance(declared, dict) or not declared:
        print("Shared response contract carries no source fingerprints.", file=sys.stderr)
        return 1

    stale: list[str] = []
    for relative, expected in declared.items():
        path = REPOSITORY / relative
        actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "missing"
        if actual != expected:
            stale.append(relative)

    if stale:
        print(
            "Shared response contract is stale for: "
            + ", ".join(stale)
            + ". Run `uv run --project agent --no-sync python "
            "agent/generate_contract.py --generate`.",
            file=sys.stderr,
        )
        return 1

    print("Shared response contract source fingerprints match.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
