from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace


MODULE_PATH = Path(__file__).with_name("genie-live-check.py")
SPEC = importlib.util.spec_from_file_location("genie_live_check", MODULE_PATH)
assert SPEC and SPEC.loader
live_check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(live_check)


def test_user_authorization_never_treats_endpoint_creator_grants_as_runtime_readiness(
    monkeypatch, capsys
):
    table = "catalog.schema.players"
    space = {
        "title": "Customer space",
        "warehouse_id": "genie-warehouse",
        "serialized_space": json.dumps(
            {"data_sources": {"tables": [{"identifier": table}]}}
        ),
    }
    monkeypatch.setattr(live_check, "api_get", lambda *_: space)
    monkeypatch.setattr(
        live_check,
        "_acl",
        lambda *_: (_ for _ in ()).throw(AssertionError("release must not inspect a user's ACL")),
    )
    args = SimpleNamespace(
        profile="customer",
        principal="runtime users",
        principal_source="varies per reader",
        execution_identity="user-authorization",
        warehouse_id="app-warehouse",
    )

    failures = live_check.check_space(
        args,
        "data genie",
        "space-id",
        "adopted",
        ["catalog.schema"],
        {table},
        set(),
        "",
    )

    output = capsys.readouterr().out
    assert failures == 0
    assert "CAN RUN is per signed-in reader and is not release-verifiable" in output
    assert "CAN USE is also per signed-in reader and not established here" in output
    assert "can run it" not in output
