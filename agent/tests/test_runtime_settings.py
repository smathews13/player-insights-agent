from datetime import datetime
from zoneinfo import ZoneInfo

from runtime_settings import RuntimeSettings, activate, current, prompt_fragment, today_line


def test_absent_settings_preserve_compiled_behavior():
    assert activate({}) == RuntimeSettings()
    assert current().loop.max_steps == 12
    assert current().answer.max_charts == 1
    assert current().answer.max_figures == 6
    assert current().loop.max_run_seconds == 150


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
                "loop": {"maxSteps": 10, "maxToolCalls": 20, "maxRunSeconds": 120},
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
    assert settings.loop.max_steps == 10
    assert settings.answer.max_figures == 4
    assert settings.answer.charts is False
    fragment = prompt_fragment()
    assert "clarification policy=strict" in fragment
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


def test_invalid_direct_caller_values_fall_back_safely():
    settings = activate(
        {
            "runtime_settings": {
                "loop": {"maxSteps": 999, "maxToolCalls": "many", "maxRunSeconds": 1},
                "answer": {"sources": "everything"},
                "behavior": {"timezone": "not/a-zone"},
            }
        }
    )
    assert settings.loop.max_steps == 12
    assert settings.loop.max_tool_calls == 12
    assert settings.behavior.timezone == ""
    assert settings.answer.takeaway_guidance == ""
    assert settings.answer.figures_order == "as-ranked"
    assert settings.answer.charts_types == "auto"


def test_the_answer_reserve_scales_and_is_zero_at_the_floor():
    """A flat 35s hold-back against a 30s minimum left the loop unable to run."""

    from runtime_settings import (
        ANSWER_RESERVE_AT_DEFAULT,
        answer_reserve_seconds,
    )

    activate({})
    assert answer_reserve_seconds() == ANSWER_RESERVE_AT_DEFAULT
    activate({"runtime_settings": {"loop": {"maxRunSeconds": 30}}})
    assert answer_reserve_seconds() == 0
    activate({"runtime_settings": {"loop": {"maxRunSeconds": 150}}})
    assert answer_reserve_seconds() == 25
