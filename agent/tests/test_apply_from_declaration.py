"""Tests for the Apply / re-log resolver."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import apply_from_declaration as apply
from config import ENV_VARS

AGENT_DIR = Path(__file__).resolve().parents[1]


def test_intended_beats_notebook():
    plan = apply.resolve_apply_plan(
        intended={"warehouse_id": "wh-from-app"},
        notebook={"warehouse_id": "wh-from-notebook", "llm_endpoint": "ep-notebook"},
    )
    by_key = {k.key: k for k in plan.knobs}
    assert by_key["warehouse_id"].source == "intended"
    assert by_key["warehouse_id"].value == "wh-from-app"
    assert by_key["llm_endpoint"].source == "notebook"
    assert by_key["llm_endpoint"].value == "ep-notebook"
    assert "PLAYER_INSIGHTS_WAREHOUSE_ID" in plan.env_exports()
    assert plan.env_exports()["PLAYER_INSIGHTS_WAREHOUSE_ID"] == "wh-from-app"


def test_notebook_refuses_catalog_allowlist():
    notebook = apply.settings_from_declaration(
        {
            "settings": {
                "catalog_allowlist": "other_catalog",
                "warehouse_id": "wh-1",
            }
        }
    )
    assert "catalog_allowlist" not in notebook
    assert notebook["warehouse_id"] == "wh-1"


def test_intended_accepts_catalog_allowlist_with_note():
    plan = apply.resolve_apply_plan(intended={"catalog_allowlist": "a,b"})
    assert any(k.key == "catalog_allowlist" and k.source == "intended" for k in plan.knobs)
    assert any("allow-widening" in note for note in plan.notes)


def test_baseline_not_exported():
    plan = apply.resolve_apply_plan(baseline={"warehouse_id": "wh-bundle"})
    assert plan.env_exports() == {}
    assert any(k.source == "baseline" for k in plan.knobs)


def test_intended_from_settings_resources():
    payload = {
        "resources": [
            {
                "resource": {"id": "sql-warehouse", "agentKey": "warehouse_id"},
                "intended": "wh-staged",
            },
            {
                "resource": {"id": "judge-endpoint", "agentKey": None},
                "intended": "should-ignore",
            },
            {
                "resource": {"id": "genie-data", "agentKey": "data_genie_space_id"},
                "intended": None,
            },
        ]
    }
    assert apply.intended_from_resources(payload["resources"]) == {
        "warehouse_id": "wh-staged",
    }


def test_intended_from_stored_rows():
    rows = [
        {"resource_id": "sql-warehouse", "value": "wh-a", "intent": "intended"},
        {"resource_id": "judge-endpoint", "value": "live", "intent": "active"},
        {"resourceId": "genie-data", "value": "space-x", "intent": "intended"},
    ]
    assert apply.intended_from_stored(rows) == {
        "warehouse_id": "wh-a",
        "data_genie_space_id": "space-x",
    }


def test_every_applyable_key_has_env_var():
    for key in apply.APPLYABLE_KEYS:
        assert key in ENV_VARS, f"{key} missing from config.ENV_VARS"


def test_cli_refuses_without_intent_flag():
    result = subprocess.run(
        [sys.executable, str(AGENT_DIR / "apply_from_declaration.py"), "--print-env"],
        cwd=AGENT_DIR,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert "i-am-deploying" in result.stderr


def test_cli_print_env():
    declaration = {"settings": {"warehouse_id": "wh-cli"}}
    result = subprocess.run(
        [
            sys.executable,
            str(AGENT_DIR / "apply_from_declaration.py"),
            "--i-am-deploying",
            "--declaration-json",
            "-",
            "--print-env",
        ],
        cwd=AGENT_DIR,
        input=json.dumps(declaration),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    assert "PLAYER_INSIGHTS_WAREHOUSE_ID='wh-cli'" in result.stdout
