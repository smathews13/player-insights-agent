"""Answer shape (A1), figure verification (A2) and the restated carry-over filter (D.2)."""

from __future__ import annotations

import answer_numbers as n
from agent import Figure, RunLog, _shaped_and_checked, restates_carry_over


def test_a_name_with_digits_is_not_a_number():
    assert n.quantities("Plays v2 of gold_2024 and 3.5.1") == []


def test_one_significant_digit_abbreviations_are_not_compared():
    held = n.quantities("**1,203,456** players, 10,500,000 events")
    assert not n.repeats(n.quantities("10M")[0], held)
    assert n.repeats(n.quantities("1.2M")[0], held)


def test_rounded_repeat_is_found():
    assert n.repeats(n.quantities("9.98M")[0], n.quantities("9,987,654 rows"))


def test_table_drops_cards_and_trims_the_takeaway():
    log = RunLog()
    takeaway, _, _, figures, _ = _shaped_and_checked(
        "**9,001** players: broken down below",
        "",
        "| a | b |\n|---|---|\n| x | 9,001 |",
        [Figure(label="P", value=9001, display="9,001")],
        log,
    )
    assert takeaway == "**9,001** players"
    assert figures == []


def test_narrative_sentence_repeating_a_content_number_is_dropped():
    out = n.without_repeated_numbers(
        "Traffic is up. It reached 1,203,456 users.",
        takeaway="**5,000** up",
        content="| 1,203,456 |",
        table=True,
    )
    assert "1,203,456" not in out
    assert "Traffic is up." in out


def test_a_sentence_with_a_new_number_is_kept_without_a_table():
    out = n.without_repeated_numbers(
        "Weekend rose to 4,321.", takeaway="**5,000** up", content="", table=False
    )
    assert "4,321" in out


def test_an_invented_card_is_withheld_and_an_evidence_card_kept():
    log = RunLog()
    log.evidence.append("run_sql returned: players 8413")
    figures = [
        Figure(label="Real", value=8413, display="8,413"),
        Figure(label="Fake", value=77777, display="77,777"),
        Figure(label="Year", value=2025, display="2025"),
        Figure(label="Share", value=45, display="45%"),
    ]
    _, _, _, kept, notes = _shaped_and_checked("**x**", "", "", figures, log)
    assert [f.label for f in kept] == ["Real", "Year", "Share"]
    assert notes == [
        'The "Fake" figure card was withheld: its value, 77,777, does not match any '
        "number the queries returned."
    ]


def test_takeaway_numbers_that_do_not_match_get_a_caveat():
    log = RunLog()
    log.evidence.append("rows: 8413")
    _, _, _, _, notes = _shaped_and_checked("**9,999** players", "", "", [], log)
    assert notes == [
        "Unverified in the takeaway: 9,999 does not match any number the queries returned."
    ]


def test_carry_over_restatements_are_recognised():
    assert restates_carry_over("Figures were carried over from turn 2.")
    assert restates_carry_over("Reused from an earlier turn.")
    assert not restates_carry_over("All-time: no date filter.")
