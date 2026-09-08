"""Request-scoped routing for every foundation-model call.

The model artifact carries both destinations.  The app chooses one route for a
new ask and sends only the route name; callers cannot supply endpoint names.
Missing route metadata keeps older clients on the direct path.
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

DIRECT = "direct"
AI_GATEWAY = "ai_gateway"
ROUTES = frozenset({DIRECT, AI_GATEWAY})
CUSTOM_INPUT_KEY = "llm_route"
TRACE_ATTRIBUTE = "player_insights.llm_route"


class InvalidLlmRoute(ValueError):
    """A request named a route this model does not implement."""


class AiGatewayNotConfigured(RuntimeError):
    """The app requested Gateway routing from an artifact without one."""


@dataclass(frozen=True)
class Selection:
    route: str
    endpoint: str
    gateway_mode: str

    @property
    def trace_metadata(self) -> dict[str, str]:
        return {TRACE_ATTRIBUTE: self.route}


_current: ContextVar[Selection | None] = ContextVar("llm_route", default=None)


def activate(custom_inputs: dict[str, Any], settings: Any) -> Selection:
    """Validate and activate the app-selected route for this request."""

    raw = custom_inputs.get(CUSTOM_INPUT_KEY, DIRECT)
    if raw not in ROUTES:
        raise InvalidLlmRoute(
            f"{CUSTOM_INPUT_KEY} must be {DIRECT!r} or {AI_GATEWAY!r}; received {raw!r}."
        )
    if raw == AI_GATEWAY:
        endpoint = str(getattr(settings, "llm_gateway_endpoint", "") or "").strip()
        mode = str(getattr(settings, "llm_gateway", "") or "").strip()
        if not endpoint or not mode:
            raise AiGatewayNotConfigured(
                "AI Gateway is enabled for this ask, but the logged model has no configured "
                "Gateway service and transport."
            )
        selection = Selection(route=AI_GATEWAY, endpoint=endpoint, gateway_mode=mode)
    else:
        selection = Selection(
            route=DIRECT,
            endpoint=str(getattr(settings, "llm_endpoint", "") or "").strip(),
            gateway_mode="",
        )
    _current.set(selection)
    return selection


def current(settings: Any) -> Selection:
    """The active request selection, defaulting legacy callers to direct."""

    return _current.get() or Selection(
        route=DIRECT,
        endpoint=str(getattr(settings, "llm_endpoint", "") or "").strip(),
        gateway_mode="",
    )


def clear() -> None:
    _current.set(None)
