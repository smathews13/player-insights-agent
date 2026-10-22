from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

import runtime_settings
from runtime_settings import RuntimeSettings, activate, current, prompt_fragment, today_line


def test_absent_settings_preserve_compiled_behavior():
    assert activate({}) == RuntimeSettings()
    assert current().loop.max_steps == 40
    assert current().loop.max_tool_calls == 80
    assert current().answer.max_charts == 6
    assert current().answer.max_figures == 6
    assert current().loop.max_run_seconds == 550


def test_prompt_fragment_always_names_todays_date():
    """Notebook parity: relative windows need a calendar day even with no knobs set."""

    activate({})
    fragment = prompt_fragment(now=datetime(2026, 8, 18, 20, 0, tzinfo=ZoneInfo("UTC")))
    assert "Today's date is 2026-08-18 (UTC)" in fragment
    assert "last 30 days" in fragment


def test_today_line_respects_named_timezone():
    line = today_line(
        "America/Los_Angeles",
        now=datetime(2026, 8, 19, 2, 0, tzinfo=ZoneInfo("UTC")),
    )
    assert "Today's date is 2026-08-18 (America/Los_Angeles)" in line


def test_request_settings_control_loop_and_answer_contract():
    settings = activate(
        {
            "runtime_settings": {
                "loop": {"maxSteps": 40, "maxToolCalls": 80, "maxRunSeconds": 550},
                "answer": {
                    "takeaway": False,
                    "narrative": True,
                    "charts": False,
                    "figures": True,
                    "caveats": False,
                    "maxCharts": 0,
                    "maxFigures": 4,
                    "maxCaveats": 3,
                    "narrativeMaxCharacters": 1000,
                    "sources": "compact",
                    "takeawayGuidance": "Lead with the decision.",
                    "narrativeGuidance": "Name the source beside each finding.",
                    "figuresOrder": "totals-first",
                    "chartsTypes": "bar",
                },
                "behavior": {
                    "clarification": "strict",
                    "timezone": "America/Los_Angeles",
                    "injectCurrentDate": True,
                },
            }
        }
    )
    assert settings.loop.max_steps == 40
    assert settings.loop.max_tool_calls == 80
    assert settings.loop.max_run_seconds == 550
    assert settings.answer.max_figures == 4
    assert settings.answer.charts is False
    fragment = prompt_fragment()
    assert "clarification policy: ask whenever a governed term is ambiguous." in fragment
    assert "Today's date is " in fragment
    assert "takeaway guidance: Lead with the decision." in fragment
    assert "narrative guidance: Name the source beside each finding." in fragment
    assert "figure order=totals-first" in fragment
    assert "chart types=bar; produce bar charts only" in fragment


def test_eval_guidance_reaches_the_prompt_without_runtime_settings():
    activate({"eval_guidance": "Stay inside governed tables."})
    fragment = prompt_fragment()
    assert "Promoted operating guidance" in fragment
    assert "Stay inside governed tables." in fragment


def test_integral_direct_caller_values_clamp_to_the_supported_range():
    settings = activate(
        {
            "runtime_settings": {
                "loop": {"maxSteps": 999, "maxToolCalls": "many", "maxRunSeconds": 1},
                "answer": {"sources": "everything"},
                "behavior": {"timezone": "not/a-zone"},
            }
        }
    )
    assert settings.loop.max_steps == 40
    assert settings.loop.max_tool_calls == 80
    assert settings.loop.max_run_seconds == 30
    assert settings.behavior.timezone == ""
    assert settings.answer.takeaway_guidance == ""
    assert settings.answer.figures_order == "as-ranked"
    assert settings.answer.charts_types == "auto"


def test_max_run_seconds_above_the_ceiling_clamps_instead_of_dropping_to_default():
    settings = activate({"runtime_settings": {"loop": {"maxRunSeconds": 551}}})

    assert settings.loop.max_run_seconds == 550


@pytest.mark.parametrize("value", [549.5, "550", True, None])
def test_fractional_and_invalid_max_run_seconds_still_use_the_default(value):
    settings = activate({"runtime_settings": {"loop": {"maxRunSeconds": value}}})

    assert settings.loop.max_run_seconds == 550


def test_the_answer_reserve_scales_and_is_zero_at_the_floor():
    """A flat 35s hold-back against a 30s minimum left the loop unable to run."""

    from runtime_settings import (
        ANSWER_RESERVE_SECONDS,
        answer_reserve_seconds,
    )

    activate({})
    assert answer_reserve_seconds() == ANSWER_RESERVE_SECONDS
    activate({"runtime_settings": {"loop": {"maxRunSeconds": 30}}})
    assert answer_reserve_seconds() == 0
    activate({"runtime_settings": {"loop": {"maxRunSeconds": 150}}})
    assert answer_reserve_seconds() == 25
    activate({"runtime_settings": {"loop": {"maxRunSeconds": 550}}})
    assert answer_reserve_seconds() == 25


def test_out_of_range_settings_clamp_to_the_bound_and_are_disclosed():
    value = runtime_settings.activate(
        {"runtime_settings": {"loop": {"maxToolCalls": 500}, "answer": {"maxFigures": 3}}}
    )
    assert value.loop.max_tool_calls == runtime_settings.MAX_TOOL_CALLS_CEILING
    assert any("tool-call limit of 500" in notice for notice in value.notices)
    assert not any("figure limit" in notice for notice in value.notices)


def test_non_whole_settings_fall_back_to_default_and_say_so():
    value = runtime_settings.activate(
        {"runtime_settings": {"answer": {"maxCharts": 2.5, "maxFigures": 4.0, "maxCaveats": True}}}
    )
    assert value.answer.max_charts == 6
    assert value.answer.max_figures == 4
    assert any("chart limit (2.5) is not a whole number" in n for n in value.notices)
    assert any("caveat limit (True)" in n for n in value.notices)
    assert runtime_settings.activate({"runtime_settings": {"answer": {}}}).notices == ()


def test_each_clarification_policy_becomes_its_sentence_in_the_finder_prompt():
    from runtime_settings import CLARIFICATION_SENTENCES, finder_fragment

    for policy, sentence in CLARIFICATION_SENTENCES.items():
        activate({"runtime_settings": {"behavior": {"clarification": policy}}})
        fragment = finder_fragment()
        assert sentence in fragment
        assert "Runtime answer contract" not in fragment
        assert "takeaway" not in fragment


def test_knowledge_tools_are_built_from_on_demand_files(tmp_path):
    import knowledge

    folder = tmp_path / knowledge.ON_DEMAND_DIR
    folder.mkdir()
    (folder / "refund-policy.md").write_text("when: a refund rule is asked about.\nBody text.")
    (folder / "no-when.md").write_text("Body only.")
    found = knowledge.load_on_demand(tmp_path)
    assert list(found) == ["refund_policy"]
    tool = knowledge.knowledge_tools(found)[0]["function"]
    assert tool["description"].startswith("Call ONLY when")
    assert found["refund_policy"][1] == "Body text."
