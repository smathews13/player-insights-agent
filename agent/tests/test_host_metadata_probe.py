"""The five minutes a release used to spend resolving nothing.

Every ``databricks.sdk`` ``Config()`` probes ``{host}/.well-known/databricks-config``
on the way up, with a 300-second retry budget when nothing narrows it, and falls
back to the configuration it already had when the probe fails. On a machine where
that endpoint does not answer the fallback is reached five minutes later, and one
of those probes was the majority of a release's elapsed time.

Two of the tests below are the ones worth keeping. The first is that the probe
runs on a short budget: that is the fix, and without a test it regresses into a
multi-minute stall the next time somebody constructs the client differently. The
second is that the budget is put BACK afterwards, which is the way this fix could
do real damage -- a release that gave every table listing five seconds to retry
would be fast and wrong, and it would only fail on the day the workspace was
briefly busy.
"""

from __future__ import annotations

import time

import pytest
from databricks.sdk.config import Config
from databricks.sdk.core import ApiClient

import host_metadata_probe as probe

#: Nothing listens here, so the probe fails without leaving the machine and
#: without depending on how a network happens to be configured today.
UNREACHABLE = "https://127.0.0.1:9"

#: The SDK's own budget, and what an unbounded probe costs. Measured at 303.4s.
SDK_RETRY_BUDGET_SECONDS = 300


@pytest.fixture
def sdk_config():
    """Put the SDK back the way it was found.

    ``bound`` replaces a method on a class imported from site-packages, so a test
    that leaves it installed changes every test that runs after it.
    """

    original = Config._resolve_host_metadata
    try:
        yield Config
    finally:
        Config._resolve_host_metadata = original


@pytest.fixture
def probe_calls(sdk_config):
    """Stand in for the real probe and record the budget it was given.

    Installed BEFORE ``bound``, so it becomes the wrapped original. Nothing here
    touches the network, which is the point: the question is what budget the
    probe would have run under, not what a discovery endpoint says today.
    """

    seen: list[dict[str, object]] = []

    def recorder(self) -> None:
        seen.append(
            {
                "retry_timeout_seconds": self.retry_timeout_seconds,
                "http_timeout_seconds": self.http_timeout_seconds,
            }
        )

    sdk_config._resolve_host_metadata = recorder
    return seen


def test_the_probe_runs_on_a_few_seconds_rather_than_the_sdks_five_minutes(probe_calls):
    """THE FIX. Both budgets are narrowed, because either one alone still stalls.

    The retry budget bounds the loop and the HTTP timeout bounds one attempt
    inside it. Left at its default the latter is 60 seconds, so a host that
    accepts the connection and then says nothing costs five attempts, which is
    the same five minutes by a different route.
    """

    probe.bound(budget_seconds=3, announce=lambda _: None)
    Config(host=UNREACHABLE, token="dummy")

    assert probe_calls, "the probe never ran, so this test proves nothing about its budget"
    assert probe_calls[0] == {"retry_timeout_seconds": 3, "http_timeout_seconds": 3.0}


def test_real_api_calls_keep_the_full_retry_budget(probe_calls):
    """The half of this that could quietly break a release rather than slow it.

    The narrowing lasts for the probe and no longer. An ``ApiClient`` reads the
    budget when it is constructed, which is after ``Config.__init__`` has
    returned, so what matters is that the config is handed back unchanged.
    """

    probe.bound(budget_seconds=3, announce=lambda _: None)
    config = Config(host=UNREACHABLE, token="dummy")

    assert config.retry_timeout_seconds is None, (
        "the probe's budget outlived the probe, so every retry this client makes "
        "now gives up after 3s instead of the SDK's 300s"
    )
    assert config.http_timeout_seconds is None

    client = ApiClient(config)
    assert client._api_client._retry_timeout_seconds == SDK_RETRY_BUDGET_SECONDS
    assert client._api_client._http_timeout_seconds == 60


def test_a_budget_already_set_on_the_config_survives_the_probe(probe_calls):
    """Ours is a default, not an override.

    A config that arrives with its own budget gets it back, so this stays a fix
    for an unbounded probe rather than a cap on anybody's deliberate patience.
    """

    probe.bound(budget_seconds=3, announce=lambda _: None)
    config = Config(host=UNREACHABLE, token="dummy", retry_timeout_seconds=120)

    assert probe_calls[0]["retry_timeout_seconds"] == 3
    assert config.retry_timeout_seconds == 120


def test_nothing_is_probed_when_every_field_it_resolves_is_already_known(probe_calls):
    """The cheapest outcome: no probe at all.

    Called directly rather than through ``Config()`` because a config carrying an
    account id and a discovery url is a different kind of client, and this is a
    question about the wrapper rather than about the SDK's validation.
    """

    probe.bound(budget_seconds=3, announce=lambda _: None)

    class Known:
        _inner: dict[str, object] = {}

    for field in probe.DISCOVERED_FIELDS:
        setattr(Known, field, "already-configured")

    Config._resolve_host_metadata(Known())

    assert not probe_calls, "there was nothing left to discover and it went looking anyway"
    assert Known._inner == {}, "a skipped probe still edited the config it skipped"


def test_it_says_which_of_the_two_happened_exactly_once(probe_calls):
    """One line, not one per client.

    Logging a model builds several clients -- ours, and MLflow's own for tracking
    and for the registry -- and a release log that reports this five times reads
    as a problem rather than as a note. Silence is worse than either: a release
    that has quietly started waiting five minutes again should say so.
    """

    said: list[str] = []
    probe.bound(budget_seconds=3, announce=said.append)
    Config(host=UNREACHABLE, token="dummy")
    Config(host=UNREACHABLE, token="dummy")

    assert len(said) == 1, said
    assert "BOUNDED" in said[0]
    assert len(probe_calls) == 2, "the probe stopped running for the second client"


def test_bounding_twice_does_not_wrap_the_wrapper(probe_calls):
    """Two calls would otherwise nest, and a nested wrapper reports twice."""

    assert probe.bound(budget_seconds=3, announce=lambda _: None) is True
    installed = Config._resolve_host_metadata
    assert probe.bound(budget_seconds=3, announce=lambda _: None) is True
    assert Config._resolve_host_metadata is installed


def test_an_sdk_without_the_probe_is_left_alone_and_says_so(sdk_config):
    """A newer SDK that bounds or drops its own probe must not fail a release.

    The method is private, so its disappearance is a supported outcome here
    rather than an error: the release proceeds exactly as it would have.
    """

    del sdk_config._resolve_host_metadata
    said: list[str] = []

    assert probe.bound(announce=said.append) is False
    assert not hasattr(sdk_config, probe.PROBE_METHOD)
    assert len(said) == 1
    assert "Nothing was changed" in said[0]


def test_an_unreachable_host_costs_seconds_rather_than_minutes(sdk_config):
    """The end-to-end guard, against the real SDK and a real socket.

    Everything above stands in for the probe, so all of it would still pass if
    the SDK stopped honouring the budget it is given. This one does not: it
    builds a real client against a port nothing listens on and times it.

    The bound is loose on purpose. It is not measuring how fast this is, it is
    refusing the five minutes, and a threshold tight enough to describe a laptop
    is a test that fails on a busy one.
    """

    probe.bound(budget_seconds=3, announce=lambda _: None)
    started = time.monotonic()
    Config(host=UNREACHABLE, token="dummy")
    elapsed = time.monotonic() - started

    assert elapsed < 60, (
        f"resolving an unreachable host took {elapsed:.1f}s. Unbounded this is "
        f"{SDK_RETRY_BUDGET_SECONDS}s, which is the stall this module exists to prevent."
    )
