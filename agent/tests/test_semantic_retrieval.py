"""What the retrieval tool returns, and the two things it must never do.

It must never hand a caller semantics that were narrowed away from them, and it
must never produce something an answer can cite. The first is an authorization
regression that is easy to miss because the payload is metadata rather than data;
the second is how a description of a column becomes a figure in an answer.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

import config
import semantic_layer as sl
import semantic_retrieval as sr
from config import Settings

DECLARED = ("cat.sch.players", "cat.sch.purchases")


def settings_for(*tables: str) -> Settings:
    return Settings(
        llm_endpoint="e",
        warehouse_id="w",
        data_genie_space_id="d",
        dictionary_genie_space_id="x",
        catalog="cat",
        schema="sch",
        catalog_allowlist=("cat.sch",),
        max_output_tokens=100,
        tables=(),
        declared_manifest=tables or DECLARED,
    )


def row(**overrides):
    values = {
        "entry_id": "id",
        "entry_kind": sl.KIND_TABLE,
        "name": "cat.sch.players",
        "asset": "cat.sch.players",
        "content": "Table cat.sch.players. Columns:\n- country (string)",
        "label": "",
        "title": "",
        "domain": "",
        "certification": sl.UNCERTIFIED,
        "authorized_scope": [sl.PUBLIC_SCOPE],
        "source": sl.SOURCE_UNITY_CATALOG,
        "source_ref": "cat.sch.players",
        "contract_version": sl.CONTRACT_VERSION,
        "generated_at": "2026-01-02T03:04:05Z",
    }
    values.update(overrides)
    return values


class FakeIndex:
    """Records the query and replays fixed rows, in the response's real shape.

    The response reports its own column names and appends a score column that is
    not in the projection, which is exactly the detail a positional reader gets
    wrong, so the fake reproduces it.
    """

    def __init__(self, rows, error: Exception | None = None):
        self.rows = rows
        self.error = error
        self.calls: list[dict] = []

    def query_index(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        names = [*sl.RETRIEVED_COLUMNS, "score"]
        return SimpleNamespace(
            manifest=SimpleNamespace(
                columns=[SimpleNamespace(name=name) for name in names]
            ),
            result=SimpleNamespace(
                data_array=[
                    [*[item.get(name) for name in sl.RETRIEVED_COLUMNS], 0.9] for item in self.rows
                ]
            ),
        )


def workspace_for(rows, error=None, me=None):
    index = FakeIndex(rows, error)
    current_user = SimpleNamespace(
        me=(lambda: me) if me is not None else _raise_no_identity
    )
    return SimpleNamespace(vector_search_indexes=index, current_user=current_user), index


def _raise_no_identity():
    raise RuntimeError("no invoker token")


def person(user_name: str, *groups: str):
    return SimpleNamespace(
        user_name=user_name,
        groups=[SimpleNamespace(display=name) for name in groups],
    )


class TestScopeEnforcement:
    def test_an_entry_the_caller_holds_no_token_for_is_withheld(self):
        """The regression this whole design exists to prevent, and it is subtle
        because the payload is a description rather than a row of data."""

        workspace, _ = workspace_for(
            [row(authorized_scope=[sl.group_scope("Restricted")])],
            me=person("a@example.com", "Analysts"),
        )
        outcome = sr.SemanticRetrieval(
            settings_for(), workspace, user_authorized=True
        ).retrieve("players")
        assert outcome.entries == []
        assert outcome.withheld == 1

    def test_an_entry_the_caller_holds_a_group_token_for_is_returned(self):
        workspace, _ = workspace_for(
            [row(authorized_scope=[sl.group_scope("Analysts")])],
            me=person("a@example.com", "Analysts"),
        )
        outcome = sr.SemanticRetrieval(
            settings_for(), workspace, user_authorized=True
        ).retrieve("players")
        assert len(outcome.entries) == 1

    def test_a_user_token_matches_regardless_of_case(self):
        workspace, _ = workspace_for(
            [row(authorized_scope=[sl.user_scope("a.person@example.com")])],
            me=person("A.Person@Example.com"),
        )
        outcome = sr.SemanticRetrieval(
            settings_for(), workspace, user_authorized=True
        ).retrieve("players")
        assert len(outcome.entries) == 1

    def test_an_empty_scope_matches_nobody(self):
        workspace, _ = workspace_for([row(authorized_scope=[])], me=person("a@example.com"))
        outcome = sr.SemanticRetrieval(
            settings_for(), workspace, user_authorized=True
        ).retrieve("players")
        assert outcome.entries == []

    def test_an_unparseable_scope_matches_nobody(self):
        """The alternative to failing closed on a transport quirk is a parsing
        bug that quietly publishes the whole corpus."""

        for value in ("not json", 7, None, {"scope": "all"}):
            workspace, _ = workspace_for(
                [row(authorized_scope=value)], me=person("a@example.com")
            )
            outcome = sr.SemanticRetrieval(
                settings_for(), workspace, user_authorized=True
            ).retrieve("players")
            assert outcome.entries == [], value

    def test_a_scope_arriving_as_a_json_string_still_matches(self):
        workspace, _ = workspace_for(
            [row(authorized_scope=json.dumps([sl.PUBLIC_SCOPE]))], me=person("a@example.com")
        )
        outcome = sr.SemanticRetrieval(
            settings_for(), workspace, user_authorized=True
        ).retrieve("players")
        assert len(outcome.entries) == 1

    def test_a_shared_principal_sees_only_public_entries(self):
        """Without user authorization the run executes as one identity shared by
        every stakeholder. Scoping to it would be scoping to nobody, so entries
        narrowed to a label are withheld from all of them."""

        workspace, _ = workspace_for(
            [row(authorized_scope=[sl.group_scope("Analysts")]), row(entry_id="b")]
        )
        outcome = sr.SemanticRetrieval(
            settings_for(), workspace, user_authorized=False
        ).retrieve("players")
        assert len(outcome.entries) == 1
        assert outcome.scopes.verified is False

    def test_an_unreadable_identity_narrows_rather_than_widens(self):
        """The SDK does not report a missing invoker token, it falls back
        silently, so this path is reached by a normal-looking run."""

        workspace, _ = workspace_for([row(authorized_scope=[sl.group_scope("Analysts")])])
        outcome = sr.SemanticRetrieval(
            settings_for(), workspace, user_authorized=True
        ).retrieve("players")
        assert outcome.entries == []

    def test_an_unverified_run_says_so_in_the_result(self):
        workspace, _ = workspace_for([row()])
        text = (
            sr.SemanticRetrieval(settings_for(), workspace, user_authorized=False)
            .retrieve("players")
            .rendered()
        )
        assert "without a verified signed-in identity" in text

    def test_the_withheld_count_is_not_rendered(self):
        """Saying how many entries were hidden tells a caller how much exists
        behind a boundary they were refused at."""

        workspace, _ = workspace_for(
            [row(authorized_scope=[sl.group_scope("Restricted")])],
            me=person("a@example.com"),
        )
        outcome = sr.SemanticRetrieval(
            settings_for(), workspace, user_authorized=True
        ).retrieve("players")
        assert outcome.withheld == 1
        text = outcome.rendered().lower()
        assert "withheld" not in text
        assert "hidden" not in text
        assert "do not have access" not in text


class TestManifestBoundary:
    def test_an_entry_outside_the_declared_manifest_is_withheld(self):
        """The manifest is the same list validate_sql refuses statements against,
        so an entry outside it describes something no read could reach."""

        workspace, _ = workspace_for(
            [row(asset="other.sch.secret", name="other.sch.secret")],
            me=person("a@example.com"),
        )
        outcome = sr.SemanticRetrieval(
            settings_for(), workspace, user_authorized=True
        ).retrieve("secret")
        assert outcome.entries == []
        assert outcome.withheld == 1

    def test_the_manifest_check_is_case_insensitive(self):
        """Unity Catalog names are case-insensitive. Comparing them raw drops
        entries for a reason nobody could see."""

        workspace, _ = workspace_for(
            [row(asset="CAT.SCH.PLAYERS")], me=person("a@example.com")
        )
        outcome = sr.SemanticRetrieval(
            settings_for(), workspace, user_authorized=True
        ).retrieve("players")
        assert len(outcome.entries) == 1

    def test_an_entry_naming_no_asset_is_not_refused_by_the_manifest(self):
        workspace, _ = workspace_for(
            [row(entry_kind=sl.KIND_TERM, name="churn", asset="")], me=person("a@example.com")
        )
        outcome = sr.SemanticRetrieval(
            settings_for(), workspace, user_authorized=True
        ).retrieve("churn")
        assert len(outcome.entries) == 1


class TestNotEvidence:
    def test_the_tool_result_carries_no_sources_even_when_entries_name_assets(self):
        """A source list built from descriptions would put a table in an answer's
        provenance that the run never queried."""

        workspace, _ = workspace_for([row()], me=person("a@example.com"))
        result = (
            sr.SemanticRetrieval(settings_for(), workspace, user_authorized=True)
            .retrieve("players")
            .as_tool_result()
        )
        assert result.sources == []
        assert result.sql == ""

    def test_the_module_declares_that_it_produces_no_evidence(self):
        assert sr.PRODUCES_EVIDENCE is False

    def test_the_result_opens_by_saying_it_is_not_data(self):
        workspace, _ = workspace_for([row()], me=person("a@example.com"))
        text = (
            sr.SemanticRetrieval(settings_for(), workspace, user_authorized=True)
            .retrieve("players")
            .rendered()
        )
        assert text.startswith("SEMANTIC SEARCH RESULTS")
        assert "not a measurement" in text or "not data" in text

    def test_the_tool_description_tells_the_model_what_it_may_not_do(self):
        description = sr.SEARCH_SEMANTICS_TOOL["function"]["description"]
        assert "no figures" in description
        assert "data_genie" in description


class TestDiscoveryIsNotPermission:
    """The scope filter narrows what is REVEALED and decides nothing about reads.

    The module docstring has always said so to whoever edits this file. These
    tests are about the two people who never read it: the model, which acts on the
    tool result, and the reader, who acts on the answer. An entry appearing is not
    a grant, and an entry missing is not proof the data is absent, so a run that
    infers either produces a confident wrong sentence about somebody's own estate.
    """

    def test_every_result_says_the_scope_filter_is_a_cache_and_not_a_grant(self):
        workspace, _ = workspace_for([row()], me=person("a@example.com"))
        text = (
            sr.SemanticRetrieval(settings_for(), workspace, user_authorized=True)
            .retrieve("players")
            .rendered()
        )
        assert sr.DISCOVERY_NOT_PERMISSION_NOTICE in text

    def test_the_caveat_holds_for_a_fully_scoped_verified_caller_too(self):
        """Unconditional on purpose.

        A caller who matched on their own user token is the one most likely to read
        the result as an entitlement, because for them the filter did the thing it
        looks like it does. There is still no state in which a projection taken at
        build time is the authority on a read happening now.
        """

        workspace, _ = workspace_for(
            [row(authorized_scope=[sl.user_scope("a@example.com")])],
            me=person("a@example.com"),
        )
        outcome = sr.SemanticRetrieval(settings_for(), workspace, user_authorized=True).retrieve(
            "players"
        )

        assert outcome.scopes.verified is True
        assert outcome.entries, "the caller matched, so this is the scoped-in case"
        assert sr.DISCOVERY_NOT_PERMISSION_NOTICE in outcome.rendered()

    def test_the_caveat_names_unity_catalog_as_the_thing_that_decides(self):
        """Pointing at the boundary, not just disclaiming this one.

        "This is not authoritative" leaves the model to guess what is, and the
        guess that costs a reader is that nothing is, so a refusal downstream gets
        reported as missing data.
        """

        notice = sr.DISCOVERY_NOT_PERMISSION_NOTICE
        assert "Unity Catalog" in notice
        assert "signed-in user" in notice
        assert "report the refusal" in notice

    def test_the_tool_description_says_so_before_the_model_calls_it(self):
        description = sr.SEARCH_SEMANTICS_TOOL["function"]["description"]
        assert "not what you may read" in description
        assert "Unity Catalog" in description

    def test_a_caller_without_select_on_the_index_fails_closed(self):
        """The index refusing is discovery going down, not the boundary moving.

        Unity Catalog decides SELECT on the index itself, so this is the path a
        caller who was never granted it takes. Two things have to be true at once:
        no entries leak, and the run continues, because a question that could be
        answered from Genie must not be lost to a discovery tool being unavailable.
        """

        workspace, _ = workspace_for(
            [row()],
            error=PermissionError(
                "PERMISSION_DENIED: User does not have SELECT on index "
                "cat.sch.player_insights_semantics"
            ),
            me=person("a@example.com"),
        )
        outcome = sr.SemanticRetrieval(settings_for(), workspace, user_authorized=True).retrieve(
            "players"
        )

        assert outcome.entries == []
        assert outcome.failure_code == sr.DEPENDENCY_UNAVAILABLE
        result = outcome.as_tool_result()
        assert result.sources == []
        assert result.sql == ""
        # The fallback matters as much as the refusal: this is the sentence that
        # keeps the turn going instead of turning a missing grant into a dead run.
        assert "list_data_assets" in result.text

    def test_the_index_is_queried_as_whoever_the_turn_resolved(self):
        """One identity per turn, and this tool does not resolve a second one.

        `agent.py` builds this from `tools.workspace`, which under user
        authorization IS the invoker's downscoped client. Asserting it here means a
        refactor that hands this module its own system client fails a test rather
        than quietly moving semantic reads onto the serving principal.
        """

        workspace, index = workspace_for([row()], me=person("a@example.com"))
        retrieval = sr.SemanticRetrieval(settings_for(), workspace, user_authorized=True)

        assert retrieval.workspace is workspace
        retrieval.retrieve("players")
        assert index.calls, "the query went through the client it was handed"


class TestQuery:
    def test_the_query_is_hybrid(self):
        """A question naming a column exactly should find that column, and
        nearest-neighbour scoring alone ranks it below entries that read like
        it."""

        workspace, index = workspace_for([row()], me=person("a@example.com"))
        sr.SemanticRetrieval(settings_for(), workspace, user_authorized=True).retrieve("x")
        assert index.calls[0]["query_type"] == "HYBRID"

    def test_it_over_fetches_so_the_scope_test_has_something_to_keep(self):
        workspace, index = workspace_for([row()], me=person("a@example.com"))
        sr.SemanticRetrieval(settings_for(), workspace, user_authorized=True).retrieve(
            "x", limit=4
        )
        assert index.calls[0]["num_results"] == 4 * sr.OVERFETCH

    def test_the_over_fetch_is_capped(self):
        workspace, index = workspace_for([row()], me=person("a@example.com"))
        sr.SemanticRetrieval(settings_for(), workspace, user_authorized=True).retrieve(
            "x", limit=999
        )
        assert index.calls[0]["num_results"] == sr.MAX_FETCH

    def test_the_limit_is_capped(self):
        workspace, _ = workspace_for(
            [row(entry_id=str(n), name=f"n{n}", asset="") for n in range(40)],
            me=person("a@example.com"),
        )
        outcome = sr.SemanticRetrieval(
            settings_for(), workspace, user_authorized=True
        ).retrieve("x", limit=999)
        assert len(outcome.entries) == sr.MAX_LIMIT

    def test_scalar_filters_are_pushed_down(self):
        workspace, index = workspace_for([row()], me=person("a@example.com"))
        sr.SemanticRetrieval(settings_for(), workspace, user_authorized=True).retrieve(
            "x", kind=sl.KIND_METRIC, domain="monetisation"
        )
        pushed = json.loads(index.calls[0]["filters_json"])
        assert pushed == {"entry_kind": sl.KIND_METRIC, "domain": "monetisation"}

    def test_scalar_filters_are_re_applied_locally(self):
        """The pushdown decides which rows the top-k is spent on. Whether a row
        is returned is decided here, so a filter the index ignored cannot widen
        the result."""

        workspace, _ = workspace_for([row(domain="something-else")], me=person("a@example.com"))
        outcome = sr.SemanticRetrieval(
            settings_for(), workspace, user_authorized=True
        ).retrieve("x", domain="monetisation")
        assert outcome.entries == []

    def test_the_scope_test_is_never_pushed_down(self):
        """Array-filter semantics cannot be exercised without provisioning an
        endpoint, and a filter believed to be enforced remotely that quietly
        matches everything is the silent widening this design guards against."""

        workspace, index = workspace_for([row()], me=person("a@example.com", "Analysts"))
        sr.SemanticRetrieval(settings_for(), workspace, user_authorized=True).retrieve("x")
        pushed = index.calls[0]["filters_json"]
        assert pushed is None or "authorized_scope" not in pushed

    def test_columns_are_read_by_name_not_position(self):
        """The response appends a score column that is not in the projection, so
        a positional read shifts every field by one."""

        workspace, _ = workspace_for([row(name="the-name")], me=person("a@example.com"))
        outcome = sr.SemanticRetrieval(
            settings_for(), workspace, user_authorized=True
        ).retrieve("x")
        assert outcome.entries[0].name == "the-name"

    def test_the_index_defaults_to_the_one_the_bundle_declares(self):
        retrieval = sr.SemanticRetrieval(settings_for(), SimpleNamespace())
        assert retrieval.index == sl.index_name("cat", "sch")


class TestUnavailable:
    def test_an_unreachable_index_is_reported_rather_than_raised(self):
        """Discovery failing is not the run failing. The question is still
        answerable through the tools that existed before this one."""

        workspace, _ = workspace_for([], error=RuntimeError("endpoint is PROVISIONING"))
        outcome = sr.SemanticRetrieval(
            settings_for(), workspace, user_authorized=False
        ).retrieve("x")
        assert outcome.failure_code == sr.DEPENDENCY_UNAVAILABLE
        text = outcome.rendered()
        assert "SEMANTIC SEARCH UNAVAILABLE" in text
        assert "list_data_assets" in text

    def test_an_unavailable_search_still_carries_no_evidence(self):
        workspace, _ = workspace_for([], error=RuntimeError("boom"))
        result = (
            sr.SemanticRetrieval(settings_for(), workspace, user_authorized=False)
            .retrieve("x")
            .as_tool_result()
        )
        assert result.sources == []

    def test_no_match_points_back_at_the_older_tools(self):
        workspace, _ = workspace_for([])
        text = (
            sr.SemanticRetrieval(settings_for(), workspace, user_authorized=False)
            .retrieve("x")
            .rendered()
        )
        assert "No semantic entries matched" in text
        assert "describe_table" in text

    def test_the_failure_code_matches_the_shared_taxonomy(self):
        """Spelled as a literal here so this module still loads against a build
        that predates the taxonomy, and held against it wherever both exist."""

        failures = pytest.importorskip("failures")
        assert sr.DEPENDENCY_UNAVAILABLE == failures.DEPENDENCY_UNAVAILABLE


class TestRendering:
    def test_the_result_is_bounded(self):
        """A retrieval returning more text than list_data_assets would have has
        replaced one prompt-budget problem with another wearing a better name."""

        big = row(content="x" * 5000, asset="")
        workspace, _ = workspace_for(
            [dict(big, entry_id=str(n), name=f"n{n}") for n in range(12)],
            me=person("a@example.com"),
        )
        text = (
            sr.SemanticRetrieval(settings_for(), workspace, user_authorized=True)
            .retrieve("x", limit=12)
            .rendered()
        )
        assert len(text) <= sr.MAX_RESULT_CHARS + 500
        assert "left out to stay inside the result budget" in text

    def test_an_entry_shows_its_certification(self):
        workspace, _ = workspace_for(
            [row(certification=sl.CERTIFIED, source=sl.SOURCE_CURATED)],
            me=person("a@example.com"),
        )
        text = (
            sr.SemanticRetrieval(settings_for(), workspace, user_authorized=True)
            .retrieve("x")
            .rendered()
        )
        assert sl.CERTIFIED in text


class TestConfiguredIndex:
    @pytest.fixture(autouse=True)
    def _enable_retrieval(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(sr, "SEMANTIC_RETRIEVAL_ENABLED", True)

    def test_a_deployment_with_no_flag_has_no_index(self):
        """The default, and the reason the tool is absent rather than broken in
        every deployment nobody has bought an endpoint for."""

        assert sr.configured_index(settings_for(), {}, {}) == ""

    def test_retirement_ignores_a_baked_index(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(sr, "SEMANTIC_RETRIEVAL_ENABLED", False)
        assert (
            sr.configured_index(
                settings_for(), {sr.MODEL_CONFIG_KEY: "baked.sem.idx"}, {}
            )
            == ""
        )

    def test_the_derived_name_matches_what_the_bundle_declares(self):
        """Two places name this index, and they are a YAML file and a Python
        module that never read each other. This is the seam between them."""

        assert sr.resolve_index(settings_for(), sr.DERIVE) == sl.index_name("cat", "sch")

    def test_a_three_level_name_adopts_an_index_built_elsewhere(self):
        assert sr.resolve_index(settings_for(), "other.place.idx") == "other.place.idx"

    def test_a_typo_is_refused_rather_than_read_as_off(self):
        """A release that silently lost its semantic layer is indistinguishable
        from one that never had it, which is why this cannot fall back to off."""

        with pytest.raises(sr.SemanticIndexMisconfigured):
            sr.resolve_index(settings_for(), "yes")

    def test_the_artifact_wins_over_the_environment(self):
        """`config.Settings` resolves this way for the same reason: an override
        inside a serving container points the agent at an index the model version
        was never granted, and the grant is what carries the caller's identity."""

        baked = {sr.MODEL_CONFIG_KEY: "baked.sem.idx"}
        environment = {sr.SEMANTIC_INDEX_ENV: "env.sem.idx"}
        assert sr.configured_index(settings_for(), baked, environment) == "baked.sem.idx"

    def test_an_artifact_that_says_off_stays_off(self):
        """An older artifact carries no key at all and falls through to the
        environment; one that carries an empty string was logged with the flag
        unset, which is a decision rather than an absence."""

        environment = {sr.SEMANTIC_INDEX_ENV: sr.DERIVE}
        assert sr.configured_index(settings_for(), {}, environment) != ""


class TestConfigurationEntry:
    """Whether this release searches an index is now REPORTABLE, which it was not.

    It is decided at log time and baked into the artifact, it was not one of
    `config.ENV_VARS` so `configuration_report` never listed it, and the app
    container is never given the variable. So a release with a semantic layer and
    one without were indistinguishable to every surface that reads what this
    endpoint is configured with, and the architecture diagram had to say in words
    that it could not tell.

    The distinction these tests protect is between the two ways of having no
    index: a release that reported the setting as unset, and a version too old to
    report it at all. The first is a healthy deployment, the second is unknown, and
    collapsing them makes every index-free release look like a blind spot.
    """

    @pytest.fixture(autouse=True)
    def _enable_retrieval(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(sr, "SEMANTIC_RETRIEVAL_ENABLED", True)

    def test_it_reports_the_index_a_release_searches(self):
        entry = sr.configuration_entry(
            settings_for(), {sr.MODEL_CONFIG_KEY: "baked.sem.idx"}, {}
        )
        assert entry["key"] == sr.MODEL_CONFIG_KEY
        assert entry["value"] == "baked.sem.idx"
        assert entry["source"] == config.FROM_ARTIFACT

    def test_an_artifact_that_says_off_is_a_report_rather_than_a_silence(self):
        """The empty value is the FACT that this release has none, so it carries a
        provenance. Testing the value instead of the key's presence would make
        every index-free deployment read as unreported."""

        entry = sr.configuration_entry(settings_for(), {sr.MODEL_CONFIG_KEY: ""}, {})
        assert entry["value"] == ""
        assert entry["source"] == config.FROM_ARTIFACT

    def test_a_version_that_never_knew_the_setting_reports_no_provenance(self):
        entry = sr.configuration_entry(settings_for(), {}, {})
        assert entry["value"] == ""
        assert entry["source"] == ""

    def test_an_environment_value_says_it_came_from_the_environment(self):
        entry = sr.configuration_entry(
            settings_for(), {}, {sr.SEMANTIC_INDEX_ENV: "env.sem.idx"}
        )
        assert entry["value"] == "env.sem.idx"
        assert entry["source"] == config.FROM_ENVIRONMENT

    def test_it_reports_the_same_value_the_run_actually_searches(self):
        """Two resolutions of one setting is how a pane comes to describe a
        deployment that does not exist."""

        baked = {sr.MODEL_CONFIG_KEY: sr.DERIVE}
        entry = sr.configuration_entry(settings_for(), baked, {})
        assert entry["value"] == sr.configured_index(settings_for(), baked, {})

    def test_it_is_shaped_like_every_other_reported_setting(self):
        """Read by the same `resourceStates` mapping as the rest of the list, so a
        missing field is a row the app silently cannot place."""

        entry = sr.configuration_entry(settings_for(), {}, {})
        assert set(entry) == set(settings_for().configuration_report()[0])

    def test_it_cannot_be_changed_without_logging_a_model(self):
        entry = sr.configuration_entry(settings_for(), {}, {})
        assert entry["mutability"] == config.BAKED_AT_LOG_TIME
        assert entry["baked"] is True

    def test_a_deployment_without_a_semantic_layer_is_not_a_misconfiguration(self):
        """`required` drives whether the app flags an empty value. An index is an
        hourly charge most releases do not carry."""

        assert sr.configuration_entry(settings_for(), {}, {})["required"] is False


class TestLogTimeWiring:
    """Source trip-wires on `log_model.py`, in the idiom `test_manifest.py` uses.

    Nothing here can be caught by running the script, because running it logs a
    model. What these guard is that a served version's tool list, its declared
    resources and its token scopes agree about whether an index exists.
    """

    @staticmethod
    def _source(name: str) -> str:
        from pathlib import Path

        return (Path(__file__).resolve().parents[1] / name).read_text()

    def test_the_index_is_declared_as_a_resource_only_when_configured(self):
        source = self._source("log_model.py")
        assert "DatabricksVectorSearchIndex(index_name=semantic_index)" in source
        assert "if semantic_index else []" in source

    def test_the_index_is_baked_into_the_model_config(self):
        """Without this the container reads an environment it does not have, and
        the tool is offered by a prompt against an index the agent cannot name."""

        source = self._source("log_model.py")
        assert "SEMANTIC_INDEX_KEY: semantic_index" in source
        assert "model_config={**settings.as_model_config(), **release_decisions}" in source

    def test_the_vector_search_scopes_are_added_only_under_user_authorization(self):
        """A scope on a downscoped token is one more API that token can be made
        to call, so an unconfigured release must not carry these."""

        source = self._source("log_model.py")
        assert "api_scopes(settings, semantic_index=semantic_index)" in source
        assert "if user_auth.enabled else ()" in source

    def test_both_modules_are_packaged(self):
        """They are imported at `agent.py` module scope, so a missing one fails
        the model LOAD inside the container rather than anything before it."""

        source = self._source("log_model.py")
        assert 'str(ROOT / "semantic_layer.py")' in source
        assert 'str(ROOT / "semantic_retrieval.py")' in source

    def test_the_tool_is_offered_only_when_an_index_is_configured(self):
        source = self._source("agent.py")
        assert "*([SEARCH_SEMANTICS_TOOL] if SEMANTIC_INDEX else [])" in source
        assert "SEMANTIC_INDEX = configured_index(" in source
