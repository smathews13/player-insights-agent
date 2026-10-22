"""The agent's failure codes, and that they still agree with the app's.

The pin against `shared/failure-taxonomy.ts` is the point of this file. The two
sides are released separately and in either order, so a code renamed on one side
is a value that crosses the wire and matches nothing, which shows up as a run
with no recorded reason rather than as an error.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import evidence
import failures

SHARED = Path(__file__).parents[2] / "player-insights-agent" / "shared"
TAXONOMY = SHARED / "failure-taxonomy.ts"


def _shared_codes() -> list[str]:
    if not SHARED.is_dir():
        pytest.skip("the app half of the repository is not present in this checkout")
    assert TAXONOMY.is_file(), (
        f"{TAXONOMY} is the authority for these codes and is missing. If it moved, this "
        "pin has to move with it rather than be deleted: an unpinned taxonomy is two "
        "taxonomies."
    )
    body = re.search(
        r"export const FAILURE_CODES = \[(.*?)\] as const;", TAXONOMY.read_text(), re.DOTALL
    )
    assert body, "FAILURE_CODES is not declared the way this pin reads it"
    return re.findall(r"'([A-Z_]+)'", body.group(1))


def test_the_terminal_codes_are_the_apps_terminal_codes_exactly():
    """Every shared code is claimed by exactly one side, in the shared file's order.

    ORDER INCLUDED, which is why this compares a filtered list rather than sets.
    The two lists are read side by side when a code is added, and a set comparison
    would let them drift into different orders, which is how a reviewer stops
    noticing that they are the same list.

    The filter is the app-only exemption and it is what keeps the pin honest in
    both directions. A shared code that belongs to the agent and was forgotten in
    `failures.py` is in neither set, so it survives the filter and fails here. A
    code that is deliberately the app's own is declared as such and permitted.
    """

    assert list(failures.TERMINAL_CODES) == [
        code for code in _shared_codes() if code not in failures.APP_ONLY_CODES
    ], (
        "a code in the shared taxonomy is missing from the agent. Add it to "
        "TERMINAL_CODES if a run the orchestrator serves could end on it, or to "
        "APP_ONLY_CODES if the app decides it before the agent is invoked."
    )


def test_the_app_only_codes_are_shared_codes_the_agent_cannot_emit():
    """The exemption is only sound while both halves of it hold.

    In the shared file, or it exempts nothing and is stale wording about a code
    that no longer exists. Out of `AGENT_CODES`, because a code the agent CAN put
    on a run and which is exempted from the pin above is the drift the pin exists
    to catch, wearing the exemption as cover.
    """

    shared = _shared_codes()
    for code in failures.APP_ONLY_CODES:
        assert code in shared, (
            f"{code} is exempted from the pin as the app's own and is not in the shared "
            "taxonomy at all. If it was removed there, remove it here."
        )
        assert code not in failures.AGENT_CODES, (
            f"{code} is declared app-only and also listed as a code the agent may emit. "
            "One of the two is wrong."
        )


def test_a_returned_schema_refusal_reports_the_returned_schema_code():
    """The later moment has its own code, and this is where that matters.

    An operator reading COLUMN_POLICY_VIOLATION assumes the STATEMENT asked for a
    protected column and was refused before running. Here the statement looked
    clean, ran, and the warehouse returned a result containing a protected field
    which was then discarded unread. Same policy, different moment, different
    remedy, and now a different code, so the two rates do not cancel out.
    """

    gateway = evidence.EvidenceGateway(["c.s.players"])
    admitted = gateway.admit_statement("run_sql", "SELECT * FROM c.s.players")

    verdict = gateway.admit_result_schema(admitted, ["player_id", "email"])

    assert verdict.outcome == evidence.REFUSED
    assert verdict.code == failures.RESULT_COLUMN_POLICY_VIOLATION
    assert verdict.code != failures.COLUMN_POLICY_VIOLATION
    # Terminal in its own right: the app has a sentence for it, so it reaches a
    # reader as itself rather than through NO_VALID_EVIDENCE.
    assert failures.terminal_code(verdict.code) == failures.RESULT_COLUMN_POLICY_VIOLATION


def test_no_candidate_level_code_pretends_to_be_a_terminal_one():
    # The shared file renders terminal codes to users. A code invented on the
    # agent side that appeared in that list would be one the app has no message
    # for, and the user would read the code.
    for code in failures.EVIDENCE_REFUSAL_CODES:
        assert code not in failures.TERMINAL_CODES
        assert code not in _shared_codes()


def test_every_candidate_code_maps_to_a_terminal_one_the_app_can_render():
    for code in failures.EVIDENCE_REFUSAL_CODES:
        assert failures.terminal_code(code) in failures.TERMINAL_CODES


def test_a_terminal_code_maps_to_itself():
    for code in failures.TERMINAL_CODES:
        assert failures.terminal_code(code) == code


def test_a_code_this_build_does_not_know_is_not_reported_as_a_success():
    # Fails closed on the field that matters. A code from a newer release reaching
    # an older reader must not be presented as a run that produced an answer.
    assert failures.terminal_code("SOMETHING_NEWER") == failures.NO_VALID_EVIDENCE
    assert failures.terminal_code("") == failures.NO_VALID_EVIDENCE


def test_nothing_may_be_rerouted_automatically():
    # The behaviour Improvement 3 removes. Not "no governance code": no code at
    # all, because an automatic reroute produces a figure from a surface nobody
    # asked for and a trace that records a success.
    for code in failures.AGENT_CODES:
        assert not failures.may_automatically_reroute(code), code


def test_the_app_and_the_agent_agree_that_nothing_reroutes_by_itself():
    # Both sides state the same rule about the same codes, so a row added to one
    # with the wrong posture is caught here rather than in production.
    _shared_codes()
    seen = 0
    for block in re.finditer(r"\n  ([A-Z_]+): \{(.*?)\n  \},", TAXONOMY.read_text(), re.DOTALL):
        code, body = block.group(1), block.group(2)
        allowed = "mayRerouteOrReidentify: true" in body
        assert allowed == failures.may_automatically_reroute(code), (
            f"{code}: the app says automatic rerouting is "
            f"{'allowed' if allowed else 'forbidden'} and the agent disagrees"
        )
        seen += 1
    # A regex that matched nothing would make the assertions above vacuous, and a
    # check that passes by reading no rows is the failure mode this repository has
    # already been bitten by three times. Counted against both sets, because the
    # rule holds for every row in the shared file and not only for the rows the
    # agent can reach: `may_automatically_reroute` answers False for an app-only
    # code too, and the loop above is what proves the app agrees.
    assert seen == len(failures.TERMINAL_CODES) + len(failures.APP_ONLY_CODES)


def test_no_governance_or_authorization_refusal_permits_a_later_route_attempt():
    # A governance refusal is about the ANSWER rather than about the tool that
    # was asked for it, so a second surface asked the same question is not a
    # second attempt: it is the same request with the guard taken off.
    for code in (
        failures.IDENTITY_REQUIRED,
        failures.IDENTITY_MISMATCH,
        failures.USER_AUTH_REJECTED,
        failures.USER_NOT_AUTHORIZED,
        failures.ASSET_NOT_IN_MANIFEST,
        failures.COLUMN_POLICY_VIOLATION,
        # The same policy at the later moment is the same restriction on the
        # answer: rows that were discarded unread are not readable by asking a
        # second surface for them.
        failures.RESULT_COLUMN_POLICY_VIOLATION,
        failures.OUTPUT_SCHEMA_VIOLATION,
        failures.GENIE_UNATTRIBUTABLE,
    ):
        assert not failures.may_request_another_route(code), code


def test_an_unknown_code_permits_no_later_route_attempt_either():
    assert not failures.may_request_another_route("SOMETHING_NEWER")
    assert not failures.may_request_another_route("")


def test_an_outage_is_not_a_refusal_and_the_model_may_ask_for_another_route():
    # The distinction the product depends on. A dependency that did not answer
    # is not a control that refused, and treating the two the same way either
    # routes around a refusal or gives up on a genuine outage.
    assert failures.may_request_another_route(failures.DEPENDENCY_UNAVAILABLE)


def test_an_identity_mode_that_could_not_be_read_is_its_own_answer():
    # Not a default to be quietly upgraded to the configured mode: the SDK falls
    # back to the default credential chain without reporting it, so a run that
    # could not read its identity has to say unknown.
    assert failures.IDENTITY_UNKNOWN in failures.IDENTITY_MODES
    assert failures.IDENTITY_UNKNOWN != failures.IDENTITY_SERVICE_PRINCIPAL


class TestFailureCause:
    @pytest.mark.parametrize(
        ("reason", "expected"),
        [
            ("SqlDenied: SQL CANCELED: still running", ("cancelled", "")),
            (
                "SqlDenied: SQL FAILED: [UNRESOLVED_COLUMN.WITH_SUGGESTION] x",
                ("rejected", "UNRESOLVED_COLUMN"),
            ),
            (
                "The gateway refused this request (REQUEST_LIMIT_EXCEEDED: nope)",
                ("rejected", "REQUEST_LIMIT_EXCEEDED"),
            ),
            ("TimeoutError: waited", ("timed out", "")),
            ("WarehouseStarting: coming up", ("timed out", "")),
            ("RuntimeError: the call timed out", ("timed out", "")),
            ("RuntimeError: boom", ("failed", "")),
        ],
    )
    def test_cause(self, reason, expected):
        assert failures.failure_cause(reason) == expected

    def test_slow_read_whatever_the_prefix(self):
        assert failures.is_slow_sql_read("Anything: SQL PENDING: x")
        assert failures.is_slow_sql_read("SQL RUNNING: x")
        assert not failures.is_slow_sql_read("SQL FAILED: [X]")
