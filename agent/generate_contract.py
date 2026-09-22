#!/usr/bin/env python3
"""Generate the shared Model Serving response contract.

The Pydantic models in ``agent/contracts.py`` are the producer source of truth.
This script turns their terminal-output union into one checked-in JSON Schema
that the app, backend maintainers, and external consumers can review without
importing the agent runtime.

Usage:

    python agent/generate_contract.py --generate
    python agent/generate_contract.py --check

``--check`` is the CI/release form. It never rewrites the artifact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter

from contracts import (
    CAVEAT_CATEGORIES,
    DYNAMIC_CAVEAT_FAMILIES,
    KNOWN_CAVEAT_FORMS,
    AgentTerminalOutput,
)

REPOSITORY = Path(__file__).resolve().parents[1]
OUTPUT = REPOSITORY / "contracts" / "agent-response.schema.json"
SCHEMA_ID = (
    "https://raw.githubusercontent.com/<your-username>/player-insights-agent/"
    "main/contracts/agent-response.schema.json"
)
CONTRACT_VERSION = "pia.agent-response/1"
TERMINAL_KINDS = ("plan", "clarification", "answer", "report", "dashboard", "unavailable")
SOURCE_FILES = (
    REPOSITORY / "agent" / "contracts.py",
    REPOSITORY / "agent" / "generate_contract.py",
)
MODEL_DUMP_ALL_FIELDS = {
    "AnalysisPlan",
    "AnswerContract",
    "AnswerOutput",
    "Chart",
    "Clarification",
    "ClarificationOutput",
    "Derivation",
    "DocumentSnippet",
    "ExecutionIdentityClaim",
    "Figure",
    "GenieSpace",
    "PlanCandidate",
    "PlanOutput",
    "PlanStep",
    "ResourceCall",
    "Source",
    "TraceStage",
    "TraceSummary",
}


def _source_hashes() -> dict[str, str]:
    return {
        str(path.relative_to(REPOSITORY)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in SOURCE_FILES
    }


def _mark_serialized_defaults_required(schema: dict[str, Any]) -> None:
    """Describe emitted ``model_dump`` objects, not permissive constructor input.

    Pydantic accepts omitted defaulted fields when constructing a model, but the
    agent serializes without ``exclude_defaults`` and therefore emits those
    fields every time. Consumers need the output contract. The unavailable
    envelope is the exception: gateway/transport refusals legitimately omit the
    correlation fields that only an identity-gated request has.
    """

    for name, definition in schema.get("$defs", {}).items():
        if name not in MODEL_DUMP_ALL_FIELDS or not isinstance(definition, dict):
            continue
        properties = definition.get("properties")
        if isinstance(properties, dict):
            definition["required"] = list(properties)


def contract_document() -> dict[str, Any]:
    """Return the deterministic machine-readable boundary document."""

    generated = TypeAdapter(AgentTerminalOutput).json_schema(
        by_alias=True,
        ref_template="#/$defs/{model}",
    )
    _mark_serialized_defaults_required(generated)
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": SCHEMA_ID,
        "title": "Player Insights Agent terminal response",
        "description": (
            "The discriminated Model Serving custom_outputs envelope shared by the "
            "Player Insights Agent and its application. Dispatch on `type`; exactly "
            "one terminal variant is present."
        ),
        "x-pia-contract-version": CONTRACT_VERSION,
        "x-pia-boundary": "Model Serving ResponsesAgent custom_outputs",
        "x-pia-generated-from": _source_hashes(),
        "x-pia-terminal-kinds": list(TERMINAL_KINDS),
        "x-pia-forward-compatibility": {
            "unknown_object_keys": (
                "Consumers may forward unknown keys during rolling deploys, but must "
                "report schema drift and must not invent reader-visible values."
            ),
            "unknown_unavailable_code": (
                "Keep the terminal outcome unavailable. Do not reinterpret it as an "
                "answer; map it to the consumer's contract-skew fallback."
            ),
        },
        "x-pia-renderable": {
            "owner": "backend",
            "field": "renderable",
            "formats": {
                "html": (
                    "Pass content byte-for-byte to an isolated browser HTML rendering surface."
                ),
                "json": (
                    "Preserve the JSON value and display it as JSON; do not derive "
                    "frontend-owned dashboard components from its fields."
                ),
            },
            "frontend_must_not": [
                "infer a different format from the payload",
                "parse, sanitize, or rewrite HTML",
                "extract fields or rebuild the dashboard as frontend components",
                "derive conversation text or metadata from the payload",
            ],
        },
        "x-pia-caveats": {
            "closed_set": False,
            "why_open": (
                "Caveats contain live table names, dates, metric names, coverage counts "
                "and access decisions. Their strings are data, not enum members."
            ),
            "wire_shape": "answer.caveats is an ordered array of reader-facing strings",
            "ordering": (
                "The producer's order is preserved within a risk tier. The app ranks "
                "the published categories by ascending rank and keeps refusals/degradation visible."
            ),
            "categories": list(CAVEAT_CATEGORIES),
            "stable_forms": list(KNOWN_CAVEAT_FORMS),
            "dynamic_families": list(DYNAMIC_CAVEAT_FAMILIES),
            "consumer_rule": (
                "Unknown caveat text is valid and must remain visible as unclassified; "
                "a consumer must never drop it merely because no known family matches."
            ),
        },
        **generated,
    }


def rendered_contract() -> str:
    return json.dumps(contract_document(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def generate() -> int:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(rendered_contract(), encoding="utf-8")
    print(f"Wrote {OUTPUT.relative_to(REPOSITORY)}")
    return 0


def check() -> int:
    expected = rendered_contract()
    try:
        actual = OUTPUT.read_text(encoding="utf-8")
    except FileNotFoundError:
        print(
            f"{OUTPUT.relative_to(REPOSITORY)} is missing. "
            "Run `python agent/generate_contract.py --generate`.",
            file=sys.stderr,
        )
        return 1
    if actual != expected:
        print(
            f"{OUTPUT.relative_to(REPOSITORY)} is stale. "
            "Run `python agent/generate_contract.py --generate` and commit the result.",
            file=sys.stderr,
        )
        return 1
    print(f"{OUTPUT.relative_to(REPOSITORY)} matches agent/contracts.py")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument(
        "--generate",
        action="store_true",
        help="Rewrite the checked-in JSON Schema.",
    )
    action.add_argument(
        "--check",
        action="store_true",
        help="Fail when the checked-in schema is stale.",
    )
    args = parser.parse_args()
    return generate() if args.generate else check()


if __name__ == "__main__":
    raise SystemExit(main())
