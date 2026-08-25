"""The evidence gateway: what it admits, what it refuses, and that SQL is unchanged.

The parity tests are the ones that matter first. Routing direct SQL through a new
object is only safe if the object decides exactly what the old path decided, and
"exactly" here means the same outcome, the same tables, and the same sentence,
because the existing suite and the model's own next move both depend on the words.
"""

from __future__ import annotations

import dataclasses

import pytest

import evidence
import failures
import sql_policy

READABLE = ("cat.sch.orders", "cat.sch.players", "cat.sch.titles")


def gateway(**kwargs) -> evidence.EvidenceGateway:
    kwargs.setdefault("identity_mode", failures.IDENTITY_SIGNED_IN_USER)
    return evidence.EvidenceGateway(READABLE, **kwargs)


# ---------------------------------------------------------------------------
# Parity with the SQL path the gateway replaces
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT count(*) FROM cat.sch.orders",
        "SELECT title, count(DISTINCT platformid_accountid) FROM cat.sch.orders GROUP BY title",
        "WITH x AS (SELECT * FROM cat.sch.titles) SELECT count(*) FROM x",
        "SELECT * FROM cat.sch.orders JOIN cat.sch.titles USING (title_id)",
        "SELECT FROM WHERE ((",
        "DELETE FROM cat.sch.orders",
        "SELECT 1; SELECT 2",
        "SELECT 1",
        "SELECT ROUND(452724 / 330477825.0 * 100, 4) AS null_pct",
        "SELECT * FROM orders",
        "SELECT * FROM other.sch.secrets",
        "SELECT email FROM cat.sch.players",
        "SELECT crm_customer_ref FROM cat.sch.players",
        "SELECT max(email) FROM cat.sch.players",
        "SELECT count(*) FROM cat.sch.orders NATURAL JOIN cat.sch.players",
        "SELECT * FROM cat.sch.players LATERAL VIEW explode(array(email)) t AS e",
    ],
)
def test_the_gateway_decides_exactly_what_validate_sql_decided(sql):
    # Both halves compared: the tables on an acceptance and the SENTENCE on a
    # refusal. The messages are the policy's own words, one of them deliberately
    # saying COUNT rather than "aggregate" because recommending an aggregate
    # hands back the bypass, so a gateway that paraphrased would be a second
    # policy wearing the first one's name.
    try:
        expected = sql_policy.validate_sql(sql, READABLE)
    except sql_policy.SqlRefused as refusal:
        verdict = gateway().admit_statement("run_sql", sql)
        assert verdict.outcome == evidence.REFUSED
        assert verdict.reason == str(refusal)
        assert verdict.code == refusal.code
        assert verdict.sources == ()
        return
    verdict = gateway().admit_statement("run_sql", sql)
    assert verdict.outcome == evidence.ACCEPTED
    assert list(verdict.sources) == expected
    assert list(verdict.candidate.referenced_assets) == expected


def test_a_refusal_hands_back_the_original_exception_to_re_raise():
    # Not a new exception built from the verdict. The caller re-raises this
    # object, which is why every existing assertion on the guard's messages
    # still holds with a gateway in the path.
    verdict = gateway().admit_statement("run_sql", "SELECT email FROM cat.sch.players")
    assert isinstance(verdict.refusal, sql_policy.SqlRefused)
    assert verdict.refusal.code == failures.COLUMN_POLICY_VIOLATION
    with pytest.raises(sql_policy.SqlRefused, match="COUNT them instead"):
        raise verdict.refusal


@pytest.mark.parametrize(
    "columns",
    [
        ["title", "players"],
        ["email"],
        ["title", "crm_customer_ref"],
        ["PLAYER_ID"],
        ["`partner_player_ref`"],
    ],
)
def test_the_result_schema_check_decides_what_it_decided_before(columns):
    admitted = gateway().admit_statement("run_sql", "SELECT * FROM cat.sch.players")
    verdict = gateway().admit_result_schema(admitted, columns)
    leaked = sql_policy.restricted_output_columns(columns)
    if leaked:
        assert verdict.outcome == evidence.REFUSED
        # The returned-schema code, not the parse-time one: the statement was
        # admitted and ran, and only the result gave the protected field away.
        assert verdict.code == failures.RESULT_COLUMN_POLICY_VIOLATION
        assert "Refused after running: this query returns" in verdict.reason
        assert ", ".join(leaked) in verdict.reason
    else:
        assert verdict.accepted


def test_the_schema_refusal_speaks_to_whoever_can_act_on_it():
    # Two audiences, two sentences, both predating the gateway. The model that
    # wrote the statement can name its columns; the model that asked a Genie
    # space cannot, so it is told to ask for an aggregate instead.
    sql_verdict = gateway().admit_statement("run_sql", "SELECT * FROM cat.sch.players")
    refused_sql = gateway().admit_result_schema(sql_verdict, ["email"])
    assert "Name the columns you need" in refused_sql.reason

    genie_verdict = gateway().admit_genie_query(
        "data_genie", "SELECT * FROM cat.sch.players"
    )
    refused_genie = gateway().admit_result_schema(genie_verdict, ["email"])
    assert "Ask for the question in aggregate" in refused_genie.reason


def test_the_schema_is_recorded_against_the_same_evidence_as_the_statement():
    # One read must not look like two. The post-execution check extends the
    # candidate rather than making a new one.
    admitted = gateway().admit_statement("run_sql", "SELECT * FROM cat.sch.orders")
    checked = gateway().admit_result_schema(admitted, ["title", "players"])
    assert checked.candidate.evidence_id == admitted.candidate.evidence_id
    assert checked.candidate.field_names == ("title", "players")
    assert checked.sources == admitted.sources


# ---------------------------------------------------------------------------
# Genie
# ---------------------------------------------------------------------------


def test_equivalent_sql_and_genie_evidence_get_equivalent_decisions():
    # The definition of the gateway working. The same statement, arriving by two
    # routes, is judged the same way.
    for sql in (
        "SELECT title, count(*) FROM cat.sch.orders GROUP BY title",
        "SELECT count(DISTINCT platformid_accountid) FROM cat.sch.players",
    ):
        assert gateway().admit_statement("run_sql", sql).accepted
        assert gateway().admit_genie_query("data_genie", sql).accepted

    for sql in (
        "SELECT email FROM cat.sch.players",
        "SELECT crm_customer_ref FROM cat.sch.players",
    ):
        assert gateway().admit_statement("run_sql", sql).outcome == evidence.REFUSED
        with pytest.raises(sql_policy.SqlRefused):
            gateway().admit_genie_query("data_genie", sql)


def test_unparseable_genie_sql_contributes_nothing():
    # The change this workstream makes. Before, this came back with no tables and
    # an answer marked "sources incomplete", and a reader told the sources are
    # incomplete still reads the number.
    verdict = gateway().admit_genie_query("data_genie", "SELCT wat FROM (((")
    assert verdict.outcome == evidence.REFUSED
    assert verdict.code == failures.GENIE_UNATTRIBUTABLE
    assert verdict.sources == ()
    assert not verdict.may_support_a_figure


def test_a_query_attachment_that_exposed_no_sql_is_not_evidence():
    verdict = gateway().admit_genie_query("data_genie", "")
    assert verdict.outcome == evidence.REFUSED
    assert verdict.code == failures.GENIE_UNATTRIBUTABLE


def test_sql_that_parses_but_names_no_table_is_not_evidence():
    verdict = gateway().admit_genie_query("data_genie", "SELECT 1")
    assert verdict.outcome == evidence.REFUSED
    assert verdict.code == failures.GENIE_UNATTRIBUTABLE


def test_a_table_named_only_inside_a_literal_is_not_a_source():
    verdict = gateway().admit_genie_query(
        "data_genie", "SELECT 'from cat.sch.fake' AS note FROM cat.sch.orders"
    )
    assert verdict.accepted
    assert verdict.sources == ("cat.sch.orders",)


def test_visualization_only_output_cannot_create_a_figure():
    # The case that is easiest to argue away, because the numbers in a Genie
    # chart are real. They are also untraceable, and an answer nobody can check
    # is what this product is built not to produce.
    verdict = gateway().admit_genie_visualization("data_genie")
    assert verdict.outcome == evidence.REFUSED
    assert verdict.code == failures.GENIE_UNATTRIBUTABLE
    assert not verdict.may_support_a_figure
    assert verdict.sources == ()


def test_a_certified_metric_is_the_one_thing_that_replaces_a_statement():
    # Has to be a name the manifest declares. An id nobody granted is a promise
    # rather than verifiable attribution, which is the point of allowing this at
    # all: see the unverified case below.
    verdict = gateway().admit_genie_visualization("data_genie", metric_ids=("cat.sch.orders",))
    assert verdict.accepted
    assert verdict.may_support_a_figure
    assert verdict.sources == ("cat.sch.orders",)


def test_a_metric_id_nobody_declared_attributes_nothing():
    """The hole this closed, and the reason it stayed open.

    There is no metric layer, so this branch is unreachable in the running product
    and every caller is a test. Until now any non-empty list of strings attributed
    a chart, which made the one sanctioned exception to "figures need a source" a
    promise rather than a check.
    """

    verdict = gateway().admit_genie_visualization(
        "data_genie", metric_ids=("metrics.player.active_players",)
    )

    assert verdict.outcome == evidence.REFUSED
    assert verdict.code == failures.GENIE_UNATTRIBUTABLE
    assert verdict.sources == ()
    assert "not a governed metric this release declares" in verdict.reason, (
        "a distinct reason from a chart with nothing behind it, so nobody debugs the Genie "
        "space when the finding is about the manifest"
    )


def test_a_half_qualified_metric_name_is_not_good_enough():
    """Same rule a table reference gets: a source the reader cannot look up is not
    a source. A bare name also cannot be checked against the manifest at all.
    """

    for claimed in ("orders", "sch.orders", "cat.sch.orders.extra", ""):
        verdict = gateway().admit_genie_visualization("data_genie", metric_ids=(claimed,))
        assert verdict.outcome == evidence.REFUSED, f"{claimed!r} must not attribute a chart"


def test_the_declared_metric_name_is_matched_without_regard_to_case():
    # Unity Catalog names are case-insensitive, so a correctly declared metric
    # written in a different case is the same object and refusing it would be a
    # bug wearing a governance costume.
    verdict = gateway().admit_genie_visualization("data_genie", metric_ids=("CAT.SCH.Orders",))

    assert verdict.accepted
    assert verdict.may_support_a_figure


def test_one_good_metric_among_several_attributes_only_itself():
    verdict = gateway().admit_genie_visualization(
        "data_genie", metric_ids=("cat.sch.orders", "metrics.invented.thing")
    )

    assert verdict.accepted
    assert verdict.sources == ("cat.sch.orders",), (
        "the undeclared one contributes no source, so the Sources block cannot show a name "
        "that resolves to nothing"
    )


def test_a_definition_is_accepted_and_is_still_not_a_figure():
    # Holding the dictionary space to the value-bearing rule would refuse it
    # entirely, and accepting its prose as a source for a number would let a
    # takeaway put a figure next to a definition.
    verdict = gateway().admit_definition("dictionary_genie", has_text=True)
    assert verdict.accepted
    assert not verdict.may_support_a_figure


def test_a_dictionary_space_that_said_nothing_is_a_failure_not_a_refusal():
    verdict = gateway().admit_definition("dictionary_genie", has_text=False)
    assert verdict.outcome == evidence.FAILED
    assert verdict.code == failures.DEPENDENCY_UNAVAILABLE


# ---------------------------------------------------------------------------
# Definitions and figures, judged apart
#
# The attribution rule is about NUMBERS, and it was being applied to the
# dictionary space's ordinary behaviour. Asked what a field means, the live space
# answers with a literal SELECT when nothing documents that field: parseable,
# naming no table, because the absence of a row is what it is reporting. That was
# refused as unattributable figures, so a correct answer was thrown away on every
# run that hit it.
#
# The pairs below are the whole distinction. The SAME statement is a definition on
# the dictionary route and a refused figure on the data route, so the tests are
# written together: neither is safe to read alone.
# ---------------------------------------------------------------------------

#: What the live dictionary space returned for a field nothing documents, taken
#: from a real call and shortened only where it named the demo's own catalog.
DEFINITION_WITHOUT_A_TABLE = (
    "SELECT 'The field launch_campaign_sessions is not documented in the "
    "data_dictionary table.' AS message"
)


def test_a_definition_with_no_table_behind_it_is_admitted():
    verdict = gateway().admit_definition_query(
        "dictionary_genie", DEFINITION_WITHOUT_A_TABLE, has_definition_text=True
    )

    assert verdict.accepted
    assert verdict.candidate.payload_type == evidence.PAYLOAD_DEFINITION
    assert verdict.sources == (), (
        "admitted is not the same as attributed: it read nothing, so it cites nothing"
    )


def test_the_same_statement_asked_for_figures_is_still_refused():
    """The property that must not regress, on the identical statement.

    If this ever passes, the fix stopped being a distinction and became a hole:
    the dictionary route would have taught the gateway to accept figures nobody
    can trace.
    """

    verdict = gateway().admit_genie_query("data_genie", DEFINITION_WITHOUT_A_TABLE)

    assert verdict.outcome == evidence.REFUSED
    assert verdict.code == failures.GENIE_UNATTRIBUTABLE
    assert verdict.sources == ()
    assert "names no table" in verdict.reason


@pytest.mark.parametrize(
    "sql",
    [
        "",
        "SELCT wat FROM (((",
        "SELECT 1",
        DEFINITION_WITHOUT_A_TABLE,
    ],
)
def test_no_figure_is_ever_attributed_by_a_statement_that_names_no_table(sql):
    # Every way a statement can fail to name its source, held to the same answer
    # on the figures route. Parameterized rather than written once because the
    # four cases take four different branches and a fix to one has repeatedly
    # been assumed to cover the others.
    verdict = gateway().admit_genie_query("data_genie", sql)

    assert verdict.outcome == evidence.REFUSED
    assert not verdict.may_support_a_figure


def test_a_lookup_that_did_read_the_dictionary_cites_the_table_it_read():
    # The other live shape: the same question, and this time the space searched
    # the dictionary table for it. Attribution is kept where it exists rather
    # than required, so this one names its source.
    verdict = gateway().admit_definition_query(
        "dictionary_genie",
        "SELECT business_definition FROM cat.sch.orders WHERE column_name = 'x'",
        has_definition_text=True,
    )

    assert verdict.accepted
    assert verdict.sources == ("cat.sch.orders",)


def test_no_definition_can_support_a_figure_however_it_was_attributed():
    """A row of the dictionary is a sentence about a field, not a measurement.

    Both branches, because the attributed one is the easy mistake: it cites a
    real table and looks in every other respect like an admitted query, so a
    caller asking "can a number be traced to this" has to still get no.
    """

    for verdict in (
        gateway().admit_definition_query(
            "dictionary_genie", DEFINITION_WITHOUT_A_TABLE, has_definition_text=True
        ),
        gateway().admit_definition_query(
            "dictionary_genie",
            "SELECT business_definition FROM cat.sch.orders",
            has_definition_text=True,
        ),
    ):
        assert verdict.accepted
        assert not verdict.may_support_a_figure


def test_the_column_policy_still_fires_on_the_dictionary_route():
    """The control that is NOT about attribution, and so is not relaxed.

    A dictionary space asked in prose for the highest email address would compose
    exactly this, and a payload type does not make an address returnable. It
    raises rather than returning a verdict, because Genie states its findings in
    prose with the value inside it and the whole message has to go.
    """

    with pytest.raises(sql_policy.SqlRefused, match="COUNT them instead"):
        gateway().admit_definition_query(
            "dictionary_genie",
            "SELECT max(email) FROM cat.sch.players",
            has_definition_text=True,
        )


def test_a_dictionary_query_with_no_definition_beside_it_is_a_failure():
    # Nothing admitted and nothing refused: the space ran something, it could not
    # be attributed, and it said nothing either. Reported as an outage rather
    # than a control, because calling it a refusal sends the model to explain a
    # restriction that was never applied.
    verdict = gateway().admit_definition_query(
        "dictionary_genie", DEFINITION_WITHOUT_A_TABLE, has_definition_text=False
    )

    assert verdict.outcome == evidence.FAILED
    assert verdict.code == failures.DEPENDENCY_UNAVAILABLE
    assert "no definition" in verdict.reason


def test_metadata_is_attributable_without_a_statement_and_is_not_a_figure():
    verdict = gateway().admit_metadata("describe_table", assets=("cat.sch.orders",))
    assert verdict.accepted
    assert verdict.sources == ("cat.sch.orders",)
    assert not verdict.may_support_a_figure


# ---------------------------------------------------------------------------
# The manifest, and the shadow period before it is enforced on Genie
# ---------------------------------------------------------------------------


def test_genie_drift_off_the_manifest_is_recorded_before_it_is_refused():
    # Measured first. The manifest is what passthrough granted the serving
    # principal; a Genie space's tables are configured in Genie and nothing in
    # the container can enumerate them, so enforcing on day one refuses ordinary
    # questions over tables the space legitimately curates.
    verdict = gateway().admit_genie_query("data_genie", "SELECT count(*) FROM raw.sch.events")
    assert verdict.accepted
    assert verdict.off_manifest == ("raw.sch.events",)


def test_the_same_reference_is_refused_once_enforcement_is_on():
    verdict = gateway(enforce_genie_manifest=True).admit_genie_query(
        "data_genie", "SELECT count(*) FROM raw.sch.events"
    )
    assert verdict.outcome == evidence.REFUSED
    assert verdict.code == failures.ASSET_NOT_IN_MANIFEST
    assert verdict.sources == ()


def test_direct_sql_is_held_to_the_manifest_whatever_the_genie_setting_is():
    # The asymmetry is deliberate and must not be undone by the new flag: the
    # agent's own SQL runs as the serving principal against the declared set, so
    # a table outside it fails at the warehouse with an opaque error.
    for enforce in (False, True):
        verdict = gateway(enforce_genie_manifest=enforce).admit_statement(
            "run_sql", "SELECT count(*) FROM raw.sch.events"
        )
        assert verdict.outcome == evidence.REFUSED
        assert verdict.code == failures.ASSET_NOT_IN_MANIFEST


# ---------------------------------------------------------------------------
# The record
# ---------------------------------------------------------------------------


def test_every_verdict_carries_the_release_and_identity_facts():
    for verdict in (
        gateway().admit_statement("run_sql", "SELECT count(*) FROM cat.sch.orders"),
        gateway().admit_statement("run_sql", "SELECT email FROM cat.sch.players"),
        gateway().admit_genie_visualization("data_genie"),
        gateway().admit_definition("dictionary_genie", has_text=True),
    ):
        record = verdict.as_record()
        assert record["identity_mode"] == failures.IDENTITY_SIGNED_IN_USER
        assert record["manifest_digest"] == evidence.manifest_digest(READABLE)
        assert record["validator_version"] == evidence.VALIDATOR_VERSION
        assert record["outcome"] in evidence.OUTCOMES


def test_a_refused_statement_is_recorded_as_a_hash_and_never_as_text():
    # A refused statement can contain the identifier it was refused for, and
    # persisting it would put that value in Lakebase and the trace, which is
    # where the refusal exists to keep it out of.
    verdict = gateway().admit_statement(
        "run_sql", "SELECT crm_customer_ref FROM cat.sch.players"
    )
    record = verdict.as_record()
    assert "crm_customer_ref" not in str(record["sql_sha256"])
    assert record["sql_sha256"]
    assert "SELECT" not in str(record)


def test_the_same_statement_formatted_two_ways_has_one_hash():
    first = gateway().admit_statement("run_sql", "SELECT count(*)  FROM cat.sch.orders")
    second = gateway().admit_statement("run_sql", "SELECT count(*)\nFROM cat.sch.orders")
    assert first.candidate.sql_hash == second.candidate.sql_hash


def test_two_calls_are_two_pieces_of_evidence():
    first = gateway().admit_statement("run_sql", "SELECT count(*) FROM cat.sch.orders")
    second = gateway().admit_statement("run_sql", "SELECT count(*) FROM cat.sch.orders")
    assert first.candidate.evidence_id != second.candidate.evidence_id


def test_the_digest_is_about_the_set_rather_than_its_order_or_case():
    assert evidence.manifest_digest(READABLE) == evidence.manifest_digest(
        tuple(reversed([name.upper() for name in READABLE]))
    )
    assert evidence.manifest_digest(READABLE) != evidence.manifest_digest(READABLE[:1])


def test_a_candidate_cannot_be_edited_after_its_verdict():
    # A candidate that could be changed afterwards is one whose verdict describes
    # something else.
    verdict = gateway().admit_statement("run_sql", "SELECT count(*) FROM cat.sch.orders")
    with pytest.raises(dataclasses.FrozenInstanceError):
        verdict.candidate.generated_sql = "SELECT email FROM cat.sch.players"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


def test_no_refusal_or_denial_permits_a_later_route_attempt():
    refused = gateway().admit_statement("run_sql", "SELECT email FROM cat.sch.players")
    assert not refused.may_request_another_route

    unattributable = gateway().admit_genie_visualization("data_genie")
    assert not unattributable.may_request_another_route

    denied = gateway().access_denied(
        "data_genie", evidence.ROUTE_GENIE, "nobody shared the space", failures.USER_NOT_AUTHORIZED
    )
    assert denied.outcome == evidence.ACCESS_DENIED
    assert not denied.may_request_another_route


def test_an_outage_permits_an_explicit_later_attempt():
    failure = gateway().failed("data_genie", evidence.ROUTE_GENIE, "the space timed out")
    assert failure.outcome == evidence.FAILED
    assert failure.code == failures.DEPENDENCY_UNAVAILABLE
    assert failure.may_request_another_route


def test_a_later_attempt_can_be_linked_to_the_route_that_failed():
    failure = gateway().failed("data_genie", evidence.ROUTE_GENIE, "the space timed out")
    later = gateway().admit_genie_query(
        "data_genie",
        "SELECT count(*) FROM cat.sch.orders",
        prior_evidence_id=failure.candidate.evidence_id,
    )
    assert later.as_record()["prior_evidence_id"] == failure.candidate.evidence_id


def test_the_link_is_never_invented():
    # A link the system filled in by itself would be describing a transition
    # nobody made, which is the same untruth as hiding one that happened.
    verdict = gateway().admit_statement("run_sql", "SELECT count(*) FROM cat.sch.orders")
    assert verdict.candidate.prior_evidence_id == ""
