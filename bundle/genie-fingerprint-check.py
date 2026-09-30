#!/usr/bin/env python3
"""Does the live Genie space still match the fingerprint baked into the model?

THE FAILURE. A space can be re-curated after `log_model.py` without a version
bump. The artifact still grants SELECT on yesterday's tables; today's questions
read a different set. This gate re-reads the live spaces and compares hashes.

    bundle/genie-fingerprint-check.py --logged summary.json
    bundle/genie-fingerprint-check.py --model-uri models:/catalog.schema.model/12
    bundle/genie-fingerprint-check.py --logged summary.json --peer-logged other.json
    bundle/genie-fingerprint-check.py --fixture-baked baked.json --fixture-live live.json

    0  live matches the artifact (and the peer, when given)
    1  a finding: re-curation or cross-target table drift
    2  the check could not run
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
_SAMPLE_AGENT = REPO / "extensions" / "sample-neutral" / "agent"
AGENT = _SAMPLE_AGENT if _SAMPLE_AGENT.is_dir() else REPO / "agent"

EXIT_OK, EXIT_FINDING, EXIT_COULD_NOT_RUN = 0, 1, 2


class Unreadable(Exception):
    """A source could not be read."""


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise Unreadable(f"{path.name} could not be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    sibling = str(path.parent)
    added = sibling not in sys.path
    if added:
        sys.path.insert(0, sibling)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        del sys.modules[name]
        raise Unreadable(f"{path} could not be imported: {exc}") from exc
    finally:
        if added:
            sys.path.remove(sibling)
    return module


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise Unreadable(f"{path} is not readable JSON: {exc}") from exc


def records_from_summary(summary: dict[str, Any], fingerprints) -> list[dict[str, Any]]:
    raw = summary.get(fingerprints.SPACE_FINGERPRINTS_KEY)
    if raw is None:
        raise Unreadable(
            f"the summary carries no {fingerprints.SPACE_FINGERPRINTS_KEY} key, so this "
            "is not a log_model summary that baked a Genie fingerprint"
        )
    return fingerprints.loads(raw)


def records_from_model_config(
    config: dict[str, Any], fingerprints, where: str
) -> list[dict[str, Any]]:
    raw = config.get(fingerprints.SPACE_FINGERPRINTS_KEY)
    if raw is None:
        raise Unreadable(
            f"{where} carries no {fingerprints.SPACE_FINGERPRINTS_KEY} key, so the "
            "registered version predates Genie fingerprinting or was logged by another path"
        )
    return fingerprints.loads(raw)


def model_config_from_uri(uri: str) -> dict[str, Any]:
    """Read the pyfunc model_config from one registered model version."""
    try:
        import mlflow
        from mlflow.models.model import Model
    except ImportError as exc:
        raise Unreadable(
            f"mlflow is not importable, so {uri} cannot be inspected: {exc}. Run this "
            "under the agent environment."
        ) from exc
    try:
        if uri.startswith("models:/"):
            mlflow.set_registry_uri("databricks-uc")
        model = Model.load(uri)
    except Exception as exc:
        raise Unreadable(f"the MLmodel at {uri} could not be read: {exc}") from exc
    for flavor in model.flavors.values():
        config = flavor.get("model_config") if isinstance(flavor, dict) else None
        if isinstance(config, dict):
            return config
    raise Unreadable(f"the MLmodel at {uri} carries no readable pyfunc model_config")


def live_records(fingerprints, preflight) -> list[dict[str, Any]]:
    from databricks.sdk import WorkspaceClient

    sys.path.insert(0, str(AGENT))
    from config import Settings

    settings = Settings.from_env()
    workspace = WorkspaceClient()
    return fingerprints.records_from_genie(settings, workspace, preflight.genie_curated_tables)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--logged", metavar="SUMMARY_JSON")
    ap.add_argument("--model-uri", metavar="MODELS_URI")
    ap.add_argument("--model-config-json", metavar="PATH")
    ap.add_argument("--peer-logged", metavar="SUMMARY_JSON")
    ap.add_argument("--allow-table-diff", metavar="TABLE", action="append", default=[])
    ap.add_argument("--fixture-baked", metavar="PATH")
    ap.add_argument("--fixture-live", metavar="PATH")
    ap.add_argument("--skip-live", action="store_true")
    args = ap.parse_args(argv)

    try:
        fingerprints = load("pia_space_fingerprint", AGENT / "space_fingerprint.py")
    except Unreadable as exc:
        print(f"  COULD NOT RUN. {exc}")
        return EXIT_COULD_NOT_RUN

    try:
        sources = [
            bool(args.fixture_baked),
            bool(args.logged),
            bool(args.model_uri),
            bool(args.model_config_json),
        ]
        if sum(sources) != 1:
            print(
                "  COULD NOT RUN. Pass exactly one of --logged, --model-uri, "
                "--model-config-json, or --fixture-baked."
            )
            return EXIT_COULD_NOT_RUN
        if args.fixture_baked:
            baked = fingerprints.loads(read_json(Path(args.fixture_baked)))
        elif args.logged:
            baked = records_from_summary(read_json(Path(args.logged)), fingerprints)
        elif args.model_uri:
            baked = records_from_model_config(
                model_config_from_uri(args.model_uri),
                fingerprints,
                f"the MLmodel at {args.model_uri}",
            )
        else:
            baked = records_from_model_config(
                read_json(Path(args.model_config_json)),
                fingerprints,
                f"the model config at {args.model_config_json}",
            )

        if args.fixture_live:
            live = fingerprints.loads(read_json(Path(args.fixture_live)))
            findings = fingerprints.compare_live(baked, live)
        elif args.skip_live:
            findings = []
            print("  NOT CHECKED. --skip-live: artifact fingerprints were not compared to a workspace.")
        else:
            preflight = load("pia_preflight", AGENT / "preflight.py")
            live = live_records(fingerprints, preflight)
            findings = fingerprints.compare_live(baked, live)
    except Unreadable as exc:
        print(f"  COULD NOT RUN. {exc}")
        return EXIT_COULD_NOT_RUN
    except Exception as exc:  # noqa: BLE001
        if args.skip_live or args.fixture_live or args.fixture_baked:
            print(f"  COULD NOT RUN. {exc}")
            return EXIT_COULD_NOT_RUN
        print(f"  COULD NOT RUN. live Genie spaces could not be read: {exc}")
        return EXIT_COULD_NOT_RUN

    if args.peer_logged:
        try:
            peer = records_from_summary(read_json(Path(args.peer_logged)), fingerprints)
            findings.extend(fingerprints.compare_targets(baked, peer, args.allow_table_diff))
        except Unreadable as exc:
            print(f"  COULD NOT RUN. {exc}")
            return EXIT_COULD_NOT_RUN

    if findings:
        print("  the Genie-space fingerprint does not match:")
        print()
        for finding in findings:
            print(f"  FAIL  {finding}")
        return EXIT_FINDING

    print("  ok    live Genie space fingerprint matches the artifact")
    if args.peer_logged:
        print("        peer target tables agree (beyond the allowlist)")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
