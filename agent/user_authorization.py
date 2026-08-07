"""Which identity the agent's data calls execute as.

Four principals are in play:

1. The signed-in human, who reaches the app as ``x-forwarded-email``.
2. The app's service principal, which is what the app authenticates as to
   Lakebase and to the serving endpoint.
3. The endpoint's automatic authentication passthrough principal, generated per
   model version and granted exactly the resources named at log time. This is
   what ``WorkspaceClient()`` resolves to inside the serving container.
4. The invoker of the endpoint, whose downscoped token Model Serving parks in a
   thread-local for the duration of one request.

Every question executes as (3) by default. This module is the switch that makes
it execute as (4) instead.

THIS IS NOT PER-USER GOVERNANCE AND MUST NOT BE DESCRIBED AS SUCH. "On behalf of
user" means the identity that CALLED the endpoint, which is the same principal
as the human only if the caller forwards their token. The app does not: it
builds its own client from the injected service-principal environment. So
turning this flag on alone moves execution from (3) to (2), a different service
principal. Forwarding ``x-forwarded-access-token`` on the invocation is the app
half, owned elsewhere, and is a prerequisite for the name to be accurate.
``executing_identity`` measures who a run actually used, because the SDK falls
back silently with no invoker token: no exception, no warning, a normal-looking
answer computed under the wrong principal.

THE FLAG IS BAKED INTO THE ARTIFACT because the two halves must agree or the
endpoint cannot authenticate at all. A ``user_auth_policy`` with no
``system_auth_policy`` leaves a bare ``WorkspaceClient()`` nothing to resolve,
and a user-credentials client against a version logged without a user policy
finds no invoker token. The container inherits no environment, so the runtime
half reads what log time decided and one resolution writes both.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

#: Read at LOG time only: this is the release decision, and the artifact carries
#: it into serving.
USER_AUTHORIZATION_ENV = "PLAYER_INSIGHTS_USER_AUTHORIZATION"

#: The key ``log_model.py`` writes into ``model_config`` and ``agent.py`` reads
#: back on load. Not a ``Settings`` field, which names workspace values.
MODEL_CONFIG_KEY = "user_authorization"

#: What the run executed as, for anything that reports it.
SYSTEM_PASSTHROUGH = "system-passthrough"
USER_AUTHORIZATION = "user-authorization"

# ---------------------------------------------------------------------------
# Scopes
#
# The downscoped token carries only these APIs, so this list is the blast radius
# of the whole feature and every entry must be justified by a call the agent
# makes. Two scopes cover all four kinds of call `tools.py` makes.
#
# The model-serving scope is deliberately ABSENT. The orchestrator LLM call stays
# on the system identity, so adding it would mean every stakeholder needs CAN
# QUERY on the LLM endpoint, and a serving endpoint reached under a user's token
# can itself reach API scopes the agent was never granted.
#
# MLFLOW DOES NOT VALIDATE THESE STRINGS. A scope that does not exist logs and
# registers cleanly and fails at serve time. Databricks documents two naming
# families for the same things (`genie` and `sql` in the Apps UI,
# `dashboards.genie` and `sql.statement-execution` elsewhere); these two are the
# pair the Model Serving on-behalf-of examples use.
# ---------------------------------------------------------------------------

#: Genie: `start_conversation` and `get_message` on both spaces.
GENIE_SCOPE = "dashboards.genie"
#: The Statement Execution API, which is also the only supported route to a
#: Unity Catalog table under user authorization on Model Serving: there is no
#: separate table scope, the warehouse enforces the caller's grants.
SQL_SCOPE = "sql"


@dataclass(frozen=True)
class Resolution:
    """What the flag was set to, and what that resolved to.

    ``reason`` is distinct from ``enabled`` so that somebody who wrote ``=1``
    meaning yes is told it did nothing, rather than reading the feature as broken.
    """

    enabled: bool
    #: What the environment or artifact actually carried, for the log line.
    raw: str
    #: ``unset`` | ``enabled`` | ``disabled`` | ``unrecognised``
    reason: str

    @property
    def mode(self) -> str:
        return USER_AUTHORIZATION if self.enabled else SYSTEM_PASSTHROUGH


def resolve(raw: str | None) -> Resolution:
    """Read the flag, failing closed on anything that is not an explicit yes.

    Unset, empty, ``1``, ``yes``, ``on`` and a typo all resolve to system
    passthrough. Only ``true`` (trimmed, any case) turns user authorization on.
    """

    value = (raw or "").strip()
    if not value:
        return Resolution(enabled=False, raw=value, reason="unset")
    normalised = value.lower()
    if normalised == "true":
        return Resolution(enabled=True, raw=value, reason="enabled")
    if normalised == "false":
        return Resolution(enabled=False, raw=value, reason="disabled")
    return Resolution(enabled=False, raw=value, reason="unrecognised")


def from_artifact(baked: Mapping[str, Any] | None) -> Resolution:
    """Read back what log time decided, out of the model's own configuration.

    MLflow round-trips ``model_config`` through YAML, so the value arrives as a
    bool or as a string; both are accepted and everything else fails closed,
    including a version logged before this key existed, which bakes nothing.
    """

    value = (baked or {}).get(MODEL_CONFIG_KEY)
    if value is None:
        return Resolution(enabled=False, raw="", reason="unset")
    if isinstance(value, bool):
        return Resolution(
            enabled=value, raw=str(value).lower(), reason="enabled" if value else "disabled"
        )
    return resolve(str(value))


def announcement(resolution: Resolution, *, at_log_time: bool) -> str:
    """The line to print where the flag is resolved.

    The endpoint's logs are the only surface that says which identity it is
    about to run every query as.
    """

    setting = (
        f"{USER_AUTHORIZATION_ENV}={resolution.raw!r}"
        if at_log_time
        else f"{MODEL_CONFIG_KEY}={resolution.raw!r} in the model artifact"
    )
    if resolution.reason == "unrecognised":
        return (
            f"[auth] {setting} is not a value this agent recognises, so it has been "
            "IGNORED and data calls will run under automatic authentication passthrough, "
            'exactly as they do today. The only value that turns user authorization on is "true". '
            "Nothing is broken and nothing has changed, but if user authorization was "
            "intended, it is not on."
        )
    if resolution.enabled:
        return (
            f"[auth] USER AUTHORIZATION IS ON ({setting}). Genie and SQL calls will execute "
            "as the identity that INVOKED this endpoint, not as the model version's "
            "passthrough principal, and that identity's own Unity Catalog grants (including "
            "row filters and column masks) decide what comes back. Note that the invoker is "
            "whoever authenticated to /invocations, which is the calling application's "
            "service principal unless that application forwards the end user's token."
        )
    if resolution.reason == "unset":
        return (
            f"[auth] Data calls run under automatic authentication passthrough "
            f"({USER_AUTHORIZATION_ENV} is unset)."
            if at_log_time
            else f"[auth] Data calls run under automatic authentication passthrough "
            f"(no {MODEL_CONFIG_KEY} in the model artifact)."
        )
    return f"[auth] Data calls run under automatic authentication passthrough ({setting})."


def announce(resolution: Resolution, *, at_log_time: bool) -> Resolution:
    """Print the resolution and hand it back, so a caller can do both in one line."""

    print(announcement(resolution, at_log_time=at_log_time))
    return resolution


def api_scopes(settings: Any) -> tuple[str, ...]:
    """The REST API scopes the agent genuinely needs, derived from what it uses.

    Derived rather than listed so a deployment with no Genie space, or no
    warehouse, does not request a scope for it. The token is the user's, so every
    extra scope is one more API the agent could be made to call with it.
    """

    scopes: list[str] = []
    if settings.data_genie_space_id or settings.dictionary_genie_space_id:
        scopes.append(GENIE_SCOPE)
    if settings.warehouse_id:
        scopes.append(SQL_SCOPE)
    return tuple(scopes)


def user_authorized_client(factory: Any = None) -> Any:
    """A ``WorkspaceClient`` bound to the invoker's downscoped token.

    MUST be constructed inside ``predict``. The token lives in a thread-local
    Model Serving populates per request, so a client built at import, or cached
    on the agent, finds nothing or finds the wrong request's caller. The SDK
    complains about neither, and outside a serving container
    ``ModelServingUserCredentials`` falls back to the default credential chain.

    THE KWARG IS ``credentials_strategy``. The SDK's own docstring says
    ``credential_strategy``, singular, which ``Config.__init__`` swallows into
    ``**kwargs``: the client then authenticates as the system principal, silently.
    """

    from databricks.sdk import WorkspaceClient
    from databricks.sdk.credentials_provider import ModelServingUserCredentials

    build = factory or WorkspaceClient
    return build(credentials_strategy=ModelServingUserCredentials())


def executing_identity(client: Any) -> str:
    """Who the client is actually authenticated as, or ``""`` if it will not say.

    The one check that distinguishes user authorization working from it silently
    falling back. ``current_user.me()`` needs no declared scope. Best effort: this
    runs on the answer path, so an unreadable identity is disclosed rather than
    failing a question that would otherwise have been answered.
    """

    try:
        me = client.current_user.me()
    except Exception:  # noqa: BLE001 - an unreadable identity is reported, not raised
        return ""
    return str(getattr(me, "user_name", "") or getattr(me, "id", "") or "")


def coverage_caveat(identity: str) -> str:
    """What an answer has to say about itself when it ran as the caller.

    UNCONDITIONAL on the user-authorized path. A row filter or column mask does
    not fail: the query succeeds, returns fewer rows, and every figure computed
    from it is a confident number about a subset. There is no signal to condition
    the disclosure on.
    """

    ran_as = f"as {identity}" if identity else "as the identity that invoked this endpoint"
    return (
        f"This answer was produced {ran_as} and covers only the data that identity is "
        "granted. Unity Catalog row filters and column masks apply without reporting "
        "themselves, so figures here may be computed from a subset of the rows another "
        "reader would see."
    )
