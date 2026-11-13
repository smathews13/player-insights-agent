"""Redact credentials and player identity values from every trace span.

Installed once as an MLflow span processor, so it applies to every span this
model writes, whichever call site wrote it. A processor runs before the span is
exported, so a redacted value never reaches the experiment.

Two rules:

* A value under a credential key (authorization, token, secret, capability...)
  or a player identity key (the agent's unreturnable identity columns) is
  replaced by ``[REDACTED]``, at any depth.
* Any string is scrubbed of token-shaped substrings: bearer tokens, Databricks
  tokens and OAuth secrets, JWTs and private keys.

The asker's email stays: it is who asked, which an audit needs, not a player.
"""

from __future__ import annotations

import re
from typing import Any

import mlflow

import sql_policy

REDACTED = "[REDACTED]"

CREDENTIAL_KEYS = frozenset(
    {
        "authorization",
        "x-forwarded-access-token",
        "access_token",
        "refresh_token",
        "id_token",
        "token",
        "user_token",
        "client_secret",
        "secret",
        "api_key",
        "password",
        "cookie",
        "set-cookie",
        "genie_mcp_capability",
    }
)
IDENTITY_KEYS = frozenset(sql_policy.UNRETURNABLE_COLUMNS - {"email"})
SENSITIVE_KEYS = CREDENTIAL_KEYS | IDENTITY_KEYS

_TOKEN_SHAPES = (
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"\bdapi[0-9a-f]{32}(?:-\d)?\b"),
    re.compile(r"\bdose[0-9a-f]{32}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"),
)
_MAX_DEPTH = 32


def scrub(text: str) -> str:
    for pattern in _TOKEN_SHAPES:
        text = pattern.sub(REDACTED, text)
    return text


def redact(value: Any, depth: int = 0) -> Any:
    if depth > _MAX_DEPTH:
        return REDACTED
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, dict):
        return {
            key: (
                REDACTED
                if isinstance(key, str) and key.strip().lower() in SENSITIVE_KEYS
                else redact(item, depth + 1)
            )
            for key, item in value.items()
        }
    if isinstance(value, list | tuple):
        return [redact(item, depth + 1) for item in value]
    return value


def redact_span(span: Any) -> None:
    """The span processor: rewrite inputs, outputs and attributes in place."""

    inputs = span.inputs
    if inputs is not None:
        span.set_inputs(redact(inputs))
    outputs = span.outputs
    if outputs is not None:
        span.set_outputs(redact(outputs))
    for key, value in dict(span.attributes or {}).items():
        if key.startswith("mlflow."):
            continue
        if key.strip().lower() in SENSITIVE_KEYS:
            span.set_attribute(key, REDACTED)
        elif isinstance(value, str | dict | list):
            cleaned = redact(value)
            if cleaned != value:
                span.set_attribute(key, cleaned)


def install() -> None:
    mlflow.tracing.configure(span_processors=[redact_span])
