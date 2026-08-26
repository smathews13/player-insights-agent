"""Validated request-time behavior knobs supplied by the app.

These settings never name data or infrastructure. They tune one invocation and
default to the behavior compiled into the model, so direct endpoint callers and
older app builds remain compatible.
"""

from __future__ import annotations

import time
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


@dataclass(frozen=True)
class LoopSettings:
    max_steps: int = 12
    max_tool_calls: int = 12
    max_run_seconds: int = 150


@dataclass(frozen=True)
class AnswerSettings:
    takeaway: bool = True
    narrative: bool = True
    charts: bool = True
    figures: bool = True
    caveats: bool = True
    max_charts: int = 1
    max_figures: int = 6
    max_caveats: int = 0
    narrative_max_characters: int = 0
    sources: str = "standard"
    takeaway_guidance: str = ""
    narrative_guidance: str = ""
    figures_order: str = "as-ranked"
    charts_types: str = "auto"


@dataclass(frozen=True)
class BehaviorSettings:
    clarification: str = "balanced"
    timezone: str = ""
    inject_current_date: bool = False


@dataclass(frozen=True)
class RuntimeSettings:
    loop: LoopSettings = LoopSettings()
    answer: AnswerSettings = AnswerSettings()
    behavior: BehaviorSettings = BehaviorSettings()
    # Promoted Prompt Registry guidance. Not a Settings control — Ask sends it
    # after Benchmarking moves the production alias (or caches the template).
    eval_guidance: str = ""


_current: ContextVar[RuntimeSettings | None] = ContextVar("runtime_settings", default=None)
_turn_started: ContextVar[float] = ContextVar("turn_started", default=0.0)
_turn_deadline: ContextVar[float] = ContextVar("turn_deadline", default=0.0)


def _integer(value: Any, default: int, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    number = int(value)
    return number if number == value and low <= number <= high else default


def _boolean(value: Any, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _string(value: Any, default: str, limit: int) -> str:
    if not isinstance(value, str):
        return default
    trimmed = value.strip()
    return trimmed if len(trimmed) <= limit else default


def activate(custom_inputs: dict[str, Any]) -> RuntimeSettings:
    """Validate and activate settings for the current invocation."""

    started = time.perf_counter()
    raw = custom_inputs.get("runtime_settings")
    if not isinstance(raw, dict):
        value = RuntimeSettings(eval_guidance=_string(custom_inputs.get("eval_guidance"), "", 8_000))
        _current.set(value)
        _turn_started.set(started)
        _turn_deadline.set(started + value.loop.max_run_seconds)
        return value
    loop = raw.get("loop") if isinstance(raw.get("loop"), dict) else {}
    answer = raw.get("answer") if isinstance(raw.get("answer"), dict) else {}
    behavior = raw.get("behavior") if isinstance(raw.get("behavior"), dict) else {}
    sources = answer.get("sources")
    clarification = behavior.get("clarification")
    timezone = behavior.get("timezone")
    if not isinstance(timezone, str) or len(timezone) > 80:
        timezone = ""
    if timezone:
        try:
            ZoneInfo(timezone)
        except ZoneInfoNotFoundError:
            timezone = ""
    value = RuntimeSettings(
        loop=LoopSettings(
            max_steps=_integer(loop.get("maxSteps"), 12, 1, 20),
            max_tool_calls=_integer(loop.get("maxToolCalls"), 12, 1, 40),
            max_run_seconds=_integer(loop.get("maxRunSeconds"), 150, 30, 200),
        ),
        answer=AnswerSettings(
            takeaway=_boolean(answer.get("takeaway"), True),
            narrative=_boolean(answer.get("narrative"), True),
            charts=_boolean(answer.get("charts"), True),
            figures=_boolean(answer.get("figures"), True),
            caveats=_boolean(answer.get("caveats"), True),
            max_charts=_integer(answer.get("maxCharts"), 1, 0, 6),
            max_figures=_integer(answer.get("maxFigures"), 6, 0, 12),
            max_caveats=_integer(answer.get("maxCaveats"), 0, 0, 20),
            narrative_max_characters=_integer(
                answer.get("narrativeMaxCharacters"), 0, 0, 12_000
            ),
            sources=sources if sources in {"compact", "standard", "detailed"} else "standard",
            takeaway_guidance=_string(answer.get("takeawayGuidance"), "", 2_000),
            narrative_guidance=_string(answer.get("narrativeGuidance"), "", 2_000),
            figures_order=(
                answer.get("figuresOrder")
                if answer.get("figuresOrder") in {"as-ranked", "totals-first", "averages-first"}
                else "as-ranked"
            ),
            charts_types=(
                answer.get("chartsTypes")
                if answer.get("chartsTypes") in {"auto", "bar", "bar-line"}
                else "auto"
            ),
        ),
        behavior=BehaviorSettings(
            clarification=(
                clarification
                if clarification in {"strict", "balanced", "proceed-with-caveat"}
                else "balanced"
            ),
            timezone=timezone,
            inject_current_date=_boolean(behavior.get("injectCurrentDate"), False),
        ),
        eval_guidance=_string(custom_inputs.get("eval_guidance"), "", 8_000),
    )
    _current.set(value)
    _turn_started.set(started)
    _turn_deadline.set(started + value.loop.max_run_seconds)
    return value


def current() -> RuntimeSettings:
    return _current.get() or RuntimeSettings()


def turn_started() -> float:
    """The one monotonic origin for this request's execution budget."""

    return _turn_started.get() or time.perf_counter()


def remaining_seconds() -> float:
    """Time left on the single request deadline, never negative."""

    deadline = _turn_deadline.get()
    if not deadline:
        return float(current().loop.max_run_seconds)
    return max(0.0, deadline - time.perf_counter())


def today_line(timezone: str = "", *, now: datetime | None = None) -> str:
    """Reference notebook parity: the agent must know what calendar day it is.

    Relative windows ("last 30 days", "yesterday", as-of dating) need a concrete
    calendar day. Serving models do not reliably know wall-clock date, so the
    notebook pattern is to inject it into context every call. Default timezone is
    UTC; a request may name another IANA zone.
    """

    zone_name = timezone or "UTC"
    try:
        zone = ZoneInfo(zone_name)
    except ZoneInfoNotFoundError:
        zone_name = "UTC"
        zone = ZoneInfo("UTC")
    stamp = (now or datetime.now(zone)).astimezone(zone)
    return (
        f"Today's date is {stamp.date().isoformat()} ({zone_name}). "
        "Use this calendar day when interpreting relative windows such as "
        "'last 30 days', 'yesterday', or 'as of today'."
    )


def prompt_fragment(*, now: datetime | None = None) -> str:
    settings = current()
    # Notebook parity: always inject the calendar day, even when no other runtime
    # knobs differ from compiled defaults. Relative windows otherwise invent a day.
    always = today_line(settings.behavior.timezone, now=now)
    if settings.answer == AnswerSettings() and settings.behavior == BehaviorSettings():
        if not settings.eval_guidance:
            return always
        return f"{always}\n\n# Promoted operating guidance\n{settings.eval_guidance}"
    lines = [
        always,
        "Runtime answer contract:",
        f"- takeaway={'on' if settings.answer.takeaway else 'off'}",
        f"- narrative={'on' if settings.answer.narrative else 'off'}",
        (
            f"- figures={'on' if settings.answer.figures else 'off'}; "
            f"cap={settings.answer.max_figures}"
        ),
        f"- charts={'on' if settings.answer.charts else 'off'}; cap={settings.answer.max_charts}",
        f"- analyst caveats={'on' if settings.answer.caveats else 'off'}",
        f"- source detail={settings.answer.sources}",
        f"- clarification policy={settings.behavior.clarification}",
        "Safety and governance refusals remain mandatory regardless of presentation settings.",
    ]
    if settings.answer.takeaway_guidance:
        lines.append(f"- takeaway guidance: {settings.answer.takeaway_guidance}")
    if settings.answer.narrative_guidance:
        lines.append(f"- narrative guidance: {settings.answer.narrative_guidance}")
    if settings.answer.figures_order != "as-ranked":
        lines.append(f"- figure order={settings.answer.figures_order}")
    if settings.answer.charts_types != "auto":
        chart_rule = (
            "bar charts only"
            if settings.answer.charts_types == "bar"
            else "bar or line charts only"
        )
        lines.append(f"- chart types={settings.answer.charts_types}; produce {chart_rule}")
    if settings.behavior.inject_current_date:
        # Explicit UI/request opt-in keeps a second labeled reminder for operators
        # who turned the switch on; the already-on line above already supplies the day.
        lines.append(
            f"- Current date (explicit): {today_line(settings.behavior.timezone, now=now)}"
        )
    if settings.eval_guidance:
        lines.append("# Promoted operating guidance")
        lines.append(settings.eval_guidance)
    return "\n".join(lines)
