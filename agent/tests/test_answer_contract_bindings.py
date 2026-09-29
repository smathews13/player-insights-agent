"""Generated AnswerContract bindings stay in lockstep with contracts.py."""

from __future__ import annotations

from pathlib import Path

from contracts import AnswerContract
from generate_answer_contract import field_names, render_python, render_typescript

def _agent_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "generate_answer_contract.py").is_file():
            return parent
        nested = parent / "extensions" / "sample-neutral" / "agent"
        if (nested / "generate_answer_contract.py").is_file():
            return nested
    raise AssertionError("generate_answer_contract.py not found")


AGENT = _agent_root()
REPO = AGENT.parent
if not (REPO / "player-insights-agent").is_dir() and (AGENT.parent.parent / "player-insights-agent").is_dir():
    REPO = AGENT.parent.parent
# Harness: extensions/sample-neutral/agent -> repo root two levels up
if not any(
    (REPO / name).is_dir()
    for name in ("player-insights-agent", "app", "platform")
):
    REPO = AGENT
    for parent in AGENT.parents:
        if (parent / "platform" / "app" / "shared").is_dir() or (
            parent / "player-insights-agent" / "shared"
        ).is_dir():
            REPO = parent
            break


def test_generated_python_matches_the_pydantic_model() -> None:
    expected = render_python(field_names(AnswerContract))
    written = (AGENT / "generated_answer_contract.py").read_text(encoding="utf-8")
    assert written == expected, "run: python generate_answer_contract.py"


def test_generated_typescript_matches_the_pydantic_model() -> None:
    expected = render_typescript(field_names(AnswerContract))
    path = REPO / "player-insights-agent" / "shared" / "generated" / "answer-contract.ts"
    if not path.is_file():
        path = REPO / "app" / "shared" / "generated" / "answer-contract.ts"
    if not path.is_file():
        path = REPO / "platform" / "app" / "shared" / "generated" / "answer-contract.ts"
    assert path.is_file(), path
    assert path.read_text(encoding="utf-8") == expected, "run: python generate_answer_contract.py"


def test_tools_reexports_the_generated_wire_fields() -> None:
    from generated_answer_contract import ANSWER_CONTRACT_FIELDS
    from tools import ANSWER_WIRE_FIELDS, unknown_answer_fields

    assert ANSWER_WIRE_FIELDS == ANSWER_CONTRACT_FIELDS
    assert unknown_answer_fields({"id": "1", "bonus": 1}) == ["bonus"]


def test_json_schema_is_answer_contract() -> None:
    import json

    schema = json.loads((AGENT / "schemas" / "answer-contract.json").read_text(encoding="utf-8"))
    assert schema["title"] == "AnswerContract"
    assert set(schema["properties"]) == set(AnswerContract.model_fields)
