"""Hash of a Genie space's identity plus the tables it curates.

WHY A HASH AND NOT THE TABLE LIST ALONE. The allowlist is already baked as
`declared_manifest`. Operators still re-curate a live space after that log, with
no version bump, and the next question reads tables the artifact never granted
SELECT on -- or loses tables it still claims. The fingerprint is the space id,
the sorted table list, and the space create time, so a replacement space with
the same tables is still a different artifact.

`SPACE_FINGERPRINTS_KEY` is the model_config / release-summary key. Traces copy
the JSON string so a stale space is visible next to the answer.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Any

SPACE_FINGERPRINTS_KEY = "genie_space_fingerprints"


def fingerprint(space_id: str, tables: Iterable[str], created_at: str = "") -> str:
    payload = {
        "created_at": (created_at or "").strip(),
        "space_id": (space_id or "").strip(),
        "tables": sorted({table for table in tables if table}),
    }
    encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def space_created_at(space: Any) -> str:
    for attr in ("create_time", "created_at", "creation_time"):
        value = getattr(space, attr, None)
        if value:
            return str(value)
    return ""


def records_from_genie(settings: Any, workspace: Any, curated_tables) -> list[dict[str, Any]]:
    """One record per configured Genie space, in role order."""
    spaces = [
        ("data", getattr(settings, "data_genie_space_id", "")),
        ("dictionary", getattr(settings, "dictionary_genie_space_id", "")),
    ]
    records: list[dict[str, Any]] = []
    for role, space_id in spaces:
        space_id = (space_id or "").strip()
        if not space_id:
            continue
        space = workspace.genie.get_space(space_id, include_serialized_space=True)
        tables = list(curated_tables(workspace, space_id))
        digest = fingerprint(space_id, tables, space_created_at(space))
        records.append(
            {
                "role": role,
                "space_id": space_id,
                "created_at": space_created_at(space),
                "tables": tables,
                "sha256": digest,
            }
        )
    return records


def dumps(records: list[dict[str, Any]]) -> str:
    slim = [
        {
            "role": row["role"],
            "space_id": row["space_id"],
            "created_at": row["created_at"],
            "sha256": row["sha256"],
            "tables": list(row["tables"]),
        }
        for row in records
    ]
    return json.dumps(slim, separators=(",", ":"), sort_keys=True)


def loads(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        return [row for row in raw if isinstance(row, dict)]
    if not isinstance(raw, str) or not raw.strip():
        return []
    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        raise ValueError("genie_space_fingerprints is not a JSON list")
    return [row for row in parsed if isinstance(row, dict)]


def table_set(records: list[dict[str, Any]]) -> set[str]:
    tables: set[str] = set()
    for row in records:
        tables.update(str(table) for table in (row.get("tables") or []) if table)
    return tables


def compare_live(baked: list[dict[str, Any]], live: list[dict[str, Any]]) -> list[str]:
    """Findings when live spaces no longer match what the artifact baked."""
    findings: list[str] = []
    baked_by_role = {str(row.get("role")): row for row in baked}
    live_by_role = {str(row.get("role")): row for row in live}
    for role in sorted(set(baked_by_role) | set(live_by_role)):
        if role not in live_by_role:
            findings.append(f"{role} Genie space is missing live but was baked into the artifact")
            continue
        if role not in baked_by_role:
            findings.append(f"{role} Genie space is live but was not baked into the artifact")
            continue
        if baked_by_role[role].get("sha256") != live_by_role[role].get("sha256"):
            findings.append(
                f"{role} Genie space fingerprint drifted: artifact "
                f"{baked_by_role[role].get('sha256')} vs live "
                f"{live_by_role[role].get('sha256')}. Re-log the model."
            )
    return findings


def compare_targets(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    allowlist: Iterable[str] = (),
) -> list[str]:
    """Findings when two targets' curated tables differ beyond `allowlist`."""
    allowed = {name for name in allowlist if name}
    left_tables = table_set(left)
    right_tables = table_set(right)
    extra_left = sorted((left_tables - right_tables) - allowed)
    extra_right = sorted((right_tables - left_tables) - allowed)
    findings: list[str] = []
    if extra_left:
        findings.append(
            "left target curates tables the right target does not: " + ", ".join(extra_left)
        )
    if extra_right:
        findings.append(
            "right target curates tables the left target does not: " + ", ".join(extra_right)
        )
    return findings
