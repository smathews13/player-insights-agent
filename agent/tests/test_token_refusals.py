"""The four ways a credential reaching the agent must be refused, with no data.

A mismatched user, an expired credential, a token missing a scope, and a
replayed capability, including one replayed against another deployment. Each
must end in a refusal before any data call, or in a refusal the reader can act
on when the platform itself refuses the call.
"""

import base64
import json
import secrets
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import agent
import execution_identity
import genie_routing
import user_authorization

USER = "reader@example.com"
NOW = 2_000_000_000
REQUEST = "request-1"


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


class Deployment:
    """One deployment's signing pair, as genie-mcp-signing-key.sh creates it."""

    def __init__(self) -> None:
        self.private = Ed25519PrivateKey.generate()
        encoding, layout = (
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        self.public_pem = self.private.public_key().public_bytes(encoding, layout).decode()

    def capability(self, **overrides) -> str:
        payload = {
            "aud": genie_routing.AUDIENCE,
            "exp": NOW + 30,
            "iat": NOW,
            "jti": secrets.token_hex(16),
            "purpose": genie_routing.PURPOSE,
            "request_id": REQUEST,
            "sub": USER,
            "transport": genie_routing.MCP,
            "v": genie_routing.VERSION,
            **overrides,
        }
        body = b64(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())
        return f"{body}.{b64(self.private.sign(body.encode('ascii')))}"


def present(capability: str, public_pem: str, *, user: str = USER, now: int = NOW) -> str:
    custom_inputs = {"genie_transport": "mcp", "genie_mcp_capability": capability}
    genie_routing.consume(custom_inputs)
    return genie_routing.activate(
        custom_inputs, public_key_pem=public_pem, request_id=REQUEST, observed_user=user, now=now
    )


def required(user: str = USER) -> execution_identity.Requirement:
    return execution_identity.Requirement(
        mode=execution_identity.SIGNED_IN_USER, expected_user=user, request_id=REQUEST
    )


# --- 1. Mismatched user -------------------------------------------------------


def test_a_token_for_another_user_is_refused_before_any_data_call():
    refusal = execution_identity.verify(
        required(), user_authorization=True, observed="somebody-else@example.com"
    )
    assert refusal is not None
    assert refusal.code == execution_identity.IDENTITY_MISMATCH


def test_a_capability_signed_for_another_user_is_refused():
    deployment = Deployment()
    with pytest.raises(genie_routing.UntrustedGenieTransport):
        present(deployment.capability(sub="somebody-else@example.com"), deployment.public_pem)


# --- 2. Expired credential ----------------------------------------------------


def test_an_expired_capability_is_refused():
    deployment = Deployment()
    with pytest.raises(genie_routing.UntrustedGenieTransport):
        present(deployment.capability(), deployment.public_pem, now=NOW + 31)


def test_an_expired_user_token_leaves_no_identity_and_the_turn_is_refused():
    class Expired(Exception):
        pass

    def me():
        raise Expired("Unauthenticated: Token is expired")

    client = SimpleNamespace(current_user=SimpleNamespace(me=me))
    observed = user_authorization.executing_identity(client)
    assert observed == ""
    refusal = execution_identity.verify(required(), user_authorization=True, observed=observed)
    assert refusal is not None
    assert refusal.code == execution_identity.IDENTITY_REQUIRED


# --- 3. Token missing a scope -------------------------------------------------

MISSING_SCOPE = "Provided OAuth token does not have required scopes: sql"


@pytest.mark.parametrize(
    "classify",
    [
        lambda error: agent.sql_object_denial(error, USER),
        lambda error: agent.genie_access_denial(error, "space-1", USER),
    ],
    ids=["sql", "genie"],
)
def test_a_token_missing_a_scope_is_reported_as_that_and_reads_nothing(classify):
    error = Exception(MISSING_SCOPE)
    error.status_code = 403
    message = classify(error)
    assert message is not None
    assert "does not carry the API scope" in message
    assert "nothing was read" in message
    assert "GRANT" not in message
    assert "share the space" not in message


def test_an_ordinary_grant_denial_is_not_mistaken_for_a_missing_scope():
    assert agent.scope_denial(Exception("[INSUFFICIENT_PERMISSIONS] SELECT on table")) is None


def test_the_agent_asks_only_for_the_scopes_its_calls_need():
    settings = SimpleNamespace(
        data_genie_space_id="space-1",
        dictionary_genie_space_id="",
        warehouse_id="wh-1",
        llm_gateway="",
        llm_gateway_endpoint="",
        semantic_index="",
    )
    assert user_authorization.api_scopes(settings) == ("dashboards.genie", "genie", "sql")


# --- 4. Replay ----------------------------------------------------------------


def test_a_capability_is_single_use():
    deployment = Deployment()
    capability = deployment.capability()
    assert present(capability, deployment.public_pem) == genie_routing.MCP
    with pytest.raises(genie_routing.UntrustedGenieTransport):
        present(capability, deployment.public_pem)


def test_a_capability_replayed_on_another_deployment_is_refused():
    ours, theirs = Deployment(), Deployment()
    with pytest.raises(genie_routing.UntrustedGenieTransport):
        present(ours.capability(), theirs.public_pem)


def test_a_capability_replayed_for_another_request_is_refused():
    deployment = Deployment()
    with pytest.raises(genie_routing.UntrustedGenieTransport):
        present(deployment.capability(request_id="request-2"), deployment.public_pem)


def test_spent_ids_are_forgotten_once_they_could_no_longer_verify():
    deployment = Deployment()
    present(deployment.capability(), deployment.public_pem)
    later = NOW + 120
    present(deployment.capability(iat=later, exp=later + 30), deployment.public_pem, now=later)
    assert len(genie_routing._SPENT) == 1


# --- Signing key rotation -----------------------------------------------------


def test_during_a_rotation_both_the_previous_and_the_new_key_verify():
    previous, current = Deployment(), Deployment()
    trusted = current.public_pem + previous.public_pem
    assert present(previous.capability(), trusted) == genie_routing.MCP
    assert present(current.capability(), trusted) == genie_routing.MCP


def test_a_retired_key_stops_verifying_once_it_is_no_longer_baked():
    retired, current = Deployment(), Deployment()
    with pytest.raises(genie_routing.UntrustedGenieTransport):
        present(retired.capability(), current.public_pem)


def test_more_than_two_trusted_keys_is_refused_rather_than_trimmed():
    keys = [Deployment() for _ in range(3)]
    with pytest.raises(genie_routing.UntrustedGenieTransport):
        present(keys[0].capability(), "".join(key.public_pem for key in keys))


def test_no_trusted_key_is_refused():
    with pytest.raises(genie_routing.UntrustedGenieTransport):
        present(Deployment().capability(), "")
