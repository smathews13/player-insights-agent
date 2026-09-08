from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

import llm_routing


@pytest.fixture(autouse=True)
def clear_route():
    llm_routing.clear()
    yield
    llm_routing.clear()


def settings():
    return SimpleNamespace(
        llm_endpoint="direct-foundation-model",
        llm_gateway_endpoint="catalog.schema.gateway_model",
        llm_gateway="mlflow",
    )


def test_missing_route_defaults_to_direct_for_older_callers():
    selected = llm_routing.activate({}, settings())
    assert selected.route == "direct"
    assert selected.endpoint == "direct-foundation-model"
    assert selected.gateway_mode == ""


def test_gateway_route_selects_the_configured_service_and_safe_metadata():
    selected = llm_routing.activate({"llm_route": "ai_gateway"}, settings())
    assert selected.endpoint == "catalog.schema.gateway_model"
    assert selected.gateway_mode == "mlflow"
    assert selected.trace_metadata == {"player_insights.llm_route": "ai_gateway"}
    assert "catalog.schema" not in repr(selected.trace_metadata)


def test_gateway_request_fails_closed_when_capability_is_incomplete():
    incomplete = SimpleNamespace(
        llm_endpoint="direct-foundation-model",
        llm_gateway_endpoint="",
        llm_gateway="",
    )
    with pytest.raises(llm_routing.AiGatewayNotConfigured):
        llm_routing.activate({"llm_route": "ai_gateway"}, incomplete)


def test_unknown_route_never_falls_back_to_direct():
    with pytest.raises(llm_routing.InvalidLlmRoute):
        llm_routing.activate({"llm_route": "direct-please"}, settings())


def test_every_agent_llm_call_uses_the_central_route_selection():
    source = (Path(__file__).resolve().parents[1] / "agent.py").read_text()
    assert "self.settings.llm_endpoint" not in source
    assert source.count("client.chat.completions.create") >= 1
    assert "def _llm_endpoint(self)" in source
    assert "def _turn_llm_client(self)" in source
