"""The substitution nobody could see, and the disclosure that replaces it.

The behaviour under test is easy to state and was easy to miss: when a Genie
space failed, the loop invited the model to "try a different surface", and the
SQL answer that followed was indistinguishable from one the run had planned. The
figures were real and governed. The claim implied about them, that they came from
the curated semantic layer, was not.

These tests are mostly about what gets RECORDED and what the caveat says, because
that is the whole control. The route is still available to the model; what has
changed is that taking it is visible.
"""

import route_disclosure
from route_disclosure import RouteLedger, failure_guidance, route_of

# ---------------------------------------------------------------------------
# Which tools can substitute for which
# ---------------------------------------------------------------------------


def test_only_value_producing_tools_count_as_routes():
    assert route_of("data_genie") == "genie"
    assert route_of("genie_mcp") == "genie"
    assert route_of("dictionary_genie") == "genie"
    assert route_of("run_sql") == "sql"
    assert route_of("query_named_table") == "sql"


def test_reading_a_schema_after_an_outage_is_not_a_substitution():
    """`describe_table` reads METADATA, so a run that calls it has substituted nothing.

    Counted, this would fire the disclosure on nearly every degraded run, because
    looking up a schema is exactly what a model does when its first route fails.
    A caveat that appears on runs it does not describe is one readers learn to
    skip, which costs the runs it does describe.
    """

    assert route_of("describe_table") == ""
    assert route_of("list_data_assets") == ""
    assert route_of("request_clarification") == ""

    ledger = RouteLedger()
    ledger.record_failure("data_genie", "timeout")

    assert ledger.record_evidence("describe_table") is None
    assert ledger.substituted is False
    assert ledger.caveat() == ""


# ---------------------------------------------------------------------------
# The link
#
# "Linked to the failed route" is the requirement. A record that says a run had
# an outage and separately had a SQL result does not say one stood in for the
# other.
# ---------------------------------------------------------------------------


def test_sql_after_a_genie_outage_is_linked_to_the_route_it_replaced():
    ledger = RouteLedger()
    failure = ledger.record_failure("data_genie", "Genie did not respond in time")

    substitution = ledger.record_evidence("run_sql")

    assert substitution is not None
    assert substitution.failure is failure
    record = substitution.as_record()
    assert record["failed_tool"] == "data_genie"
    assert record["replacement_tool"] == "run_sql"
    assert record["failed_route_id"] == failure.failure_id, (
        "the id is the link: two Genie failures in one run are otherwise the same entry, and "
        "which attempt this SQL stood in for is the question a reader has"
    )


def test_sql_after_managed_genie_mcp_failure_is_disclosed():
    ledger = RouteLedger()
    failure = ledger.record_failure("genie_mcp", "managed MCP unavailable")

    substitution = ledger.record_evidence("run_sql")

    assert substitution is not None
    assert substitution.failure is failure
    assert substitution.as_record()["failed_tool"] == "genie_mcp"
    assert "direct SQL over the warehouse was used instead" in ledger.caveat()


def test_two_failures_link_to_the_route_the_run_set_out_to_use():
    """Oldest unmatched failure, not newest.

    Both are defensible; the oldest is what a reader means. The answer's
    provenance is a claim about where the analysis came from, not about the last
    thing that happened to break before it worked.
    """

    ledger = RouteLedger()
    first = ledger.record_failure("data_genie", "timeout")
    ledger.record_failure("dictionary_genie", "also down")

    substitution = ledger.record_evidence("run_sql")

    assert substitution is not None
    assert substitution.failure is first


def test_one_failure_is_not_credited_to_two_substitutions():
    """Otherwise a run with two SQL calls reports two outages it did not have."""

    ledger = RouteLedger()
    ledger.record_failure("data_genie", "timeout")

    assert ledger.record_evidence("run_sql") is not None
    assert ledger.record_evidence("query_named_table") is None
    assert len(ledger.substitutions) == 1


def test_sql_that_was_never_a_substitute_is_not_recorded_as_one():
    """A run that simply used SQL has nothing to disclose, and must say nothing."""

    ledger = RouteLedger()

    assert ledger.record_evidence("run_sql") is None
    assert ledger.substituted is False
    assert ledger.caveat() == ""


def test_a_second_genie_call_after_a_genie_failure_is_not_a_substitution():
    """Same route, so nothing changed surfaces: this is a retry, and retries are
    already covered by the degraded caveat. Calling it a substitution would claim
    the answer left the semantic layer when it did not.
    """

    ledger = RouteLedger()
    ledger.record_failure("data_genie", "timeout")

    assert ledger.record_evidence("dictionary_genie") is None
    assert ledger.substituted is False


# ---------------------------------------------------------------------------
# A refusal is not an outage
#
# The one confusion in this module that would be actively harmful.
# ---------------------------------------------------------------------------


def test_a_refusal_is_not_recorded_here_and_the_module_says_why():
    """A refusal means the answer is NOT ALLOWED, so substituting is the defect.

    Enforced by the caller, which routes refusals to a different handler, and
    asserted here as the contract this ledger is written against: if a refusal
    ever reaches `record_failure`, the ledger starts describing a control being
    routed around in the language of ordinary degradation, and the caveat it
    produces would tell the reader the figures are fine.
    """

    assert "REFUSAL is not recorded here" in route_disclosure.RouteLedger.record_failure.__doc__


# ---------------------------------------------------------------------------
# What the reader is told
# ---------------------------------------------------------------------------


def test_the_caveat_names_both_routes_and_does_not_overclaim_the_damage():
    ledger = RouteLedger()
    ledger.record_failure("data_genie", "timeout")
    ledger.record_evidence("run_sql")

    caveat = ledger.caveat()

    assert "did not respond" in caveat
    assert "direct SQL over the warehouse" in caveat
    assert "governed read either way" in caveat, (
        "the figures ARE governed, and saying otherwise would be a false caveat that trains "
        "readers to discount the true ones"
    )
    assert "curated" in caveat, "what is actually lost is the semantic layer's definitions"


def test_the_caveat_does_not_repeat_itself_when_several_calls_substitute():
    ledger = RouteLedger()
    ledger.record_failure("data_genie", "timeout")
    ledger.record_failure("data_genie", "timeout again")
    ledger.record_evidence("run_sql")
    ledger.record_evidence("query_named_table")

    caveat = ledger.caveat()

    assert caveat.count("was tried first") == 1, "one substitution pair, said once"


# ---------------------------------------------------------------------------
# What the MODEL is told, which is where the old fallback lived
# ---------------------------------------------------------------------------


def test_the_failure_text_no_longer_invites_a_silent_reroute():
    guidance = failure_guidance("data_genie", "Genie did not respond in time")

    assert "try a different surface" not in guidance, "the clause that was the fallback"
    assert "its own tool call" in guidance, "a reroute is now something to request, not assume"
    assert "spends a step" in guidance, "counted against the budget, and the model is told so"
    assert "will disclose" in guidance, (
        "a model that knows the substitution is already recorded has no reason to present it "
        "as the original plan, which is cheaper than forbidding it"
    )


def test_the_failure_text_does_not_forbid_the_reroute_outright():
    """Deliberate, and the most likely thing for a later change to reverse.

    Refusing a substitution takes a working answer away from a stakeholder
    mid-demo over a Genie outage nobody in the room can fix. The disclosure is
    the control; the prohibition would be a second, harsher one that buys little
    once the first is honest.
    """

    guidance = failure_guidance("data_genie", "timeout")

    assert "If you judge another route worth trying" in guidance
    assert "outage, not a refusal" in guidance


def test_a_metadata_tool_failing_still_just_asks_for_the_failure_to_be_reported():
    guidance = failure_guidance("describe_table", "table not found")

    assert "Report this rather than working around it" in guidance
    assert "tool call" not in guidance, "there is no route to substitute, so no terms to state"
