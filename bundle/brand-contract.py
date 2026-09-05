#!/usr/bin/env python3
"""Enforce canonical branding across bundle and published operator surfaces."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

DISPLAY_NAME = "Player Insights Agent"
PRODUCT_SLUG = "player-insights-agent"
MODEL_OBJECT_NAME = "player_insights_agent"

SOURCE_SURFACES = (
    "databricks.yml",
    "README.md",
    "bundle/README.md",
    "bundle/DECISIONS.md",
    "bundle/deploy.sh",
    "bundle/agent-release.sh",
    "bundle/app-release.sh",
    "bundle/app-source-staging.sh",
    "bundle/tag-resources.py",
    "docs/Databricks_App_Agent_API_Access.md",
    "mirror/public-README.md",
    "player-insights-agent/app.yaml",
    "player-insights-agent/client/public/site.webmanifest",
    "player-insights-agent/server/lib/app-schema-bootstrap.ts",
    "player-insights-agent/shared/app-schema.ts",
    "player-insights-agent/shared/deployment-config.ts",
)
GENERATED_SURFACES = (
    "player-insights-agent/build/deploy/app.yaml",
    "player-insights-agent/build/deploy/client/dist/site.webmanifest",
)

FORBIDDEN = (
    ("retired display or package name", re.compile(r"astrolabe", re.IGNORECASE)),
    ("ambiguous product acronym", re.compile(r"(?<![A-Za-z0-9_-])PIA(?![A-Za-z0-9_-])")),
    (
        "retired app staging path",
        re.compile(r"player-insights-agent-(?:real-src|app-source)", re.IGNORECASE),
    ),
    ("stale orchestrator label", re.compile(r"\borchestrator\b", re.IGNORECASE)),
)

# The only retained legacy spelling is a proven machine identity placed on
# resources by old releases. The canonical tag writer removes it; no display,
# description, log, or generated README is allowed to render it.
MACHINE_COMPATIBILITY_ALLOWLIST = {
    "bundle/tag-resources.py": ('RETIRED_TAG_KEYS = ("astrolabe",)',),
}
STATE_COMPATIBILITY_KEYS = {
    "resources/player_insights.schema.yml": "player_insights_schema:",
    "resources/player_insights_app.app.yml": "player_insights_app:",
    "resources/player_insights_assets.volume.yml": "player_insights_volume:",
    "resources/player_insights_experiment.experiment.yml": "player_insights_experiment:",
    "resources/player_insights_setup.job.yml": "player_insights_setup:",
    "resources/player_insights_semantic.example.yml": "player_insights_semantic_rebuild:",
    "resources/player_insights_telemetry.schema.yml": "player_insights_telemetry_schema:",
}


def resource_surfaces(root: Path) -> tuple[str, ...]:
    return tuple(
        path.relative_to(root).as_posix() for path in sorted((root / "resources").glob("*.yml"))
    )


def visible_text(relative: str, text: str) -> str:
    for allowed in MACHINE_COMPATIBILITY_ALLOWLIST.get(relative, ()):
        if text.count(allowed) != 1:
            raise ValueError(
                f"{relative}: compatibility identity changed or appeared more than once: {allowed}"
            )
        text = text.replace(allowed, "")
    return text


def scan(root: Path, include_generated: bool) -> list[str]:
    findings: list[str] = []
    surfaces = SOURCE_SURFACES + resource_surfaces(root)
    if include_generated:
        surfaces += GENERATED_SURFACES

    for relative in surfaces:
        path = root / relative
        if not path.is_file():
            findings.append(f"{relative}: required branding surface is missing")
            continue
        try:
            text = visible_text(relative, path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError) as error:
            findings.append(str(error))
            continue
        for label, pattern in FORBIDDEN:
            match = pattern.search(text)
            if match:
                line = text.count("\n", 0, match.start()) + 1
                findings.append(f"{relative}:{line}: {label}: {match.group(0)}")

    bundle = (root / "databricks.yml").read_text(encoding="utf-8")
    required_bundle_literals = (
        f"default: {DISPLAY_NAME}",
        f"default: {PRODUCT_SLUG}",
        f"default: {MODEL_OBJECT_NAME}",
        "default: ${var.app_catalog}.${var.app_schema}.${var.product_model_name}",
        "default: /Shared/${var.product_slug}",
        "system_billing: ${var.product_slug}",
    )
    for literal in required_bundle_literals:
        if literal not in bundle:
            findings.append(f"databricks.yml: missing canonical bundle contract: {literal}")

    for relative, key in STATE_COMPATIBILITY_KEYS.items():
        text = (root / relative).read_text(encoding="utf-8")
        if key not in text:
            findings.append(
                f"{relative}: stable non-user-facing state key changed without a migration: {key}"
            )

    example = bundle[bundle.index("\n  example:\n") : bundle.index("\n  customer:\n")]
    for literal in (
        "volume: player_insights_assets",
        "lakebase_app_schema: player_insights",
        "app_telemetry_schema: player_insights_telemetry",
    ):
        if literal not in example:
            findings.append(
                f"databricks.yml: example data-bearing compatibility identity is missing: {literal}"
            )

    public_readme = (root / "mirror/public-README.md").read_text(encoding="utf-8")
    if "| Source code path | `player-insights-agent/build/deploy`" not in public_readme:
        findings.append("mirror/public-README.md: canonical Deploy from Git source path is missing")

    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--include-generated",
        action="store_true",
        help="also check the committed build/deploy surfaces published by the mirror",
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    findings = scan(root, args.include_generated)
    if findings:
        print("\n".join(findings))
        return 1
    scope = "source and generated" if args.include_generated else "source"
    print(f"PASS  {scope} bundle branding uses {DISPLAY_NAME} / {PRODUCT_SLUG}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
