"""Notebook release helper: auth, claim, safe execution, and callbacks."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

import apply_model_version as helper


def declaration():
    document = {
        "source": "connections-apply",
        "settings": {"warehouse_id": "wh-1; touch /tmp/never"},
    }
    document["revision"] = helper._revision(document)
    return document


def release(document):
    return {
        "id": "request-1",
        "status": "approved",
        "target": "customer",
        "vFrom": "3",
        "declaration": document,
        "declarationRevision": document["revision"],
    }


def api(document, calls):
    current = release(document)

    def transport(method, url, headers, body):
        calls.append((method, url, dict(headers), body))
        if url.endswith("/claim"):
            return 200, {"release": {**current, "status": "running"}}
        if url.endswith("/status"):
            return 200, {
                "release": {
                    **current,
                    "status": body["status"],
                    "vFrom": "3",
                    "vTo": body.get("vTo"),
                }
            }
        return 200, {"release": current}

    return transport


def test_claim_release_preflight_and_success_callback(tmp_path, monkeypatch):
    root = tmp_path
    (root / "bundle").mkdir()
    (root / "bundle" / "apply-declaration.sh").write_text("#!/bin/sh\n")
    (root / "bundle" / "preflight.sh").write_text("#!/bin/sh\n")
    calls = []
    subprocess_calls = []
    declarations = []

    def run(argv, **kwargs):
        subprocess_calls.append((argv, kwargs))
        if "--result-json" in argv:
            source = Path(argv[argv.index("--declaration-json") + 1])
            declarations.append(json.loads(source.read_text()))
            result = Path(argv[argv.index("--result-json") + 1])
            result.write_text(json.dumps({"model_version": "4", "status": "succeeded"}))
            return subprocess.CompletedProcess(argv, 0, "", "")
        return subprocess.CompletedProcess(argv, 0, "  ok    live release\n", "")

    monkeypatch.setattr(helper.subprocess, "run", run)
    result = helper.apply_model_version(
        "request-1",
        "https://app.example",
        repo_root=str(root),
        _transport=api(declaration(), calls),
        _auth_headers=lambda: {"Authorization": "Bearer notebook-oauth"},
    )

    assert result["status"] == "succeeded"
    assert result["v_to"] == "4"
    assert [call[0] for call in calls] == ["GET", "POST", "POST"]
    assert all(call[2]["Authorization"] == "Bearer notebook-oauth" for call in calls)
    apply_argv = subprocess_calls[0][0]
    assert isinstance(apply_argv, list)
    assert "wh-1; touch /tmp/never" not in apply_argv
    assert declarations == [declaration()]
    assert subprocess_calls[0][1]["env"]["TARGET"] == "customer"


def test_failure_is_reported_before_reraising(tmp_path, monkeypatch):
    (tmp_path / "bundle").mkdir()
    (tmp_path / "bundle" / "apply-declaration.sh").write_text("#!/bin/sh\n")
    calls = []

    def fail(argv, **_kwargs):
        raise subprocess.CalledProcessError(9, argv)

    monkeypatch.setattr(helper.subprocess, "run", fail)
    with pytest.raises(subprocess.CalledProcessError):
        helper.apply_model_version(
            "request-1",
            "https://app.example",
            repo_root=str(tmp_path),
            _transport=api(declaration(), calls),
            token="short-lived",
        )

    failure = calls[-1][3]
    assert failure["status"] == "failed"
    assert len(failure["errorSummary"]) <= 1000
    assert calls[-1][2]["Authorization"] == "Bearer short-lived"


def test_revision_mismatch_refuses_before_claim(tmp_path):
    (tmp_path / "bundle").mkdir()
    (tmp_path / "bundle" / "apply-declaration.sh").write_text("#!/bin/sh\n")
    document = declaration()
    document["settings"]["warehouse_id"] = "changed-after-approval"
    calls = []

    with pytest.raises(RuntimeError, match="does not match its revision"):
        helper.apply_model_version(
            "request-1",
            "https://app.example",
            repo_root=str(tmp_path),
            _transport=api(document, calls),
            token="short-lived",
        )
    assert [call[0] for call in calls] == ["GET"]
