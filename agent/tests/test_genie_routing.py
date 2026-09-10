import base64
import json
from pathlib import Path

import pytest

import agent
import genie_routing

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "genie_mcp_node_capability.json").read_text()
)


def names(tools):
    return [tool["function"]["name"] for tool in tools]


def test_default_turn_exposes_direct_genie_only():
    genie_routing.clear()
    genie_routing.consume({})
    genie_routing.activate(
        {},
        public_key_pem="",
        request_id="request-direct",
        observed_user="reader@example.com",
    )
    assert "data_genie" in names(agent._finder_tools())
    assert "genie_mcp" not in names(agent._finder_tools())


def test_node_generated_signature_verifies_in_python_and_enables_mcp():
    genie_routing.clear()
    custom_inputs = {
        "genie_transport": "mcp",
        "genie_mcp_capability": FIXTURE["capability"],
    }
    genie_routing.consume(custom_inputs)

    selected = genie_routing.activate(
        custom_inputs,
        public_key_pem=FIXTURE["public_key_pem"],
        request_id=FIXTURE["request_id"],
        observed_user=FIXTURE["subject"],
        now=FIXTURE["now"],
    )

    assert selected == "mcp"
    assert "genie_mcp_capability" not in custom_inputs
    assert "genie_mcp" in names(agent._finder_tools())
    assert "data_genie" not in names(agent._finder_tools())
    assert genie_routing.trace_metadata() == {
        "genie.transport": "mcp",
        "genie.capability_verification": "verified",
    }


@pytest.mark.parametrize("capability", ["", "not-valid-base64.***"])
def test_direct_endpoint_spoof_without_valid_signature_cannot_select_managed_genie(
    capability,
):
    genie_routing.clear()
    custom_inputs = {
        "genie_transport": "mcp",
        "genie_mcp_capability": capability,
    }
    genie_routing.consume(custom_inputs)

    with pytest.raises(genie_routing.UntrustedGenieTransport):
        genie_routing.activate(
            custom_inputs,
            public_key_pem=FIXTURE["public_key_pem"],
            request_id=FIXTURE["request_id"],
            observed_user=FIXTURE["subject"],
            now=FIXTURE["now"],
        )

    assert "data_genie" in names(agent._finder_tools())
    assert "genie_mcp" not in names(agent._finder_tools())
    assert genie_routing.trace_metadata() == {
        "genie.transport": "direct",
        "genie.capability_verification": "refused",
    }


def test_unknown_transport_is_refused():
    custom_inputs = {"genie_transport": "client-selected"}
    genie_routing.consume(custom_inputs)
    with pytest.raises(genie_routing.InvalidGenieTransport):
        genie_routing.activate(
            custom_inputs,
            public_key_pem=FIXTURE["public_key_pem"],
            request_id=FIXTURE["request_id"],
            observed_user=FIXTURE["subject"],
            now=FIXTURE["now"],
        )


@pytest.mark.parametrize(
    ("request_id", "observed_user", "now"),
    [
        ("another-request", FIXTURE["subject"], FIXTURE["now"]),
        (FIXTURE["request_id"], "somebody-else@example.com", FIXTURE["now"]),
        (FIXTURE["request_id"], FIXTURE["subject"], 2000000050),
    ],
)
def test_capability_is_bound_to_request_user_and_expiry(request_id, observed_user, now):
    custom_inputs = {
        "genie_transport": "mcp",
        "genie_mcp_capability": FIXTURE["capability"],
    }
    genie_routing.consume(custom_inputs)

    with pytest.raises(genie_routing.UntrustedGenieTransport):
        genie_routing.activate(
            custom_inputs,
            public_key_pem=FIXTURE["public_key_pem"],
            request_id=request_id,
            observed_user=observed_user,
            now=now,
        )


def test_tampered_capability_fails_without_echoing_signing_material():
    body, signature = FIXTURE["capability"].split(".")
    payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    payload["transport"] = "direct"
    tampered = (
        base64.urlsafe_b64encode(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        )
        .rstrip(b"=")
        .decode()
        + "."
        + signature
    )
    custom_inputs = {
        "genie_transport": "mcp",
        "genie_mcp_capability": tampered,
    }
    genie_routing.consume(custom_inputs)

    with pytest.raises(
        genie_routing.UntrustedGenieTransport,
        match="signing material was redacted",
    ) as raised:
        genie_routing.activate(
            custom_inputs,
            public_key_pem=FIXTURE["public_key_pem"],
            request_id=FIXTURE["request_id"],
            observed_user=FIXTURE["subject"],
            now=FIXTURE["now"],
        )

    assert tampered not in str(raised.value)
