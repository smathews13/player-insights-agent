"""Whether this request may execute at all, decided before anything runs.

``user_authorization.py`` is the switch that says which principal the data calls
use. This module is the gate in front of it: it decides whether the request is
allowed to proceed under that principal, and refuses the turn when the answer is
no.

The two are separate because the switch cannot fail. ``executing_identity`` was
already measuring who a run authenticated as, but only to write a caveat onto an
answer that had already been computed and returned. A run that silently fell back
to the passthrough principal produced real figures from tables the asker may not
be granted, and disclosed it in a sentence under the chart. Disclosure is not a
boundary. This module turns the same measurement into a refusal, taken before the
first model call, so a question that cannot be attributed to the person asking it
is never executed rather than executed and annotated.

WHY THE CHECK CANNOT BE HOISTED OUT OF THE REQUEST. Model Serving parks the
invoker's token in a thread-local for the duration of one request, and serves
concurrent requests from one container. Anything resolved at import, or cached on
the agent, is one caller's identity handed to everybody after them. So the
observation is taken per turn and passed down the stack rather than stored.

NO TOKEN AND NO RAW CLAIM GOES THROUGH HERE. The gate compares two identities
that are already recorded elsewhere in the clear: the email the app resolved for
the signed-in user, and the account name the invoker's own client reports for
itself. The bearer token stays inside the SDK, and nothing in this module reads
one, so no trace attribute or Lakebase column built from these values can carry
credentials.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

#: The contract version for the checks below, recorded on every root trace.
#: Bumped when what the gate ENFORCES changes, so a trace from an older model
#: version cannot be read as having been through the current rules. Not the
#: model version, which moves for unrelated reasons.
POLICY_VERSION = "identity-policy/1"

# ---------------------------------------------------------------------------
# The `custom_inputs` keys the app sends. Named here rather than in `agent.py`
# so the app-side contract has one definition on this side of the wire.
# ---------------------------------------------------------------------------

MODE_KEY = "identity_mode"
EXPECTED_USER_KEY = "expected_user"
REQUEST_ID_KEY = "request_id"
RUN_ID_KEY = "run_id"

#: The request asserts it is being made for a named human, whose token it
#: forwarded. The only mode any version will now run.
SIGNED_IN_USER = "signed_in_user"
#: A LABEL, NEVER AN ADMISSIBLE REQUEST. Kept so a record can state that a run
#: was not attributed to a human; no longer a mode `verify` will let through.
#: It used to be honoured by a version logged without a user auth policy, which
#: is how a question could be answered from the customer's governed tables under
#: this endpoint's own principal.
SERVICE_PRINCIPAL = "service_principal"

# ---------------------------------------------------------------------------
# Failure codes. These are the identity half of the app's shared failure
# taxonomy and the strings must match it exactly: the app maps them onto the
# terminal `unavailable` result without translating them.
# ---------------------------------------------------------------------------

#: There is no usable user context: none was sent, or the invoker would not say
#: who it is, or this model version cannot run as a user at all.
IDENTITY_REQUIRED = "IDENTITY_REQUIRED"
#: A user context was sent and the endpoint is executing as somebody else.
IDENTITY_MISMATCH = "IDENTITY_MISMATCH"

#: What the user is told. Deliberately the same sentence for both codes: which
#: of them fired is a fact about our deployment, not about them, and the
#: difference is only actionable to somebody reading the trace. The code travels
#: beside it for that reader.
REFUSAL_MESSAGE = "The request could not be executed with your permissions."

#: The longest a message returned to a reader may be, matching the cap the Genie
#: and SQL refusals in `agent.py` are already held to. One number for every
#: refusal channel: a message that arrives truncated in one surface and whole in
#: another is read as two different faults.
MESSAGE_MAX = 600

#: What a reader is told when the serving environment carried no user credential
#: at all. NOT the same sentence as `REFUSAL_MESSAGE`, and deliberately so.
#:
#: The other refusals are about THIS request: a mode was missing, an identity did
#: not match. This one is about the DEPLOYMENT, and it is the difference between a
#: reader who signs out and back in forever and one who forwards a sentence to
#: whoever released the endpoint. The customer incident that produced it reached
#: the user as `HTTP 400 BAD_REQUEST ... model_serving_user_credentials auth:
#: Unable to authenticate using user_credentials`, on the first question, with
#: nothing in it naming a cause or a fix.
#:
#: IT NAMES THE FIX AND THE NON-FIXES. Three of the four things an operator tries
#: first -- restart the app, re-grant the tables, reload the data -- cannot move
#: this, because the credential is wired at log and deploy time and nothing else
#: writes it.
USER_CREDENTIALS_UNAVAILABLE_MESSAGE = (
    "This deployment cannot run your question as you. The serving endpoint was set "
    "up without working user-authorization credential forwarding, so the model had "
    "no credential for the signed-in user and stopped rather than reading the data "
    "as somebody else. Nothing you can do in the app changes this. It is fixed by "
    "re-logging the model and redeploying it with the project's release script, from "
    "the full source repository, so the user-authorization policy and the endpoint's "
    "on-behalf-of-user wiring are applied together. A restart, a new grant, or a data "
    "change will not fix it."
)


@dataclass(frozen=True)
class Requirement:
    """What the caller asked to run as, as it arrived.

    Every field defaults to empty rather than being required, because this is
    parsed from an untrusted body and a missing field must reach the gate as a
    refusal rather than as a `KeyError` five frames further in.
    """

    mode: str = ""
    #: The signed-in email the app resolved from `x-forwarded-email`. An
    #: assertion by the app, not by the caller: the gate's job is to hold the
    #: endpoint's actual invoker against it.
    expected_user: str = ""
    request_id: str = ""
    run_id: str = ""


@dataclass(frozen=True)
class Refusal:
    """A turn that will not be run, in the shape the app's contract wants."""

    code: str
    #: Which layer decided. Constant here, and carried anyway so the app does
    #: not have to infer it from the code.
    layer: str = "identity"
    #: Always false. Nothing about a rejected identity improves by asking again
    #: with the same one, and a retryable refusal is one an interface will
    #: quietly retry until it succeeds under some other principal.
    retryable: bool = False
    message: str = REFUSAL_MESSAGE
    #: For the endpoint's own logs and the trace. Never shown to the user, and
    #: never built from anything that is not already stored in the clear.
    detail: str = ""


def requirement(custom_inputs: Mapping[str, Any] | None) -> Requirement:
    """Read the identity context off the request, trusting none of its types."""

    values = custom_inputs or {}
    return Requirement(
        mode=_text(values.get(MODE_KEY)),
        expected_user=_text(values.get(EXPECTED_USER_KEY)),
        request_id=_text(values.get(REQUEST_ID_KEY)),
        run_id=_text(values.get(RUN_ID_KEY)),
    )


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def same_identity(expected: str, observed: str) -> bool:
    """Whether two identities name the same account.

    Case-insensitive because the local part of an email is case-sensitive by RFC
    and by nobody's actual directory: SCIM, the workspace UI and
    ``x-forwarded-email`` disagree on the casing of the same person routinely,
    and a gate that refuses on it fails every user whose address is stored
    capitalised. Nothing else is normalised: a plus-address, a different domain
    and a bare service-principal UUID are all genuinely different principals.
    """

    return bool(expected) and expected.strip().casefold() == observed.strip().casefold()


def verify(
    required: Requirement,
    *,
    user_authorization: bool,
    observed: str,
) -> Refusal | None:
    """Decide whether this turn may run. ``None`` means it may.

    ``observed`` is what the client the data tools will actually use reports as
    its own account, which is the only value here that is evidence rather than
    assertion. It is empty when the identity could not be read, and that is a
    refusal and not a shrug: an unreadable identity is exactly what a silent
    fallback to the passthrough principal looks like from inside the container.

    NO PASSTHROUGH TURN SURVIVES THIS FUNCTION. A version logged without a user
    auth policy has no invoker token, so it can only read the customer's tables
    under its own principal, and it now refuses every request rather than any.
    The branch that used to return `None` here was the last way a governed read
    could run as something other than the person who asked for it: a caller that
    simply omitted `identity_mode` was served, under grants that were not theirs,
    with an answer that looked identical to one computed under their own.

    A version logged WITH the policy refuses a request that carries no user, so
    the mode cannot be escaped by omitting a field either. Both directions are
    the same rule: a turn nobody can be named for does not run.
    """

    if not user_authorization:
        return Refusal(
            code=IDENTITY_REQUIRED,
            detail=(
                "This model version was logged without a user auth policy, so it has no "
                "invoker token and can only reach the data under its own principal. "
                f"The request declared {required.mode or 'no'} identity mode; no mode is "
                "admissible on such a version. Log a version with "
                "PLAYER_INSIGHTS_USER_AUTHORIZATION=true, or point the app at one."
            ),
        )

    if required.mode != SIGNED_IN_USER:
        return Refusal(
            code=IDENTITY_REQUIRED,
            detail=(
                f"This version executes data calls as the endpoint's invoker, and the "
                f"request declared {required.mode or 'no'} identity mode. There is no "
                "service-principal path through this version: a request with no user to "
                "attribute it to is refused rather than run as the app."
            ),
        )
    if not required.expected_user:
        return Refusal(
            code=IDENTITY_REQUIRED,
            detail=(
                "The request declared signed_in_user and named no user, so there is "
                "nothing to hold the invoker against. The app sends the address it "
                "resolved from x-forwarded-email; its absence means the app did not "
                "resolve one and should not have called."
            ),
        )
    if not observed:
        return Refusal(
            code=IDENTITY_REQUIRED,
            detail=(
                "The invoker's own client would not say who it is, so this run cannot be "
                "shown to be executing as "
                f"{required.expected_user}. An unreadable identity is refused because it "
                "is indistinguishable from the SDK having fallen back to the model "
                "version's passthrough principal, which answers normally and reads every "
                "table the manifest granted."
            ),
        )
    if not same_identity(required.expected_user, observed):
        return Refusal(
            code=IDENTITY_MISMATCH,
            detail=(
                f"The app asked for this question to run as {required.expected_user} and "
                f"the endpoint is executing as {observed}. The two must be the same "
                "account or the answer is computed under grants that belong to somebody "
                "else."
            ),
        )
    return None


def credentials_unavailable(detail: str = "") -> Refusal:
    """The refusal for a serving environment that carried no invoker credential.

    THE SAME ENVELOPE AS EVERY OTHER REFUSAL, on purpose: `IDENTITY_REQUIRED` is
    already the app's code for "there is no usable user context", the app already
    maps it onto the terminal `unavailable` result, and it already prefers the
    agent's own message over its generic one. A new code would arrive at an app
    build that does not know it and be reported as an unrecognised failure from a
    mismatched release -- which is a true sentence about the wrong problem.

    What changes is the message. `detail` is the SDK's own sentence, which goes to
    the endpoint's log for whoever is fixing the deployment and never to the
    reader; it carries no token, only the strategy's complaint that there was none.
    """

    return Refusal(
        code=IDENTITY_REQUIRED,
        message=USER_CREDENTIALS_UNAVAILABLE_MESSAGE[:MESSAGE_MAX],
        detail=(
            "Model Serving had no user credential to authenticate this request with, so "
            "the model could not act as the signed-in user. This version was logged WITH "
            "a user auth policy, so the gap is in the deployment around it: the endpoint "
            "was not stood up with on-behalf-of-user forwarding, or the caller invoked it "
            "as its own service principal without forwarding the user's token. Re-log and "
            "redeploy through the release script, which writes both halves together. "
            f"The SDK said: {detail or 'nothing further'}"
        ),
    )


def effective_mode(*, user_authorization: bool, verified: bool) -> str:
    """What the run is actually executing as, for the trace and the record.

    Distinct from the requested mode on purpose. They agree on every path that
    is allowed to reach an answer, and the value of recording both is the paths
    where they do not.
    """

    return SIGNED_IN_USER if (user_authorization and verified) else SERVICE_PRINCIPAL


def trace_attributes(
    required: Requirement,
    *,
    user_authorization: bool,
    verified: bool,
) -> dict[str, Any]:
    """The identity facts to hang on the root span.

    The trace is the only record of a run that outlives the response, so it has
    to be able to answer "whose grants produced this" on its own. Neither the
    token nor any claim from it appears: the requested mode is a label the app
    sent, and the effective mode is derived from the check above.
    """

    return {
        "identity.requested_mode": required.mode or "unset",
        "identity.effective_mode": effective_mode(
            user_authorization=user_authorization, verified=verified
        ),
        "identity.verified": verified,
        "identity.policy_version": POLICY_VERSION,
    }
