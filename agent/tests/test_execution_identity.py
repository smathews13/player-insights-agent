"""The gate that decides whether a question runs at all.

The property under test is negative and easy to lose: no request that cannot be
attributed to the person asking it reaches a Genie space, a warehouse, or an
orchestrator call. Every assertion about what a refused turn RETURNS is secondary
to the assertions about what it did not DO, because a refusal that has already
read three tables has not refused anything.

NOT COVERED, because it needs a logged version on a real endpoint: whether Model
Serving actually parks a downscoped invoker token, and whether the account name
`current_user.me()` reports for a forwarded user token is the same string the app
resolves from `x-forwarded-email`. Those are asserted against a deployment, and
this file asserts what the agent does with the answer.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from mlflow.types.responses import ResponsesAgentRequest

import execution_identity
from config import Settings
from execution_identity import (
    IDENTITY_MISMATCH,
    IDENTITY_REQUIRED,
    MESSAGE_MAX,
    REFUSAL_MESSAGE,
    SERVICE_PRINCIPAL,
    SIGNED_IN_USER,
    USER_CREDENTIALS_UNAVAILABLE_MESSAGE,
    Requirement,
    credentials_unavailable,
    effective_mode,
    requirement,
    same_identity,
    verify,
)
from user_authorization import UserCredentialsUnavailable

#: What the SDK raises when the serving environment holds no downscoped user
#: token, quoted as a customer received it inside an HTTP 400.
SDK_NO_CREDENTIAL = (
    "model_serving_user_credentials auth: Unable to authenticate using "
    "user_credentials in Databricks Model Serving Environment"
)

ADA = "ada@example.com"
LOG_MODEL = (Path(__file__).resolve().parents[1] / "log_model.py").read_text()


def test_the_gate_is_packaged_into_the_artifact():
    """`agent.py` imports this at module scope, so a version logged without it
    does not fail open: it fails to load. Asserted anyway, because a release
    that cannot start is still a release nobody can use."""

    assert 'str(ROOT / "execution_identity.py")' in LOG_MODEL


# ---------------------------------------------------------------------------
# Reading the request
# ---------------------------------------------------------------------------


def test_a_request_that_says_nothing_produces_an_empty_requirement():
    """Absent fields must arrive at the gate as a refusal, not as a KeyError."""

    assert requirement(None) == Requirement()
    assert requirement({}) == Requirement()


def test_fields_that_are_not_strings_are_read_as_absent():
    """The body is untrusted. A caller cannot smuggle a mode in as a truthy int."""

    parsed = requirement(
        {
            "identity_mode": 1,
            "expected_user": ["ada@example.com"],
            "request_id": None,
            "run_id": {"nested": "run"},
        }
    )

    assert parsed == Requirement()


def test_whitespace_is_not_an_identity():
    assert requirement({"expected_user": "   "}).expected_user == ""


# ---------------------------------------------------------------------------
# Comparing two identities
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "expected,observed",
    [
        (ADA, ADA),
        (ADA, "Ada@Example.com"),
        ("Ada@Example.COM", ADA),
        (ADA, f"  {ADA}  "),
    ],
)
def test_the_same_account_written_differently_is_the_same_account(expected, observed):
    """Directories disagree on casing constantly, and a gate that refuses on it
    refuses every user whose address is stored capitalised."""

    assert same_identity(expected, observed) is True


@pytest.mark.parametrize(
    "observed",
    [
        "grace@example.com",
        "ada@other-tenant.com",
        "ada+reports@example.com",
        "ca9f730e-0000-0000-0000-000000004153",
        "",
    ],
)
def test_a_different_principal_is_never_folded_into_the_expected_one(observed):
    """A plus-address, another tenant and a service-principal UUID are all
    genuinely different accounts with genuinely different grants."""

    assert same_identity(ADA, observed) is False


def test_an_absent_expectation_matches_nothing_including_itself():
    """Otherwise "" == "" admits a request that named nobody to an endpoint that
    would say nobody."""

    assert same_identity("", "") is False


# ---------------------------------------------------------------------------
# The decision
# ---------------------------------------------------------------------------


def user_request(**overrides) -> Requirement:
    return Requirement(
        **{
            "mode": SIGNED_IN_USER,
            "expected_user": ADA,
            "request_id": "req-1",
            "run_id": "run-1",
            **overrides,
        }
    )


def test_the_named_user_executing_as_themselves_is_allowed_through():
    assert verify(user_request(), user_authorization=True, observed=ADA) is None


def test_a_request_naming_nobody_is_refused_rather_than_run_as_the_app():
    """The escape hatch this closes: omit a field, get a service principal.

    A version with a user auth policy has no analytical service-principal path,
    so a request with no user to attribute it to has nowhere to go.
    """

    refusal = verify(Requirement(), user_authorization=True, observed=ADA)

    assert refusal is not None
    assert refusal.code == IDENTITY_REQUIRED


def test_asking_explicitly_for_the_service_principal_is_refused_too():
    """Being explicit about wanting the privileged path is not an argument for it."""

    refusal = verify(user_request(mode=SERVICE_PRINCIPAL), user_authorization=True, observed=ADA)

    assert refusal is not None
    assert refusal.code == IDENTITY_REQUIRED


def test_a_mode_with_no_user_named_is_refused():
    refusal = verify(user_request(expected_user=""), user_authorization=True, observed=ADA)

    assert refusal is not None
    assert refusal.code == IDENTITY_REQUIRED


def test_an_unreadable_invoker_is_refused_and_not_shrugged_at():
    """THE SILENT FALLBACK, which is the failure this whole gate exists for.

    With no invoker token the SDK does not raise: it resolves the passthrough
    principal and answers normally, reading every table the manifest granted.
    From inside the container that is indistinguishable from an identity that
    could not be read, so both are refused.
    """

    refusal = verify(user_request(), user_authorization=True, observed="")

    assert refusal is not None
    assert refusal.code == IDENTITY_REQUIRED


def test_executing_as_somebody_other_than_the_asker_is_a_mismatch():
    refusal = verify(user_request(), user_authorization=True, observed="grace@example.com")

    assert refusal is not None
    assert refusal.code == IDENTITY_MISMATCH


def test_the_service_principal_the_app_authenticates_as_is_a_mismatch():
    """The specific shape of the bug: the app forwarded no token, so the invoker
    is the app itself, and the run would have been attributed to the human."""

    refusal = verify(
        user_request(),
        user_authorization=True,
        observed="ca9f730e-0000-0000-0000-000000004153",
    )

    assert refusal is not None
    assert refusal.code == IDENTITY_MISMATCH


def test_no_refusal_is_ever_retryable():
    """A retryable refusal is one an interface will quietly retry until some
    other principal succeeds at it."""

    for observed in ("", "grace@example.com"):
        refusal = verify(user_request(), user_authorization=True, observed=observed)
        assert refusal is not None
        assert refusal.retryable is False
        assert refusal.layer == "identity"


def test_the_user_is_told_the_same_thing_whichever_check_failed():
    """Which check fired is a fact about our deployment, not about them, and the
    difference is only actionable to somebody reading the trace."""

    messages = {
        verify(required, user_authorization=True, observed=observed).message  # type: ignore[union-attr]
        for required, observed in (
            (Requirement(), ADA),
            (user_request(), ""),
            (user_request(), "grace@example.com"),
        )
    }

    assert len(messages) == 1


def test_the_detail_that_names_accounts_never_reaches_the_user():
    """The operator needs both account names to diagnose it; the caller must not
    learn which account the endpoint believes it is running as."""

    refusal = verify(user_request(), user_authorization=True, observed="grace@example.com")

    assert refusal is not None
    assert "grace@example.com" in refusal.detail
    assert "grace@example.com" not in refusal.message
    assert ADA not in refusal.message


# ---------------------------------------------------------------------------
# The other direction: a version that cannot run as a user
# ---------------------------------------------------------------------------


def test_a_passthrough_version_refuses_a_request_that_asks_for_a_user():
    """Fails closed both ways. An app pointed at the wrong endpoint is told,
    rather than served by a service principal under a `signed_in_user` label."""

    refusal = verify(user_request(), user_authorization=False, observed="")

    assert refusal is not None
    assert refusal.code == IDENTITY_REQUIRED


def test_a_passthrough_version_refuses_every_request_including_ones_naming_no_user():
    """THE FALLBACK. A version with no user auth policy can only read the data as
    itself, so it now answers nothing rather than answering as itself.

    Both requests below used to be served. Omitting `identity_mode` was enough:
    a caller that named nobody got real figures out of the customer's tables,
    computed under grants that were not theirs and indistinguishable, on the
    screen, from an answer computed under their own.
    """

    for request in (Requirement(), Requirement(mode=SERVICE_PRINCIPAL)):
        refusal = verify(request, user_authorization=False, observed="")
        assert refusal is not None, f"{request.mode or 'an unlabelled request'} was served"
        assert refusal.code == IDENTITY_REQUIRED
        assert refusal.retryable is False


def test_a_passthrough_version_refuses_even_when_it_can_name_its_own_principal():
    """An identity it CAN read is still not the asker's, so it is not a way in."""

    refusal = verify(Requirement(), user_authorization=False, observed="app-sp-1234")

    assert refusal is not None
    assert refusal.code == IDENTITY_REQUIRED


# ---------------------------------------------------------------------------
# What the trace records
# ---------------------------------------------------------------------------


def test_the_effective_mode_is_derived_and_not_taken_from_the_request():
    """A request cannot label itself as having executed as its user."""

    assert effective_mode(user_authorization=True, verified=True) == SIGNED_IN_USER
    assert effective_mode(user_authorization=True, verified=False) == SERVICE_PRINCIPAL
    assert effective_mode(user_authorization=False, verified=True) == SERVICE_PRINCIPAL


def test_the_trace_records_both_modes_and_the_policy_that_decided():
    attributes = execution_identity.trace_attributes(
        user_request(), user_authorization=True, verified=True
    )

    assert attributes["identity.requested_mode"] == SIGNED_IN_USER
    assert attributes["identity.effective_mode"] == SIGNED_IN_USER
    assert attributes["identity.verified"] is True
    assert attributes["identity.policy_version"] == execution_identity.POLICY_VERSION


def test_a_request_that_named_no_mode_records_that_rather_than_a_blank():
    """An empty attribute reads as a trace that was not instrumented."""

    attributes = execution_identity.trace_attributes(
        Requirement(), user_authorization=False, verified=False
    )

    assert attributes["identity.requested_mode"] == "unset"
    assert attributes["identity.effective_mode"] == SERVICE_PRINCIPAL


def test_no_trace_attribute_can_carry_a_credential():
    """Nothing here reads a token or a claim, so this asserts the shape stays
    that way: every value is one of two identities already stored in the clear."""

    attributes = execution_identity.trace_attributes(
        user_request(), user_authorization=True, verified=True
    )

    assert set(attributes) == {
        "identity.requested_mode",
        "identity.effective_mode",
        "identity.verified",
        "identity.policy_version",
    }


# ---------------------------------------------------------------------------
# The gate in the agent, which is where it has to hold
# ---------------------------------------------------------------------------


class RefusingTools:
    """Tools that fail the test if the gate let anything reach them."""

    def __init__(self):
        self.workspace = SimpleNamespace(
            current_user=SimpleNamespace(me=lambda: SimpleNamespace(user_name=ADA))
        )
        self.user_authorized = True
        self.settings = Settings.from_env()

    def __getattr__(self, name):
        raise AssertionError(f"a refused turn called {name}")


class RefusingLlm:
    def __init__(self):
        self.chat = SimpleNamespace(
            completions=SimpleNamespace(create=self._explode),
        )

    @staticmethod
    def _explode(**_kwargs):
        raise AssertionError("a refused turn spent an orchestrator call")


def gated(monkeypatch, observed: str):
    """An agent under user authorization whose invoker reports `observed`."""

    import agent as agent_module

    monkeypatch.setattr(
        agent_module,
        "user_authorized_client",
        lambda: SimpleNamespace(
            current_user=SimpleNamespace(me=lambda: SimpleNamespace(user_name=observed))
        ),
    )
    return agent_module.PlayerInsightsResponsesAgent(
        settings=Settings.from_env(),
        tools=RefusingTools(),  # type: ignore[arg-type]
        llm_client=RefusingLlm(),
        user_authorization=True,
    )


def ask(runtime, **custom_inputs):
    return runtime.predict(
        ResponsesAgentRequest(
            input=[{"role": "user", "content": "Compare active players by label."}],
            custom_inputs={"execute_plan": True, **custom_inputs},
        )
    )


def test_a_mismatched_identity_never_reaches_a_tool_or_the_model(monkeypatch):
    """`RefusingTools` and `RefusingLlm` raise on any use, so this passes only if
    the turn stopped before planning as well as before execution."""

    response = ask(
        gated(monkeypatch, observed="grace@example.com"),
        identity_mode=SIGNED_IN_USER,
        expected_user=ADA,
        request_id="req-7",
    )

    assert response.custom_outputs["code"] == IDENTITY_MISMATCH


def test_a_refused_turn_carries_no_analysis_of_any_kind(monkeypatch):
    """An `unavailable` result with a takeaway or a source is a degraded answer
    wearing a refusal's name, and the client will render whichever it finds."""

    outputs = ask(
        gated(monkeypatch, observed=""),
        identity_mode=SIGNED_IN_USER,
        expected_user=ADA,
        run_id="run-7",
    ).custom_outputs

    assert outputs["type"] == "unavailable"
    assert outputs["code"] == IDENTITY_REQUIRED
    for absent in ("answer", "plan", "clarification", "takeaway", "figures", "sql", "sources"):
        assert absent not in outputs


def test_a_refusal_carries_the_correlation_ids_back(monkeypatch):
    """Without them the user has nothing to quote and the run cannot be found."""

    outputs = ask(
        gated(monkeypatch, observed="grace@example.com"),
        identity_mode=SIGNED_IN_USER,
        expected_user=ADA,
        request_id="req-7",
        run_id="run-7",
    ).custom_outputs

    assert outputs["request_id"] == "req-7"
    assert outputs["run_id"] == "run-7"
    assert outputs["execution_identity"] == {"mode": SIGNED_IN_USER, "verified": False}


def test_a_refusal_tells_the_caller_nothing_about_the_endpoints_own_identity(monkeypatch):
    """The whole serialized response, not just the message: a caller who cannot
    be authorized must not learn which account the endpoint runs as."""

    response = ask(
        gated(monkeypatch, observed="grace@example.com"),
        identity_mode=SIGNED_IN_USER,
        expected_user=ADA,
    )
    serialized = response.model_dump_json()

    assert "grace@example.com" not in serialized


def test_the_gate_asks_the_invoker_before_it_builds_any_tools(monkeypatch):
    """The observation has to come from its own client. Building the runtime
    first would put a Genie space and a warehouse behind a refused request."""

    import agent as agent_module

    asked: list[str] = []

    def factory():
        asked.append("me")
        return SimpleNamespace(
            current_user=SimpleNamespace(me=lambda: SimpleNamespace(user_name="grace@x.com"))
        )

    monkeypatch.setattr(agent_module, "user_authorized_client", factory)
    runtime = agent_module.PlayerInsightsResponsesAgent(
        settings=Settings.from_env(),
        tools=RefusingTools(),  # type: ignore[arg-type]
        llm_client=RefusingLlm(),
        user_authorization=True,
    )

    ask(runtime, identity_mode=SIGNED_IN_USER, expected_user=ADA)

    assert asked == ["me"]


def test_a_passthrough_agent_does_not_ask_an_invoker_that_does_not_exist(monkeypatch):
    """One round trip per turn is the price of the gate, and it is not charged
    to a build that has no invoker to ask about."""

    import agent as agent_module

    def explode():
        raise AssertionError("passthrough built a user-authorized client")

    monkeypatch.setattr(agent_module, "user_authorized_client", explode)
    runtime = agent_module.PlayerInsightsResponsesAgent(
        settings=Settings.from_env(),
        tools=RefusingTools(),  # type: ignore[arg-type]
        llm_client=RefusingLlm(),
        user_authorization=False,
    )

    assert runtime._invoker_identity() == ""


def test_two_concurrent_callers_are_gated_against_their_own_identities(monkeypatch):
    """Nothing about one turn's identity may survive into the next.

    Sequential here rather than threaded, which is the weaker test and the one
    worth having: an identity cached anywhere on the agent fails this, and a
    threaded version would fail it intermittently instead.
    """

    import agent as agent_module

    invokers = iter([ADA, "grace@example.com"])

    def next_invoker():
        name = next(invokers)
        return SimpleNamespace(
            current_user=SimpleNamespace(me=lambda: SimpleNamespace(user_name=name))
        )

    monkeypatch.setattr(agent_module, "user_authorized_client", next_invoker)
    runtime = agent_module.PlayerInsightsResponsesAgent(
        settings=Settings.from_env(),
        tools=RefusingTools(),  # type: ignore[arg-type]
        llm_client=RefusingLlm(),
        user_authorization=True,
    )

    # Grace asks first and the endpoint is executing as Ada: refused.
    first = ask(runtime, identity_mode=SIGNED_IN_USER, expected_user="grace@example.com")
    # Ada asks second and the endpoint is executing as Grace: also refused. If
    # the first turn's identity had been kept, this one would have been allowed.
    second = ask(runtime, identity_mode=SIGNED_IN_USER, expected_user=ADA)

    assert first.custom_outputs["code"] == IDENTITY_MISMATCH
    assert second.custom_outputs["code"] == IDENTITY_MISMATCH


# ---------------------------------------------------------------------------
# The endpoint deployed without on-behalf-of-user forwarding
#
# A customer's first question came back as HTTP 400 with the SDK's
# `model_serving_user_credentials auth:` sentence and nothing else. The turn is
# still refused -- it must be -- but it is refused in the shape the app already
# reads, carrying a sentence that names the fix.
# ---------------------------------------------------------------------------


def test_the_message_stays_inside_the_cap_every_refusal_channel_uses():
    """A message truncated in one surface and whole in another reads as two
    different faults, and this one has to survive intact to be actionable."""

    assert len(USER_CREDENTIALS_UNAVAILABLE_MESSAGE) <= MESSAGE_MAX
    assert len(credentials_unavailable("x").message) <= MESSAGE_MAX


def test_the_message_names_the_cause_the_fix_and_the_non_fixes():
    """Asserted on the sentence rather than trusted to review. Each clause here
    is one of the four things an operator tried on the real incident."""

    message = credentials_unavailable(SDK_NO_CREDENTIAL).message

    assert "user-authorization credential forwarding" in message
    assert "re-logging the model and redeploying" in message
    assert "release script" in message
    assert "restart" in message and "grant" in message
    # It is a fault in the deployment, so it must not be described in terms of
    # the reader's own permissions or session.
    assert REFUSAL_MESSAGE not in message


def test_the_sdk_sentence_goes_to_the_log_and_not_to_the_reader():
    """The same rule every other refusal detail follows: what an operator needs
    is in the endpoint's log, and the response says nothing about the endpoint's
    own identity or the SDK's internals."""

    refusal = credentials_unavailable(SDK_NO_CREDENTIAL)

    assert SDK_NO_CREDENTIAL in refusal.detail
    assert SDK_NO_CREDENTIAL not in refusal.message
    assert refusal.layer == "identity"
    assert refusal.retryable is False


def test_a_serving_environment_with_no_credential_refuses_instead_of_raising(monkeypatch):
    """The whole point. Before this the ValueError left `predict` unhandled and
    the caller received a raw 400; now it is the app's `unavailable` envelope."""

    import agent as agent_module

    def no_credential():
        raise ValueError(SDK_NO_CREDENTIAL)

    monkeypatch.setattr(agent_module, "user_authorized_client", no_credential)
    runtime = agent_module.PlayerInsightsResponsesAgent(
        settings=Settings.from_env(),
        tools=RefusingTools(),  # type: ignore[arg-type]
        llm_client=RefusingLlm(),
        user_authorization=True,
    )

    outputs = ask(
        runtime, identity_mode=SIGNED_IN_USER, expected_user=ADA, request_id="req-9"
    ).custom_outputs

    assert outputs["type"] == "unavailable"
    # The code the app already knows, so this cannot arrive at an older app build
    # as an unrecognised failure from a mismatched release.
    assert outputs["code"] == IDENTITY_REQUIRED
    assert outputs["message"] == USER_CREDENTIALS_UNAVAILABLE_MESSAGE
    assert outputs["request_id"] == "req-9"
    for absent in ("answer", "takeaway", "figures", "sql", "sources"):
        assert absent not in outputs


def test_a_credential_that_fails_on_the_first_call_refuses_the_same_way(monkeypatch):
    """Construction succeeding and `me()` refusing is the same deployment fault
    seen one frame later, and must not become "sign in again"."""

    import agent as agent_module

    def lazily_broken():
        def explode():
            raise ValueError(SDK_NO_CREDENTIAL)

        return SimpleNamespace(current_user=SimpleNamespace(me=explode))

    monkeypatch.setattr(agent_module, "user_authorized_client", lazily_broken)
    runtime = agent_module.PlayerInsightsResponsesAgent(
        settings=Settings.from_env(),
        tools=RefusingTools(),  # type: ignore[arg-type]
        llm_client=RefusingLlm(),
        user_authorization=True,
    )

    outputs = ask(runtime, identity_mode=SIGNED_IN_USER, expected_user=ADA).custom_outputs

    assert outputs["message"] == USER_CREDENTIALS_UNAVAILABLE_MESSAGE


def test_a_genuinely_different_auth_failure_is_re_raised_untouched(monkeypatch):
    """No catch-all. An unreachable workspace must not be reported as an endpoint
    that needs redeploying, because the reader would believe it."""

    import agent as agent_module

    original = TimeoutError("the workspace did not answer in time")

    def unreachable():
        raise original

    monkeypatch.setattr(agent_module, "user_authorized_client", unreachable)
    runtime = agent_module.PlayerInsightsResponsesAgent(
        settings=Settings.from_env(),
        tools=RefusingTools(),  # type: ignore[arg-type]
        llm_client=RefusingLlm(),
        user_authorization=True,
    )

    with pytest.raises(TimeoutError) as raised:
        ask(runtime, identity_mode=SIGNED_IN_USER, expected_user=ADA)

    assert raised.value is original


def test_the_unreadable_identity_refusal_is_still_the_generic_one(monkeypatch):
    """The narrow catch must not have widened into the neighbouring case: a
    client that answers `me()` with nothing is a silent fallback, not a missing
    credential, and keeps the sentence it always had."""

    outputs = ask(
        gated(monkeypatch, observed=""), identity_mode=SIGNED_IN_USER, expected_user=ADA
    ).custom_outputs

    assert outputs["message"] == REFUSAL_MESSAGE
    assert UserCredentialsUnavailable.__name__ not in str(outputs)
