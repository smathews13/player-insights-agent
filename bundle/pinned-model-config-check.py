#!/usr/bin/env python3
"""Verify a pinned registered version names the target it will serve."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

CRITICAL_KEYS = (
    "catalog",
    "schema",
    "warehouse_id",
    "data_genie_space_id",
    "dictionary_genie_space_id",
    "llm_endpoint",
    "llm_gateway_endpoint",
    "llm_gateway",
    "catalog_allowlist",
    "catalog_denylist",
    "max_output_tokens",
    "manifest_source",
)


def normalize(value: Any) -> Any:
    if isinstance(value, tuple):
        return [normalize(item) for item in value]
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if isinstance(value, dict):
        return {str(key): normalize(item) for key, item in value.items()}
    return value


def model_config_from_uri(uri: str) -> dict[str, Any]:
    import mlflow
    from mlflow.models.model import Model

    if uri.startswith("models:/"):
        mlflow.set_registry_uri("databricks-uc")
    model = Model.load(uri)
    for flavor in model.flavors.values():
        if not isinstance(flavor, dict):
            continue
        config = flavor.get("model_config") or flavor.get("config")
        if isinstance(config, dict):
            return config
    raise ValueError(f"{uri} carries no readable pyfunc config")


def findings(actual: dict[str, Any], expected: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for key in CRITICAL_KEYS:
        want = normalize(expected.get(key))
        got = normalize(actual.get(key))
        if got != want:
            out.append(f"{key}: target={want!r}, model={got!r}")
    return out


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--model-uri")
    source.add_argument("--model-config-json", type=Path)
    parser.add_argument("--expected-json", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        actual = (
            model_config_from_uri(args.model_uri)
            if args.model_uri
            else json.loads(args.model_config_json.read_text(encoding="utf-8"))
        )
        expected = json.loads(args.expected_json.read_text(encoding="utf-8"))
        mismatches = findings(actual, expected)
    except Exception as exc:  # noqa: BLE001 - every loader failure is reported as could-not-run
        print(f"COULD NOT RUN: {exc}")
        return 2
    if mismatches:
        print("Pinned model configuration does not match this target:")
        for mismatch in mismatches:
            print(f"  FAIL  {mismatch}")
        return 1
    print("ok    pinned model configuration matches the target")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
