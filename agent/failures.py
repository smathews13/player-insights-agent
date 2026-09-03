"""The failure codes, as the agent side spells them.

NOT A SECOND TAXONOMY. `shared/failure-taxonomy.ts` is the authority and says so
in its own header: it owns the HTTP status, the sentence a user reads, the trace
behaviour, the alert severity, and whether a request ending on a code may still
carry an answer. Nothing here restates any of that, because a second table with
its own opinion about `httpStatus` is worse than no table: both look canonical,
and the one being read is whichever surface you happened to open.

What this module is for is the half the TypeScript cannot do. The agent runs in a
serving container with no access to that file, and it needs three things from the
contract at answer time:

- the code STRINGS, spelled identically, so a value that crosses the wire into
  Lakebase and the trace means the same thing on both sides. `test_failures.py`
  reads the `.ts` and pins them, because the two are released separately and in
  either order.
- which control fired, at the level of ONE piece of evidence rather than one
  request. A refused statement is not a failed request here: the loop discloses
  it and answers what remains, which is the existing and deliberate behaviour.
- whether a refusal may be worked around. This is the one property worth
  duplicating, and it is duplicated as a set rather than a table.

CANDIDATE-LEVEL CODES ARE NOT TERMINAL CODES. `TERMINAL_CODES` may only contain
what the shared file contains. `EVIDENCE_REFUSAL_CODES` are the finer-grained
reasons the evidence gateway rejects ONE candidate; they are recorded on the run
and counted, and they reach a user only through the terminal code they map to.
Anything here that ever needs to be a request's terminal outcome must be added to
the shared file first, which is where the meaning gets agreed.

THE CONVERSE IS NOT TRUE, and `APP_ONLY_CODES` is where that is written down: the
shared file holds codes this agent cannot reach, so "every shared code appears in
`TERMINAL_CODES`" is the wrong pin and would be satisfied by making this module's
own documentation false. See the block below the terminal list.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# The shared codes. Spelling pinned against shared/failure-taxonomy.ts.
# ---------------------------------------------------------------------------

IDENTITY_REQUIRED = "IDENTITY_REQUIRED"
IDENTITY_MISMATCH = "IDENTITY_MISMATCH"
USER_AUTH_REJECTED = "USER_AUTH_REJECTED"
USER_NOT_AUTHORIZED = "USER_NOT_AUTHORIZED"
DEPENDENCY_UNAVAILABLE = "DEPENDENCY_UNAVAILABLE"
GENIE_UNATTRIBUTABLE = "GENIE_UNATTRIBUTABLE"
ASSET_NOT_IN_MANIFEST = "ASSET_NOT_IN_MANIFEST"
COLUMN_POLICY_VIOLATION = "COLUMN_POLICY_VIOLATION"

#: The same policy as the code above, at a later and worse moment: a statement
#: that named no protected column was admitted, RAN, and the schema of its result
#: set names one anyway, so the rows were discarded unread. In practice a
#: `SELECT *` over a table with an identifier in it, or Genie SQL the parser could
#: not expand.
#:
#: KEPT DISTINCT FROM `COLUMN_POLICY_VIOLATION` DELIBERATELY, and the argument for
#: that is in the shared entry rather than repeated here. The half worth carrying
#: at the point the condition fires: the two rates mean opposite things and cancel
#: out when added, and this one is the only control that catches what the parse
#: cannot, so its rate IS the coverage measure for the parse-time guard. Merging
#: them makes that measurement unrecoverable.
RESULT_COLUMN_POLICY_VIOLATION = "RESULT_COLUMN_POLICY_VIOLATION"

OUTPUT_SCHEMA_VIOLATION = "OUTPUT_SCHEMA_VIOLATION"
NO_VALID_EVIDENCE = "NO_VALID_EVIDENCE"
STREAM_INTERRUPTED = "STREAM_INTERRUPTED"
RUN_DEADLINE_EXCEEDED = "RUN_DEADLINE_EXCEEDED"
PERSISTENCE_UNAVAILABLE = "PERSISTENCE_UNAVAILABLE"

#: In the shared file's own order, so a diff between the two reads as a diff.
TERMINAL_CODES = (
    IDENTITY_REQUIRED,
    IDENTITY_MISMATCH,
    USER_AUTH_REJECTED,
    USER_NOT_AUTHORIZED,
    DEPENDENCY_UNAVAILABLE,
    GENIE_UNATTRIBUTABLE,
    ASSET_NOT_IN_MANIFEST,
    COLUMN_POLICY_VIOLATION,
    RESULT_COLUMN_POLICY_VIOLATION,
    OUTPUT_SCHEMA_VIOLATION,
    NO_VALID_EVIDENCE,
    STREAM_INTERRUPTED,
    RUN_DEADLINE_EXCEEDED,
    PERSISTENCE_UNAVAILABLE,
)

# ---------------------------------------------------------------------------
# Shared codes the agent cannot reach
#
# THE LINE, so the next person adding a code knows which side of it they are on:
# a code belongs here when the APP decides it on a request the agent is never
# invoked for, and belongs in `TERMINAL_CODES` when a run the orchestrator serves
# could end on it. These are settled in `admitRun` against the run
# ledger, before Model Serving is called at all, so no orchestrator code path
# could produce one; they are the shared taxonomy's only `request`-layer codes,
# which is that layer's own definition: the failure is the envelope the caller
# sent, not anything the run did.
#
# WHY THE SET EXISTS RATHER THAN JUST ADDING THEM ABOVE. `AGENT_CODES` is
# documented as every code the agent may put on one piece of evidence or one run,
# and that sentence is what a reader trusts when they consult it. Listing a code
# the agent cannot emit would make it false in order to satisfy an exact-match
# pin, which is paying for a green test with the meaning of the thing being
# pinned. Declaring the exemption instead keeps the pin honest in both
# directions: a shared code that belongs to the agent and was forgotten here
# still fails, because it is in neither set.
#
# MEMBERSHIP IS EXPLICIT rather than derived. Python cannot read the shared
# file's layers at import time, and an exemption that grows by itself is an
# exemption nobody reviews.
#
# Named here rather than beside the agent's own codes, so a reader looking for
# something to raise does not find one of these first.
# ---------------------------------------------------------------------------

#: An idempotency key reused for a different question, refused by the ledger.
IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT"

#: An `Idempotency-Key` header the server could not use, refused rather than
#: ignored. A different failure from the conflict above and not a variant of it:
#: nothing was compared, because there was no earlier request to compare with.
IDEMPOTENCY_KEY_MALFORMED = "IDEMPOTENCY_KEY_MALFORMED"

#: The app's month-to-date budget gate refuses before it calls Model Serving.
BUDGET_APPROVAL_REQUIRED = "BUDGET_APPROVAL_REQUIRED"

#: The app's release-certification gate also refuses before it calls Model Serving.
RELEASE_NOT_CERTIFIED = "RELEASE_NOT_CERTIFIED"

APP_ONLY_CODES = (
    IDEMPOTENCY_CONFLICT,
    IDEMPOTENCY_KEY_MALFORMED,
    BUDGET_APPROVAL_REQUIRED,
    RELEASE_NOT_CERTIFIED,
)

# ---------------------------------------------------------------------------
# Candidate-level codes
#
# The three below say a statement could not be CHECKED, which is a different
# finding from a statement that was checked and refused, and the difference is
# what an operator triages on: a rule that fired means the product is working, a
# statement nobody could parse means the guard is guessing about coverage.
#
# They are not in the shared file because no user-facing surface renders them:
# a run that produced nothing else ends on NO_VALID_EVIDENCE, which is.
# ---------------------------------------------------------------------------

#: The guard could not parse it, so it could not be checked. Refused rather than
#: passed, which is the oldest rule in the SQL guard.
SQL_UNPARSEABLE = "SQL_UNPARSEABLE"

#: More than one statement, or a root that is not a SELECT.
SQL_NOT_READ_ONLY = "SQL_NOT_READ_ONLY"

#: Something was read that cannot be tied to a three-part table name: a
#: table-valued function, a bare name, a half-qualified one. Attribution is the
#: product here, so an unattributable read is not evidence.
ASSET_UNRESOLVED = "ASSET_UNRESOLVED"

EVIDENCE_REFUSAL_CODES = (SQL_UNPARSEABLE, SQL_NOT_READ_ONLY, ASSET_UNRESOLVED)

#: Every code the agent may put on one piece of evidence or one run.
#:
#: `APP_ONLY_CODES` is deliberately NOT part of this. The sentence above is what a
#: caller reads this for, and a code the agent cannot emit would make it false.
AGENT_CODES = TERMINAL_CODES + EVIDENCE_REFUSAL_CODES

#: What a candidate-level code becomes if the run ends with nothing else. Only
#: the codes that are NOT already terminal need an entry.
_TERMINAL_FOR = {
    SQL_UNPARSEABLE: NO_VALID_EVIDENCE,
    SQL_NOT_READ_ONLY: NO_VALID_EVIDENCE,
    ASSET_UNRESOLVED: NO_VALID_EVIDENCE,
}

# ---------------------------------------------------------------------------
# Which identity a data call authenticated as
# ---------------------------------------------------------------------------

#: `UNKNOWN` is a real answer rather than a default to be quietly upgraded. The
#: SDK does not report a missing invoker token: it falls back to the default
#: credential chain, so a run that could not read its own identity has to say so
#: instead of reporting the mode it was configured for. Owned by the signed-in-user
#: workstream; named here because the evidence contract carries the value.
IDENTITY_SIGNED_IN_USER = "signed_in_user"
IDENTITY_SERVICE_PRINCIPAL = "service_principal"
IDENTITY_UNKNOWN = "unknown"

IDENTITY_MODES = (
    IDENTITY_SIGNED_IN_USER,
    IDENTITY_SERVICE_PRINCIPAL,
    IDENTITY_UNKNOWN,
)

# ---------------------------------------------------------------------------
# Rerouting
#
# TWO DIFFERENT QUESTIONS, and blurring them is what produced the failure this
# workstream exists to remove. "May the system try another surface by itself"
# and "may the model ask for one in a later step" have different answers, and
# the old code answered both with a sentence handed to the model saying "try a
# different surface if one applies".
# ---------------------------------------------------------------------------

#: Codes after which the system may reroute or re-identify BY ITSELF. Empty, and
#: empty by construction rather than by accident, which is why it is written as a
#: named set rather than as the absence of a branch. `shared/failure-taxonomy.ts`
#: says the same thing with `mayRerouteOrReidentify: false` on every row, and
#: `test_failures.py` pins the two together.
#:
#: An automatic reroute is unattributable by nature: the run produces a figure
#: from a surface nobody asked for, the trace records a success, and the caveats
#: say a surface "did not respond". That has happened here. An unshared Genie
#: space was reported to the model as a tool that failed, the model asked the
#: same question with run_sql, and a stakeholder read a figure that had not come
#: from the governed space it was supposed to come from.
AUTOMATIC_REROUTE_ALLOWED: frozenset[str] = frozenset()

#: Codes after which even an EXPLICIT later attempt on another route is refused.
#:
#: A governance refusal is about the ANSWER, not about the tool that was asked
#: for it, so asking a second surface the same question is not a second attempt,
#: it is the same request with the guard removed. An authorization denial is the
#: same shape: nothing about a different route changes who is asking.
#:
#: An outage is not on this list, and that is the distinction being preserved. A
#: dependency that did not answer may legitimately be followed by a different
#: route, provided the model asks for it, it is counted against the tool budget,
#: and the transition is disclosed.
NO_LATER_ROUTE_ATTEMPT = frozenset(
    {
        IDENTITY_REQUIRED,
        IDENTITY_MISMATCH,
        USER_AUTH_REJECTED,
        USER_NOT_AUTHORIZED,
        ASSET_NOT_IN_MANIFEST,
        COLUMN_POLICY_VIOLATION,
        RESULT_COLUMN_POLICY_VIOLATION,
        OUTPUT_SCHEMA_VIOLATION,
        GENIE_UNATTRIBUTABLE,
        SQL_UNPARSEABLE,
        SQL_NOT_READ_ONLY,
        ASSET_UNRESOLVED,
    }
)


def terminal_code(code: str) -> str:
    """The terminal code a candidate-level one becomes, or the code itself.

    An unrecognised code becomes `NO_VALID_EVIDENCE` rather than being passed
    through. Fails closed on the field that matters: a code this build does not
    know cannot be presented as a request that succeeded.
    """

    if code in _TERMINAL_FOR:
        return _TERMINAL_FOR[code]
    return code if code in TERMINAL_CODES else NO_VALID_EVIDENCE


def may_automatically_reroute(code: str) -> bool:
    """Whether the system may switch route or identity without being asked.

    Always False. A function rather than a constant so that the call sites read
    as a decision being consulted, and so that anyone who wants to change the
    answer has to change it here, once, in front of the reasons above.
    """

    return code in AUTOMATIC_REROUTE_ALLOWED


def may_request_another_route(code: str) -> bool:
    """Whether the MODEL may ask for a different surface in a later step.

    An unknown code is treated as one that may not be, for the reason `spec`
    fails closed: a control from a newer release must not be ignored by an older
    reader.
    """

    return code not in NO_LATER_ROUTE_ATTEMPT and code in AGENT_CODES
