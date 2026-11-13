"""Traces never carry credentials or player identity values.

Token-shaped values are assembled at runtime so this file holds none.
"""

from __future__ import annotations

import mlflow
import pytest

import trace_redaction
from trace_redaction import REDACTED, redact, redact_span

PAT = "dapi" + "0123456789abcdef" * 2
JWT = "eyJ" + "a" * 20 + ".eyJ" + "b" * 20 + "." + "c" * 20
PEM = "-----BEGIN " + "PRIVATE KEY-----\nMIIEv" + "Q" * 40 + "\n-----END " + "PRIVATE KEY-----"


def test_credential_and_identity_keys_are_redacted_at_any_depth():
    cleaned = redact(
        {
            "headers": {"Authorization": "Bearer abcdefghijkl", "accept": "json"},
            "rows": [{"crm_customer_ref": "c-1", "player_id": "p-1", "sessions": 4}],
            "client_secret": "s",
            "genie_mcp_capability": "body.signature",
        }
    )
    assert cleaned == {
        "headers": {"Authorization": REDACTED, "accept": "json"},
        "rows": [{"crm_customer_ref": REDACTED, "player_id": REDACTED, "sessions": 4}],
        "client_secret": REDACTED,
        "genie_mcp_capability": REDACTED,
    }


def test_token_shaped_text_is_scrubbed_inside_free_text():
    text = f"used {PAT} then Bearer {JWT} and {PEM} done"
    cleaned = redact(text)
    for secret in (PAT, JWT, "MIIEv"):
        assert secret not in cleaned
    assert cleaned.startswith("used ") and cleaned.endswith(" done")


def test_the_asker_and_ordinary_values_are_kept():
    value = {"expected_user": "reader@example.com", "email": "reader@example.com", "count": 3}
    assert redact(value) == value
    assert redact("Sessions rose 4% week over week.") == "Sessions rose 4% week over week."


class FakeSpan:
    def __init__(self, inputs, outputs, attributes):
        self.inputs, self.outputs, self.attributes = inputs, outputs, dict(attributes)

    def set_inputs(self, value):
        self.inputs = value

    def set_outputs(self, value):
        self.outputs = value

    def set_attribute(self, key, value):
        self.attributes[key] = value


def test_the_span_processor_rewrites_inputs_outputs_and_attributes():
    span = FakeSpan(
        {"token": PAT, "question": "How many players?"},
        {"text": f"Bearer {JWT}"},
        {"authorization": "x", "note": f"key {PAT}", "mlflow.spanType": "TOOL", "n": 3},
    )
    redact_span(span)
    assert span.inputs == {"token": REDACTED, "question": "How many players?"}
    assert span.outputs == {"text": REDACTED}
    assert span.attributes == {
        "authorization": REDACTED,
        "note": f"key {REDACTED}",
        "mlflow.spanType": "TOOL",
        "n": 3,
    }


@pytest.fixture
def local_tracking(tmp_path, monkeypatch):
    monkeypatch.setenv("MLFLOW_ENABLE_ASYNC_TRACE_LOGGING", "false")
    # An experiment left active by an earlier test names an id this fresh store
    # does not have, and the trace is then dropped rather than written.
    monkeypatch.delenv("MLFLOW_EXPERIMENT_ID", raising=False)
    previous = mlflow.get_tracking_uri()
    mlflow.set_tracking_uri(f"sqlite:///{tmp_path / 'mlflow.db'}")
    mlflow.set_experiment("trace-redaction")
    trace_redaction.install()
    yield
    mlflow.tracking.fluent._active_experiment_id = None
    mlflow.set_tracking_uri(previous)


def test_an_exported_trace_holds_no_token_or_identity_value(local_tracking):
    with mlflow.start_span("tool") as span:
        span.set_inputs({"authorization": f"Bearer {PAT}", "question": "q"})
        span.set_outputs({"rows": [{"player_id": "p-1", "sessions": 2}], "note": JWT})
    trace = mlflow.get_trace(mlflow.get_last_active_trace_id())
    exported = trace.data.spans[0]
    assert exported.inputs == {"authorization": REDACTED, "question": "q"}
    assert exported.outputs == {"rows": [{"player_id": REDACTED, "sessions": 2}], "note": REDACTED}
    assert PAT not in trace.to_json() and "p-1" not in trace.to_json()
