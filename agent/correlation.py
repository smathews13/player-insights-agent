"""The one id that names a question in the trace, as it is named everywhere else.

The app mints it before the request leaves the browser and sends it as
`custom_inputs.request_id`; `player-insights-agent/shared/correlation.ts` is the
other half of this contract and holds the reasoning for why the browser mints it
and why it is not the run ledger's primary key. This module's job is narrower:
put that id where MLflow can be SEARCHED by it, so a question the app logged can
be turned into the trace of the run that answered it.

WHY TAGS AND NOT ONLY SPAN ATTRIBUTES. An attribute is readable once you have
already found the span, which is the problem, not the solution: `search_traces`
filters on tags. A correlation id that only exists as an attribute joins nothing
-- an operator holding an id from a log line still has to open traces one at a
time until one matches. So the ids are set as trace tags, and repeated as
attributes on the orchestrator span for a reader who opens it directly.

WHAT THIS SIDE KNOWS AND THE APP SIDE DOES NOT. The release facts here are the
ones baked into the model artifact or resolved by the served entity: the build
the agent was logged from, and the warehouse and spaces its data calls bill
against. The app records the other half beside them in the run ledger -- release
id, bundle target, app name, workspace and serving endpoint (`releaseIdentity` in
server/lib/run-admission.ts). Neither side guesses the other's: an agent reading
`DATABRICKS_APP_NAME` out of a serving container would record whichever app was
deployed last, or nothing, and both read as fact.

NOTHING CALLER-SUPPLIED IS PRINTED OR STORED UNVALIDATED. `custom_inputs` is an
untrusted body. A trace tag is queryable text stored beside a run and a print is
a log line, so an unchecked value there can forge a line, or carry a question's
text into the one place that deliberately does not record questions. `usable`
holds both ids to the shape the app mints and drops anything else, which is why
`request_id` reaches a tag through this module rather than directly.
"""

from __future__ import annotations

import re
from contextvars import ContextVar
from typing import Any

#: What the app prefixes its ids with, so ours are distinguishable in a log line
#: that also carries platform ids. Kept identical to `CORRELATION_PREFIX` in
#: shared/correlation.ts.
CORRELATION_PREFIX = "req-"

#: The prefix, then a hyphenated lowercase UUID, and nothing else. The same
#: expression as `CORRELATION_SHAPE` on the app side, and strict for the same
#: reason: this value is printed and stored.
_SHAPE = re.compile(r"^req-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

#: The tag an operator searches by. Bare rather than dotted, because it is what
#: goes in `mlflow.search_traces(filter_string="tags.correlation_id = '...'")`
#: and a dotted key has to be backquoted there by everyone who ever uses it.
CORRELATION_TAG = "correlation_id"
#: The run ledger's primary key, so a Lakebase row leads to the trace and back.
#: Separate from the correlation id on purpose -- see shared/correlation.ts.
RUN_TAG = "run_id"

#: SQL attribution for the current request only. A ContextVar is required because
#: one serving process handles concurrent users; module-level ids would leak one
#: run's Query History tags onto another.
_CURRENT_QUERY_IDS: ContextVar[dict[str, str] | None] = ContextVar(
    "current_query_ids", default=None
)


def usable(value: Any) -> str:
    """The caller's id if it is one we will print, otherwise the empty string.

    Empty is ordinary rather than exceptional: the benchmark runner, a `curl`,
    and any app build older than this contract all send nothing. A request is
    never refused over it, because a question's answer does not depend on
    whether its id was well formed.
    """

    if not isinstance(value, str):
        return ""
    trimmed = value.strip()
    return trimmed if _SHAPE.match(trimmed) else ""


def activate_query_ids(required: Any) -> None:
    """Scope validated request/run ids to this turn's SQL statements."""

    recorded: dict[str, str] = {}
    request_id = usable(getattr(required, "request_id", ""))
    if request_id:
        recorded[CORRELATION_TAG] = request_id
    run_id = usable(getattr(required, "run_id", ""))
    if run_id:
        recorded[RUN_TAG] = run_id
    _CURRENT_QUERY_IDS.set(recorded)


def clear_query_ids() -> None:
    """Remove this turn's ids even when the generator exits early."""

    _CURRENT_QUERY_IDS.set(None)


def current_query_ids() -> dict[str, str]:
    """A copy of the current turn's validated ids, never shared mutable state."""

    return dict(_CURRENT_QUERY_IDS.get() or {})


def facts(required: Any, settings: Any = None) -> dict[str, str]:
    """The correlation and release facts for this turn, as strings.

    Absent values are OMITTED rather than written as empty strings. A tag whose
    value is "" reads as a measurement that came back blank; no tag at all reads
    as a version that did not record it, which is the truth for a request that
    sent no id and for a build logged before this existed.

    `required` is an `execution_identity.Requirement`, taken rather than the raw
    `custom_inputs` so there is one parser for the app's contract on this side of
    the wire. `settings` is the agent's `config.Settings`, and is optional
    because the two ids are worth recording even where settings are not to hand.
    """

    recorded: dict[str, str] = {}

    correlation = usable(getattr(required, "request_id", ""))
    if correlation:
        recorded[CORRELATION_TAG] = correlation
    run_id = usable(getattr(required, "run_id", ""))
    if run_id:
        recorded[RUN_TAG] = run_id

    # Which build of the agent answered. Baked at log time, so it is a property
    # of the served model version rather than of the container it runs in.
    build_sha = _text(getattr(settings, "build_sha", ""))
    if build_sha:
        recorded["release.build_sha"] = build_sha
    # A cost identifier, and the only one this side owns: every SQL statement the
    # run executes is billed to this warehouse, and a trace that does not name it
    # cannot be joined to `system.billing.usage`.
    warehouse = _text(getattr(settings, "warehouse_id", ""))
    if warehouse:
        recorded["deployment.warehouse_id"] = warehouse
    return recorded


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""
