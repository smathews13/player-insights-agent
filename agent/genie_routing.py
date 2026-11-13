"""Per-request selection of the governed data Genie transport."""

from __future__ import annotations

import base64
import binascii
import json
import re
import threading
import time
from contextvars import ContextVar
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

DIRECT = "direct"
MCP = "mcp"
CUSTOM_INPUT_KEY = "genie_transport"
CAPABILITY_INPUT_KEY = "genie_mcp_capability"
AUDIENCE = "player-insights-agent"
PURPOSE = "managed-genie-mcp"
VERSION = 1
MAX_LIFETIME_SECONDS = 60
MAX_TRUSTED_KEYS = 2
_PEM_BLOCK = re.compile(r"-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]+?-----END PUBLIC KEY-----")
CLOCK_SKEW_SECONDS = 5
_CURRENT: ContextVar[str] = ContextVar("genie_transport", default=DIRECT)
_VERIFICATION: ContextVar[str] = ContextVar(
    "genie_capability_verification", default="not_requested"
)
_CAPABILITY: ContextVar[str] = ContextVar("genie_mcp_capability", default="")
#: Capability ids already spent in this process, with their expiry. The app signs
#: one capability per question and invokes once, so a second sight of an id is a
#: replay. Per serving replica: a replay that reaches another replica within the
#: lifetime is still bound to the same user, request and deployment key.
_SPENT: dict[str, int] = {}
_SPENT_LOCK = threading.Lock()
_MAX_SPENT = 10_000


class InvalidGenieTransport(ValueError):
    """A serving request named a transport this model does not expose."""


class UntrustedGenieTransport(InvalidGenieTransport):
    """A request attempted to enable a privileged route without attestation."""


def consume(custom_inputs: dict[str, Any]) -> None:
    """Remove bearer-like capability material before any tracing or persistence."""

    raw = custom_inputs.pop(CAPABILITY_INPUT_KEY, "")
    _CAPABILITY.set(raw if isinstance(raw, str) and len(raw) <= 4096 else "")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _canonical(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _spend(jti: str, exp: int, now: int) -> None:
    with _SPENT_LOCK:
        for spent, expiry in list(_SPENT.items()):
            if expiry < now - CLOCK_SKEW_SECONDS:
                del _SPENT[spent]
        if jti in _SPENT or len(_SPENT) >= _MAX_SPENT:
            _refuse()
        _SPENT[jti] = exp


def forget_spent() -> None:
    """Empty the replay record. For tests, which reuse one signed fixture."""

    with _SPENT_LOCK:
        _SPENT.clear()


def trusted_keys(public_key_pem: str) -> list[Ed25519PublicKey]:
    """The current key and, during a rotation, the previous one.

    The release bakes one PEM block per trusted key, newest first. More than
    `MAX_TRUSTED_KEYS` is refused rather than trimmed: a third key means a
    rotation was not finished, and silently trusting it would keep a retired
    key alive.
    """

    blocks = _PEM_BLOCK.findall(public_key_pem)
    if not blocks or len(blocks) > MAX_TRUSTED_KEYS:
        _refuse()
    keys = []
    for block in blocks:
        key = serialization.load_pem_public_key(block.encode())
        if not isinstance(key, Ed25519PublicKey):
            _refuse()
        keys.append(key)
    return keys


def _signed_by(key: Ed25519PublicKey, signature: bytes, body: str) -> bool:
    try:
        key.verify(signature, body.encode("ascii"))
    except InvalidSignature:
        return False
    return True


def _refuse() -> None:
    _VERIFICATION.set("refused")
    raise UntrustedGenieTransport(
        "Genie MCP capability verification failed; signing material was redacted"
    )


def _verify(
    capability: str,
    *,
    public_key_pem: str,
    request_id: str,
    observed_user: str,
    now: int,
) -> None:
    try:
        body, encoded_signature = capability.split(".", 1)
        decoded_body = _decode(body)
        payload = json.loads(decoded_body)
        if not isinstance(payload, dict) or decoded_body != _canonical(payload):
            _refuse()
        expected_keys = {
            "aud",
            "exp",
            "iat",
            "jti",
            "purpose",
            "request_id",
            "sub",
            "transport",
            "v",
        }
        if set(payload) != expected_keys:
            _refuse()
        iat = payload["iat"]
        exp = payload["exp"]
        if not isinstance(iat, int) or isinstance(iat, bool):
            _refuse()
        if not isinstance(exp, int) or isinstance(exp, bool):
            _refuse()
        if (
            not isinstance(payload["v"], int)
            or isinstance(payload["v"], bool)
            or payload["v"] != VERSION
            or payload["aud"] != AUDIENCE
            or payload["purpose"] != PURPOSE
            or payload["transport"] != MCP
            or payload["request_id"] != request_id
            or not isinstance(payload["jti"], str)
            or not 16 <= len(payload["jti"]) <= 128
            or not isinstance(payload["sub"], str)
            or payload["sub"].strip().casefold() != observed_user.strip().casefold()
            or iat > now + CLOCK_SKEW_SECONDS
            or exp <= now
            or exp - iat <= 0
            or exp - iat > MAX_LIFETIME_SECONDS
            or now - iat > MAX_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS
        ):
            _refuse()
        signature = _decode(encoded_signature)
        if not any(_signed_by(key, signature, body) for key in trusted_keys(public_key_pem)):
            _refuse()
        _spend(payload["jti"], exp, now)
    except UntrustedGenieTransport:
        raise
    except (
        InvalidSignature,
        ValueError,
        TypeError,
        KeyError,
        UnicodeDecodeError,
        binascii.Error,
        json.JSONDecodeError,
    ):
        _refuse()


def activate(
    custom_inputs: dict[str, Any],
    *,
    public_key_pem: str,
    request_id: str,
    observed_user: str,
    now: int | None = None,
) -> str:
    """Select MCP only after independently verifying the app's signed grant."""

    _CURRENT.set(DIRECT)
    _VERIFICATION.set("not_requested")
    raw = custom_inputs.get(CUSTOM_INPUT_KEY)
    if raw is None or raw == DIRECT:
        _CAPABILITY.set("")
        return DIRECT
    if raw == MCP:
        _verify(
            _CAPABILITY.get(),
            public_key_pem=public_key_pem,
            request_id=request_id,
            observed_user=observed_user,
            now=int(time.time()) if now is None else now,
        )
        _CAPABILITY.set("")
        _CURRENT.set(MCP)
        _VERIFICATION.set("verified")
        return MCP
    raise InvalidGenieTransport(f"unsupported Genie transport: {raw!r}")


def current() -> str:
    return _CURRENT.get()


def capability_pending() -> bool:
    """Whether request-local signing material is awaiting verification."""

    return bool(_CAPABILITY.get())


def clear() -> None:
    _CURRENT.set(DIRECT)
    _VERIFICATION.set("not_requested")
    _CAPABILITY.set("")


def trace_metadata() -> dict[str, str]:
    return {
        "genie.transport": current(),
        "genie.capability_verification": _VERIFICATION.get(),
    }
