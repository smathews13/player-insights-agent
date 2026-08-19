"""Stop the SDK's host-metadata discovery from costing five minutes a release.

Every ``databricks.sdk`` ``Config()`` — and therefore every ``WorkspaceClient()``,
including the ones MLflow builds for itself while logging and registering a model
— runs a discovery probe against ``{host}/.well-known/databricks-config`` before
it will finish constructing. The probe is BEST EFFORT: on any failure the SDK
logs "Falling back to explicit user provided configuration" and carries on with
the values it was given, which is the path this repository has always taken.

What it is not is BOUNDED. The probe's HTTP client is built from
``retry_timeout_seconds`` and ``http_timeout_seconds``, neither of which has an
environment variable and neither of which this repository sets, so both are
unset and the client falls back to its own defaults: a 60-second per-attempt
timeout inside a 300-SECOND RETRY BUDGET. When that endpoint does not answer --
blocked by a proxy, or answering something the retry loop considers worth
retrying -- ``Config()`` blocks for five minutes, then falls back to the
configuration it already had in hand. Measured offline at 303.4s for ONE client.

That was the majority of a release's elapsed time, and all of it bought nothing:
the fallback values were available before the probe started.

So the probe is bounded here rather than removed. Removing it would be a change
to how a workspace is resolved; bounding it is a change to how long we are
willing to wait for something we do not need, and it leaves the fallback exactly
where it was. Two things follow, and both matter:

- **Nothing the probe would have discovered reaches the model artifact.** It
  fills ``account_id``, ``workspace_id``, ``discovery_url``, ``cloud`` and
  ``token_audience`` on the client's own config. What gets baked comes from
  ``Settings`` and the release's own decisions. A bounded probe changes how long
  a client takes to build, not what it builds.
- **Bounding cannot be worse than the failure it replaces.** On a machine where
  the endpoint does not answer, the SDK already ends up on the fallback path --
  five minutes later. On a machine where it does answer, a working discovery
  endpoint answers in well under the budget, so nothing changes at all.

The real API calls that follow keep their full retry budget. The narrowing is
applied to the config for the duration of the probe and then put back, and the
budget an ``ApiClient`` uses is read when the client is constructed, which is
after ``Config.__init__`` has returned. There is a test for that, because a fix
for a slow release that quietly made every table listing give up after five
seconds would be a bad trade.
"""

from __future__ import annotations

import time
from collections.abc import Callable

#: Generous for a discovery endpoint that answers at all, and a rounding error
#: on a release when one does not.
DEFAULT_BUDGET_SECONDS = 5

#: The fields the probe exists to fill in. When every one of them is already
#: known there is nothing left to discover, so the probe is skipped outright
#: rather than merely bounded.
DISCOVERED_FIELDS = (
    "account_id",
    "workspace_id",
    "discovery_url",
    "cloud",
    "token_audience",
)

#: The two budgets the probe's HTTP client is built from, with the type each one
#: is stored as. Written into the config's backing dict directly: assigning
#: through the descriptor is fine going in, but it cannot express "unset" coming
#: back out, and unset is what these almost always are.
BUDGET_FIELDS = {"retry_timeout_seconds": int, "http_timeout_seconds": float}

#: Private to the SDK, so its absence is treated as "nothing to bound" rather
#: than as an error. A newer SDK that bounds its own probe, or drops it, should
#: not fail a release.
PROBE_METHOD = "_resolve_host_metadata"

#: Set on the replacement so a second call is a no-op instead of wrapping the
#: wrapper, which would multiply the budget by the number of calls.
MARKER = "_bounded_probe_budget_seconds"


def bound(
    budget_seconds: float = DEFAULT_BUDGET_SECONDS,
    announce: Callable[[str], None] = print,
) -> bool:
    """Bound the discovery probe for every client built in this process.

    Returns whether a probe was found to bound. Says what it did on the way
    past, once, because a release that silently stopped waiting five minutes and
    a release that silently started waiting again look identical in the log.
    """

    from databricks.sdk.config import Config

    original = getattr(Config, PROBE_METHOD, None)
    if original is None:
        # Not a failure. This version of the SDK has no discovery probe to
        # bound, and the release proceeds exactly as it would have.
        announce(
            f"NOTE: databricks-sdk has no Config.{PROBE_METHOD}, so there is no "
            "host-metadata discovery probe to bound. Nothing was changed."
        )
        return False
    if getattr(original, MARKER, None) is not None:
        return True

    reported: list[str] = []

    def bounded(self) -> None:
        if all(getattr(self, field, None) for field in DISCOVERED_FIELDS):
            _report(
                reported,
                announce,
                "host metadata: probe SKIPPED, every field it resolves was already configured",
            )
            return

        inner = self._inner
        previously_set = {field: inner[field] for field in BUDGET_FIELDS if field in inner}
        for field, as_type in BUDGET_FIELDS.items():
            inner[field] = as_type(budget_seconds)
        started = time.monotonic()
        try:
            original(self)
        finally:
            # Put the budgets back BEFORE anything builds an ApiClient from this
            # config, which is what keeps real API calls on the SDK's own retry
            # policy rather than on a five-second one.
            for field in BUDGET_FIELDS:
                inner.pop(field, None)
            inner.update(previously_set)
            _report(
                reported,
                announce,
                f"host metadata: probe BOUNDED to {budget_seconds}s "
                f"(took {time.monotonic() - started:.1f}s; the SDK's own budget is 300s, "
                "and it falls back to the configured values either way)",
            )

    bounded.__name__ = PROBE_METHOD
    bounded.__doc__ = original.__doc__
    setattr(bounded, MARKER, budget_seconds)
    setattr(Config, PROBE_METHOD, bounded)
    return True


def _report(reported: list[str], announce: Callable[[str], None], message: str) -> None:
    """Say it once per process, not once per client.

    Logging a model builds several clients -- ours, and MLflow's own for
    tracking and for the registry -- and the same line five times reads as a
    problem rather than as a note.
    """

    if reported:
        return
    reported.append(message)
    announce(message)
