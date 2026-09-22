from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

# ---------------------------------------------------------------------------
# Reader-facing caveats
# ---------------------------------------------------------------------------
#
# Caveats are not an enum. Some are produced from live facts -- the table whose
# grant was denied, the dates missing from a window, or the metric whose
# definition was absent -- and their complete sentences cannot be known before
# the run. The shared JSON contract therefore publishes a CLOSED LIST OF
# SEMANTIC FAMILIES and the few stable literal forms that another component
# matches. `agent/generate_contract.py` writes these values beside the response
# schema so the app and the agent can release independently without pretending
# dynamic disclosures are a finite string enum.

DEGRADED_ANSWER_MARKER = "This answer is degraded:"
SALVAGED_CAVEAT = "Review the generated SQL and source details before using this result."
MLFLOW_NOT_RECORDED_CAVEAT = (
    "MLflow did not record this run, so process and SQL inspection are unavailable."
)

CAVEAT_CATEGORIES: tuple[dict[str, object], ...] = (
    {
        "id": "refused",
        "rank": 0,
        "meaning": "Part of the request was refused or the answer is degraded.",
        "always_visible": True,
    },
    {
        "id": "evidence",
        "rank": 1,
        "meaning": "Part of the evidence is unaccounted for or the run stopped early.",
    },
    {
        "id": "undefined",
        "rank": 2,
        "meaning": "A number relies on a metric or field without a governed definition.",
    },
    {
        "id": "coverage",
        "rank": 3,
        "meaning": "The measured window or population does not fully cover the question.",
    },
    {
        "id": "aggregation",
        "rank": 4,
        "meaning": "The number is valid but its aggregation or grain limits interpretation.",
    },
    {
        "id": "omitted",
        "rank": 5,
        "meaning": "Valid supporting content was omitted from figures for presentation limits.",
    },
    {
        "id": "unclassified",
        "rank": 6,
        "meaning": "A valid free-form caveat that no published family recognizes yet.",
    },
    {
        "id": "identity",
        "rank": 7,
        "meaning": "The grants or execution identity under which governed data was read.",
    },
    {
        "id": "deployment",
        "rank": 8,
        "meaning": "A standing deployment or dataset condition rather than a run-specific risk.",
    },
)

KNOWN_CAVEAT_FORMS: tuple[dict[str, object], ...] = (
    {
        "id": "degraded-answer",
        "producer": "agent-and-app",
        "category": "refused",
        "match": "prefix",
        "value": DEGRADED_ANSWER_MARKER,
    },
    {
        "id": "salvaged-structured-answer",
        "producer": "agent",
        "category": "evidence",
        "match": "exact",
        "value": SALVAGED_CAVEAT,
    },
    {
        "id": "mlflow-not-recorded",
        "producer": "agent",
        "category": "deployment",
        "match": "exact",
        "value": MLFLOW_NOT_RECORDED_CAVEAT,
    },
    {
        "id": "prose-only-answer",
        "producer": "app",
        "category": "refused",
        "match": "exact",
        "value": (
            "This answer is degraded: the response format was incomplete. "
            "Retry the question before using this result."
        ),
    },
    {
        "id": "prose-only-after-stages",
        "producer": "app",
        "category": "refused",
        "match": "exact",
        "value": (
            "This answer is degraded: the response ended before the answer format completed. "
            "Retry the question before using this result."
        ),
    },
    {
        "id": "service-principal-fallback",
        "producer": "app",
        "category": "identity",
        "match": "exact",
        "value": (
            "Data access scope: this answer used the application’s Unity Catalog grants, "
            "which may include data outside the signed-in account’s direct access."
        ),
    },
    {
        "id": "historical-untraced-answer",
        "producer": "app-read-policy",
        "category": "deployment",
        "match": "exact",
        "value": (
            "No MLflow trace was recorded for this answer, so it cannot be opened in MLflow."
        ),
        "historical_only": True,
    },
)

DYNAMIC_CAVEAT_FAMILIES: tuple[dict[str, str], ...] = (
    {
        "id": "governance-refusal",
        "category": "refused",
        "contents": "Names the control or access decision and the portion of the request refused.",
    },
    {
        "id": "dependency-degradation",
        "category": "refused",
        "contents": "Names the unavailable dependency and which answer path could not be used.",
    },
    {
        "id": "incomplete-provenance",
        "category": "evidence",
        "contents": "Names missing source attribution or evidence that could not be retrieved.",
    },
    {
        "id": "run-limit",
        "category": "evidence",
        "contents": "Names the time, step, tool-call, or budget limit that stopped the run.",
    },
    {
        "id": "definition-gap",
        "category": "undefined",
        "contents": "Names a metric or field absent from the governed data dictionary.",
    },
    {
        "id": "window-or-population-gap",
        "category": "coverage",
        "contents": "Names dates, rows, labels, or populations missing from the measurement.",
    },
    {
        "id": "grain-or-rollup",
        "category": "aggregation",
        "contents": "States the grain, weighting, additivity, or rollup limitation.",
    },
    {
        "id": "presentation-omission",
        "category": "omitted",
        "contents": "Names valid results omitted because of chart or figure limits.",
    },
    {
        "id": "execution-identity",
        "category": "identity",
        "contents": "Names the effective identity or grant scope that produced the evidence.",
    },
    {
        "id": "deployment-disclosure",
        "category": "deployment",
        "contents": "States a standing environment or dataset condition.",
    },
)


class Figure(BaseModel):
    label: str
    value: float
    display: str
    comparison: str = ""


class Chart(BaseModel):
    """One Plotly panel, as produced by `charts.new_plot`.

    `data` and `layout` are Plotly's own free-form shapes, carried opaquely to the
    browser. Only the envelope is a contract, and `kind` is derived from the
    traces rather than supplied, so it cannot disagree with `data`.
    """

    id: str
    title: str
    kind: str
    data: list[dict[str, Any]]
    layout: dict[str, Any] = Field(default_factory=dict)


class Source(BaseModel):
    """One table the run read, and what it read it for.

    `role` is the distinction the run already draws internally and used not to
    publish. A table queried for values is `reading`; a table read to look up
    what a term means, or to see what columns it has, is `reference`. Both are
    sources of the answer and only the first is a source of its numbers, so a
    flat list presented the dictionary the agent consulted as though the figures
    had come out of it.

    Empty means unstated, which is what an answer stored before this field
    existed carries. Readers must say so rather than assuming either role: the
    app has no way to tell from a name, and guessing is how the dictionary came
    to be labelled as the source of the numbers in the first place.
    """

    name: str
    freshness: str
    role: str = ""


class DocumentSnippet(BaseModel):
    """A short, verbatim footnote from an attached document used in the answer."""

    filename: str
    quote: str
    supports: str


class Derivation(BaseModel):
    """What one statement measured, over what, from where.

    Four labelled facts, each derived from the parse of the statement that ran
    (`provenance.py`), never from what the model wrote. Together they answer the
    question a table name and a figure cannot: "8,413 active players" means one
    thing over thirty days and another over a year, and something different again
    with one title filtered out.

    EVERY FIELD MAY BE EMPTY, and empty means the statement did not say. A query
    with no WHERE clause covers everything and has no window, which is a fact
    about it; a Genie statement whose tables could not be resolved has no source.
    A reader must render an empty field as nothing rather than as "unknown" or as
    "all time" -- the second is a claim about the population that nothing here
    checked.

    `filter` never carries the VALUE of a column that identifies a person; the
    column is named and the literal is withheld. See `provenance.py`, which does
    the withholding, for why the column name itself is published.
    """

    #: The fully-qualified table the statement read, or the first of several.
    source: str = ""
    #: What it measured, named as the query named it: the projection's alias where
    #: it had one, otherwise the aggregate itself.
    metric: str = ""
    #: The time range its predicates covered, as a range or a bound.
    window: str = ""
    #: Which rows it kept, beyond the window.
    filter: str = ""


class TraceStage(BaseModel):
    """One step of a run, as the timeline reads it.

    `input` and `output` are the allowlisted reader projection. Tool stages keep
    their arguments and concrete result, with agent-only retry and safety
    guidance removed. Agent stages keep only a compact task and outcome, never
    their model prompt or internal handoff. The size cap lives in `agent.py`.

    `depth` and `parent_id` express nesting. A tool-calling loop is a tree, and a
    flat list of siblings misrepresents it as a sequence of equals.
    """

    id: str
    name: str
    kind: str
    start: float
    duration: float
    status: Literal["complete", "running", "partial", "failed"]
    calls: int = 1
    input: str = ""
    output: str = ""
    #: Fully-qualified table names this discovery step enumerated.
    #:
    #: Separate from ``output`` on purpose. This small structured projection lets
    #: live/replayed clients render an honest table inventory without parsing
    #: prose.
    tables: list[str] = Field(default_factory=list)
    #: 0 for a top-level step, 1 for a tool call made inside one. Defaulted so a
    #: stage from a model version that predates nesting reads as top-level.
    depth: int = 0
    #: The `id` of the stage this one ran inside, or "" at the top level.
    parent_id: str = ""


class GenieSpace(BaseModel):
    """A Genie space this run put a question to.

    Recorded per run because the space is chosen at request time from settings
    baked into the model artifact, so it is a fact only the run itself knows: the
    app cannot read the orchestrator's configuration, and a deployment can be
    re-logged against different spaces without the app noticing. Without this,
    nothing anywhere records which space answered a given question.

    Both halves, because they answer different questions. `id` is what an admin
    needs to open the space or match it against the bundle; `title` is what a
    reader should be shown, since a 32-character hex id names infrastructure and
    tells a person nothing. `title` is empty when no title was baked at log time,
    and a reader with an empty title has to fall back rather than print a blank.
    """

    id: str
    title: str = ""


class ResourceCall(BaseModel):
    """Calls this run dispatched to one configured external resource.

    This is deliberately identifier-only telemetry. It carries no prompt,
    result, query text, or token contents. `calls` is incremented on dispatch,
    including a request that later fails, because the external service was
    still asked and may still have billed it.
    """

    kind: Literal["genie-space", "vector-index"]
    id: str
    tool: Literal["data_genie", "genie_mcp", "dictionary_genie", "search_semantics"]
    calls: int = 1


class TraceSummary(BaseModel):
    """What one run did, as the app reads it back.

    `toolCalls` counts EXTERNAL CALLS THE RUN MADE: dictionary Genie, data Genie,
    the read-only SQL fallback, the synthesis model call, the plotting call. It is
    NOT the number of stages tagged `kind="tool"` and is normally larger, because
    `discover` and `synthesis` are tagged `"agent"` and the SQL fallback produces
    no stage of its own.

    The two are different quantities, reported separately: the app exposes the
    tagged stages as `toolStages`. Do not make one derivable from the other.

    `prompt_tokens` / `completion_tokens` / `total_tokens` are the sum of every
    chat-completions `usage` block recorded this turn. Zero when the endpoint
    did not return usage, not when the run made no model calls: the two are not
    distinguishable from the totals alone, and a missing meter must not look
    like a free run.

    `genie_spaces` are the spaces this run actually called, in the order it first
    reached each, and it is empty for a run that asked Genie nothing. Recorded on
    dispatch rather than on a successful reply, so a run refused by a space it was
    never shared with still says which space refused it -- which is the run whose
    routing someone most needs to see.
    """

    id: str
    totalMs: float
    toolCalls: int
    stages: list[TraceStage]
    genie_spaces: list[GenieSpace] = Field(default_factory=list)
    resource_calls: list[ResourceCall] = Field(default_factory=list)
    genie_transport: Literal["direct", "mcp"] = "direct"
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class PlanStep(BaseModel):
    id: str
    title: str
    description: str
    kind: Literal["context", "definitions", "data", "synthesis"]


class PlanCandidate(BaseModel):
    table: str
    field: str
    definition: str
    why: str
    recommended: bool = False


class AnalysisPlan(BaseModel):
    id: str
    question: str
    summary: str
    steps: list[PlanStep]
    candidates: list[PlanCandidate] = Field(default_factory=list, max_length=3)
    requires_approval: bool = True
    uses_conversation_context: bool = False
    uses_attachment_context: bool = False

    @model_validator(mode="after")
    def candidates_match_steps(self) -> AnalysisPlan:
        if not self.candidates:
            return self
        if len(self.candidates) != len(self.steps):
            raise ValueError("plan candidates must be index-aligned with steps")
        if sum(candidate.recommended for candidate in self.candidates) != 1:
            raise ValueError("exactly one plan candidate must be recommended")
        return self


class Clarification(BaseModel):
    """The run stopped to ask the user something, rather than guessing.

    The third outcome of a turn, alongside a plan and an answer. Used for a table
    named but not fully qualified, and for a question whose terms are undefined,
    where any interpretation produces a real number for a question nobody asked.

    Deliberately NOT an answer with a caveat: an answer invites the reader to use
    the figures, and there are none worth using here.
    """

    id: str
    #: One short, specific question. What the user has to supply, not an apology.
    question: str
    #: Why the question cannot be answered as asked, in a sentence.
    reason: str = ""
    #: Concrete choices when there are any: candidate full table names, or the
    #: country sets a region might mean. Empty rather than fabricated.
    options: list[str] = Field(default_factory=list)
    #: What was attempted before stopping, so "why is it asking me this" is
    #: answerable from the steps.
    trace: TraceSummary


class ReportFigure(BaseModel):
    id: str | None = None
    label: str
    value: str
    caption: str | None = None


class ReportTable(BaseModel):
    id: str | None = None
    title: str | None = None
    columns: list[str]
    align: list[Literal["left", "right", "center"]] | None = None
    rows: list[list[str]]
    sources: list[str] | None = None


class ReportPlotlySpec(BaseModel):
    data: list[dict[str, Any]]
    layout: dict[str, Any]


class ReportChart(BaseModel):
    id: str
    title: str
    kind: str
    plotly: ReportPlotlySpec


class ReportSection(BaseModel):
    id: str | None = None
    heading: str | None = None
    body: str | None = None
    figures: list[ReportFigure] | None = None
    table: ReportTable | None = None
    charts: list[ReportChart] | None = None
    note: str | None = None


class ReportSource(BaseModel):
    name: str
    freshness: str | None = None


class ReportContract(BaseModel):
    """A structured multi-section document interpreted by the application."""

    schema_version: Literal["pia.report/1"] = "pia.report/1"
    title: str
    subtitle: str | None = None
    theme: Literal["page", "presentation"] | None = None
    summary: str | None = None
    sections: list[ReportSection]
    sources: list[ReportSource] | None = None
    caveats: list[str] | None = Field(
        default=None,
        description=(
            "Reader-facing qualifications using the same open caveat semantics "
            "published in x-pia-caveats."
        ),
    )
    generatedAt: str | None = None
    provenance: Any | None = None


class AnswerContract(BaseModel):
    id: str
    takeaway: str
    narrative: str
    #: Concrete findings returned by the run, kept separate from interpretation.
    content: str = ""
    figures: list[Figure] = Field(default_factory=list)
    charts: list[Chart] = Field(default_factory=list)
    #: Opaque evidence rows a later follow-up may reuse to draw a chart without
    #: pretending it queried the data again. Empty when this turn has no
    #: transferable chart evidence.
    chart_evidence: list[str] = Field(default_factory=list)
    sources: list[Source] = Field(default_factory=list)
    document_snippets: list[DocumentSnippet] = Field(default_factory=list)
    caveats: list[str] = Field(
        default_factory=list,
        description=(
            "Reader-facing qualifications. This is intentionally an open list of strings: "
            "live table names, dates, metric names and access decisions make the sentence set "
            "dynamic. See x-pia-caveats in the generated shared schema for the closed semantic "
            "families, stable markers and ordering rules."
        ),
    )
    #: Per-statement provenance, in the order the run ran them.
    #:
    #: NOT called `provenance` on purpose, and this is a wire-compatibility point
    #: rather than a preference. The app already sends the browser a field by that
    #: name, meaning which PARTS of an answer came from a live run
    #: (`shared/answer-provenance.ts`), and the ask route builds its reply by
    #: spreading the agent's answer and then setting its own. A field called
    #: `provenance` here would be silently overwritten by that, which is the worst
    #: of the three outcomes: it would read as an agent that stopped reporting.
    derivation: list[Derivation] = Field(default_factory=list)
    sql: str = ""
    trace: TraceSummary

    @field_validator("takeaway", "narrative", "content", "sql", mode="before")
    @classmethod
    def _null_string_is_empty(cls, value: Any) -> Any:
        """An explicit JSON null means 'nothing here', not a validation failure."""

        return "" if value is None else value

    @field_validator(
        "figures",
        "charts",
        "chart_evidence",
        "sources",
        "document_snippets",
        "caveats",
        "derivation",
        mode="before",
    )
    @classmethod
    def _null_list_is_empty(cls, value: Any) -> Any:
        """A null section is none of that section, not a failed answer object."""

        return [] if value is None else value


# ---------------------------------------------------------------------------
# Model Serving `custom_outputs` envelopes
# ---------------------------------------------------------------------------
#
# These wrappers are the actual boundary Acme's backend and the app share.
# The inner models above existed already, but without the envelope a consumer
# still had to infer whether `answer`, `plan`, or `clarification` was present.
# The generated JSON Schema uses this discriminated union as its root.


class ExecutionIdentityClaim(BaseModel):
    mode: str
    verified: bool


class AnswerOutput(BaseModel):
    type: Literal["answer"]
    answer: AnswerContract


class PlanOutput(BaseModel):
    type: Literal["plan"]
    plan: AnalysisPlan


class ClarificationOutput(BaseModel):
    type: Literal["clarification"]
    clarification: Clarification


class ReportOutput(BaseModel):
    type: Literal["report"]
    report: ReportContract


class HtmlRenderable(BaseModel):
    """A complete backend-authored HTML document."""

    format: Literal["html"]
    content: str


class JsonRenderable(BaseModel):
    """Backend-authored JSON whose structure remains backend-owned."""

    format: Literal["json"]
    content: Any


DashboardRenderable = Annotated[
    HtmlRenderable | JsonRenderable,
    Field(discriminator="format"),
]


class DashboardOutput(BaseModel):
    """A backend-authored renderable artifact.

    The backend selects the declared format and owns the payload. The frontend
    chooses only the matching generic rendering surface; it does not infer a
    format, derive dashboard components, or reinterpret the payload as its own
    answer/report contract.
    """

    type: Literal["dashboard"]
    renderable: DashboardRenderable = Field(
        description=(
            "Backend-selected renderable payload. HTML is passed byte-for-byte "
            "to an isolated browser frame. JSON preserves the backend value and "
            "is displayed as JSON rather than rebuilt as frontend components."
        )
    )


class UnavailableOutput(BaseModel):
    """A terminal refusal emitted by the served agent inside an HTTP 200.

    `code` and `layer` remain open strings on purpose. A newer agent can add a
    terminal code before the app deploys; the app must preserve the refusal and
    degrade it to its unknown-code fallback rather than misread it as an answer.
    Request/run ids and execution identity are present on identity refusals and
    absent on gateway/transport refusals.
    """

    type: Literal["unavailable"]
    code: str
    layer: str
    retryable: bool
    message: str
    request_id: str | None = None
    run_id: str | None = None
    execution_identity: ExecutionIdentityClaim | None = None


AgentTerminalOutput = Annotated[
    (
        AnswerOutput
        | PlanOutput
        | ClarificationOutput
        | ReportOutput
        | DashboardOutput
        | UnavailableOutput
    ),
    Field(discriminator="type"),
]
