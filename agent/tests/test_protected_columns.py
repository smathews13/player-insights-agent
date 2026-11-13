"""A deployment's own names for the cross-label key and identity columns.

The public source uses neutral column names, so a model built from it protects
names a customer's tables may not have. These settings carry the real names into
the artifact. They only ever add: an empty or mistyped value must leave the
built-in protection exactly as it was.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from config import BAKED_KEYS, ENV_VARS, Settings, protected_columns

AGENT = Path(__file__).resolve().parents[1]

CUSTOMER = {
    "PLAYER_INSIGHTS_CATALOG": "acme_catalog",
    "PLAYER_INSIGHTS_SCHEMA": "player_insights",
    "PLAYER_INSIGHTS_WAREHOUSE_ID": "wh-acme",
    "PLAYER_INSIGHTS_DATA_GENIE_ID": "space-data-acme",
    "PLAYER_INSIGHTS_DICTIONARY_GENIE_ID": "space-dict-acme",
}


def _guard_in_a_fresh_process(env: dict[str, str], sql: str) -> dict:
    """Import the guard with `env`, as a model load would, and run one statement."""

    script = f"""
import json, sql_policy
try:
    sql_policy.validate_sql({sql!r}, ("cat.sch.players",))
    refused = None
except sql_policy.SqlRefused as error:
    refused = error.code
print(json.dumps({{
    "refused": refused,
    "blocked": sorted(sql_policy.BLOCKED_COLUMNS),
    "unreturnable": sorted(sql_policy.UNRETURNABLE_COLUMNS),
}}))
"""
    clean = {k: v for k, v in os.environ.items() if not k.startswith("PLAYER_INSIGHTS_")}
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=AGENT,
        env={**clean, **env},
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


def test_both_settings_are_baked_into_the_artifact():
    for key in ("cross_label_keys", "identity_columns"):
        assert key in ENV_VARS
        assert key in BAKED_KEYS
    settings = Settings.from_env(
        env={
            **CUSTOMER,
            "PLAYER_INSIGHTS_CROSS_LABEL_KEYS": "Shared_Key, cat.sch.t.other_key",
            "PLAYER_INSIGHTS_IDENTITY_COLUMNS": "gamer_ref",
        },
        baked={},
    )
    baked = settings.as_model_config()
    assert baked["cross_label_keys"] == ["other_key", "shared_key"]
    assert baked["identity_columns"] == ["gamer_ref"]
    reloaded = Settings.from_env(env={}, baked=baked)
    assert reloaded.cross_label_keys == ("other_key", "shared_key")


def test_the_artifact_wins_over_the_environment():
    keys, identities = protected_columns(
        env={"PLAYER_INSIGHTS_CROSS_LABEL_KEYS": "from_shell"},
        baked={"cross_label_keys": ["from_artifact"], "identity_columns": []},
    )
    assert keys == ("from_artifact",)
    assert identities == ()


def test_unset_means_the_built_in_names_alone():
    assert protected_columns(env={}, baked={}) == ((), ())
    assert Settings.from_env(env=CUSTOMER, baked={}).cross_label_keys == ()


def test_a_configured_key_is_refused_anywhere_and_never_returned():
    guard = _guard_in_a_fresh_process(
        {"PLAYER_INSIGHTS_CROSS_LABEL_KEYS": "shared_key"},
        "SELECT count(*) FROM cat.sch.players a JOIN cat.sch.players b USING (shared_key)",
    )
    assert guard["refused"] == "COLUMN_POLICY_VIOLATION"
    assert "shared_key" in guard["blocked"]
    assert "shared_key" in guard["unreturnable"]


def test_a_configured_identity_column_cannot_be_returned():
    guard = _guard_in_a_fresh_process(
        {"PLAYER_INSIGHTS_IDENTITY_COLUMNS": "gamer_ref"},
        "SELECT gamer_ref FROM cat.sch.players",
    )
    assert guard["refused"] == "COLUMN_POLICY_VIOLATION"
    assert "gamer_ref" not in guard["blocked"]


def test_the_settings_only_add_to_the_built_in_names():
    plain = _guard_in_a_fresh_process({}, "SELECT 1")
    added = _guard_in_a_fresh_process(
        {"PLAYER_INSIGHTS_CROSS_LABEL_KEYS": "shared_key", "PLAYER_INSIGHTS_IDENTITY_COLUMNS": "x"},
        "SELECT 1",
    )
    assert set(plain["blocked"]) < set(added["blocked"])
    assert set(plain["unreturnable"]) < set(added["unreturnable"])


def test_trace_redaction_covers_a_configured_identity_column():
    script = (
        "import json, trace_redaction; print(json.dumps(sorted(trace_redaction.IDENTITY_KEYS)))"
    )
    clean = {k: v for k, v in os.environ.items() if not k.startswith("PLAYER_INSIGHTS_")}
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=AGENT,
        env={**clean, "PLAYER_INSIGHTS_IDENTITY_COLUMNS": "gamer_ref"},
        capture_output=True,
        text=True,
        check=True,
    )
    assert "gamer_ref" in json.loads(result.stdout.strip().splitlines()[-1])
