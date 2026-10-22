"""Drift (C3): the same figure counted a different way from an earlier turn."""

from __future__ import annotations

import json

import drift
from tests.test_agent import ACTIVITY, Call, FakeTools, ScriptedLlm, ask, build
from tools import ToolResult

UNIT = "platformid_accountid"


def block(sql, result="n\n100", turn="t1"):
    return {"tool": "run_sql", "arguments": {"sql": sql}, "result": result, "turn_id": turn}


def week(days=7, extra=""):
    return (
        f"SELECT COUNT(DISTINCT {UNIT}) AS n FROM {ACTIVITY} "
        f"WHERE event_date >= date_sub(current_date(), {days}){extra}"
    )


def one(sql, **kwargs):
    definition = drift.definition_of(block(sql, **kwargs), "c1")
    assert definition is not None
    return definition


def test_an_overlap_window_inside_a_join_condition_is_a_window():
    sql = (
        f"SELECT COUNT(DISTINCT a.{UNIT}) FROM {ACTIVITY} a JOIN {ACTIVITY} b "
        f"ON a.{UNIT} = b.{UNIT} AND b.event_date >= date_sub(current_date(), 7)"
    )
    assert one(sql).window


def test_a_lookup_join_is_not_a_new_source():
    sql = (
        f"SELECT COUNT(DISTINCT a.{UNIT}) FROM {ACTIVITY} a "
        "JOIN cat.sch.titles t ON a.title_id = t.title_id"
    )
    definition = one(sql)
    assert definition.tables == {ACTIVITY.lower()}
    assert definition.lookups == {"cat.sch.titles"}


def test_between_and_two_bounds_are_the_same_window():
    between = f"SELECT COUNT(DISTINCT {UNIT}) FROM {ACTIVITY} WHERE event_date BETWEEN 1 AND 2"
    bounds = (
        f"SELECT COUNT(DISTINCT {UNIT}) FROM {ACTIVITY} WHERE event_date >= 1 AND event_date <= 2"
    )
    assert one(between).window == one(bounds).window


def test_a_count_in_a_cte_is_a_measure():
    sql = f"WITH c AS (SELECT COUNT(DISTINCT {UNIT}) AS n FROM {ACTIVITY}) SELECT n FROM c"
    assert one(sql).unit == UNIT


def test_failed_results_and_other_counts_are_skipped():
    assert drift.definition_of(block(week(), result="ERROR: nope"), "c1") is None
    assert drift.definition_of(block(f"SELECT COUNT(*) FROM {ACTIVITY}"), "c1") is None
    assert drift.definition_of(block("SELEC nonsense"), "c1") is None


def test_a_grouped_result_has_no_figure_so_a_breakdown_is_not_a_big_move():
    grouped = one(f"SELECT label, COUNT(DISTINCT {UNIT}) FROM {ACTIVITY} GROUP BY label")
    assert grouped.figure is None
    assert one(week(), result="n\n1,200").figure == 1200


def _decide(new, old, *, replying=False, **match):
    current = [new]
    earlier = [(old, "q")]
    base = {
        "current_ref": new.ref,
        "earlier_ref": old.ref,
        "same_quantity": True,
        "user_asked": False,
        "meaningful": False,
        "name": "Weekly players",
        "earlier_plain": "players over 7 days",
        "current_plain": "players over 30 days",
    }
    base.update(match)
    matches = drift.parse_matches({"matches": [base]}, current, earlier)
    return drift.decide(matches, current, earlier, replying=replying)


def _pair(new_sql, old_sql, new_result="n\n100", old_result="n\n100"):
    new = drift.definition_of(block(new_sql, result=new_result), "c1")
    old = drift.definition_of(block(old_sql, result=old_result), "e1.1")
    return new, old


def test_a_changed_table_asks_even_when_not_meaningful():
    other = ACTIVITY.replace("activity", "other")
    new, old = _pair(week().replace(ACTIVITY, other), week())
    new = drift.Definition(**{**new.__dict__, "tables": frozenset({ACTIVITY.lower(), "x.y.z"})})
    outcome = _decide(new, old)
    assert outcome.action == "clarify"
    assert outcome.question.startswith(
        "Earlier in this conversation, Weekly players was counted as"
    )
    assert len(outcome.options) == 2


def test_a_reply_to_a_clarification_is_never_asked_again():
    new, old = _pair(week(30), week(7))
    outcome = _decide(new, old, replying=True, meaningful=True)
    assert outcome.action == "caveat"
    assert "not directly comparable" in outcome.caveats[0]


def test_a_window_change_that_is_not_meaningful_is_a_caveat():
    new, old = _pair(week(30), week(7))
    assert _decide(new, old).action == "caveat"


def test_the_user_asking_for_the_new_way_says_nothing():
    new, old = _pair(week(30), week(7))
    assert _decide(new, old, user_asked=True).action == "none"


def test_a_figure_that_is_not_the_same_quantity_is_ignored():
    new, old = _pair(week(30), week(7))
    assert _decide(new, old, same_quantity=False).action == "none"


def test_a_big_move_with_the_same_definition_is_a_caveat():
    new, old = _pair(week(), week(), "n\n1,600", "n\n1,000")
    outcome = _decide(new, old)
    assert outcome.action == "caveat"
    assert "1.6 times" in outcome.caveats[0]
    small, base = _pair(week(), week(), "n\n1,100", "n\n1,000")
    assert _decide(small, base).action == "none"


def test_an_invented_or_reversed_ref_is_dropped():
    new, old = _pair(week(30), week(7))
    current, earlier = [new], [(old, "q")]
    payload = {
        "matches": [
            {"current_ref": "c9", "earlier_ref": old.ref, "same_quantity": True},
            {"current_ref": old.ref, "earlier_ref": new.ref, "same_quantity": True},
        ]
    }
    assert drift.parse_matches(payload, current, earlier) == []


def test_the_recogniser_needs_the_whole_question():
    whole = drift.QUESTION_TEMPLATE.format(name="Weekly players", earlier="a", current="b")
    history = [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": whole},
        {"role": "user", "content": "a"},
    ]
    assert drift.replying_to_drift(history, "a")
    history[1]["content"] = "Earlier in this conversation, something else entirely?"
    assert not drift.replying_to_drift(history, "a")


def test_no_comparable_pair_means_no_candidates():
    new = one(f"SELECT COUNT(DISTINCT {UNIT}) FROM cat.sch.other")
    old = one(week())
    assert drift.candidates([new], [(old, "q")]) == []


class DriftLlm(ScriptedLlm):
    def __init__(self, *args, matches, **kwargs):
        super().__init__(*args, **kwargs)
        self.matches = matches
        self.drift_calls = 0

    def _create(self, **kwargs):
        if kwargs["messages"][0].get("content") == drift.JUDGEMENT_SYSTEM:
            self.drift_calls += 1
            self.calls.append(kwargs)
            return self._message(content=json.dumps({"matches": self.matches}))
        return super()._create(**kwargs)


def _earlier_turn():
    return {
        "turn_id": "turn-1",
        "question": "Weekly players?",
        "type": "answer",
        "takeaway": "**100** weekly players.",
        "evidence_blocks": [
            {**block(week(7)), "sources": [ACTIVITY], "truncated": False, "version": ""}
        ],
    }


def _matches(**over):
    base = {
        "current_ref": "c1",
        "earlier_ref": "e1.1",
        "same_quantity": True,
        "user_asked": False,
        "meaningful": True,
        "reason": "",
        "name": "Weekly players",
        "earlier_plain": "players over 7 days",
        "current_plain": "players over 30 days",
    }
    base.update(over)
    return [base]


def _run(llm_matches, **ask_kwargs):
    tools = FakeTools(run_sql=ToolResult(text="n\n250", sources=[ACTIVITY]))
    llm = DriftLlm([Call("run_sql", {"sql": week(30)})], "Done.", matches=llm_matches)
    response = ask(
        build(llm, tools),
        "How many weekly players now?",
        prior_turns=[_earlier_turn()],
        **ask_kwargs,
    )
    return llm, response


def test_a_meaningful_change_asks_which_way_to_count():
    llm, response = _run(_matches())
    assert llm.drift_calls == 1
    clarification = response.custom_outputs["clarification"]
    assert clarification["id"].startswith("drift-")
    assert clarification["options"] == ["players over 7 days", "players over 30 days"]


def test_an_unmeaningful_change_is_a_caveat_on_the_answer():
    _, response = _run(_matches(meaningful=False))
    answer = response.custom_outputs["answer"]
    assert any("not directly comparable" in c for c in answer["caveats"])


def test_no_carried_turns_means_no_call():
    tools = FakeTools(run_sql=ToolResult(text="n\n250", sources=[ACTIVITY]))
    llm = DriftLlm([Call("run_sql", {"sql": week(30)})], "Done.", matches=[])
    ask(build(llm, tools), "How many weekly players now?")
    assert llm.drift_calls == 0


def test_a_parser_that_raises_means_no_check_not_a_dead_turn(monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(drift, "current_definitions", boom)
    _, response = _run(_matches())
    assert response.custom_outputs["type"] == "answer"
