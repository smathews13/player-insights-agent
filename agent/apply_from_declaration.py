"""Resolve hard knobs for a model re-log from staged intent.

THE PROBLEM. Genie spaces, warehouse, catalogs and the allowlist bake into the
model artifact (and AuthPolicy resources) at log time. Connections can stage an
"intended" value in Lakebase, and a notebook can publish a declaration row, but
neither changes the running agent. Only a new model version does.

THE SOLUTION. One resolver that merges those two documents into the same
PLAYER_INSIGHTS_* environment variables `log_model.py` / `bundle/agent-release.sh`
already understand, then a sibling script that exports them and calls the
existing release path. Nothing here silently re-logs.

PRECEDENCE (highest first), for each applyable agent key:

  1. Lakebase intended setting (admin staged on Connections)
  2. Notebook declaration latest-row setting
  3. Baseline (bundle / current shell) — left unset so agent-release keeps it

`catalog_allowlist` is special: a notebook value is NEVER taken (same refusal as
`notebook-declaration.ts`). An admin-staged intended value IS taken, because the
administrator typed it on purpose; widening still needs `--allow-widening` on
the release.

Soft / live knobs (judge endpoint, etc.) are out of scope. This module never
touches them.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from typing import Any

from config import ENV_VARS

#: Keys Apply may promote into a re-log. Matches `needs-model-version` in
#: `player-insights-agent/shared/notebook-declaration.ts`, minus refused ones.
APPLYABLE_KEYS: frozenset[str] = frozenset(
    {
        "warehouse_id",
        "data_genie_space_id",
        "dictionary_genie_space_id",
        "llm_endpoint",
        "llm_gateway",
        "max_output_tokens",
        "catalog",
        "schema",
        "catalog_denylist",
        # Admin-staged only; notebook values are dropped below.
        "catalog_allowlist",
    }
)

#: Notebook may publish this, but Apply never takes it from a declaration.
NOTEBOOK_REFUSED_KEYS: frozenset[str] = frozenset({"catalog_allowlist"})

#: Connections resource id -> agent/config.py field. Same join as
#: `shared/deployment-config.ts` `agentKey` on stageable model-version rows.
RESOURCE_TO_AGENT_KEY: dict[str, str] = {
    "sql-warehouse": "warehouse_id",
    "genie-data": "data_genie_space_id",
    "genie-dictionary": "dictionary_genie_space_id",
    "llm-endpoint": "llm_endpoint",
    "llm-gateway": "llm_gateway",
    "max-output-tokens": "max_output_tokens",
    "catalog": "catalog",
    "schema": "schema",
    "catalog-allowlist": "catalog_allowlist",
    "catalog-denylist": "catalog_denylist",
}


@dataclass(frozen=True)
class ResolvedKnob:
    """One hard knob Apply would export for the release."""

    key: str
    value: str
    source: str  # "intended" | "notebook" | "baseline"
    env_var: str


@dataclass(frozen=True)
class ApplyPlan:
    """What a deployer would export before `agent-release.sh --apply`."""

    knobs: tuple[ResolvedKnob, ...]
    skipped: tuple[dict[str, str], ...]
    notes: tuple[str, ...]

    def env_exports(self) -> dict[str, str]:
        return {knob.env_var: knob.value for knob in self.knobs if knob.source != "baseline"}

    def command(self, target: str, *, apply: bool = False) -> str:
        """Customer-facing command line (no internal workspace names)."""
        flag = "--apply" if apply else "--plan"
        return f"TARGET={target} bundle/apply-declaration.sh {flag} --i-am-deploying"


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return ",".join(str(part).strip() for part in value if str(part).strip())
    return str(value).strip()


def intended_from_resources(resources: list[Mapping[str, Any]] | None) -> dict[str, str]:
    """Extract agentKey -> intended value from an `/api/settings` resources list."""
    out: dict[str, str] = {}
    for entry in resources or []:
        resource = entry.get("resource") or {}
        key = resource.get("agentKey")
        raw_intended = entry.get("intended")
        if raw_intended is None:
            continue
        intended = _text(entry.get("intended"))
        if not key or (not intended and key != "llm_gateway"):
            continue
        if key not in APPLYABLE_KEYS:
            continue
        out[str(key)] = intended
    return out


def intended_from_stored(
    stored: list[Mapping[str, Any]] | Mapping[str, Mapping[str, Any]] | None,
) -> dict[str, str]:
    """Extract from Lakebase-shaped rows: resource_id / value / intent."""
    out: dict[str, str] = {}
    if stored is None:
        return out
    rows: list[Mapping[str, Any]]
    if isinstance(stored, Mapping):
        rows = list(stored.values())
    else:
        rows = list(stored)
    for row in rows:
        resource_id = _text(row.get("resource_id") or row.get("resourceId"))
        value = _text(row.get("value"))
        if not resource_id:
            continue
        key = RESOURCE_TO_AGENT_KEY.get(resource_id)
        if not value and key != "llm_gateway":
            continue
        if not key or key not in APPLYABLE_KEYS:
            continue
        # Soft/live overrides are out of scope; only staged "intended" rows.
        intent = _text(row.get("intent")) or "intended"
        if intent != "intended":
            continue
        out[key] = value
    return out


def settings_from_declaration(document: Mapping[str, Any] | None) -> dict[str, str]:
    """Parse a notebook declaration document's settings map."""
    out: dict[str, str] = {}
    if not document:
        return out
    settings = document.get("settings")
    if isinstance(settings, Mapping):
        items = settings.items()
    elif isinstance(settings, list):
        items = (
            (entry.get("key"), entry.get("value"))
            for entry in settings
            if isinstance(entry, Mapping)
        )
    else:
        return out
    for key, value in items:
        k = _text(key)
        v = _text(value)
        if not k or not v:
            continue
        if k in NOTEBOOK_REFUSED_KEYS:
            continue
        if k not in APPLYABLE_KEYS:
            continue
        out[k] = v
    return out


def resolve_apply_plan(
    *,
    intended: Mapping[str, str] | None = None,
    notebook: Mapping[str, str] | None = None,
    baseline: Mapping[str, str] | None = None,
) -> ApplyPlan:
    """Merge intended + notebook + baseline into exportable knobs."""
    intended_map = {
        k: _text(v) for k, v in (intended or {}).items() if _text(v) or k == "llm_gateway"
    }
    notebook_map = {k: _text(v) for k, v in (notebook or {}).items() if _text(v)}
    baseline_map = {k: _text(v) for k, v in (baseline or {}).items() if _text(v)}

    knobs: list[ResolvedKnob] = []
    skipped: list[dict[str, str]] = []
    notes: list[str] = []

    for key in sorted(APPLYABLE_KEYS):
        env_var = ENV_VARS.get(key)
        if not env_var:
            skipped.append({"key": key, "reason": "no env var mapping"})
            continue

        if key in intended_map:
            knobs.append(
                ResolvedKnob(key=key, value=intended_map[key], source="intended", env_var=env_var)
            )
            continue
        if key in notebook_map:
            knobs.append(
                ResolvedKnob(key=key, value=notebook_map[key], source="notebook", env_var=env_var)
            )
            continue
        if key in baseline_map:
            knobs.append(
                ResolvedKnob(key=key, value=baseline_map[key], source="baseline", env_var=env_var)
            )
            continue

    if any(k.key == "catalog_allowlist" and k.source == "intended" for k in knobs):
        notes.append(
            "Readable scopes were staged by an administrator. If the new list is "
            "wider than the live model version, pass --allow-widening to the release."
        )
    if any(k.source == "notebook" for k in knobs) and not any(
        k.source == "intended" for k in knobs
    ):
        notes.append(
            "Values come from the notebook declaration. Connections intended "
            "settings override the notebook when both name the same key."
        )
    if not any(k.source in ("intended", "notebook") for k in knobs):
        notes.append(
            "Nothing was staged in Connections or published by a notebook for "
            "hard knobs. A release would log the bundle target as usual."
        )

    return ApplyPlan(knobs=tuple(knobs), skipped=tuple(skipped), notes=tuple(notes))


def plan_to_dict(plan: ApplyPlan) -> dict[str, Any]:
    return {
        "knobs": [asdict(knob) for knob in plan.knobs],
        "exports": plan.env_exports(),
        "skipped": list(plan.skipped),
        "notes": list(plan.notes),
    }


def _load_json(path: str | None) -> Any:
    if not path:
        return None
    if path == "-":
        return json.load(sys.stdin)
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Resolve Connections intended settings and/or a notebook declaration "
            "into PLAYER_INSIGHTS_* exports for a model re-log."
        )
    )
    parser.add_argument(
        "--i-am-deploying",
        action="store_true",
        help="Required intent flag. Refuses without it.",
    )
    parser.add_argument(
        "--declaration-json",
        help="Path to a notebook declaration document (or - for stdin).",
    )
    parser.add_argument(
        "--intended-json",
        help=(
            "Path to intended settings: either an /api/settings payload "
            "(resources[]), or a list of {resource_id,value,intent} rows."
        ),
    )
    parser.add_argument(
        "--baseline-json",
        help="Optional agentKey->value map used only when neither source sets a key.",
    )
    parser.add_argument(
        "--print-env",
        action="store_true",
        help="Print KEY=value lines suitable for `export` (overrides only).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="as_json",
        help="Print the full plan as JSON.",
    )
    args = parser.parse_args(argv)

    if not args.i_am_deploying:
        print(
            "REFUSED. Pass --i-am-deploying to confirm you intend to drive a "
            "model re-log from staged settings.",
            file=sys.stderr,
        )
        return 2

    declaration = _load_json(args.declaration_json)
    intended_raw = _load_json(args.intended_json)
    baseline_raw = _load_json(args.baseline_json)

    notebook = settings_from_declaration(declaration if isinstance(declaration, Mapping) else None)

    intended: dict[str, str] = {}
    if isinstance(intended_raw, Mapping) and "resources" in intended_raw:
        intended = intended_from_resources(intended_raw.get("resources"))  # type: ignore[arg-type]
    elif isinstance(intended_raw, list):
        intended = intended_from_stored(intended_raw)
    elif isinstance(intended_raw, Mapping):
        # Bare agentKey -> value map
        intended = {k: _text(v) for k, v in intended_raw.items() if _text(v) or k == "llm_gateway"}

    baseline: dict[str, str] = {}
    if isinstance(baseline_raw, Mapping):
        baseline = {k: _text(v) for k, v in baseline_raw.items() if _text(v)}

    plan = resolve_apply_plan(intended=intended, notebook=notebook, baseline=baseline)

    if args.as_json:
        print(json.dumps(plan_to_dict(plan), indent=2, sort_keys=True))
        return 0

    if args.print_env:
        for env_var, value in sorted(plan.env_exports().items()):
            # Shell-safe single quotes; values are ids / lists, not multiline.
            escaped = value.replace("'", "'\"'\"'")
            print(f"{env_var}='{escaped}'")
        return 0

    for knob in plan.knobs:
        if knob.source == "baseline":
            continue
        print(f"  {knob.source:9}  {knob.key}={knob.value}  -> {knob.env_var}")
    for note in plan.notes:
        print(f"  note  {note}")
    if not plan.env_exports():
        print("  (no overrides)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
