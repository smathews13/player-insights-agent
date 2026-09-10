"""What happens after a data route fails, and what the answer has to say about it.

THE FALLBACK THIS REPLACES WAS ONE CLAUSE OF PROMPT TEXT. When a tool raised, the
loop told the model "report this rather than working around it, or try a different
surface if one applies", and the second half undid the first. A Genie space that
timed out produced a confident answer over the warehouse instead, with nothing
tying the SQL to the route it stood in for: the substitution was invisible in the
trace, absent from the caveats, and indistinguishable in the answer from a run
that had chosen SQL from the start.

Nothing about that was a bug in the sense of a wrong branch. The model did what
it was asked, the SQL was governed, the figures were real. What was missing is
that a reader cannot tell a curated, governed Genie answer from a substitute the
agent improvised when its first choice went down, and those are different claims
about how much the number can be trusted.

So the route is not chosen for the model any more. A later attempt on another
surface is a SEPARATE tool call the model has to ask for, which means it costs a
step from the same budget every other call costs, it is linked here to the route
it followed, and both facts reach the answer's caveats. The model may still make
that call. It may not make it silently.

This module holds the ledger and the words, and deliberately holds no policy
about whether a substitution is allowed: refusing one outright would take a
working answer away from a stakeholder mid-demo over a Genie outage nobody in the
room can fix, which is a worse failure than a disclosed substitution. The
disclosure is the control.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

#: Which route a tool belongs to, for the only question this module asks: did the
#: evidence come from somewhere other than where the run first tried?
#:
#: `describe_table` and `list_data_assets` are absent on purpose. They read
#: METADATA, not values, and a run that reads a schema after a Genie timeout has
#: not substituted anything: it is finding out what to ask next. Counting them
#: would fire this disclosure on nearly every degraded run and teach a reader to
#: skip it.
ROUTE_OF_TOOL = {
    "data_genie": "genie",
    "genie_mcp": "genie",
    "dictionary_genie": "genie",
    "run_sql": "sql",
    "query_named_table": "sql",
}

#: How each route is named to a reader, who has no reason to know a tool name.
ROUTE_NAMES = {
    "genie": "the governed Genie space",
    "sql": "direct SQL over the warehouse",
}


def route_of(tool: str) -> str:
    """The route a tool reads through, or "" for a tool that produces no values."""

    return ROUTE_OF_TOOL.get(tool, "")


@dataclass(frozen=True)
class RouteFailure:
    """One data route that did not produce evidence, and why.

    Carries an id because a substitution has to be LINKED to the attempt it
    followed rather than merely recorded near it. Two Genie failures in one run
    are otherwise indistinguishable in the record, and "which attempt did this
    SQL stand in for" is the question the link exists to answer.
    """

    tool: str
    route: str
    reason: str
    failure_id: str = field(default_factory=lambda: f"route-{uuid.uuid4().hex[:12]}")


@dataclass(frozen=True)
class Substitution:
    """Evidence that came from a route the run turned to after another failed."""

    failure: RouteFailure
    tool: str
    route: str

    def as_record(self) -> dict[str, str]:
        return {
            "failed_tool": self.failure.tool,
            "failed_route": self.failure.route,
            "failed_route_id": self.failure.failure_id,
            "reason": self.failure.reason[:300],
            "replacement_tool": self.tool,
            "replacement_route": self.route,
        }


class RouteLedger:
    """Per-run record of failed data routes and what the run used instead.

    Per-run for the same reason `RunLog` is: Model Serving handles requests
    concurrently in one container, so anything accumulated on the agent would
    disclose one stakeholder's outage in another stakeholder's answer.
    """

    def __init__(self) -> None:
        self.failures: list[RouteFailure] = []
        self.substitutions: list[Substitution] = []

    def record_failure(self, tool: str, reason: str) -> RouteFailure | None:
        """Note that a data route produced nothing. Returns None for other tools.

        Operational failures only. A REFUSAL is not recorded here and must not be:
        a refusal means the answer is not allowed, so "the run used another route
        instead" is precisely the behaviour the refusal text forbids, and treating
        the two alike would make this ledger a record of the control being routed
        around while reading as ordinary degradation.
        """

        route = route_of(tool)
        if not route:
            return None
        failure = RouteFailure(tool=tool, route=route, reason=reason)
        self.failures.append(failure)
        return failure

    def record_evidence(self, tool: str) -> Substitution | None:
        """Note that a data route produced evidence, and link it if it stood in.

        Linked to the OLDEST unmatched failure on another route, not the newest.
        Both are defensible and the oldest is the one a reader means: it is the
        route the run set out to use, and the answer's provenance is a claim about
        where the analysis came from rather than about the last thing that broke.
        """

        route = route_of(tool)
        if not route:
            return None
        matched = {substitution.failure.failure_id for substitution in self.substitutions}
        for failure in self.failures:
            if failure.route != route and failure.failure_id not in matched:
                substitution = Substitution(failure=failure, tool=tool, route=route)
                self.substitutions.append(substitution)
                return substitution
        return None

    @property
    def substituted(self) -> bool:
        return bool(self.substitutions)

    def as_records(self) -> list[dict[str, str]]:
        return [substitution.as_record() for substitution in self.substitutions]

    def caveat(self) -> str:
        """The disclosure, or "" when the run substituted nothing.

        Written as a statement about the ANSWER rather than about the outage,
        because the reader's question is not "what broke" but "how much should I
        trust this figure". The degraded caveat already reports the outage, and
        that one does not say the analysis changed surfaces underneath it.
        """

        if not self.substitutions:
            return ""
        routes = []
        for substitution in self.substitutions:
            failed = ROUTE_NAMES.get(substitution.failure.route, substitution.failure.route)
            used = ROUTE_NAMES.get(substitution.route, substitution.route)
            pair = f"{failed} was tried first and did not respond, so {used} was used instead"
            if pair not in routes:
                routes.append(pair)
        return (
            "This answer did not come from the route the analysis started with: "
            + "; ".join(routes)
            + ". The figures are from a governed read either way, but they were not produced "
            "by the curated semantic layer, so treat any definition implied by them as this "
            "agent's reading rather than the business's agreed one."
        )


def failure_guidance(tool: str, reason: str) -> str:
    """What the model is told when a tool fails, in place of the old invitation.

    The difference from "or try a different surface if one applies" is that the
    terms are stated. The model is not forbidden from asking for another route,
    because forbidding it costs a stakeholder their answer over an outage they
    cannot fix; it is told that asking is a separate call, that the call is
    counted, and that the substitution will be disclosed whether or not the
    answer mentions it. A model that knows the substitution is already recorded
    has no reason to present it as the original plan.
    """

    route = route_of(tool)
    if not route:
        # A metadata or clarification tool. There is nothing to substitute, so
        # the old text is right for it: the run wants the failure reported.
        return f"ERROR: {tool} failed: {reason}. Report this rather than working around it."
    return (
        f"ERROR: {tool} failed: {reason}. This is an outage, not a refusal, so the data may "
        "well be readable another way. Do NOT silently answer from another surface as though "
        "you had planned to. If you judge another route worth trying, request it as its own "
        "tool call: it spends a step from the same budget, it is recorded as standing in for "
        "this one, and the answer will disclose that the analysis changed surfaces. Say in "
        "your answer which surface the figures came from, and do not describe a direct SQL "
        "result as governed or curated."
    )
