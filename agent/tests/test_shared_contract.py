from __future__ import annotations

import json

from contracts import (
    CAVEAT_CATEGORIES,
    DEGRADED_ANSWER_MARKER,
    DYNAMIC_CAVEAT_FAMILIES,
    KNOWN_CAVEAT_FORMS,
)
from generate_contract import OUTPUT, TERMINAL_KINDS, contract_document, rendered_contract


def test_checked_in_response_contract_matches_the_python_models():
    assert OUTPUT.read_text(encoding="utf-8") == rendered_contract()


def test_contract_names_every_terminal_shape_and_uses_type_as_the_discriminator():
    contract = contract_document()

    assert contract["x-pia-terminal-kinds"] == list(TERMINAL_KINDS)
    assert contract["discriminator"]["propertyName"] == "type"
    assert set(contract["discriminator"]["mapping"]) == set(TERMINAL_KINDS)


def test_answer_output_requires_every_field_the_agent_serializes():
    answer = contract_document()["$defs"]["AnswerContract"]

    assert set(answer["required"]) == set(answer["properties"])
    assert answer["properties"]["caveats"]["items"] == {"type": "string"}
    assert answer["properties"]["chart_evidence"]["items"] == {"type": "string"}


def test_caveat_contract_is_open_but_its_semantic_families_are_complete():
    caveats = contract_document()["x-pia-caveats"]

    assert caveats["closed_set"] is False
    assert caveats["categories"] == list(CAVEAT_CATEGORIES)
    assert caveats["stable_forms"] == list(KNOWN_CAVEAT_FORMS)
    assert caveats["dynamic_families"] == list(DYNAMIC_CAVEAT_FAMILIES)
    assert [category["rank"] for category in caveats["categories"]] == list(range(9))
    assert [category["id"] for category in caveats["categories"]] == [
        "refused",
        "evidence",
        "undefined",
        "coverage",
        "aggregation",
        "omitted",
        "unclassified",
        "identity",
        "deployment",
    ]
    assert caveats["stable_forms"][0]["value"] == DEGRADED_ANSWER_MARKER


def test_contract_is_plain_json_with_no_runtime_only_values():
    encoded = json.dumps(contract_document(), ensure_ascii=False)

    assert "typing." not in encoded
    assert "pydantic." not in encoded
