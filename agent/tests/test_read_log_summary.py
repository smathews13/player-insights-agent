"""The release reads the last JSON object with model_version, not the last line."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_PATH = Path(__file__).resolve().parents[2] / "bundle" / "read-log-summary.py"


def _load():
    spec = importlib.util.spec_from_file_location("read_log_summary", _PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_last_json_object_wins_even_when_a_warning_follows_it(tmp_path):
    helper = _load()
    log = tmp_path / "log.txt"
    log.write_text(
        "logging\n"
        '{"model_version": "4", "status": "ok"}\n'
        "WARNING: warehouse still starting\n"
        '{"model_version": "7", "api_scopes": ["sql"]}\n'
        "not json\n",
        encoding="utf-8",
    )
    dest = tmp_path / "summary.json"
    assert helper.main([str(log), "--write", str(dest)]) == 0
    assert dest.read_text(encoding="utf-8").startswith('{"model_version": "7"')


def test_missing_model_version_is_a_failure_not_a_retry_signal(tmp_path, capsys):
    helper = _load()
    log = tmp_path / "log.txt"
    log.write_text("logged something\nWARNING: not a summary\n", encoding="utf-8")
    assert helper.main([str(log)]) == 1
    assert "no JSON object with model_version" in capsys.readouterr().err


def test_a_last_line_that_is_not_json_is_ignored():
    helper = _load()
    with pytest.raises(ValueError):
        helper.last_summary('{"no_version": 1}\ntrailing warning\n')
