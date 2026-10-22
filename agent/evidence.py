"""Admission control: what may influence an answer, and what may only be reported.

ONE GATE IN FRONT OF EVERY DATA-PRODUCING TOOL. Direct SQL has been well governed
for a while: a parse, the baked manifest, the protected-column policy, and the
warehouse's own result schema. Genie was not held to the same standard, and the
gap was not a missing check so much as a missing DECISION: an unparseable
generated statement, or a chart with no statement behind it, arrived with a caveat
attached and went on to become figures, sources and prose. A caveat is not a
control. A reader who is told the sources are incomplete still reads the number.

So the shape here is deliberate. A tool produces a CANDIDATE, the gateway returns
a VERDICT, and only an accepted verdict may reach synthesis. Everything else is
reported: as a governance refusal, as an access denial, or as an operational
failure, which are three different facts and have never been allowed to collapse
into one here.

WHY THE VERDICT CARRIES THE ORIGINAL REFUSAL. `Verdict.refusal` is the exact
`SqlRefused` the guard raised, and the SQL path re-raises that object rather than
a new one built from the verdict. The messages are long, specific, and load-bearing
(one of them deliberately says COUNT rather than "aggregate", because recommending
an aggregate hands back the bypass), and a gateway that rewrote them would be a
second set of words for the same policy. Re-raising the object is also what makes
the refactor provable: the existing suite asserts on those messages and cannot
tell that a gateway is now in the path.

WHAT THIS MODULE DOES NOT DECIDE. It does not fetch, execute, or retry anything,
and it holds no client. It is given what a tool found and answers one question
about it. That is what lets the same object serve SQL, both Genie spaces, and
whatever surface is added next, and it is why it can be tested without a
workspace.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field, replace

import failures
from sql_policy import (
    SqlRefused,
    parse_sql,
    referenced_tables,
    refuse_restricted_columns,
    restricted_output_columns,
    validate_sql,
)

#: Bumped when a decision this module makes CHANGES, not when it is refactored.
#: It goes on every run and every release certificate, so two answers to the same
#: question that were validated differently are distinguishable afterwards. That
#: is the whole use: without it, "the validator was stricter last week" is not a
#: statement anybody can check.
VALIDATOR_VERSION = "evidence-gateway/1"

# ---------------------------------------------------------------------------
# The four outcomes
#
# FOUR, not two, and this predates the gateway: the agent has always separated a
# governance refusal from an access denial from an operational failure, because
# the remedies are a person, an admin, and a retry respectively, and a reader
# given the wrong one goes and does the wrong thing. `accepted` joins them as the
# only outcome that may influence an answer.
# ---------------------------------------------------------------------------

ACCEPTED = "accepted"
REFUSED = "refused"
ACCESS_DENIED = "access_denied"
FAILED = "failed"

OUTCOMES = (ACCEPTED, REFUSED, ACCESS_DENIED, FAILED)

# ---------------------------------------------------------------------------
# Routes and payloads
# ---------------------------------------------------------------------------

#: Direct SQL the model wrote, checked before it runs.
ROUTE_SQL = "sql"
#: A Genie space, whose SQL arrives having already run.
ROUTE_GENIE = "genie"
#: Catalog metadata: the declared listing, a table description. Reads no player
#: data, so it is attributable without a statement to parse.
ROUTE_METADATA = "metadata"

ROUTES = (ROUTE_SQL, ROUTE_GENIE, ROUTE_METADATA)

#: Rows with a schema behind them. The only payload a figure may come from.
PAYLOAD_TABULAR = "tabular"
#: A chart with no statement exposed. Genie returns these, and they are the
#: sharpest case in the plan: the figures are real and nothing about them can be
#: traced, so they may be reported and may not be used.
PAYLOAD_VISUALIZATION = "visualization"
#: A governed definition, from the dictionary space. Not a figure and not a
#: source for one.
PAYLOAD_DEFINITION = "definition"
#: A certified semantic metric, identified rather than derived. The one thing the
#: plan allows in place of a parseable statement, because a metric identifier is
#: machine-verifiable attribution: it names the governed definition the number
#: came from.
PAYLOAD_METRIC = "metric"
#: Catalog metadata rather than data.
PAYLOAD_METADATA = "metadata"

PAYLOAD_TYPES = (
    PAYLOAD_TABULAR,
    PAYLOAD_VISUALIZATION,
    PAYLOAD_DEFINITION,
    PAYLOAD_METRIC,
    PAYLOAD_METADATA,
)

#: Payloads whose acceptance implies a figure may be drawn from them.
_VALUE_BEARING = (PAYLOAD_TABULAR, PAYLOAD_METRIC)


def manifest_digest(tables: Sequence[str]) -> str:
    """A short stable fingerprint of the declared table set.

    On every verdict, so an answer can be tied to the manifest that was in force
    when it was produced. The manifest is generated at log time from the catalog
    scopes, so it can differ between two releases nobody edited, and "which
    tables was this allowed to read" is otherwise only answerable by finding the
    model version and reading its config back.

    Case-folded and sorted, because the digest is about the SET. A manifest whose
    order changed is the same manifest, and a digest that said otherwise would
    make drift alerts fire on nothing.
    """

    joined = "\n".join(sorted(name.strip().lower() for name in tables if name.strip()))
    return hashlib.sha256(joined.encode()).hexdigest()[:16]


def _evidence_id() -> str:
    return f"ev-{uuid.uuid4().hex[:12]}"


@dataclass(frozen=True)
class Column:
    """One column of a result, as the warehouse reported it.

    The type is carried because a figure has to be linkable to a FIELD and not
    only to a name: two results with a `revenue` column, one a string and one a
    decimal, are not interchangeable evidence for the same number.
    """

    name: str
    type: str = ""


@dataclass(frozen=True)
class EvidenceCandidate:
    """What one tool call produced, normalized before anything judges it.

    Normalized so that the SQL path and the Genie path present the same object
    and cannot be judged by two policies that resemble each other. Frozen
    because a candidate that could be edited after its verdict is a candidate
    whose verdict describes something else.

    `depends_on_values` is the field that decides how strict the gateway is. A
    question answered from a definition or a column list does not need a
    statement behind it; a figure does. Defaulted True, so a tool that does not
    say is held to the stricter rule.
    """

    tool: str
    route: str
    payload_type: str
    generated_sql: str = ""
    referenced_assets: tuple[str, ...] = ()
    output_schema: tuple[Column, ...] = ()
    identity_mode: str = failures.IDENTITY_UNKNOWN
    manifest_digest: str = ""
    validator_version: str = VALIDATOR_VERSION
    evidence_id: str = field(default_factory=_evidence_id)
    #: Certified metric identifiers this result is attributed to, when it has no
    #: statement of its own. Empty for everything the agent reads today; the
    #: field exists because it is the ONLY exception the plan allows to the
    #: parseable-SQL rule, and an exception with no shape is one that gets argued
    #: for later.
    metric_ids: tuple[str, ...] = ()
    #: Whether the answer this would support depends on data VALUES.
    depends_on_values: bool = True
    #: The evidence id of an earlier attempt on another route that failed, when
    #: this call is the explicit follow-up to one. Never set automatically: the
    #: link exists so a disclosed route change is traceable, and a link the
    #: system invented would be describing a transition nobody made.
    prior_evidence_id: str = ""

    def as_record(self) -> dict[str, object]:
        """The candidate as it is persisted and traced.

        THE SQL IS NOT IN HERE. A refused statement can contain the protected
        identifier it was refused for, and persisting it would put that value in
        Lakebase and the trace, which is the place the refusal exists to keep it
        out of. The hash is enough to tell two attempts apart and to recognise a
        repeat.
        """

        return {
            "evidence_id": self.evidence_id,
            "tool": self.tool,
            "route": self.route,
            "payload_type": self.payload_type,
            "sql_sha256": self.sql_hash,
            "referenced_assets": list(self.referenced_assets),
            "output_schema": [
                {"name": column.name, "type": column.type} for column in self.output_schema
            ],
            "identity_mode": self.identity_mode,
            "manifest_digest": self.manifest_digest,
            "validator_version": self.validator_version,
            "metric_ids": list(self.metric_ids),
            "prior_evidence_id": self.prior_evidence_id,
        }

    @property
    def sql_hash(self) -> str:
        """A fingerprint of the statement, or "" when there was none.

        Whitespace-normalized, so the same statement formatted two ways is one
        statement. Not reversible: the point is to compare, not to recover.
        """

        if not self.generated_sql.strip():
            return ""
        normalized = " ".join(self.generated_sql.split())
        return hashlib.sha256(normalized.encode()).hexdigest()[:16]

    @property
    def field_names(self) -> tuple[str, ...]:
        return tuple(column.name for column in self.output_schema)


@dataclass(frozen=True)
class Verdict:
    """The gateway's answer about one candidate.

    `sources` is empty on anything but an acceptance, and that is the mechanism
    rather than a detail: a rejected candidate contributes no source, no figure,
    no SQL and no factual context, so the way to guarantee that is for the
    rejected verdict to have nothing to contribute.
    """

    outcome: str
    candidate: EvidenceCandidate
    code: str = ""
    reason: str = ""
    sources: tuple[str, ...] = ()
    #: The refusal the guard raised, kept so a caller can re-raise the ORIGINAL
    #: object. See the module docstring: the messages are the policy's own words
    #: and must not be rewritten by whatever is in the path.
    refusal: SqlRefused | None = None
    #: Referenced assets that are not in the declared manifest. Recorded on every
    #: Genie verdict whether or not the manifest is being enforced there, because
    #: manifest drift is a thing to measure before it is a thing to refuse.
    off_manifest: tuple[str, ...] = ()
    #: True when this was REFUSED on the evidence and admitted anyway, because the
    #: release set `allow_unattributed_figures`. Kept as a field on an accepted
    #: verdict rather than as a fourth outcome, because every caller that asks
    #: "may I use this" should get yes (that is what the flag decided) while every
    #: caller that asks "was anything waived" gets a straight answer. Folding it
    #: into the outcome would have made the audit and the behaviour the same
    #: switch, and then a permissive run would look like a clean one.
    waived: bool = False

    @property
    def accepted(self) -> bool:
        return self.outcome == ACCEPTED

    @property
    def may_support_a_figure(self) -> bool:
        """Whether a number in the answer may be attributed to this.

        Acceptance is necessary and not sufficient. A definition is accepted
        evidence and is not a source for a figure, so a takeaway that puts a
        number next to it is citing prose.

        A WAIVED verdict is the same shape of mistake and the easier one to make,
        because it looks accepted in every other respect. The waiver permitted the
        figures to be shown; it did not make them attributable, and this property
        is the question "can a number be traced to this", which is still no.
        """

        if self.waived:
            return False
        return self.accepted and self.candidate.payload_type in _VALUE_BEARING

    @property
    def read_for_values(self) -> bool:
        """Whether this verdict's tables were read by a query that returns values.

        Deliberately not `may_support_a_figure`, which is stricter and answers a
        different question: that one is "can a number be traced to this", and it
        is False for a waived verdict because a waiver permits a figure to be
        shown without making it attributable. This one is "what was the table
        read FOR", and a waived query read it for its values.

        Used to label a source, so both errors it can make are visible to a
        reader. Calling a queried table a reference read is the misdescription
        the label exists to end, in the other direction.
        """

        return self.accepted and self.candidate.payload_type in _VALUE_BEARING

    @property
    def may_request_another_route(self) -> bool:
        """Whether the model may ask a different surface after this verdict.

        Never after a refusal or a denial: a governance decision is about the
        answer, not about the tool that was asked for it. After a genuine
        failure, yes, and only as a separate call the model makes, counted and
        disclosed. See `failures` for the two questions this does not conflate.
        """

        if self.outcome in (REFUSED, ACCESS_DENIED):
            return False
        return failures.may_request_another_route(self.code)

    def as_record(self) -> dict[str, object]:
        return {
            **self.candidate.as_record(),
            "outcome": self.outcome,
            "code": self.code,
            "terminal_code": failures.terminal_code(self.code) if self.code else "",
            # Sanitized: the guard's own sentence, which names columns and tables
            # by policy name rather than quoting the statement.
            "reason": self.reason[:600],
            "sources": list(self.sources),
            "off_manifest": list(self.off_manifest),
            # Always present, not only when true, so that "was anything waived on
            # this run" is answerable from the record without knowing which
            # release the version came from.
            "waived": self.waived,
        }


class EvidenceRefused(SqlRefused):
    """A result the gateway will not admit, carrying the verdict that says why.

    A subclass of `SqlRefused` so that every existing caller catches it unchanged,
    which matters most in the orchestrator loop: that handler is the one place
    that knows a refusal is not a failure, tells the model so, and records it
    beside the guards rather than beside the outages. A new exception type would
    have taken the generic path, which invites the model to try another surface,
    and inviting that is the whole defect this workstream removes.

    The verdict travels with it because the run has to record the decision, and
    an exception is the only thing that crosses a call boundary where the tool
    has already given up on returning anything.

    `verdicts` is the whole trail, not just the summary. One Genie message can
    hold several attachments, each judged separately, and a single message-level
    verdict cannot carry more than one statement fingerprint: a test asking the
    record to identify the refused attempt is what found that, with the hash
    empty. Without the trail the audit says a message was unattributable and
    cannot say which of three statements failed to parse, which is the question
    anyone reading it later actually has.
    """

    def __init__(self, verdict: Verdict, verdicts: Sequence[Verdict] = ()) -> None:
        super().__init__(verdict.reason, verdict.code)
        self.verdict = verdict
        self.verdicts = tuple(verdicts) or (verdict,)


#: What a result-schema refusal says, per route. Two audiences: the model that
#: WROTE the statement can name its columns instead of starring, and the model
#: that asked a Genie space cannot, so it is told to ask for an aggregate. Both
#: texts predate the gateway and are kept verbatim, which is what makes the
#: refactor invisible to the existing tests.
_SCHEMA_REFUSALS = {
    ROUTE_SQL: (
        "Refused after running: this query returns {columns}, which identifies individual "
        "players, so no rows were read back. Name the columns you need instead of selecting "
        "every column, and aggregate the identifiers."
    ),
    ROUTE_GENIE: (
        "Refused after running: Genie's query returns {columns}, which identifies individual "
        "players, so no rows were read back. Ask for the question in aggregate: counts of "
        "players rather than the players."
    ),
}


#: What the loop tells the model after a refusal that is NOT about attribution.
#: Kept verbatim from the loop, where it was the only text: a refused cross-label
#: join or a protected column is a restriction on the ANSWER, so every route to it
#: is closed and re-asking is circumvention rather than a remedy.
_RESTRICTION_GUIDANCE = (
    "This is a governance control, not a failure and not a routing hint. Do NOT ask "
    "another tool the same question, and do not rephrase it as prose for a Genie space: "
    "the restriction is on the answer, not on this tool. Say plainly in your answer that "
    "the request was refused and why, and answer the part of the question that does not "
    "require it."
)

#: What the loop tells the model when the refusal was about ATTRIBUTION.
#:
#: THE TEXT ABOVE IS WRONG FOR THIS CASE, and shipping both together made the two
#: instructions contradict each other: the tool said "ask for a table instead" and
#: the loop immediately said "do not ask another tool the same question, and do not
#: rephrase it as prose for a Genie space". A model reading both does either thing
#: at random, which is a poor way to run a control whose whole cost is one extra
#: turn.
#:
#: The difference is real rather than a wording preference. A protected column is a
#: restriction on what the answer may contain, so every route to it is closed. An
#: unattributable result is a restriction on what may be used as PROOF, and the same
#: question asked for a table comes back with a query attachment the guard can
#: parse. So the remedy is a re-ask, on the same space, and it is worth naming
#: precisely because the model has just been told no.
_ATTRIBUTION_GUIDANCE = (
    "This is a governance control, not a failure. It is about ATTRIBUTION, not about what "
    "you are allowed to know, so unlike other refusals there IS a next step that usually "
    "works: ASK THE SAME GENIE SPACE AGAIN for the same thing as a TABLE, naming the "
    "columns or the grouping you want, rather than as a chart or a summary. A table comes "
    "back with the query behind it, which can be attributed, and an attributed result can "
    "be charted afterwards. Prefer that re-ask to giving up, and prefer it to switching to "
    "another tool. Two things you must not do: do not restate any figure from the refused "
    "attempt, because it was not admitted as evidence and repeating it puts an unverifiable "
    "number in the answer anyway; and if the re-ask is also refused, say the figures could "
    "not be attributed rather than reporting them with a warning."
)


#: What the loop tells the model when the refusal itself names a remedy.
#:
#: THE SAME DEFECT AS THE PAIR ABOVE, one control further along, and it cost a
#: stakeholder a whole answer. Asked for week-over-week retention, the run was
#: refused with "COUNT them instead: count(DISTINCT platformid_accountid) is
#: allowed", and then handed `_RESTRICTION_GUIDANCE`, which says not to re-ask.
#: The model was told to count and told not to try again in the same message; it
#: re-sent a near-identical query, was refused identically, and reported that
#: retention could not be produced.
#:
#: The distinction is not strictness, it is what the refusal is ABOUT. A
#: cross-label bridge is a restriction on the ANSWER, so every route to it is
#: closed. A statement refused for the shape it is written in is a restriction on
#: the STATEMENT, and the same question asked with the identifier one level lower
#: is a different statement, not the same request wearing a hat.
#:
#: BOUNDED AT ONE, and the bound is the second half of the fix rather than
#: politeness about budget: an unbounded "try again" against a control that will
#: keep refusing is how a run spends its whole tool budget being told no and then
#: has nothing left to answer the part it could have answered.
_REMEDIABLE_GUIDANCE = (
    "This is a governance control, not a failure and not a routing hint. It refused the SHAPE "
    "of this statement rather than the question, and it named what to change: {remedy}. So "
    "there is a next step, and it is a REWRITE of the same query for the same tool -- not the "
    "same query re-sent, and not the same question rephrased as prose for another surface, "
    "both of which will be refused identically. Make exactly ONE more attempt and make it "
    "materially different in that way. If the rewrite is refused too, stop: say plainly in "
    "your answer that the request was refused and why, answer whatever part of the question "
    "does not require it, and do not restate any figure from a refused attempt."
)

#: What it is told after a remediable refusal has already been advised once.
_SPENT_REMEDY_GUIDANCE = (
    "This is a governance control, not a failure. You have already been told once how to "
    "reshape this query and the reshaped attempt was refused as well, so do NOT try a third: "
    "the next attempt spends this run's budget without changing the outcome. Say plainly in "
    "your answer that the request was refused and why, and answer the part of the question "
    "that does not require it."
)


def refusal_guidance(refusal: BaseException, *, already_advised: bool = False) -> str:
    """What to tell the model after a refusal, chosen by what was refused.

    Dispatched on the code and on the refusal's own `remedy` rather than on the
    exception type, because all three refusals arrive as `SqlRefused` and the type
    is load-bearing elsewhere: it is what keeps a refusal on the loop's governance
    path instead of its outage path.

    A refusal carries a remedy only where someone decided a different statement
    would be accepted, so the default is the restrictive wording and a refusal
    raised anywhere else in the codebase still gets it.

    `already_advised` is whether this run has spent its one reshaped attempt. The
    caller owns that count because the caller is the only thing that can see the
    whole run; a refusal object cannot know it is the second one.
    """

    code = str(getattr(refusal, "code", "") or "")
    if code == failures.GENIE_UNATTRIBUTABLE:
        return _ATTRIBUTION_GUIDANCE
    remedy = str(getattr(refusal, "remedy", "") or "")
    if remedy:
        if already_advised:
            return _SPENT_REMEDY_GUIDANCE
        return _REMEDIABLE_GUIDANCE.format(remedy=remedy)
    return _RESTRICTION_GUIDANCE


class EvidenceGateway:
    """The one admission control every data-producing tool passes.

    Built per call rather than held on the tools, because two of its fields are
    per-request: the identity the call authenticates as, and (once deadlines
    land) how much of the budget is left. A gateway cached on an object that
    Model Serving reuses across concurrent requests would answer one caller's
    question with another caller's identity stamped on it, which is the exact
    failure the user-authorized client is built fresh to avoid.
    """

    def __init__(
        self,
        readable: Sequence[str],
        *,
        identity_mode: str = failures.IDENTITY_UNKNOWN,
        validator_version: str = VALIDATOR_VERSION,
        enforce_genie_manifest: bool = False,
        allow_unattributed_figures: bool = False,
    ) -> None:
        self.readable = tuple(readable)
        self.identity_mode = identity_mode
        self.validator_version = validator_version
        #: Whether an unattributable Genie result is admitted with a disclosure
        #: instead of refused. See `unattributed_figures`, which owns the release
        #: decision and the words. Default STRICT, and the default is the position:
        #: this exists only because there is no semantic metric layer to attribute
        #: a chart, so it is a stopgap for a missing capability rather than a
        #: preference about strictness.
        self.allow_unattributed_figures = allow_unattributed_figures
        #: Whether a Genie reference outside the declared manifest is REFUSED or
        #: merely recorded.
        #:
        #: Default off, and the default is a measured position rather than
        #: timidity. The manifest is what passthrough granted the serving
        #: PRINCIPAL; a Genie space's tables are configured in Genie and are a
        #: different set that nothing in the container can enumerate. Enforcing
        #: on day one therefore refuses ordinary questions over any table the
        #: space legitimately curates and the manifest does not happen to list,
        #: in exchange for no confidentiality the warehouse is not already
        #: enforcing against Genie's own credentials. Every verdict records the
        #: drift regardless, which is what the shadow period is for: turn this on
        #: when the recorded drift is empty on real traffic.
        self.enforce_genie_manifest = enforce_genie_manifest
        self._digest = manifest_digest(self.readable)

    @property
    def digest(self) -> str:
        return self._digest

    # -------------------------------------------------------------------
    # Building candidates
    # -------------------------------------------------------------------

    def candidate(
        self,
        tool: str,
        route: str,
        payload_type: str,
        **fields: object,
    ) -> EvidenceCandidate:
        """A candidate stamped with this run's identity, digest and version.

        Stamped here rather than by each caller so that the three fields cannot
        be omitted by a tool that forgot them, and cannot disagree between two
        tools in one run.
        """

        return EvidenceCandidate(
            tool=tool,
            route=route,
            payload_type=payload_type,
            identity_mode=self.identity_mode,
            manifest_digest=self._digest,
            validator_version=self.validator_version,
            **fields,  # type: ignore[arg-type]
        )

    # -------------------------------------------------------------------
    # Direct SQL: before it runs, and after
    # -------------------------------------------------------------------

    def admit_statement(self, tool: str, sql: str) -> Verdict:
        """Judge one statement the model wrote, BEFORE the warehouse sees it.

        The whole of the existing pre-execution guard, called rather than
        reproduced: `validate_sql` parses once, resolves the tables, checks them
        against the declared manifest, and applies the column policy. The verdict
        carries the refusal it raised so the caller can re-raise that object, and
        the reason it gives is the guard's own sentence.
        """

        candidate = self.candidate(
            tool, ROUTE_SQL, PAYLOAD_TABULAR, generated_sql=sql, depends_on_values=True
        )
        try:
            tables = validate_sql(sql, self.readable)
        except SqlRefused as refusal:
            return Verdict(
                outcome=REFUSED,
                candidate=candidate,
                code=refusal.code or failures.NO_VALID_EVIDENCE,
                reason=str(refusal),
                refusal=refusal,
            )
        return Verdict(
            outcome=ACCEPTED,
            candidate=replace(candidate, referenced_assets=tuple(tables)),
            sources=tuple(tables),
        )

    def admit_result_schema(self, verdict: Verdict, columns: Sequence[str]) -> Verdict:
        """Judge what the statement ACTUALLY returned, before a row becomes text.

        The half of the column defence a static parse cannot do: `SELECT *`
        cannot be expanded without the table's schema, so the warehouse's own
        result schema is the authority. It runs before any row is rendered,
        because from there rows reach the synthesis prompt, the trace, Lakebase
        and a screen.

        Takes the accepted verdict rather than a bare candidate, so the schema is
        recorded against the same evidence id the statement was admitted under.
        A second id here would make one read look like two.
        """

        candidate = replace(
            verdict.candidate,
            output_schema=tuple(Column(name=str(name)) for name in columns),
        )
        leaked = restricted_output_columns(columns)
        if leaked:
            template = _SCHEMA_REFUSALS.get(candidate.route, _SCHEMA_REFUSALS[ROUTE_SQL])
            # `RESULT_COLUMN_POLICY_VIOLATION`, not `COLUMN_POLICY_VIOLATION`,
            # which this reported until the shared taxonomy had a code for the
            # later moment. The statement named nothing protected and was
            # admitted; the warehouse returned a result that did. An operator
            # reading the parse-time code here would conclude the question asked
            # for a protected field, and the two rates measure opposite things.
            refusal = SqlRefused(
                template.format(columns=", ".join(leaked)),
                failures.RESULT_COLUMN_POLICY_VIOLATION,
            )
            return Verdict(
                outcome=REFUSED,
                candidate=candidate,
                code=failures.RESULT_COLUMN_POLICY_VIOLATION,
                reason=str(refusal),
                refusal=refusal,
                off_manifest=verdict.off_manifest,
            )
        return Verdict(
            outcome=ACCEPTED,
            candidate=candidate,
            sources=verdict.sources,
            off_manifest=verdict.off_manifest,
        )

    # -------------------------------------------------------------------
    # Genie: SQL that has already run, or no SQL at all
    # -------------------------------------------------------------------

    def admit_genie_query(
        self,
        tool: str,
        sql: str,
        *,
        depends_on_values: bool = True,
        metric_ids: Sequence[str] = (),
        prior_evidence_id: str = "",
    ) -> Verdict:
        """Judge one Genie query attachment by the statement it exposed.

        FAIL-CLOSED ON ATTRIBUTION, which is the change this workstream makes.
        Before, an unparseable statement returned no tables and the answer went
        out marked "sources incomplete"; the figures were still in the prose and
        a reader who has been told the sources are incomplete still reads the
        number. Now it contributes nothing, and the run says a result could not
        be attributed.

        The column policy is applied in full, and it is the same object the SQL
        path calls. It is not optional just because the query already ran: Genie
        states its findings in a sentence with the values IN it, so refusing
        before that text is returned is what keeps an address out of the
        synthesis prompt, the trace, Lakebase and a screen.
        """

        candidate = self.candidate(
            tool,
            ROUTE_GENIE,
            PAYLOAD_TABULAR,
            generated_sql=sql,
            depends_on_values=depends_on_values,
            metric_ids=tuple(metric_ids),
            prior_evidence_id=prior_evidence_id,
        )
        assets, unattributable = self._genie_assets(sql)
        if unattributable:
            return self._unattributable(candidate, unattributable)
        return self._attributed(candidate, assets)

    def admit_definition_query(self, tool: str, sql: str, *, has_definition_text: bool) -> Verdict:
        """Judge a query the DICTIONARY space ran, by what a definition is.

        THE FIGURES RULE WAS BEING APPLIED TO A DEFINITIONS CALL, and it refused
        the dictionary space on its correct behaviour. Asked what a field means,
        the space answers `SELECT 'this field is not documented' AS message`: a
        parseable statement that names no table, because there was no row to
        read. `admit_genie_query` reads that as figures with nothing behind them
        and drops the whole message, so the definition the space DID return went
        nowhere and the user watched a step fail on every run that hit it.

        The guard was right about what it saw and wrong about what it was for.
        Attribution is a rule about NUMBERS: a figure a reader cannot trace to a
        table is a figure they cannot check, and that has not moved. A definition
        is not a figure. It is the governed MEANING of a field, it is text, and
        the honest answer to "what does this mean" is sometimes that nothing
        defines it — which no query can attribute, because the absence of a row
        is what is being reported.

        So this route is judged on whether a definition came back, and the value
        of attribution is kept where it exists rather than required: a lookup that
        did read the dictionary table cites it. What does NOT change is the column
        policy, which `_genie_assets` applies to both routes and which raises: a
        statement that would hand back an address is refused whatever the question
        was, and no payload type makes that acceptable.

        `PAYLOAD_DEFINITION` either way, so `may_support_a_figure` is False even
        on the attributed branch. A row of the dictionary is a sentence about a
        field, so a number lifted out of one is not a measurement of anything.
        """

        candidate = self.candidate(
            tool,
            ROUTE_GENIE,
            PAYLOAD_DEFINITION,
            generated_sql=sql,
            depends_on_values=False,
        )
        assets, unattributable = self._genie_assets(sql)
        if assets:
            return self._attributed(candidate, assets)
        if has_definition_text:
            return Verdict(outcome=ACCEPTED, candidate=candidate)
        # Nothing to admit and nothing refused: the space ran something, it could
        # not be attributed, and it said nothing either. A FAILURE rather than a
        # governance refusal, for the reason `failures` keeps the two apart: the
        # remedy is a retry or a person looking at the space, and telling the
        # model a control fired sends it to explain a restriction that does not
        # exist.
        return Verdict(
            outcome=FAILED,
            candidate=candidate,
            code=failures.DEPENDENCY_UNAVAILABLE,
            reason=(
                f"The dictionary space returned no definition. {unattributable} So there is "
                "nothing here to use as the meaning of the field."
            ),
        )

    def _genie_assets(self, sql: str) -> tuple[tuple[str, ...], str]:
        """The tables one Genie attachment read, or why that is not knowable.

        Shared by both Genie routes, so that the four ways a statement can fail to
        name its sources are found once and described in one set of words.
        Whether being unattributable is FATAL differs between the two spaces and
        is the caller's decision; what it means does not differ, and a second copy
        of this walk is how the two would come to disagree about one statement.

        The column policy raises out of here, on both routes and deliberately. It
        is not an attribution rule: a statement that would return an identifier is
        refused whatever the answer was for, and it has to drop the whole message
        rather than one attachment, because Genie states its findings in prose
        with the values inside it.
        """

        if not sql.strip():
            return (), (
                "Genie ran a query and exposed no SQL for it, so nothing it returned can be "
                "traced to a table."
            )

        try:
            tree = parse_sql(sql)
        except SqlRefused:
            # Deliberately NOT the parser's message. It advises rewriting the
            # statement, which is advice for whoever wrote it, and nobody here
            # chose what SQL the space generated.
            return (), (
                "Genie ran a query the guard cannot parse, so what it read cannot be "
                "established and its result is not evidence."
            )

        refuse_restricted_columns(tree)

        try:
            assets = tuple(referenced_tables(tree))
        except SqlRefused:
            return (), (
                "Genie ran a query whose sources cannot be resolved to named tables, so its "
                "result is not attributable."
            )
        if not assets:
            return (), (
                "Genie ran a query that names no table, so there is nothing to attribute its "
                "result to."
            )
        return assets, ""

    def _attributed(self, candidate: EvidenceCandidate, assets: tuple[str, ...]) -> Verdict:
        """The verdict for an attachment whose tables ARE known: cite them, or refuse.

        One copy for both Genie routes, because manifest drift is a property of
        the statement rather than of what the answer was wanted for. A dictionary
        lookup that reads a table this deployment does not declare is the same
        finding as a data query that does.
        """

        declared = {name.lower(): name for name in self.readable}
        off_manifest = tuple(name for name in assets if name.lower() not in declared)
        candidate = replace(candidate, referenced_assets=assets)
        if off_manifest and self.enforce_genie_manifest:
            return Verdict(
                outcome=REFUSED,
                candidate=candidate,
                code=failures.ASSET_NOT_IN_MANIFEST,
                reason=(
                    f"Genie read {', '.join(off_manifest)}, which this deployment does not "
                    "declare, so its result was not used."
                ),
                off_manifest=off_manifest,
            )
        # Cited with the declaration's own spelling where there is one, so a table
        # named two ways in two answers is not read as two tables.
        sources = tuple(declared.get(name.lower(), name) for name in assets)
        return Verdict(
            outcome=ACCEPTED,
            candidate=candidate,
            sources=sources,
            off_manifest=off_manifest,
        )

    def admit_genie_visualization(self, tool: str, *, metric_ids: Sequence[str] = ()) -> Verdict:
        """Judge a chart Genie returned with no statement behind it.

        REFUSED unless a certified metric identifier attributes it. This is the
        case the plan is most specific about and the one that is easiest to argue
        away, because the numbers in a Genie chart are real. They are also
        untraceable: nothing in the attachment says which table, which window, or
        which population, so a figure taken from it cannot be checked by the
        person it is shown to, and an answer nobody can check is the thing this
        product is built not to produce.

        A metric identifier is the exception because it is machine-verifiable
        attribution rather than a promise: it names the governed definition the
        number came from, which is the same kind of claim a parsed statement
        makes.

        WHICH MEANS IT HAS TO BE VERIFIED HERE, and until now it was not: any
        non-empty list of strings attributed the chart. Nobody noticed because
        nothing supplies one. THERE IS NO METRIC LAYER: the demo schema is twelve
        plain managed tables and not one metric view, so this branch is unreachable
        in the running product and its only callers are tests. That is exactly the
        condition in which a hole stays open, so the id is now checked against the
        declared manifest before it attributes anything.

        Whoever builds the metric layer will meet that check rather than a silent
        acceptance. A metric view the agent may read has to be declared to be
        queried at all, so the honest name passes and an invented one is refused,
        which is the whole difference between verifiable attribution and a promise.
        """

        governed = self._governed_metrics(metric_ids)
        candidate = self.candidate(
            tool,
            ROUTE_GENIE,
            PAYLOAD_METRIC if governed else PAYLOAD_VISUALIZATION,
            metric_ids=tuple(governed),
        )
        if governed:
            return Verdict(outcome=ACCEPTED, candidate=candidate, sources=tuple(governed))
        if metric_ids:
            # Named a metric and none of them held up. Said separately from the
            # no-metric case, because "your chart had nothing behind it" would send
            # somebody debugging the Genie space when the finding is about the
            # manifest.
            return self._unattributable(
                candidate,
                "Genie returned a chart attributed to "
                f"{', '.join(str(metric) for metric in metric_ids)}, which is not a governed "
                "metric this release declares, so the figures cannot be traced and were not "
                "used.",
            )
        return self._unattributable(
            candidate,
            "Genie returned a chart with no query behind it, so its figures cannot be traced "
            "to a table or to a governed metric and were not used.",
        )

    def admit_definition(self, tool: str, *, has_text: bool) -> Verdict:
        """Judge a governed definition: prose about a FIELD, not a figure.

        Accepted without a statement, because a definition is not a claim about
        data values and holding it to the value-bearing rule would refuse the
        dictionary space entirely. `may_support_a_figure` is False on the
        verdict, so an accepted definition still cannot become a number.

        This is the case where the space ran NOTHING. When it ran a query and the
        answer is still a definition, `admit_definition_query` decides, and it
        exists because that case was reaching the figures rule and being refused.
        """

        candidate = self.candidate(tool, ROUTE_GENIE, PAYLOAD_DEFINITION, depends_on_values=False)
        if not has_text:
            return Verdict(
                outcome=FAILED,
                candidate=candidate,
                code=failures.DEPENDENCY_UNAVAILABLE,
                reason="The dictionary space returned no definition.",
            )
        return Verdict(outcome=ACCEPTED, candidate=candidate)

    def admit_metadata(self, tool: str, *, assets: Sequence[str] = ()) -> Verdict:
        """Judge catalog metadata: a declared listing, a table description.

        Attributable without a statement to parse, because the asset is what was
        read and it is named. Not value-bearing: a column list is not a figure.
        """

        candidate = self.candidate(
            tool,
            ROUTE_METADATA,
            PAYLOAD_METADATA,
            referenced_assets=tuple(assets),
            depends_on_values=False,
        )
        return Verdict(outcome=ACCEPTED, candidate=candidate, sources=tuple(assets))

    # -------------------------------------------------------------------
    # Things that were not evidence at all
    # -------------------------------------------------------------------

    def access_denied(self, tool: str, route: str, reason: str, code: str) -> Verdict:
        """A surface that refused this run's IDENTITY.

        Its own outcome, not a failure. "Did not respond" invites a retry, and
        the two conditions this covers (a Genie space nobody shared, a workspace
        entitlement nobody assigned) will refuse every question ever asked,
        identically, until a person does something in a UI.
        """

        return Verdict(
            outcome=ACCESS_DENIED,
            candidate=self.candidate(tool, route, PAYLOAD_METADATA, depends_on_values=False),
            code=code,
            reason=reason,
        )

    def failed(self, tool: str, route: str, reason: str) -> Verdict:
        """A dependency that did not answer. The only outcome a retry can help."""

        return Verdict(
            outcome=FAILED,
            candidate=self.candidate(tool, route, PAYLOAD_METADATA, depends_on_values=False),
            code=failures.DEPENDENCY_UNAVAILABLE,
            reason=reason,
        )

    def _governed_metrics(self, metric_ids: Sequence[str]) -> tuple[str, ...]:
        """The subset of the claimed metric ids this release can actually vouch for.

        Fail closed, and on the same basis a table reference is checked: a
        three-part Unity Catalog name that the declared manifest contains. A bare
        name, a half-qualified one, or a plausible name nobody granted attributes
        nothing, because a source the reader cannot look up is the problem this
        gateway exists to prevent rather than a lesser form of attribution.

        Case-insensitive on the comparison, since Unity Catalog names are.
        """

        declared = {name.lower() for name in self.readable}
        return tuple(
            metric
            for metric in (str(claimed).strip().strip("`") for claimed in metric_ids)
            if metric.count(".") == 2 and metric.lower() in declared
        )

    def _unattributable(self, candidate: EvidenceCandidate, reason: str) -> Verdict:
        """The one place both ways of being unattributable converge.

        Which is why the escape valve is applied HERE rather than at the two call
        sites: a flag checked in two places is a flag that will eventually be
        checked in one.

        When it is open the verdict is ACCEPTED and WAIVED, and it still carries
        the refusal code and the reason. Those are not decoration. `sources` stays
        empty because nothing became attributable by being permitted, so an answer
        built on this cites nothing, which is the honest outcome and also the thing
        that makes the caveat true.
        """

        if self.allow_unattributed_figures:
            return Verdict(
                outcome=ACCEPTED,
                candidate=candidate,
                code=failures.GENIE_UNATTRIBUTABLE,
                reason=reason,
                waived=True,
            )
        return Verdict(
            outcome=REFUSED,
            candidate=candidate,
            code=failures.GENIE_UNATTRIBUTABLE,
            reason=reason,
        )
