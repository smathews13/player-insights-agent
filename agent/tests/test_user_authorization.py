"""The switch that decides which identity a question executes as.

Covered here: how the flag parses, which scopes it derives, how the client is
constructed, and whether the default is untouched. NOT COVERED, because it needs
a logged model version on a real endpoint: whether a downscoped invoker token
arrives in the serving container, and whether the scope strings are the ones the
platform recognises.

The bias is towards the ways this can be wrong quietly. A flag that does nothing,
a client cached across two callers, an answer that does not say whose grants it
was computed under: none of these raise.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from config import Settings
from tools import GRANTS_DECIDE_NOTE, PlayerInsightTools
from user_authorization import (
    GENIE_SCOPE,
    MODEL_CONFIG_KEY,
    SQL_SCOPE,
    SYSTEM_PASSTHROUGH,
    USER_AUTHORIZATION,
    USER_AUTHORIZATION_ENV,
    UserCredentialsUnavailable,
    announcement,
    api_scopes,
    coverage_caveat,
    executing_identity,
    from_artifact,
    is_user_credentials_unavailable,
    resolve,
    user_authorized_client,
)

#: The sentence the SDK really raises when Model Serving hands the container no
#: downscoped user token, as it reached a customer inside an HTTP 400. Quoted
#: verbatim rather than paraphrased: the detector matches on the SDK's words, so
#: a test that invents its own wording proves nothing about the real failure.
SDK_NO_CREDENTIAL = (
    "model_serving_user_credentials auth: Unable to authenticate using "
    "user_credentials in Databricks Model Serving Environment"
)

LOG_MODEL = (Path(__file__).resolve().parents[1] / "log_model.py").read_text()


def settings(**overrides) -> Settings:
    base = {
        "llm_endpoint": "databricks-claude-sonnet-4-6",
        "warehouse_id": "test-warehouse",
        "data_genie_space_id": "test-space-data",
        "dictionary_genie_space_id": "test-space-dictionary",
        "catalog": "test_catalog",
        "schema": "test_schema",
        "catalog_allowlist": ("test_catalog",),
        "max_output_tokens": 2500,
    }
    return Settings(**{**base, **overrides})


# ---------------------------------------------------------------------------
# Reading the flag
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [None, "", "   ", "1", "yes", "on", "TRUE!", "treu", "True ish", "0", "no", "enabled"],
)
def test_anything_that_is_not_an_explicit_yes_leaves_the_agent_as_it_is(raw):
    """Fail closed, on every plausible way of writing "on" except the right one.

    System passthrough is what version 11 is serving to a live customer demo, so
    it is the safe side of this switch and every uncertain input has to land on
    it. `1` and `yes` are here because they are what someone types when they
    assume a boolean, and they must not work: a flag that accepts some spellings
    and not others is worse than one that accepts exactly one, because the
    failure is intermittent across deployments rather than reproducible.
    """

    assert resolve(raw).enabled is False


@pytest.mark.parametrize("raw", ["true", "TRUE", "True", "  true  "])
def test_only_true_turns_it_on(raw):
    resolution = resolve(raw)
    assert resolution.enabled is True
    assert resolution.reason == "enabled"


def test_a_value_nobody_recognises_is_reported_as_ignored_rather_than_as_off():
    """`unrecognised` is kept distinct from `disabled`, and the log line says so.

    A misconfiguration that silently does the safe thing is still a
    misconfiguration. Somebody who set the variable to `1` meaning yes has to be
    told it did nothing, or the feature reads as broken rather than as off, and
    the place they will look is the run log of the release, which is the only
    output this decision has.
    """

    resolution = resolve("1")
    assert (resolution.enabled, resolution.reason) == (False, "unrecognised")

    line = announcement(resolution, at_log_time=True)
    assert "IGNORED" in line
    assert USER_AUTHORIZATION_ENV in line
    # The corrective, not just the complaint. A warning that does not say what
    # the accepted value is makes the reader guess a second time.
    assert '"true"' in line

    # An explicit `false` is a decision someone made, not a mistake, so it is not
    # shouted about.
    assert "IGNORED" not in announcement(resolve("false"), at_log_time=True)


def test_the_announcement_does_not_promise_that_the_caller_is_a_person():
    """The one claim this feature must not overstate.

    "On behalf of user" means the identity that invoked the endpoint. The app
    invokes it as its own service principal, so until the app forwards the end
    user's token, turning this on moves execution from one service principal to
    another. An operator reading the boot log has to be able to find that out
    from the boot log.
    """

    line = announcement(resolve("true"), at_log_time=False)
    assert "USER AUTHORIZATION IS ON" in line
    assert "invoker" in line.lower()
    assert "service principal" in line


# ---------------------------------------------------------------------------
# Reading it back inside the container
# ---------------------------------------------------------------------------


def test_a_model_version_logged_before_this_existed_keeps_passthrough():
    """The compatibility case, and the one an accident would land on.

    Versions 9, 10 and 11 bake no such key. If a missing key resolved to
    anything but passthrough, attaching an old version for a rollback would
    change how it authenticates, which is the opposite of what a rollback is
    for.
    """

    assert from_artifact({}).enabled is False
    assert from_artifact(None).enabled is False
    assert from_artifact({"catalog": "test_catalog"}).enabled is False


@pytest.mark.parametrize(
    ("baked", "expected"),
    [
        (True, True),
        (False, False),
        ("true", True),
        ("false", False),
        # YAML round-trips are not guaranteed to preserve the type, and a string
        # that is not "true" fails closed exactly as the environment variable does.
        ("1", False),
        (1, False),
        (None, False),
    ],
)
def test_the_artifact_is_read_with_the_same_closed_fist_as_the_environment(baked, expected):
    assert from_artifact({MODEL_CONFIG_KEY: baked}).enabled is expected


# ---------------------------------------------------------------------------
# Scopes
# ---------------------------------------------------------------------------


def test_the_scopes_are_the_two_the_agent_can_justify():
    """Genie and SQL, because those are the only APIs `tools.py` calls."""

    assert api_scopes(settings()) == (GENIE_SCOPE, SQL_SCOPE)


def test_the_model_serving_scope_is_not_requested():
    """The orchestrator's own LLM call stays on the system identity.

    Requesting a serving scope would mean every stakeholder needed CAN QUERY on
    the Claude endpoint before they could ask a question, and (per the
    platform's own security note) a serving endpoint reached with a user's
    token can itself reach API scopes this agent never declared. The endpoint is
    infrastructure. Only the data needs the caller's grants applied to it.
    """

    scopes = api_scopes(settings())
    assert not any("serving" in scope or "model-serving" == scope for scope in scopes)
    assert not any("vector" in scope or "files" in scope or "iam" in scope for scope in scopes)


def test_a_deployment_that_uses_no_genie_space_does_not_ask_for_genie():
    """Derived from what is configured, so an unused capability costs no scope."""

    without_genie = settings(data_genie_space_id="", dictionary_genie_space_id="")
    assert api_scopes(without_genie) == (SQL_SCOPE,)
    assert api_scopes(settings(warehouse_id="")) == (GENIE_SCOPE,)
    # One space is enough to need the scope: the agent calls whichever it has.
    assert GENIE_SCOPE in api_scopes(settings(dictionary_genie_space_id=""))


def test_logging_with_no_scopes_at_all_is_refused_rather_than_registered():
    """An empty scope list downscopes the token to nothing, and fails at serve time.

    MLflow does not validate scopes (`UserAuthPolicy` stores the list verbatim),
    so an empty one logs and registers cleanly and then refuses every Genie and
    SQL call on a deployed endpoint. Source-level, because `log_model.py` logs a
    model as a side effect of import and cannot be imported to be tested.
    """

    assert "if user_auth.enabled and not scopes:" in LOG_MODEL
    assert "Refusing to log with user authorization and no API scopes" in LOG_MODEL


# ---------------------------------------------------------------------------
# Building the client
# ---------------------------------------------------------------------------


def test_the_client_is_built_with_the_kwarg_the_sdk_actually_accepts():
    """`credentials_strategy`, plural. This test is the reason to check.

    The SDK's own docstring for `ModelServingUserCredentials` says
    `credential_strategy`, singular. `Config.__init__` does not accept that name;
    it is swallowed by `**kwargs`, no exception is raised, and the client
    authenticates as the system principal. The whole feature would then be a
    no-op that logs as though it were on.
    """

    from databricks.sdk.credentials_provider import ModelServingUserCredentials

    captured: dict[str, object] = {}

    def factory(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace()

    user_authorized_client(factory=factory)

    assert list(captured) == ["credentials_strategy"]
    assert isinstance(captured["credentials_strategy"], ModelServingUserCredentials)


def test_the_kwarg_name_is_one_the_workspace_client_declares():
    """Pinned against the installed SDK, not against the documentation.

    A rename here is silent in exactly the way described above, so the accepted
    parameter name is asserted rather than trusted.
    """

    import inspect

    from databricks.sdk import WorkspaceClient

    parameters = inspect.signature(WorkspaceClient.__init__).parameters
    assert "credentials_strategy" in parameters
    assert "credential_strategy" not in parameters


# ---------------------------------------------------------------------------
# Who the run actually ran as
# ---------------------------------------------------------------------------


def test_the_identity_is_read_from_the_client_rather_than_assumed():
    client = SimpleNamespace(
        current_user=SimpleNamespace(me=lambda: SimpleNamespace(user_name="ada@example.com"))
    )
    assert executing_identity(client) == "ada@example.com"


def test_a_service_principal_answers_with_its_id_and_that_is_the_tell():
    """The documented symptom of a missing invoker token, kept legible.

    When no user token reaches the container the SDK falls back without raising,
    and `me()` then answers with a service principal: a UUID where an address
    should be. Returning it verbatim is what lets an operator recognise it.
    """

    client = SimpleNamespace(
        current_user=SimpleNamespace(
            me=lambda: SimpleNamespace(user_name=None, id="ca9f730e-0000-0000-0000-000000004153")
        )
    )
    assert executing_identity(client) == "ca9f730e-0000-0000-0000-000000004153"


def test_an_unreadable_identity_does_not_fail_the_question():
    """Best effort, on the answer path of a live demo.

    An identity that could not be read is a thing to disclose, not a reason to
    drop a turn that would otherwise have been answered.
    """

    def explode():
        raise RuntimeError("no")

    assert executing_identity(SimpleNamespace(current_user=SimpleNamespace(me=explode))) == ""
    assert executing_identity(SimpleNamespace()) == ""


# ---------------------------------------------------------------------------
# The serving environment with no invoker credential at all
#
# The customer incident: an endpoint deployed without on-behalf-of-user
# forwarding raised the SDK's own sentence out of `predict`, and the first
# question a person asked came back as an HTTP 400 whose body was that sentence.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        SDK_NO_CREDENTIAL,
        "Unable to authenticate using user_credentials in Databricks Model Serving Environment",
        # Case is the SDK's to choose and has already changed a check's answer in
        # this repository once.
        SDK_NO_CREDENTIAL.upper(),
    ],
)
def test_the_missing_invoker_credential_is_recognised_however_it_is_spelled(text):
    assert is_user_credentials_unavailable(ValueError(text))


@pytest.mark.parametrize(
    "text",
    [
        "default auth: cannot configure default credentials",
        "PERMISSION_DENIED: User does not have CAN QUERY on the endpoint",
        "Unable to authenticate using azure-cli",
        "invalid access token",
        "",
    ],
)
def test_a_different_auth_failure_is_not_folded_into_it(text):
    """The narrowness IS the feature.

    "Re-log and redeploy the model" is confident, specific, wrong advice for an
    expired token or a revoked grant, and a reader who follows it spends a
    release finding that out.
    """

    assert not is_user_credentials_unavailable(ValueError(text))


def test_it_is_recognised_through_a_wrapper():
    """The SDK wraps its own ValueError and a caller may wrap it again, so the
    whole `raise ... from ...` chain is read rather than the outermost frame."""

    inner = ValueError(SDK_NO_CREDENTIAL)
    try:
        raise inner
    except ValueError as error:
        outer = RuntimeError("client construction failed")
        outer.__cause__ = error

    assert is_user_credentials_unavailable(outer)


def test_building_the_client_without_a_credential_raises_the_named_failure():
    """Renamed rather than reworded: the SDK's sentence is kept as the message so
    the endpoint's log still says exactly what the SDK said."""

    def factory(**_kwargs):
        raise ValueError(SDK_NO_CREDENTIAL)

    with pytest.raises(UserCredentialsUnavailable) as raised:
        user_authorized_client(factory=factory)

    assert SDK_NO_CREDENTIAL in str(raised.value)
    assert isinstance(raised.value.__cause__, ValueError)


def test_any_other_construction_failure_is_re_raised_untouched():
    """Identity, type and message, because a caller upstream may be catching on
    any of the three."""

    original = TimeoutError("the workspace did not answer in time")

    def factory(**_kwargs):
        raise original

    with pytest.raises(TimeoutError) as raised:
        user_authorized_client(factory=factory)

    assert raised.value is original


def test_a_credential_that_fails_on_first_use_is_named_too():
    """The SDK resolves lazily, so the same fault can surface on the first call
    rather than at construction. Swallowed to "" it becomes "sign in again",
    which sends the reader to fix a session for a fault in the deployment."""

    def explode():
        raise ValueError(SDK_NO_CREDENTIAL)

    with pytest.raises(UserCredentialsUnavailable):
        executing_identity(SimpleNamespace(current_user=SimpleNamespace(me=explode)))


def test_every_other_first_use_failure_still_reports_an_empty_identity():
    """The best-effort contract above is unchanged for everything else: a live
    turn is not dropped because one round trip failed."""

    def explode():
        raise RuntimeError("PERMISSION_DENIED: no CAN QUERY on the endpoint")

    assert executing_identity(SimpleNamespace(current_user=SimpleNamespace(me=explode))) == ""


def test_the_coverage_caveat_names_the_failure_that_cannot_be_detected():
    """Row filters and column masks, which succeed and return less.

    A table the caller cannot read fails loudly and the model reports it. A row
    filter does not fail at all, so no signal exists to make this disclosure
    conditional on, which is why the caveat has to be unconditional and has to
    name the mechanism rather than gesture at "permissions".
    """

    caveat = coverage_caveat("ada@example.com")
    assert "ada@example.com" in caveat
    assert "row filters" in caveat.lower()
    assert "column masks" in caveat.lower()

    # Still says what it can when the identity would not answer, rather than
    # dropping the disclosure along with the name.
    anonymous = coverage_caveat("")
    assert "invoked this endpoint" in anonymous
    assert "row filters" in anonymous.lower()


# ---------------------------------------------------------------------------
# What the tools tell the model
# ---------------------------------------------------------------------------


def test_the_table_listing_stops_promising_readability_when_the_caller_governs():
    """`list_data_assets` is generated from the manifest, which stops meaning that.

    Under passthrough the declared list IS what the serving principal can read,
    and the tool's docstring says everything it returns is readable by
    construction. Under user authorization the manifest is only a ceiling. The
    model chooses a table from this listing, so the correction belongs in the
    listing.
    """

    declared = settings(
        declared_manifest=(
            "test_catalog.test_schema.gold_player_180d_summary",
            "test_catalog.test_schema.silver_purchases",
        )
    )
    passthrough = PlayerInsightTools(declared, SimpleNamespace())
    as_caller = PlayerInsightTools(declared, SimpleNamespace(), user_authorized=True)

    unqualified = passthrough.list_data_assets("test_catalog", "test_schema").text
    assert GRANTS_DECIDE_NOTE not in unqualified
    listing = as_caller.list_data_assets("test_catalog", "test_schema").text
    assert GRANTS_DECIDE_NOTE in listing
    # The names are still there. This adds a qualification, it does not withhold
    # the catalogue: a model that cannot see the tables asks worse questions.
    assert "gold_player_180d_summary" in listing


def test_the_listing_tells_the_model_not_to_quietly_pick_another_table():
    """The four-tables-out-of-ten failure, addressed where it would happen.

    A refusal on one table must be reported as a refusal. Substituting a table
    the caller can read and answering from that is how a partial answer becomes
    an unmarked one, and it is exactly what a helpful model does by default.
    """

    assert "Do NOT substitute a different table" in GRANTS_DECIDE_NOTE
    assert "lacks access" in GRANTS_DECIDE_NOTE


def test_the_tools_never_claim_an_authorization_they_were_not_handed():
    """The flag says what the client IS, so it may not default to the good case.

    It decides what an answer discloses about whose grants bounded it, and a
    default of True would have every answer claim it was computed under the
    reader's own access whether or not it was.
    """

    assert PlayerInsightTools(settings(), SimpleNamespace()).user_authorized is False


# ---------------------------------------------------------------------------
# How the release wires the two halves together
# ---------------------------------------------------------------------------


def test_the_declared_resources_survive_the_switch_rather_than_being_dropped():
    """They move into the system half of the policy; they do not go away.

    MLflow refuses `resources` and `auth_policy` together: "Only one of
    `resources`, and `auth_policy` can be specified." The obvious way to satisfy
    that is to drop the resource list, which would strip the serving principal of
    the LLM endpoint and every declared table and leave the agent unable to make
    its own model calls. Source-level, because `log_model.py` logs a model on
    import.
    """

    assert "SystemAuthPolicy(resources=resources)" in LOG_MODEL
    assert "UserAuthPolicy(api_scopes=list(scopes))" in LOG_MODEL
    # Exactly one of the two is ever passed, via a single splat.
    assert '{"resources": resources}' in LOG_MODEL
    assert "**authorization," in LOG_MODEL
    assert "resources=resources," not in LOG_MODEL


def test_the_release_bakes_the_mode_it_logged_and_carries_the_module():
    """One resolution decides the policy and the runtime, and both travel.

    A version logged with a user policy whose code builds a system client cannot
    authenticate at all, and vice versa. They are written from the same
    `user_auth`, and the module that reads it back has to be in `code_paths` or
    the model fails to load.
    """

    assert "MODEL_CONFIG_KEY: user_auth.enabled" in LOG_MODEL
    assert 'str(ROOT / "user_authorization.py")' in LOG_MODEL
    # The same failure the retired setup_probe.py entry was added for: a module
    # agent.py or config.py imports at scope, missing here, fails the LOAD rather
    # than the log. preflight.py is that module now: config.py takes
    # DECLARED_TABLES and BUILD_SHA_VAR from it.
    assert 'str(ROOT / "preflight.py")' in LOG_MODEL


def test_the_release_log_says_which_identity_it_just_authorized():
    """Beside the manifest, because under this flag the manifest means less."""

    assert '"execution_identity": user_auth.mode' in LOG_MODEL
    assert '"api_scopes": list(scopes)' in LOG_MODEL


def test_the_two_modes_have_names_that_can_be_reported():
    assert resolve("true").mode == USER_AUTHORIZATION
    assert resolve(None).mode == SYSTEM_PASSTHROUGH


# ---------------------------------------------------------------------------
# What the agent does with it at answer time
#
# THE CLIENT'S LIFETIME IS THE POINT. Model Serving parks the invoker's token in a
# thread-local for one request, so a client built once and kept on the agent,
# which is itself built once at import, hands the first caller's identity to
# everybody after them. No exception, and every answer looks right.
# ---------------------------------------------------------------------------


class RecordingWorkspace:
    """A stand-in for the SDK client, with an identity and a call counter."""

    built = 0

    def __init__(self, identity="ada@example.com", **kwargs):
        RecordingWorkspace.built += 1
        self.kwargs = kwargs
        self.current_user = SimpleNamespace(me=lambda: SimpleNamespace(user_name=identity))
        self.serving_endpoints = SimpleNamespace(get_open_ai_client=lambda: f"llm-{id(self)}")


@pytest.fixture
def clients(monkeypatch):
    """Both client factories replaced, and counted separately."""

    import agent as agent_module

    RecordingWorkspace.built = 0
    users: list[RecordingWorkspace] = []
    systems: list[RecordingWorkspace] = []

    def user_factory():
        client = RecordingWorkspace()
        users.append(client)
        return client

    def system_factory():
        client = RecordingWorkspace(identity="07f9fa43-system")
        systems.append(client)
        return client

    monkeypatch.setattr(agent_module, "user_authorized_client", user_factory)
    monkeypatch.setattr("databricks.sdk.WorkspaceClient", system_factory)
    return SimpleNamespace(users=users, systems=systems)


def build(user_authorization: bool):
    from agent import PlayerInsightsResponsesAgent

    return PlayerInsightsResponsesAgent(
        settings=settings(), user_authorization=user_authorization
    )


def test_a_user_authorized_client_is_never_reused_between_turns(clients):
    """Two turns, two clients. This is the whole safety property.

    Caching would be the natural thing to write (the passthrough client is
    cached three lines away), and it is the one thing that turns a governance
    feature into a data leak: caller B's question answered under caller A's
    grants, correctly formatted and confidently wrong about who may see it.
    """

    runtime = build(user_authorization=True)
    first, _ = runtime._runtime()
    second, _ = runtime._runtime()

    assert len(clients.users) == 2
    assert first.workspace is not second.workspace
    assert first is not second
    # And nothing was stashed on the agent for the next request to find.
    assert runtime._tools is None


def test_the_passthrough_client_can_no_longer_reach_a_data_tool(clients):
    """The removed fallback, at the construction site rather than at the gate.

    `_runtime` used to answer a passthrough version with a full set of data tools
    built on the endpoint's own credentials. That object is what read the
    customer's tables as us, so it is not built at all now: the gate refuses the
    request several frames earlier, and this raises if anything ever gets past it.
    """

    runtime = build(user_authorization=False)

    with pytest.raises(RuntimeError, match="no"):
        runtime._runtime()
    assert clients.users == [], "no invoker client should have been attempted"
    assert runtime._tools is None, "nothing may be cached for the next request to find"


def test_the_orchestrator_still_talks_to_the_model_as_the_system(clients):
    """The LLM call is infrastructure, and stays on the passthrough identity.

    Routing it through the caller would make CAN QUERY on the Claude endpoint a
    prerequisite for asking a question, and would hand a serving endpoint a user
    token it could use to reach scopes this agent never declared.
    """

    runtime = build(user_authorization=True)
    tools, llm = runtime._runtime()

    assert len(clients.systems) == 1
    assert llm == f"llm-{id(clients.systems[0])}"
    assert tools.workspace in clients.users


def test_the_tools_know_which_identity_they_are_holding(clients):
    """One value, because there is now only one way to get a tools object.

    The `False` half of this used to assert that the passthrough tools correctly
    labelled themselves as a service principal. Labelling it was the concession;
    building it was the defect.
    """

    assert build(user_authorization=True)._runtime()[0].user_authorized is True


def test_the_data_tools_refuse_to_be_built_without_a_client_to_read_as():
    """The other half of the same removal, one layer down.

    `PlayerInsightTools` used to build its own `WorkspaceClient` when it was
    handed none, which inside a serving container is this endpoint's own
    principal. Both callers always passed one, so the default was invisible and
    would have been the way back in.
    """

    from tools import PlayerInsightTools

    with pytest.raises(ValueError, match="no default"):
        PlayerInsightTools(settings(), None)


def test_an_agent_asked_for_nothing_in_particular_behaves_as_it_does_today():
    """The default, asserted rather than assumed.

    Nothing about the currently deployed path may change for anyone who does not
    opt in, and the test process bakes no configuration, which is the same state
    a version logged before this existed is in.
    """

    from agent import PlayerInsightsResponsesAgent

    assert PlayerInsightsResponsesAgent(settings=settings()).user_authorization is False


def answer_under(user_authorization: bool, identity: str):
    from agent import LoopOutcome, PlayerInsightsResponsesAgent, RunLog, Synthesis

    runtime = PlayerInsightsResponsesAgent(
        settings=settings(),
        tools=SimpleNamespace(),  # type: ignore[arg-type]
        llm_client=object(),
        user_authorization=user_authorization,
    )
    log = RunLog()
    log.executed_as = identity
    # A run that read something, so the disclosure under test is not competing
    # with "no governed table was read for this answer", which is inserted ahead
    # of it, correctly: an answer grounded in nothing is a bigger problem than an
    # answer grounded in a subset.
    log.sources = ["test_catalog.test_schema.gold_player_180d_summary"]
    return runtime._answer(
        "run-1",
        "tr-1",
        Synthesis(takeaway="Active players rose.", narrative="They did."),
        [],
        log,
        LoopOutcome(answer_text="They did."),
    )


def test_an_answer_computed_under_a_caller_says_whose_grants_bounded_it():
    """First in the list, because it changes what every figure below it is about.

    Under passthrough an answer's coverage is the declared manifest and is the
    same for every reader. Under user authorization it is whatever that caller
    happens to hold, and the run cannot measure how much was left out.
    """

    caveats = answer_under(True, "ada@example.com").caveats
    assert caveats[0] == coverage_caveat("ada@example.com")
    assert "ada@example.com" in caveats[0]


def test_an_answer_under_passthrough_gains_no_such_caveat():
    """Nothing on the deployed path changes, including what it says about itself."""

    caveats = answer_under(False, "").caveats
    assert not any("row filters" in caveat.lower() for caveat in caveats)


def test_the_disclosure_survives_an_identity_that_would_not_answer():
    """An unknown identity narrows the claim; it does not drop the disclosure."""

    caveats = answer_under(True, "").caveats
    assert caveats[0] == coverage_caveat("")
