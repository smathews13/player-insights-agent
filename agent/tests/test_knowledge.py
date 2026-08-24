from pathlib import Path

from knowledge import (
    add_packaged_knowledge,
    load_common_knowledge,
    load_counting_users,
    load_packaged_knowledge,
)


def test_loads_markdown_in_stable_order_and_skips_empty_files(tmp_path: Path):
    (tmp_path / "20-second.md").write_text("Second", encoding="utf-8")
    (tmp_path / "10-first.md").write_text("First", encoding="utf-8")
    (tmp_path / "15-empty.md").write_text("\n", encoding="utf-8")
    (tmp_path / "ignored.txt").write_text("Not markdown", encoding="utf-8")

    assert load_packaged_knowledge(tmp_path) == "First\n\nSecond"


def test_missing_payload_is_safe_and_does_not_change_the_prompt(tmp_path: Path):
    missing = tmp_path / "missing"

    assert load_packaged_knowledge(missing) == ""
    assert add_packaged_knowledge("Base rules", "") == "Base rules"


def test_nonempty_payload_has_an_explicit_prompt_boundary():
    enriched = add_packaged_knowledge("Base rules", "Governed guidance")

    assert enriched == "Base rules\n\n# Packaged knowledge\nGoverned guidance"


def test_counting_users_is_the_shared_identifier_contract():
    text = load_counting_users()
    assert "brand_firstpartyid" in text
    assert "crm_customer_ref" in text
    assert "Northwind-only" in text


def test_common_knowledge_names_no_undeclared_tables():
    text = load_common_knowledge()
    assert "cross title" in text
    assert "untagged" in text
    assert "resolve_table" in text
