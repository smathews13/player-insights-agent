"""Configuration for the test process.

`agent.py` builds a `PlayerInsightsResponsesAgent` at module scope, so importing
it resolves settings, and settings do not default to anything. A test run states
its own configuration here.

FICTIONAL VALUES, NOT THE DEMO PROFILE'S: a test that starts passing because it
found a real catalog has stopped testing anything. `test_catalog` and
`test_schema` are the names the whole package builds namespaces from, and every
module that needs one should use them rather than inventing its own.

`test_config.py` is the deliberate exception. A named profile's real values are
the subject of what it asserts, so it spells them out on purpose.
"""

from __future__ import annotations

import os

for name, value in {
    "PLAYER_INSIGHTS_CATALOG": "test_catalog",
    "PLAYER_INSIGHTS_SCHEMA": "test_schema",
    "PLAYER_INSIGHTS_WAREHOUSE_ID": "test-warehouse",
    "PLAYER_INSIGHTS_DATA_GENIE_ID": "test-space-data",
    "PLAYER_INSIGHTS_DICTIONARY_GENIE_ID": "test-space-dictionary",
    # The existing suite drives the data Genie rung; the opt-out has its own tests.
    "PLAYER_INSIGHTS_OFFER_DATA_GENIE": "1",
}.items():
    os.environ.setdefault(name, value)


import pytest  # noqa: E402


def pytest_configure(config):
    config.addinivalue_line(
        "markers", "plan_stage_off: run with the shipped state, PLAN_STAGE_ENABLED = False"
    )


@pytest.fixture(autouse=True)
def _plan_stage_on(request, monkeypatch):
    """Keep the plan tests running: the stage ships OFF, so they switch it on."""

    if request.node.get_closest_marker("plan_stage_off") is None:
        import agent

        monkeypatch.setattr(agent, "PLAN_STAGE_ENABLED", True)
    yield


@pytest.fixture(autouse=True)
def _fresh_described_columns():
    import sql_policy

    sql_policy.begin_described_columns()
    yield
    sql_policy.begin_described_columns()
